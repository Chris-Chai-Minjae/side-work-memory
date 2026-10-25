import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ulid } from "ulid"
import { clearLedger } from "../../src/ledger/delete"
import { openLedger } from "../../src/ledger/schema"
import { digestContextAwareness } from "../../src/memory/digest"
import { renderContextAwarenessDayPage } from "../../src/memory/render"

const day = "2026-09-24"
const from = new Date(2026, 8, 24, 9, 10).getTime()
const to = new Date(2026, 8, 24, 9, 20).getTime()
const now = new Date(2026, 8, 24, 9, 30).getTime()

function insertSummary(
  db: ReturnType<typeof openLedger>,
  kind: "10min" | "6h",
  windowFrom: number,
  windowTo: number,
  id = ulid(windowFrom),
): string {
  const eventRef = `e:${ulid(from + 1)}`
  db.query(`
    INSERT INTO context_awareness_summaries
      (id, kind, window_from, window_to, created_at, updated_at, title,
       description, body, citations, source_ids, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done')
  `).run(
    id,
    kind,
    windowFrom,
    windowTo,
    windowFrom,
    windowFrom,
    kind === "6h" ? "Morning work" : "Read SQLite docs",
    JSON.stringify([kind === "6h" ? "Reviewed two articles." : "Reviewed extension loading."]),
    "Looked at the SQLite extension guide.",
    JSON.stringify([{ ref: eventRef, title: "Guide", url: "https://fixture.invalid/guide" }]),
    JSON.stringify([eventRef]),
  )
  return id
}

test("Given done window and rollup summaries, when rendered, then the v3 page has overview, cited section and digest timestamps", async () => {
  const root = mkdtempSync(join(tmpdir(), "side-render-v3-"))
  const db = openLedger(join(root, "ledger.db"))
  try {
    const windowId = insertSummary(db, "10min", from, to)
    const rollupId = insertSummary(
      db,
      "6h",
      new Date(2026, 8, 24, 6).getTime(),
      new Date(2026, 8, 24, 12).getTime(),
    )
    const result = await renderContextAwarenessDayPage(db, root, day, now)
    expect(result).toEqual({ status: "committed", value: { summaries: 2 } })
    const page = readFileSync(
      join(root, "memory", "episodic", `context-awareness-${day}.md`),
      "utf8",
    )
    expect(page).toContain("render: '3'")
    expect(page).toContain(`# Context awareness — ${day}`)
    expect(page).toContain("## Day overview")
    expect(page).toContain(`Morning work — Reviewed two articles.  s:${rollupId}`)
    expect(page).toContain(`### 09:10 – 09:20 — Read SQLite docs  s:${windowId}`)
    expect(page).toMatch(/Sources: e:[0-9A-HJKMNP-TV-Z]{26}/u)
    expect(page).not.toContain("[Guide]")
    expect(page).not.toContain("https://fixture.invalid/guide")
    expect(
      page
        .replace(/^updated_at: .+$/m, "updated_at: <local timestamp>")
        .replace(/[es]:[0-9A-HJKMNP-TV-Z]{26}/g, (ref) => `${ref[0]}:<id>`),
    ).toMatchSnapshot()
    expect(
      db
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) AS count FROM context_awareness_summaries WHERE digested_at = ?",
        )
        .get(now)?.count,
    ).toBe(2)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("Given a stale day, when digested twice, then only the first pass renders it; no summaries deletes its page", async () => {
  const root = mkdtempSync(join(tmpdir(), "side-digest-stale-"))
  const db = openLedger(join(root, "ledger.db"))
  try {
    insertSummary(db, "10min", from, to)
    expect(await digestContextAwareness(db, root, now)).toEqual({
      days: 1,
      summaries: 1,
      failed: 0,
    })
    expect(await digestContextAwareness(db, root, now + 1)).toEqual({
      days: 0,
      summaries: 0,
      failed: 0,
    })
    db.query("DELETE FROM context_awareness_summaries").run()
    db.query("INSERT INTO side_meta (key, value) VALUES (?, '1')").run(`dirty_day:${day}`)
    expect(await digestContextAwareness(db, root, now + 2)).toEqual({
      days: 1,
      summaries: 0,
      failed: 0,
    })
    expect(existsSync(join(root, "memory", "episodic", `context-awareness-${day}.md`))).toBe(false)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("Given clear(lastHour) during rendering, when the fenced write reaches commit, then deleted sections never return in 100 repeats", async () => {
  for (let iteration = 0; iteration < 100; iteration++) {
    const root = mkdtempSync(join(tmpdir(), "side-render-fence-"))
    const db = openLedger(join(root, "ledger.db"))
    try {
      const id = insertSummary(db, "10min", from, to)
      const result = await renderContextAwarenessDayPage(db, root, day, now, {
        beforeCommit: async () => {
          await clearLedger(db, "lastHour", {
            now,
            onDirtyDay: async (dirtyDay) => {
              await renderContextAwarenessDayPage(db, root, dirtyDay, now)
            },
          })
        },
      })
      expect(result.status).toBe("discarded")
      const file = join(root, "memory", "episodic", `context-awareness-${day}.md`)
      expect(existsSync(file) ? readFileSync(file, "utf8").includes(`s:${id}`) : false).toBe(false)
    } finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
})
