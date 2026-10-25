import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { createHistoryHandlers } from "../../src/api/resources/history"
import { EMBEDDING_DIMENSIONS, SYNC_DEBOUNCE_MS } from "../../src/constants"
import { clearLedger } from "../../src/ledger/delete"
import { openLedger } from "../../src/ledger/schema"
import { LedgerStats } from "../../src/ledger/stats"
import { openIndexDb } from "../../src/memory/index-db"
import { createMemoryIndexSyncScheduler, syncMemoryIndex } from "../../src/memory/sync"
import { FakeClock } from "../mocks/fake-clock"

const ManifestSchema = z.record(
  z.string(),
  z.object({ mtimeMs: z.number(), sha256: z.string(), chunkIds: z.array(z.string()) }),
)

function page(root: string, day: string, body: string): string {
  const directory = join(root, "memory", "episodic")
  mkdirSync(directory, { recursive: true })
  const filename = join(directory, `context-awareness-${day}.md`)
  writeFileSync(
    filename,
    `# Context awareness — ${day}\n\n### 09:10 – 09:20 — Example  s:synthetic-${day}\n${body}\n`,
  )
  return filename
}

function vector(): Float32Array {
  const value = new Float32Array(EMBEDDING_DIMENSIONS)
  value[0] = 1
  return value
}

