import type { Database } from "bun:sqlite"
import { readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { requeueFailedSummaryJob } from "../../comprehension/queue"
import { MAX_JOBS_PER_PASS } from "../../constants"
import { RpcMethods } from "../../contracts/rpc"
import { CitationSchema, HistorySummarySchema } from "../../contracts/rpc-resources"
import { clearLedger } from "../../ledger/delete"
import { compactFrame } from "../../ledger/frames"
import type { LedgerStats } from "../../ledger/stats"
import { renderContextAwarenessDayPage } from "../../memory/render"
import { truncateWal } from "../../sqlite/checkpoint"

const DescriptionSchema = z.array(z.string())
const CitationsSchema = z.array(CitationSchema)
const SummaryStates = ["pending", "running", "done", "failed", "skipped"] as const

type SummaryRow = {
  readonly id: string
  readonly kind: string
  readonly window_from: number
  readonly window_to: number
  readonly title: string
  readonly description: string
  readonly status: string
  readonly citations: string
}

type HistoryDependencies = {
  readonly db: Database
  readonly directory: string
  readonly stats: LedgerStats
  readonly now: () => number
  readonly getMasterKey: () => Buffer | null
  readonly rotateKey?: () => void | Promise<void>
  readonly afterClear?: () => void | Promise<void>
  readonly getRetentionDays: () => number
  readonly onSummariesRetried: () => void
}

type HistoryHandlers = {
  readonly historyStatus: (params: unknown) => z.output<typeof RpcMethods.historyStatus.output>
  readonly historyList: (params: unknown) => z.output<typeof RpcMethods.historyList.output>
  readonly "day.get": (
    params: unknown,
  ) => Promise<z.output<(typeof RpcMethods)["day.get"]["output"]>>
  readonly clear: (params: unknown) => Promise<z.output<typeof RpcMethods.clear.output>>
  readonly "summaries.retryFailedToday": (
    params: unknown,
  ) => z.output<(typeof RpcMethods)["summaries.retryFailedToday"]["output"]>
}

function localDay(at: number): string {
  return new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at)
}

function localDayStart(at: number): number {
  const value = new Date(at)
  value.setHours(0, 0, 0, 0)
  return value.getTime()
}

function validLocalDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) return false
  const [year, month, date] = day.split("-").map(Number)
  if (year === undefined || month === undefined || date === undefined) return false
  const parsed = new Date(year, month - 1, date)
  return (
    parsed.getFullYear() === year && parsed.getMonth() + 1 === month && parsed.getDate() === date
  )
}

function toSummary(row: SummaryRow) {
  return HistorySummarySchema.parse({
    id: row.id,
    kind: row.kind,
    window_from: row.window_from,
    window_to: row.window_to,
    title: row.title,
    description:
      row.description === "" ? "" : DescriptionSchema.parse(JSON.parse(row.description)).join(" "),
    status: row.status,
    citations: CitationsSchema.parse(JSON.parse(row.citations)),
  })
}

