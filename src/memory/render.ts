import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { renameSync, rmSync } from "node:fs"
import { chmod, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { CA_PAGE_RENDER_VERSION, PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "../constants"
import { type FenceResult, withFence } from "../ledger/fence"

type SummaryRow = {
  readonly id: string
  readonly kind: "10min" | "6h"
  readonly window_from: number
  readonly window_to: number
  readonly updated_at: number
  readonly title: string
  readonly description: string
  readonly body: string | null
  readonly citations: string
  readonly source_ids: string
}

const CitationsSchema = z.array(z.object({ ref: z.string() }))
const StringsSchema = z.array(z.string())

function localDayRange(day: string): { from: number; to: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) throw new RangeError("Invalid local day")
  const fromDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (
    fromDate.getFullYear() !== Number(match[1]) ||
    fromDate.getMonth() + 1 !== Number(match[2]) ||
    fromDate.getDate() !== Number(match[3])
  )
    throw new RangeError("Invalid local day")
  const toDate = new Date(fromDate)
  toDate.setDate(toDate.getDate() + 1)
  return { from: fromDate.getTime(), to: toDate.getTime() }
}

function timeLabel(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

function localIso(at: number): string {
  const date = new Date(at)
  const wall = new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .format(date)
    .replace(" ", "T")
  const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "longOffset" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value
  if (!zone) throw new Error("Local timezone offset is unavailable")
  return `${wall}${zone === "GMT" ? "+00:00" : zone.replace("GMT", "")}`
}

function sources(row: SummaryRow): string {
  const citations = CitationsSchema.parse(JSON.parse(row.citations))
  const sourceIds = StringsSchema.parse(JSON.parse(row.source_ids))
  const parts = citations.map(({ ref }) => ref)
  const included = new Set(citations.map(({ ref }) => ref))
  for (const ref of sourceIds) if (!included.has(ref)) parts.push(ref)
  return parts.join(" | ")
}

function renderPage(day: string, now: number, summaries: readonly SummaryRow[]): string {
  const windows = summaries.filter((row) => row.kind === "10min")
  const rollups = summaries.filter((row) => row.kind === "6h")
  const parts = [
    "---",
    `render: '${CA_PAGE_RENDER_VERSION}'`,
    `updated_at: ${localIso(now)}`,
    "---",
    `# Context awareness — ${day}`,
    "",
    "_Captured by Side from on-device activity. Summaries only; raw captures expire after 14 days._",
  ]
  if (rollups.length > 0) {
    parts.push("", "## Day overview")
    for (const row of rollups) {
      const description = StringsSchema.parse(JSON.parse(row.description))
      parts.push(`- ${row.title} — ${description[0] ?? ""}  s:${row.id}`)
    }
  }
  for (const row of windows) {
    parts.push(
      "",
      `### ${timeLabel(row.window_from)} – ${timeLabel(row.window_to)} — ${row.title}  s:${row.id}`,
      row.body ?? "",
      "",
      `Sources: ${sources(row)}`,
    )
  }
  return `${parts.join("\n")}\n`
}

export type RenderOptions = { readonly beforeCommit?: () => void | Promise<void> }

export async function renderContextAwarenessDayPage(
  db: Database,
  dataDir: string,
  day: string,
  now: number,
  options: RenderOptions = {},
): Promise<FenceResult<{ readonly summaries: number }>> {
  const { from, to } = localDayRange(day)
  const folder = join(dataDir, "memory", "episodic")
  const filename = join(folder, `context-awareness-${day}.md`)
  return withFence(db, async (commit) => {
    const rows = db
      .query<SummaryRow, [number, number]>(`
        SELECT id, kind, window_from, window_to, updated_at, title, description, body,
               citations, source_ids
        FROM context_awareness_summaries
        WHERE status = 'done' AND kind IN ('10min', '6h')
          AND window_from >= ? AND window_from < ?
        ORDER BY window_from, kind, id
      `)
      .all(from, to)
    const hasWindows = rows.some((row) => row.kind === "10min")
    let temporary: string | null = null
    if (hasWindows) {
      await mkdir(folder, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
      await chmod(folder, PRIVATE_DIRECTORY_MODE)
      temporary = join(folder, `.context-awareness-${randomUUID()}.tmp`)
      await writeFile(temporary, renderPage(day, now, rows), {
        mode: PRIVATE_FILE_MODE,
        flag: "wx",
      })
    }
    try {
      await options.beforeCommit?.()
      return commit(() => {
        for (const row of rows) {
          db.query(`
            UPDATE context_awareness_summaries SET digested_at = ?
            WHERE id = ? AND status = 'done' AND updated_at = ?
          `).run(now, row.id, row.updated_at)
        }
        db.query("DELETE FROM side_meta WHERE key = ?").run(`dirty_day:${day}`)
        // The file move is synchronous inside the deletion-epoch write fence.
        if (temporary) renameSync(temporary, filename)
        else rmSync(filename, { force: true })
        return { summaries: rows.length }
      })
    } finally {
      if (temporary) await rm(temporary, { force: true })
    }
  })
}