test("Given two day pages, when one changes, then only its chunks are reembedded", async () => {
  const root = mkdtempSync(join(tmpdir(), "side-sync-change-"))
  const ledgerDb = openLedger(join(root, "ledger.db"))
  const indexDb = openIndexDb(join(root, "index.db"))
  const embedded: string[] = []
  const embedder = {
    embed: async (text: string) => {
      embedded.push(text)
      return vector()
    },
  }
  try {
    const first = page(root, "2026-09-23", "First original content")
    const fixedMtime = new Date("2026-09-23T00:00:00.000Z")
    utimesSync(first, fixedMtime, fixedMtime)
    page(root, "2026-09-24", "Second unchanged content")
    const sync = () => syncMemoryIndex({ ledgerDb, indexDb, dataDir: root, embedder })
    expect((await sync()).status).toBe("committed")
    expect(embedded).toHaveLength(2)
    const oldId = indexDb
      .query<{ id: string }, [string]>("SELECT id FROM chunks WHERE day = ?")
      .get("2026-09-23")?.id
    expect(oldId).toBeDefined()

    page(root, "2026-09-23", "First updated content")
    utimesSync(first, fixedMtime, fixedMtime)
    expect(statSync(first).mtimeMs).toBe(fixedMtime.getTime())
    expect((await sync()).status).toBe("committed")
    expect(embedded).toHaveLength(3)
    expect(embedded[2]).toContain("First updated content")
    expect(
      indexDb
        .query<{ id: string }, [string]>("SELECT id FROM chunks WHERE id = ?")
        .get(oldId ?? ""),
    ).toBeNull()
    expect(
      indexDb
        .query<{ text: string }, [string]>("SELECT text FROM chunks WHERE day = ?")
        .get("2026-09-24")?.text,
    ).toContain("Second unchanged content")

    const relative = "episodic/context-awareness-2026-09-23.md"
    const manifest = ManifestSchema.parse(
      JSON.parse(readFileSync(join(root, "memory", "memory-index.json"), "utf8")),
    )
    expect(manifest[relative]?.mtimeMs).toBe(statSync(first).mtimeMs)
    expect(manifest[relative]?.sha256).toBe(
      createHash("sha256").update(readFileSync(first)).digest("hex"),
    )
    expect(manifest[relative]?.chunkIds).toEqual(
      indexDb
        .query<{ id: string }, [string]>("SELECT id FROM chunks WHERE path = ?")
        .all(relative)
        .map(({ id }) => id),
    )

    const sameContent = readFileSync(first)
    utimesSync(first, new Date(0), new Date(Date.now() + 10_000))
    expect((await sync()).status).toBe("committed")
    expect(embedded).toHaveLength(3)
    expect(
      ManifestSchema.parse(
        JSON.parse(readFileSync(join(root, "memory", "memory-index.json"), "utf8")),
      )[relative]?.mtimeMs,
    ).toBe(statSync(first).mtimeMs)
    expect(
      ManifestSchema.parse(
        JSON.parse(readFileSync(join(root, "memory", "memory-index.json"), "utf8")),
      )[relative]?.sha256,
    ).toBe(createHash("sha256").update(sameContent).digest("hex"))
  } finally {
    indexDb.close()
    ledgerDb.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("Given an indexed page, when its file is deleted, then its chunks, FTS, vectors, and manifest entry are removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "side-sync-delete-"))
  const ledgerDb = openLedger(join(root, "ledger.db"))
  const indexDb = openIndexDb(join(root, "index.db"))
  let calls = 0
  const embedder = {
    embed: async () => {
      calls++
      return vector()
    },
  }
  try {
    const removed = page(root, "2026-09-23", "Unique deleted phrase")
    page(root, "2026-09-24", "Surviving page content")
    const sync = () => syncMemoryIndex({ ledgerDb, indexDb, dataDir: root, embedder })
    await sync()
    expect(calls).toBe(2)
    rmSync(removed)
    await sync()
    expect(calls).toBe(2)
    expect(
      indexDb
        .query<{ day: string }, []>("SELECT day FROM chunks")
        .all()
        .map(({ day }) => day),
    ).toEqual(["2026-09-24"])
    expect(
      indexDb.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM chunks_fts").get()?.count,
    ).toBe(1)
    expect(
      indexDb.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM chunks_vec").get()?.count,
    ).toBe(1)
    const manifest = ManifestSchema.parse(
      JSON.parse(readFileSync(join(root, "memory", "memory-index.json"), "utf8")),
    )
    expect(manifest["episodic/context-awareness-2026-09-23.md"]).toBeUndefined()
  } finally {
    indexDb.close()
    ledgerDb.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("Given nine chunks, when syncing, then embeddings run in batches of four", async () => {
  const root = mkdtempSync(join(tmpdir(), "side-sync-batch-"))
  const ledgerDb = openLedger(join(root, "ledger.db"))
  const indexDb = openIndexDb(join(root, "index.db"))
  let active = 0
  let maximum = 0
  let calls = 0
  const embedder = {
    embed: async () => {
      calls++
      active++
      maximum = Math.max(maximum, active)
      await Promise.resolve()
      active--
      return vector()
    },
  }
  try {
    const sections = Array.from(
      { length: 9 },
      (_, i) =>
        `### 09:${String(i).padStart(2, "0")} – 09:${String(i + 1).padStart(2, "0")} — Example  s:synthetic-${i}\nContent ${i}`,
    )
    const directory = join(root, "memory", "episodic")
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "context-awareness-2026-09-24.md"), sections.join("\n\n"))
    await syncMemoryIndex({ ledgerDb, indexDb, dataDir: root, embedder })
    expect(calls).toBe(9)
    expect(maximum).toBe(4)
  } finally {
    indexDb.close()
    ledgerDb.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("Given clear after embedding, when committing, then stale index and manifest writes are discarded", async () => {
  const root = mkdtempSync(join(tmpdir(), "side-sync-fence-"))
  const ledgerDb = openLedger(join(root, "ledger.db"))
  const indexDb = openIndexDb(join(root, "index.db"))
  try {
    const filename = page(root, "2026-09-24", "Content cleared before index commit")
    const result = await syncMemoryIndex({
      ledgerDb,
      indexDb,
      dataDir: root,
      embedder: { embed: async () => vector() },
      beforeCommit: async () => {
        await clearLedger(ledgerDb, "all", { rotateKey: async () => {} })
        rmSync(filename)
      },
    })
    expect(result.status).toBe("discarded")
    expect(
      indexDb.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM chunks").get()?.count,
    ).toBe(0)
    expect(() => readFileSync(join(root, "memory", "memory-index.json"))).toThrow()
  } finally {
    indexDb.close()
    ledgerDb.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("Given a reader holding the index WAL, deleted-page sync reports the checkpoint failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "side-sync-checkpoint-busy-"))
  const ledgerDb = openLedger(join(root, "ledger.db"))
  const indexDb = openIndexDb(join(root, "index.db"))
  const reader = openIndexDb(join(root, "index.db"))
  try {
    const removed = page(root, "2026-09-23", "Synthetic checkpoint content")
    await syncMemoryIndex({
      ledgerDb,
      indexDb,
      dataDir: root,
      embedder: { embed: async () => vector() },
    })
    reader.exec("BEGIN")
    reader.query("SELECT COUNT(*) FROM chunks").get()
    rmSync(removed)

    await expect(
      syncMemoryIndex({
        ledgerDb,
        indexDb,
        dataDir: root,
        embedder: { embed: async () => vector() },
      }),
    ).rejects.toThrow("WAL checkpoint")
    expect(indexDb.query("SELECT id FROM chunks").all()).toEqual([])
  } finally {
    reader.close()
    indexDb.close()
    ledgerDb.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("Given plaintext summary and index canaries, clear leaves none in the ledger, WAL, or index", async () => {
  const root = mkdtempSync(join(tmpdir(), "side-clear-canary-"))
  const ledgerDb = openLedger(join(root, "ledger.db"))
  const indexDb = openIndexDb(join(root, "index.db"))
  const canary = "synthetic-clear-canary-8f42c71a"
  const now = new Date(2026, 8, 24, 12).getTime()
  const sync = () =>
    syncMemoryIndex({
      ledgerDb,
      indexDb,
      dataDir: root,
      embedder: { embed: async () => vector() },
    })
  try {
    page(root, "2026-09-24", canary)
    ledgerDb
      .query(`
      INSERT INTO context_awareness_summaries
        (id, kind, window_from, window_to, created_at, updated_at, title, description, body, status)
      VALUES ('canary-summary', '10min', ?, ?, ?, ?, ?, ?, ?, 'done')
    `)
      .run(now - 600_000, now, now, now, canary, canary, canary)
    await sync()
    expect(
      indexDb
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM chunks WHERE instr(text, ?) > 0",
        )
        .get(canary)?.count,
    ).toBe(1)
    const handlers = createHistoryHandlers({
      db: ledgerDb,
      directory: root,
      stats: new LedgerStats(ledgerDb, root),
      now: () => now,
      getMasterKey: () => Buffer.alloc(32, 7),
      rotateKey: () => {},
      afterClear: async () => {
        await sync()
      },
      getRetentionDays: () => 14,
      onSummariesRetried: () => {},
    })

    await handlers.clear({ target: "all" })

    const dayPage = join(root, "memory", "episodic", "context-awareness-2026-09-24.md")
    if (statSync(dayPage, { throwIfNoEntry: false })) {
      expect(readFileSync(dayPage).includes(Buffer.from(canary))).toBe(false)
    }
    for (const path of [join(root, "ledger.db"), join(root, "index.db")]) {
      expect(readFileSync(path).includes(Buffer.from(canary))).toBe(false)
      const wal = `${path}-wal`
      if (statSync(wal, { throwIfNoEntry: false })) {
        expect(readFileSync(wal).includes(Buffer.from(canary))).toBe(false)
      }
    }
  } finally {
    indexDb.close()
    ledgerDb.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("Given repeated digest triggers, when 750ms passes after the last trigger, then sync runs once", async () => {
  const clock = new FakeClock()
  let calls = 0
  const scheduler = createMemoryIndexSyncScheduler(
    async () => {
      calls++
    },
    {
      schedule(callback, delayMs) {
        const id = clock.setTimeout(callback, delayMs)
        return () => clock.clearTimeout(id)
      },
    },
  )
  const first = scheduler.schedule()
  clock.advanceBy(SYNC_DEBOUNCE_MS - 1)
  const second = scheduler.schedule()
  clock.advanceBy(SYNC_DEBOUNCE_MS - 1)
  expect(calls).toBe(0)
  clock.advanceBy(1)
  await Promise.all([first, second])
  expect(calls).toBe(1)
})