export function createHistoryHandlers(dependencies: HistoryDependencies): HistoryHandlers {
  const { db, directory, stats } = dependencies
  return {
    historyStatus() {
      const now = dependencies.now()
      const todayStart = localDayStart(now)
      const tomorrow = new Date(todayStart)
      tomorrow.setDate(tomorrow.getDate() + 1)
      const days = db
        .query<{ window_from: number }, []>(`
          SELECT DISTINCT window_from FROM context_awareness_summaries
          WHERE status = 'done' AND kind = '10min'
        `)
        .all()
      const summaryDays = new Set(days.map((row) => localDay(row.window_from)))
      const activityDays = new Set(summaryDays)
      for (const row of db
        .query<{ day: string }, []>(
          "SELECT day FROM side_day_counters WHERE COALESCE(events, 0) > 0",
        )
        .all()) {
        activityDays.add(row.day)
      }
      const todaySummaryStates = {
        pending: 0,
        running: 0,
        done: 0,
        failed: 0,
        skipped: 0,
      }
      for (const row of db
        .query<{ status: string; count: number }, [number, number]>(`
          SELECT status, COUNT(*) AS count FROM context_awareness_summaries
          WHERE window_from >= ? AND window_from < ? GROUP BY status
        `)
        .all(todayStart, tomorrow.getTime())) {
        if (SummaryStates.some((status) => status === row.status))
          todaySummaryStates[row.status as (typeof SummaryStates)[number]] = row.count
      }
      const storeBytes = stats.footprint(now)
      return {
        store_bytes: storeBytes,
        average_bytes_per_day:
          activityDays.size === 0 ? 0 : Math.round(storeBytes / activityDays.size),
        days_with_summaries: [...summaryDays].sort(),
        today_summary_states: todaySummaryStates,
      }
    },
    historyList(params) {
      const input = RpcMethods.historyList.input.parse(params)
      if (input.from > input.to) throw new RangeError("History range is reversed")
      return db
        .query<SummaryRow, [number, number]>(`
          SELECT id, kind, window_from, window_to, title, description, status, citations
          FROM context_awareness_summaries
          WHERE window_from <= ? AND window_to >= ?
          ORDER BY window_from, kind, id
        `)
        .all(input.to, input.from)
        .map(toSummary)
    },
    "summaries.retryFailedToday"(params) {
      RpcMethods["summaries.retryFailedToday"].input.parse(params)
      const now = dependencies.now()
      const todayStart = localDayStart(now)
      const tomorrow = new Date(todayStart)
      tomorrow.setDate(tomorrow.getDate() + 1)
      const failed = db
        .query<{ id: string }, [number, number]>(`
          SELECT id FROM context_awareness_summaries
          WHERE status = 'failed' AND window_from >= ? AND window_from < ?
          ORDER BY window_from, id
        `)
        .all(todayStart, tomorrow.getTime())
      let requeued = 0
      for (const { id } of failed) {
        if (requeued >= MAX_JOBS_PER_PASS) break
        if (requeueFailedSummaryJob(db, id, now, dependencies.getRetentionDays())) requeued++
      }
      if (requeued > 0) dependencies.onSummariesRetried()
      return { requeued }
    },
    async "day.get"(params) {
      const input = RpcMethods["day.get"].input.parse(params)
      if (!validLocalDay(input.date)) return null
      const filename = join(directory, "memory", "episodic", `context-awareness-${input.date}.md`)
      try {
        const [markdown, metadata] = await Promise.all([readFile(filename, "utf8"), stat(filename)])
        return { date: input.date, markdown, updated_at: metadata.mtime.toISOString() }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
        return null
      }
    },
    async clear(params) {
      const input = RpcMethods.clear.input.parse(params)
      const key = dependencies.getMasterKey()
      if (key === null) throw new Error("Capture key is unavailable")
      try {
        let result: Awaited<ReturnType<typeof clearLedger>>
        try {
          result = await clearLedger(db, input.target, {
            now: dependencies.now(),
            ...(dependencies.rotateKey ? { rotateKey: dependencies.rotateKey } : {}),
            compactFrame: (ledger, id, now) => compactFrame(ledger, key, id, now),
            onDirtyDay: async (day) => {
              const page = join(directory, "memory", "episodic", `context-awareness-${day}.md`)
              try {
                await renderContextAwarenessDayPage(db, directory, day, dependencies.now())
              } catch (error) {
                await rm(page, { force: true })
                throw error
              }
            },
          })
        } finally {
          await dependencies.afterClear?.()
          truncateWal(db)
        }
        return {
          deleted_events: result.deletedEvents,
          deleted_summaries: result.deletedSummaries,
          deletion_epoch: result.deletionEpoch,
        }
      } finally {
        stats.invalidateFootprint()
        key.fill(0)
      }
    },
  }
}
