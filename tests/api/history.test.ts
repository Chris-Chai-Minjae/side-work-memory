import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ulid } from "ulid"
import { createHistoryHandlers } from "../../src/api/resources/history"
import { markNonGlanceEvent } from "../../src/comprehension/queue"
import { openLedger } from "../../src/ledger/schema"
import { LedgerStats } from "../../src/ledger/stats"

const now = new Date(2026, 8, 24, 12).getTime()
const today = "2026-09-24"

async function withHistory(
  run: (fixture: {
    db: ReturnType<typeof openLedger>
    directory: string
    handlers: ReturnType<typeof createHistoryHandlers>
    rotations: string[]
    retries: string[]
  }) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "side-api-history-"))
  const db = openLedger(join(directory, "ledger.db"))
  const rotations: string[] = []
  const retries: string[] = []
  const handlers = createHistoryHandlers({
    db,
    directory,
    stats: new LedgerStats(db, directory),
    now: () => now,
    getMasterKey: () => Buffer.alloc(32, 7),
    rotateKey: () => {
      rotations.push("rotated")
    },
    getRetentionDays: () => 14,
    onSummariesRetried: () => {
      retries.push("scheduled")
    },
  })
  try {
    await run({ db, directory, handlers, rotations, retries })
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

test("Given failed summaries with retained source today, retry only requeues today's eligible work", async () => {
  await withHistory(async ({ db, handlers, retries }) => {
    const eligibleAt = new Date(2026, 8, 24, 9).getTime()
    const oldAt = new Date(2026, 8, 23, 9).getTime()
    const eligible = addSummary(db, { at: eligibleAt, status: "failed" })
    const missingSource = addSummary(db, { at: eligibleAt + 600_000, status: "failed" })
    const old = addSummary(db, { at: oldAt, status: "failed" })
    for (const [id, at] of [
      [eligible, eligibleAt],
      [old, oldAt],
    ] as const) {
      const eventId = `synthetic-${id}`
      db.query(
        "INSERT INTO context_awareness_events (id, occurred_at, source, kind, payload) VALUES (?, ?, 'test', 'content.snapshot', '{}')",
      ).run(eventId, at + 1)
      markNonGlanceEvent(db, eventId, at + 1)
    }

    expect(await handlers["summaries.retryFailedToday"](undefined)).toEqual({ requeued: 1 })
    const state = db.query<{ status: string; attempt_count: number }, [string]>(
      "SELECT status, attempt_count FROM context_awareness_summaries WHERE id = ?",
    )
    expect(state.get(eligible)).toEqual({ status: "pending", attempt_count: 0 })
    expect(state.get(missingSource)?.status).toBe("failed")
    expect(state.get(old)?.status).toBe("failed")
    expect(retries).toEqual(["scheduled"])
  })
})

function addSummary(
  db: ReturnType<typeof openLedger>,
  options: { at: number; status?: string; kind?: string; title?: string },
): string {
  const id = ulid(options.at)
  db.query(`
    INSERT INTO context_awareness_summaries
      (id, kind, window_from, window_to, created_at, updated_at,
       title, description, citations, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    options.kind ?? "10min",
    options.at,
    options.at + 600_000,
    options.at,
    options.at,
    options.title ?? "Synthetic research",
    JSON.stringify(["Investigated synthetic SQLite notes"]),
    JSON.stringify([{ ref: `s:${id}`, title: "Synthetic source" }]),
    options.status ?? "done",
  )
  return id
}

test("Given summaries on two local days, historyStatus lists days, states, and storage", async () => {
  await withHistory(async ({ db, handlers }) => {
    addSummary(db, { at: new Date(2026, 8, 23, 9).getTime() })
    addSummary(db, { at: new Date(2026, 8, 24, 9).getTime() })
    addSummary(db, { at: new Date(2026, 8, 24, 10).getTime(), status: "pending" })
    const status = await handlers.historyStatus(undefined)
    expect(status.days_with_summaries).toEqual(["2026-09-23", today])
    expect(status.today_summary_states).toEqual({
      pending: 1,
      running: 0,
      done: 1,
      failed: 0,
      skipped: 0,
    })
    expect(status.store_bytes).toBeGreaterThan(0)
    expect(status.average_bytes_per_day).toBeGreaterThan(0)
  })
})

test("Given a summary overlapping the requested window, historyList returns display fields", async () => {
  await withHistory(async ({ db, handlers }) => {
    const at = new Date(2026, 8, 24, 9).getTime()
    const id = addSummary(db, { at, title: "Synthetic planning" })
    addSummary(db, { at: new Date(2026, 8, 23, 9).getTime() })
    const summaries = await handlers.historyList({ from: at + 300_000, to: at + 900_000 })
    expect(summaries).toEqual([
      {
        id,
        kind: "10min",
        window_from: at,
        window_to: at + 600_000,
        title: "Synthetic planning",
        description: "Investigated synthetic SQLite notes",
        status: "done",
        citations: [{ ref: `s:${id}`, title: "Synthetic source" }],
      },
    ])
  })
})

test("Given an enqueued summary with default empty description, historyList still returns pending and done rows", async () => {
  await withHistory(async ({ db, handlers }) => {
    const at = new Date(2026, 8, 24, 9).getTime()
    addSummary(db, { at, title: "Finished synthetic window" })
    const pendingId = ulid(at + 600_000)
    db.query(`
      INSERT INTO context_awareness_summaries
        (id, kind, window_from, window_to, created_at, updated_at, available_at)
      VALUES (?, '10min', ?, ?, ?, ?, ?)
    `).run(pendingId, at + 600_000, at + 1_200_000, at, at, at)

    const summaries = await handlers.historyList({ from: at, to: at + 1_200_000 })
    expect(summaries).toHaveLength(2)
    expect(summaries[1]).toMatchObject({
      id: pendingId,
      status: "pending",
      description: "",
      citations: [],
    })
  })
})

test("Given a rendered day page, day.get reads it and rejects impossible dates", async () => {
  await withHistory(async ({ directory, handlers }) => {
    const folder = join(directory, "memory", "episodic")
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `context-awareness-${today}.md`), "# Synthetic day\n")
    expect(await handlers["day.get"]({ date: today })).toMatchObject({
      date: today,
      markdown: "# Synthetic day\n",
    })
    expect(await handlers["day.get"]({ date: "2026-09-23" })).toBeNull()
    await expect(handlers["day.get"]({ date: "2026-02-31" })).rejects.toThrow()
  })
})

test("Given today's five summaries, clear today removes the page and returns null", async () => {
  await withHistory(async ({ db, directory, handlers, rotations }) => {
    const at = new Date(2026, 8, 24, 9).getTime()
    for (let offset = 0; offset < 5; offset++) addSummary(db, { at: at + offset * 600_000 })
    const folder = join(directory, "memory", "episodic")
    mkdirSync(folder, { recursive: true })
    const page = join(folder, `context-awareness-${today}.md`)
    writeFileSync(page, "# Stale synthetic page\n")
    const beforeBytes = (await handlers.historyStatus(undefined)).store_bytes
    const result = await handlers.clear({ target: "today" })
    expect(result).toMatchObject({ deleted_events: 0, deleted_summaries: 5, deletion_epoch: 1 })
    expect(existsSync(page)).toBe(false)
    expect(await handlers["day.get"]({ date: today })).toBeNull()
    expect((await handlers.historyStatus(undefined)).store_bytes).toBeLessThan(beforeBytes)
    expect(rotations).toEqual([])
  })
})

test("Given clear all, the injected key rotation runs after deletion", async () => {
  await withHistory(async ({ db, handlers, rotations }) => {
    const at = new Date(2026, 8, 24, 9).getTime()
    addSummary(db, { at })
    const result = await handlers.clear({ target: "all" })
    expect(result.deleted_summaries).toBe(1)
    expect(rotations).toEqual(["rotated"])
    expect(db.query("SELECT id FROM context_awareness_summaries").all()).toEqual([])
  })
})

test("Given a reader holding the ledger WAL, clear reports the checkpoint failure after deletion", async () => {
  await withHistory(async ({ db, directory, handlers }) => {
    addSummary(db, { at: new Date(2026, 8, 24, 9).getTime() })
    const reader = openLedger(join(directory, "ledger.db"))
    try {
      reader.exec("BEGIN")
      reader.query("SELECT COUNT(*) FROM context_awareness_summaries").get()

      await expect(handlers.clear({ target: "all" })).rejects.toThrow("WAL checkpoint")
      expect(db.query("SELECT id FROM context_awareness_summaries").all()).toEqual([])
    } finally {
      reader.close()
    }
  })
})
