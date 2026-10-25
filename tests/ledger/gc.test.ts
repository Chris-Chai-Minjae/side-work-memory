import type { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { markNonGlanceEvent } from "../../src/comprehension/queue"
import {
  FOOTPRINT_TTL_MS,
  FRAME_COLD_AGE_MS,
  MS_PER_DAY,
  RETENTION_DAYS_MIN,
  VACUUM_SLACK_MIN_BYTES,
} from "../../src/constants"
import { readBlobContent, sealColdBlobs } from "../../src/ledger/frames"
import { runLedgerGc } from "../../src/ledger/gc"
import { openLedger } from "../../src/ledger/schema"
import { LedgerStats } from "../../src/ledger/stats"
import { writeLedgerEvent } from "../../src/ledger/write"

const masterKey = Buffer.alloc(32, 0x42)
const now = new Date("2026-09-24T12:00:00+09:00").getTime()

function withLedger(run: (db: Database, directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "side-ledger-gc-"))
  const db = openLedger(join(directory, "ledger.db"))
  try {
    run(db, directory)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

function count(db: Database, table: string): number {
  const row = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()
  if (!row) throw new Error("Synthetic count query returned no row")
  return row.count
}

describe("ledger GC", () => {
  test("Given expired qualified evidence, when retention GC runs, then summary markers for deleted events disappear", () => {
    withLedger((db) => {
      // Given one old and one current event with durable qualification marks.
      const oldTime = now - 2 * MS_PER_DAY
      const old = writeLedgerEvent(db, masterKey, {
        occurredAt: oldTime,
        source: "mac_ax",
        kind: "content.snapshot",
      })
      const current = writeLedgerEvent(db, masterKey, {
        occurredAt: now,
        source: "mac_ax",
        kind: "content.snapshot",
      })
      markNonGlanceEvent(db, old.id, oldTime)
      markNonGlanceEvent(db, current.id, now)

      // When the one-day retention pass deletes the old event.
      runLedgerGc(db, masterKey, { now, retentionDays: RETENTION_DAYS_MIN })

      // Then only the surviving event retains a qualification marker.
      expect(
        db
          .query<{ key: string }, []>(`
        SELECT key FROM side_meta WHERE key LIKE 'summary_non_glance_event:%' ORDER BY key
      `)
          .all(),
      ).toEqual([{ key: `summary_non_glance_event:${current.id}` }])
    })
  })

  test("Given one-day retention with old and current evidence, when GC runs, then only old evidence and its empty frame disappear while summaries remain", () => {
    withLedger((db) => {
      const oldTime = now - 2 * MS_PER_DAY
      const old = writeLedgerEvent(db, masterKey, {
        occurredAt: oldTime,
        source: "mac_ax",
        kind: "content.snapshot",
        content: "Synthetic expired nebula",
      })
      const current = writeLedgerEvent(db, masterKey, {
        occurredAt: now,
        source: "mac_ax",
        kind: "content.snapshot",
        content: "Synthetic current nebula",
      })
      if (!old.blobId) throw new Error("Synthetic old event has no blob")
      if (!current.blobId) throw new Error("Synthetic current event has no blob")
      db.query(
        "INSERT INTO context_awareness_frames (id, content, member_count, stored_bytes, created_at) VALUES (?, ?, 1, 1, ?)",
      ).run("synthetic-old-frame", Buffer.from([1]), oldTime)
      db.query(
        "UPDATE context_awareness_blobs SET frame_id = ?, frame_index = 0, content = x'' WHERE id = ?",
      ).run("synthetic-old-frame", old.blobId)
      db.query(
        "INSERT INTO context_awareness_summaries (id, kind, window_from, window_to, created_at, updated_at) VALUES (?, '10min', ?, ?, ?, ?)",
      ).run("synthetic-summary", oldTime, oldTime + 1, oldTime, oldTime)

      const result = runLedgerGc(db, masterKey, { now, retentionDays: RETENTION_DAYS_MIN })

      expect(result).toMatchObject({ deletedEvents: 1, deletedBlobs: 1, deletedFrames: 1 })
      expect(db.query<{ id: string }, []>("SELECT id FROM context_awareness_events").all()).toEqual(
        [{ id: current.id }],
      )
      expect(db.query<{ id: string }, []>("SELECT id FROM context_awareness_blobs").all()).toEqual([
        { id: current.blobId },
      ])
      expect(count(db, "context_awareness_frames")).toBe(0)
      expect(count(db, "context_awareness_summaries")).toBe(1)
      expect(count(db, "side_terms")).toBeGreaterThan(0)
    })
  })

  test("Given an old event sharing a blob with a current event, when GC runs, then the shared blob stays", () => {
    withLedger((db) => {
      const old = writeLedgerEvent(db, masterKey, {
        occurredAt: now - 2 * MS_PER_DAY,
        source: "mac_ax",
        kind: "content.snapshot",
        content: "Synthetic shared comet",
      })
      const current = writeLedgerEvent(db, masterKey, {
        occurredAt: now,
        source: "mac_ax",
        kind: "content.snapshot",
        content: "Synthetic shared comet",
      })

      runLedgerGc(db, masterKey, { now, retentionDays: RETENTION_DAYS_MIN })

      expect(old.blobId).toBe(current.blobId)
      expect(count(db, "context_awareness_events")).toBe(1)
      expect(count(db, "context_awareness_blobs")).toBe(1)
    })
  })

  test("Given an event exactly at the retention cutoff, when GC runs, then the event stays", () => {
    withLedger((db) => {
      writeLedgerEvent(db, masterKey, {
        occurredAt: now - MS_PER_DAY,
        source: "mac_ax",
        kind: "content.snapshot",
        content: "Synthetic boundary content",
      })

      runLedgerGc(db, masterKey, { now, retentionDays: RETENTION_DAYS_MIN })

      expect(count(db, "context_awareness_events")).toBe(1)
    })
  })

  test("Given a frame with half its blobs expired, when GC runs, then it repacks the survivors without changing their content", () => {
    withLedger((db) => {
      const contents = [
        "Synthetic expired red star",
        "Synthetic expired gold star",
        "Synthetic live blue star",
        "Synthetic live green star",
      ] as const
      const written = contents.map((content, index) =>
        writeLedgerEvent(db, masterKey, {
          occurredAt: index < 2 ? now - 2 * MS_PER_DAY : now,
          source: "mac_ax",
          kind: "content.snapshot",
          content,
        }),
      )
      expect(sealColdBlobs(db, masterKey, now + FRAME_COLD_AGE_MS + 1)).toBe(4)
      const before = db
        .query<{ member_count: number }, []>("SELECT member_count FROM context_awareness_frames")
        .get()
      expect(before?.member_count).toBe(4)

      const result = runLedgerGc(db, masterKey, { now, retentionDays: RETENTION_DAYS_MIN })

      const after = db
        .query<{ member_count: number }, []>("SELECT member_count FROM context_awareness_frames")
        .get()
      expect(result.compactedFrames).toBe(1)
      expect(after?.member_count).toBe(2)
      for (const [index, expected] of contents.entries()) {
        const blobId = written[index]?.blobId
        if (!blobId) throw new Error("Synthetic framed event has no blob")
        expect(readBlobContent(db, masterKey, blobId)).toBe(index < 2 ? null : expected)
      }
    })
  })

  test("Given a frame with even one expired blob, when GC runs, then it scrubs that member and preserves its neighbors", () => {
    withLedger((db) => {
      const written = [
        "Synthetic expired violet moon",
        "Synthetic live amber moon",
        "Synthetic live teal moon",
      ].map((content, index) =>
        writeLedgerEvent(db, masterKey, {
          occurredAt: index === 0 ? now - 2 * MS_PER_DAY : now,
          source: "mac_ax",
          kind: "content.snapshot",
          content,
        }),
      )
      expect(sealColdBlobs(db, masterKey, now + FRAME_COLD_AGE_MS + 1)).toBe(3)

      const result = runLedgerGc(db, masterKey, { now, retentionDays: RETENTION_DAYS_MIN })

      expect(result.compactedFrames).toBe(1)
      expect(
        db
          .query<{ member_count: number }, []>("SELECT member_count FROM context_awareness_frames")
          .get()?.member_count,
      ).toBe(2)
      for (const [index, event] of written.entries()) {
        if (!event.blobId) throw new Error("Synthetic framed event has no blob")
        expect(readBlobContent(db, masterKey, event.blobId)).toBe(
          index === 0
            ? null
            : index === 1
              ? "Synthetic live amber moon"
              : "Synthetic live teal moon",
        )
      }
    })
  })

  test("Given content exactly at and then over 64MiB, when GC runs, then only the oldest excess content expires", () => {
    withLedger((db) => {
      const insert = (id: string, occurredAt: number, bytes: number) => {
        db.query(`
          INSERT INTO context_awareness_blobs
            (id, content_hash, content, redacted_bytes, created_at, last_seen_at)
          VALUES (?, ?, x'', ?, ?, ?)
        `).run(id, `hash-${id}`, bytes, occurredAt, occurredAt)
        db.query(`
          INSERT INTO context_awareness_events (id, occurred_at, source, kind, payload, blob_id)
          VALUES (?, ?, 'mac_ax', 'content.snapshot', '{}', ?)
        `).run(`event-${id}`, occurredAt, id)
      }
      insert("oldest", now - 2, 33_554_432)
      insert("newest", now - 1, 33_554_432)

      expect(runLedgerGc(db, masterKey, { now, retentionDays: RETENTION_DAYS_MIN })).toMatchObject({
        deletedEvents: 0,
        deletedBlobs: 0,
      })
      insert("overflow", now, 1)
      expect(runLedgerGc(db, masterKey, { now, retentionDays: RETENTION_DAYS_MIN })).toMatchObject({
        deletedEvents: 1,
        deletedBlobs: 1,
      })
      expect(
        db.query<{ id: string }, []>("SELECT id FROM context_awareness_blobs ORDER BY id").all(),
      ).toEqual([{ id: "newest" }, { id: "overflow" }])
    })
  })

  test("Given over-budget content shared by old and current events, when GC runs, then all references expire together", () => {
    withLedger((db) => {
      db.query(`
        INSERT INTO context_awareness_blobs
          (id, content_hash, content, redacted_bytes, created_at, last_seen_at)
        VALUES ('shared', 'hash-shared', x'', 67_108_865, ?, ?)
      `).run(now - 2, now)
      for (const [id, occurredAt] of [
        ["old", now - 2],
        ["current", now],
      ] as const) {
        db.query(`
          INSERT INTO context_awareness_events (id, occurred_at, source, kind, payload, blob_id)
          VALUES (?, ?, 'mac_ax', 'content.snapshot', '{}', 'shared')
        `).run(id, occurredAt)
      }

      expect(runLedgerGc(db, masterKey, { now, retentionDays: RETENTION_DAYS_MIN })).toMatchObject({
        deletedEvents: 2,
        deletedBlobs: 1,
      })
      expect(count(db, "context_awareness_events")).toBe(0)
      expect(count(db, "context_awareness_blobs")).toBe(0)
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
    })
  })

  test("Given at least sixteen megabytes of free pages, when GC runs, then full VACUUM reclaims them and truncates WAL", () => {
    withLedger((db, directory) => {
      // In this synthetic fixture incremental vacuum cannot reclaim pages, so the full threshold is exercised.
      db.exec("PRAGMA auto_vacuum=NONE; VACUUM")
      const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size
      if (!pageSize) throw new Error("Synthetic page size is unavailable")
      db.query(
        "INSERT INTO context_awareness_frames (id, content, member_count, stored_bytes, created_at) VALUES (?, ?, 1, ?, ?)",
      ).run(
        "synthetic-unused-frame",
        Buffer.alloc(VACUUM_SLACK_MIN_BYTES + pageSize),
        VACUUM_SLACK_MIN_BYTES + pageSize,
        now,
      )
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)")

      const result = runLedgerGc(db, masterKey, { now, retentionDays: RETENTION_DAYS_MIN })

      const freePages = db
        .query<{ freelist_count: number }, []>("PRAGMA freelist_count")
        .get()?.freelist_count
      expect(result.deletedFrames).toBe(1)
      expect(freePages).toBe(0)
      expect(statSync(join(directory, "ledger.db-wal"), { throwIfNoEntry: false })?.size ?? 0).toBe(
        0,
      )
    })
  })

  test("Given a reader holding the WAL, when GC checkpoints, then it reports an incomplete truncation", () => {
    withLedger((db, directory) => {
      writeLedgerEvent(db, masterKey, {
        occurredAt: now - 2 * MS_PER_DAY,
        source: "mac_ax",
        kind: "content.snapshot",
        content: "Synthetic checkpoint witness",
      })
      const reader = openLedger(join(directory, "ledger.db"))
      try {
        reader.exec("BEGIN")
        reader.query("SELECT COUNT(*) FROM context_awareness_events").get()
        db.exec("PRAGMA busy_timeout=0")

        expect(() =>
          runLedgerGc(db, masterKey, { now, retentionDays: RETENTION_DAYS_MIN }),
        ).toThrow("WAL checkpoint")
      } finally {
        reader.close()
      }
    })
  })
})

describe("ledger stats", () => {
  test("Given current events, when read, then stats describe live evidence and today's counters", () => {
    withLedger((db, directory) => {
      const bodyA = "Synthetic silver comet"
      const bodyB = "Synthetic blue comet"
      writeLedgerEvent(db, masterKey, {
        occurredAt: now - 1,
        source: "mac_ax",
        kind: "content.snapshot",
        content: bodyA,
        sessionId: "synthetic-session",
      })
      writeLedgerEvent(db, masterKey, {
        occurredAt: now,
        source: "mac_ax",
        kind: "content.snapshot",
        content: bodyB,
        sessionId: "synthetic-session",
      })
      const stats = new LedgerStats(db, directory).snapshot(now)

      expect(stats).toMatchObject({
        events: 2,
        blobs: 2,
        rawBytes: Buffer.byteLength(bodyA) + Buffer.byteLength(bodyB),
        frames: 0,
        sessions: 1,
        lastEventAt: now,
        suppressions: 0,
        today: {
          events: 2,
          blobs: 2,
          rawBytes: Buffer.byteLength(bodyA) + Buffer.byteLength(bodyB),
          suppressions: 0,
          masks: 0,
          sessions: 1,
          lastEventAt: now,
        },
      })
      expect(stats.storeBytes).toBeGreaterThan(0)
    })
  })

  test("Given a mask and an hourly suppression bucket, when stats are read, then the daily aggregate counts both once", () => {
    withLedger((db, directory) => {
      writeLedgerEvent(db, masterKey, {
        occurredAt: now,
        source: "mac_ax",
        kind: "content.snapshot",
        content: "password: hunter2",
      })
      const day = db
        .query<{ day: string; suppressions: number; masks: number }, []>(
          "SELECT day, suppressions, masks FROM side_day_counters",
        )
        .get()
      if (!day) throw new Error("Synthetic day counter is unavailable")
      expect(day.masks).toBeGreaterThan(0)
      db.query("UPDATE side_day_counters SET suppressions = suppressions + 3 WHERE day = ?").run(
        day.day,
      )
      db.query(
        "INSERT INTO side_suppressions (bucket_start, scope, key_hash, count) VALUES (?, 'app', 'synthetic-hash', 3)",
      ).run(now)

      const stats = new LedgerStats(db, directory).snapshot(now)

      expect(stats.suppressions).toBe(day.suppressions + 3)
      expect(stats.today.suppressions).toBe(day.suppressions + 3)
      expect(stats.today.masks).toBe(day.masks)
    })
  })

  test("Given day pages and an index, when footprint is read within five minutes, then cached bytes stay fixed until expiry", () => {
    withLedger((db, directory) => {
      const pages = join(directory, "memory", "episodic")
      mkdirSync(pages, { recursive: true })
      writeFileSync(join(pages, "context-awareness-2026-09-24.md"), "synthetic-page")
      writeFileSync(join(pages, "unrelated.md"), "ignored")
      writeFileSync(join(directory, "index.db"), "index-a")
      const stats = new LedgerStats(db, directory)
      const pageCount = db.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count
      const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size
      if (pageCount === undefined || pageSize === undefined)
        throw new Error("Synthetic PRAGMA query returned no row")

      const first = stats.footprint(now)
      writeFileSync(join(directory, "index.db"), "index-a-expanded")

      expect(first).toBe(pageCount * pageSize + Buffer.byteLength("synthetic-pageindex-a"))
      expect(stats.footprint(now + FOOTPRINT_TTL_MS - 1)).toBe(first)
      expect(stats.footprint(now + FOOTPRINT_TTL_MS)).toBe(
        pageCount * pageSize + Buffer.byteLength("synthetic-pageindex-a-expanded"),
      )
    })
  })
})
