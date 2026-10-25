import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { markNonGlanceEvent } from "../../src/comprehension/queue"
import { MS_PER_DAY, TEN_MINUTES_MS } from "../../src/constants"
import { clearLedger } from "../../src/ledger/delete"
import { FenceAsyncCommitError, withFence } from "../../src/ledger/fence"
import { compactFrame, readBlobContent, sealColdBlobs } from "../../src/ledger/frames"
import { openLedger } from "../../src/ledger/schema"
import { writeLedgerEvent } from "../../src/ledger/write"

const now = new Date(2026, 8, 24, 12).getTime()
const yesterday = now - MS_PER_DAY

function withLedger(
  run: (db: ReturnType<typeof openLedger>, path: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "side-ledger-delete-"))
  const path = join(directory, "ledger.db")
  const db = openLedger(path)
  return run(db, path).finally(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
}

function insertEvent(db: ReturnType<typeof openLedger>, id: string, occurredAt: number): void {
  db.query(
    "INSERT INTO context_awareness_events (id, occurred_at, source, kind, payload) VALUES (?, ?, 'mac_ax', 'content.snapshot', '{}')",
  ).run(id, occurredAt)
  db.query("INSERT INTO side_terms (term_hash, event_id) VALUES (?, ?)").run(`term-${id}`, id)
}

function count(db: ReturnType<typeof openLedger>, table: string): number {
  return db.query<{ total: number }, []>(`SELECT count(*) AS total FROM ${table}`).get()?.total ?? 0
}

function insertSummary(
  db: ReturnType<typeof openLedger>,
  id: string,
  from: number,
  to: number,
  kind = "10min",
): void {
  db.query(
    "INSERT INTO context_awareness_summaries (id, kind, window_from, window_to, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, kind, from, to, to, to)
}

function ids(db: ReturnType<typeof openLedger>, table: string): string[] {
  return db
    .query<{ id: string }, []>(`SELECT id FROM ${table} ORDER BY id`)
    .all()
    .map((row) => row.id)
}

describe("ledger clear", () => {
  test("Given a qualified event in the cleared interval, when history is cleared, then its summary marker is removed", async () => {
    await withLedger(async (db) => {
      // Given one recent qualified event and one old qualified event.
      const recent = now - TEN_MINUTES_MS + 1
      insertEvent(db, "recent-qualified", recent)
      markNonGlanceEvent(db, "recent-qualified", recent)
      insertEvent(db, "old-qualified", yesterday)
      markNonGlanceEvent(db, "old-qualified", yesterday)

      // When the recent interval is cleared.
      await clearLedger(db, "last10m", { now })

      // Then no marker identifies the erased event while the old one remains.
      const marks = db
        .query<{ key: string }, []>(`
        SELECT key FROM side_meta WHERE key LIKE 'summary_non_glance_event:%' ORDER BY key
      `)
        .all()
      expect(marks).toEqual([{ key: "summary_non_glance_event:old-qualified" }])
    })
  })

  test.each([
    ["last10m", ["recent"], ["hour", "today", "old"]],
    ["lastHour", ["recent", "hour"], ["today", "old"]],
    ["today", ["recent", "hour", "today"], ["old"]],
    ["all", ["recent", "hour", "today", "old"], []],
  ] as const)(
    "%s deletes only events in its interval and their terms",
    async (target, removed, kept) => {
      await withLedger(async (db) => {
        insertEvent(db, "recent", now - TEN_MINUTES_MS)
        insertEvent(db, "hour", now - TEN_MINUTES_MS - 1)
        insertEvent(db, "today", new Date(2026, 8, 24).getTime())
        insertEvent(db, "old", yesterday)
        const rotated: string[] = []

        const result = await clearLedger(db, target, {
          now,
          rotateKey: () => {
            rotated.push("requested")
          },
        })

        expect(result.deletedEvents).toBe(removed.length)
        expect(ids(db, "context_awareness_events")).toEqual([...kept].sort())
        expect(
          db
            .query<{ event_id: string }, []>("SELECT event_id FROM side_terms ORDER BY event_id")
            .all()
            .map((row) => row.event_id),
        ).toEqual([...kept].sort())
        expect(result.deletionEpoch).toBe(1)
        expect(rotated).toHaveLength(target === "all" ? 1 : 0)
      })
    },
  )

  test("overlapping 10min and 6h summaries are removed and affected days marked dirty", async () => {
    await withLedger(async (db) => {
      insertEvent(db, "recent", now - TEN_MINUTES_MS)
      insertSummary(db, "crosses-start", now - TEN_MINUTES_MS - 1, now - TEN_MINUTES_MS + 1, "6h")
      insertSummary(db, "within", now - TEN_MINUTES_MS, now)
      insertSummary(db, "crosses-end", now - 1, now + 1)
      insertSummary(db, "before", yesterday, now - TEN_MINUTES_MS - 1)
      insertSummary(db, "ends-at-start", yesterday, now - TEN_MINUTES_MS)
      insertSummary(db, "starts-at-end", now, now + 1)
      const dirty: string[] = []

      const result = await clearLedger(db, "last10m", {
        now,
        onDirtyDay: (day) => {
          dirty.push(day)
        },
      })

      expect(result.deletedSummaries).toBe(3)
      expect(ids(db, "context_awareness_summaries")).toEqual([
        "before",
        "ends-at-start",
        "starts-at-end",
      ])
      expect(result.dirtyDays).toEqual(["2026-09-24"])
      expect(dirty).toEqual(["2026-09-24"])
      expect(
        db
          .query<{ value: string }, []>(
            "SELECT value FROM side_meta WHERE key = 'dirty_day:2026-09-24'",
          )
          .get()?.value,
      ).toBe("1")
    })
  })

  test("a clear rolled back by a delete failure does not advance the epoch or remove events", async () => {
    await withLedger(async (db) => {
      insertEvent(db, "recent", now)
      db.exec(
        "CREATE TRIGGER fail_delete BEFORE DELETE ON context_awareness_events BEGIN SELECT RAISE(FAIL, 'synthetic delete failure'); END",
      )

      await expect(clearLedger(db, "today", { now })).rejects.toThrow("synthetic delete failure")
      expect(ids(db, "context_awareness_events")).toEqual(["recent"])
      expect(
        db
          .query<{ value: string }, []>("SELECT value FROM side_meta WHERE key = 'deletion_epoch'")
          .get(),
      ).toBeNull()
    })
  })

  test("shared blobs survive a selective clear while orphan blobs and counters are removed", async () => {
    await withLedger(async (db) => {
      db.query(
        "INSERT INTO context_awareness_blobs (id, content_hash, content, redacted_bytes, created_at, last_seen_at) VALUES ('shared', 'hash-shared', x'00', 8, ?, ?), ('orphan', 'hash-orphan', x'00', 5, ?, ?)",
      ).run(now, now, now, now)
      insertEvent(db, "recent", now)
      insertEvent(db, "kept", yesterday)
      db.query(
        "UPDATE context_awareness_events SET blob_id = 'shared' WHERE id IN ('recent', 'kept')",
      ).run()
      db.query("UPDATE context_awareness_events SET blob_id = 'orphan' WHERE id = 'recent'").run()
      db.query(
        "INSERT INTO context_awareness_events (id, occurred_at, source, kind, payload, blob_id) VALUES ('recent-shared', ?, 'mac_ax', 'content.snapshot', '{}', 'shared')",
      ).run(now)
      db.query(
        "INSERT INTO side_day_counters (day, events, blobs, raw_bytes, suppressions, masks) VALUES ('2026-09-24', 2, 2, 13, 0, 0)",
      ).run()

      await clearLedger(db, "last10m", { now })

      expect(ids(db, "context_awareness_blobs")).toEqual(["shared"])
      expect(count(db, "context_awareness_events")).toBe(1)
      expect(
        db
          .query<{ events: number; blobs: number; raw_bytes: number }, []>(
            "SELECT events, blobs, raw_bytes FROM side_day_counters WHERE day = '2026-09-24'",
          )
          .get(),
      ).toEqual({ events: 0, blobs: 1, raw_bytes: 8 })
    })
  })

  test("all requests key rotation after committing deletion and surfaces helper failure", async () => {
    await withLedger(async (db) => {
      insertEvent(db, "recent", now)
      db.query("INSERT INTO side_day_counters (day, events) VALUES ('2026-09-20', 0)").run()
      const dirty: string[] = []
      await expect(
        clearLedger(db, "all", {
          now,
          rotateKey: () => {
            expect(ids(db, "context_awareness_events")).toEqual([])
            throw new Error("synthetic rotation failure")
          },
          onDirtyDay: (day) => {
            dirty.push(day)
          },
        }),
      ).rejects.toThrow("synthetic rotation failure")
      expect(ids(db, "context_awareness_events")).toEqual([])
      expect(
        db
          .query<{ value: string }, []>("SELECT value FROM side_meta WHERE key = 'deletion_epoch'")
          .get()?.value,
      ).toBe("1")
      expect(dirty).toEqual(["2026-09-20", "2026-09-24"])
    })
  })

  test("a shared frame cannot retain deleted members without a scrub callback", async () => {
    await withLedger(async (db) => {
      db.query(
        "INSERT INTO context_awareness_frames (id, content, member_count, stored_bytes, created_at) VALUES ('frame', x'01', 2, 1, ?)",
      ).run(now)
      db.query(
        "INSERT INTO context_awareness_blobs (id, content_hash, content, redacted_bytes, created_at, last_seen_at, frame_id, frame_index) VALUES ('removed', 'hash-removed', x'', 1, ?, ?, 'frame', 0), ('kept', 'hash-kept', x'', 1, ?, ?, 'frame', 1)",
      ).run(now, now, now, now)
      insertEvent(db, "recent", now)
      insertEvent(db, "old", yesterday)
      db.query("UPDATE context_awareness_events SET blob_id = 'removed' WHERE id = 'recent'").run()
      db.query("UPDATE context_awareness_events SET blob_id = 'kept' WHERE id = 'old'").run()

      await expect(clearLedger(db, "last10m", { now })).rejects.toThrow("shared frame")
      expect(ids(db, "context_awareness_events")).toEqual(["old", "recent"])
      expect(
        db
          .query<{ value: string }, []>("SELECT value FROM side_meta WHERE key = 'deletion_epoch'")
          .get(),
      ).toBeNull()

      const calls: string[] = []
      await clearLedger(db, "last10m", {
        now,
        compactFrame: (connection, frameId) => {
          calls.push(frameId)
          connection
            .query(
              "UPDATE context_awareness_frames SET content = x'02', member_count = 1 WHERE id = 'frame'",
            )
            .run()
          return true
        },
      })
      expect(calls).toEqual(["frame"])
      expect(ids(db, "context_awareness_blobs")).toEqual(["kept"])
      expect(
        db
          .query<{ member_count: number }, []>(
            "SELECT member_count FROM context_awareness_frames WHERE id = 'frame'",
          )
          .get()?.member_count,
      ).toBe(1)
    })
  })

  test("real frame compaction removes a deleted member and preserves retained content", async () => {
    await withLedger(async (db) => {
      const key = Buffer.alloc(32, 0x42)
      const removed = writeLedgerEvent(db, key, {
        occurredAt: now - TEN_MINUTES_MS,
        source: "mac_ax",
        kind: "content.snapshot",
        content: "Synthetic content to remove",
      })
      const kept = writeLedgerEvent(db, key, {
        occurredAt: yesterday,
        source: "mac_ax",
        kind: "content.snapshot",
        content: "Synthetic content to retain",
      })
      if (!removed.blobId || !kept.blobId) throw new Error("Synthetic blob setup failed")
      expect(sealColdBlobs(db, key, now)).toBe(2)
      const oldFrame = db
        .query<{ frame_id: string }, [string]>(
          "SELECT frame_id FROM context_awareness_blobs WHERE id = ?",
        )
        .get(removed.blobId)?.frame_id
      if (!oldFrame) throw new Error("Synthetic frame setup failed")

      await clearLedger(db, "last10m", {
        now,
        compactFrame: (connection, frameId, at) => compactFrame(connection, key, frameId, at),
      })

      expect(readBlobContent(db, key, removed.blobId)).toBeNull()
      expect(readBlobContent(db, key, kept.blobId)).toBe("Synthetic content to retain")
      expect(
        db
          .query<{ id: string }, [string]>("SELECT id FROM context_awareness_frames WHERE id = ?")
          .get(oldFrame),
      ).toBeNull()
    })
  })

  test("a cross-midnight clear marks both event and summary days dirty", async () => {
    await withLedger(async (db) => {
      const afterMidnight = new Date(2026, 8, 24, 0, 5).getTime()
      insertEvent(db, "before-midnight", new Date(2026, 8, 23, 23, 58).getTime())
      insertSummary(db, "spanning", new Date(2026, 8, 23, 23).getTime(), afterMidnight, "6h")

      const result = await clearLedger(db, "last10m", { now: afterMidnight })
      expect(result.dirtyDays).toEqual(["2026-09-23", "2026-09-24"])
      expect(result.deletedEvents).toBe(1)
      expect(result.deletedSummaries).toBe(1)
    })
  })

  test("changing account_generation discards a fenced commit", async () => {
    await withLedger(async (db) => {
      const operation = withFence(db, async (commit) => {
        db.query("INSERT INTO side_meta (key, value) VALUES ('account_generation', '2')").run()
        return commit(() => {
          insertSummary(db, "resurrected", now - TEN_MINUTES_MS, now)
          return "stale-result"
        })
      })
      expect(await operation).toEqual({ status: "discarded" })
      expect(ids(db, "context_awareness_summaries")).toEqual([])
    })
  })

  test("a thenable fenced commit is rejected and its synchronous writes roll back", async () => {
    await withLedger(async (db) => {
      const hiddenThenable = (): object => {
        insertSummary(db, "uncommitted", now - TEN_MINUTES_MS, now)
        return Promise.resolve("late-result")
      }
      await expect(withFence(db, async (commit) => commit(hiddenThenable))).rejects.toBeInstanceOf(
        FenceAsyncCommitError,
      )
      expect(ids(db, "context_awareness_summaries")).toEqual([])
    })
  })

  test("a fenced commit locks out a second WAL writer before entering its write callback", async () => {
    await withLedger(async (db, path) => {
      const second = openLedger(path)
      try {
        const result = await withFence(db, async (commit) =>
          commit(() => {
            expect(() =>
              second
                .query("INSERT INTO side_meta (key, value) VALUES ('external_marker', '1')")
                .run(),
            ).toThrow()
            db.query("INSERT INTO side_meta (key, value) VALUES ('fenced_marker', '1')").run()
            return "committed"
          }),
        )
        expect(result).toEqual({ status: "committed", value: "committed" })
        expect(
          second
            .query<{ value: string }, []>(
              "SELECT value FROM side_meta WHERE key = 'external_marker'",
            )
            .get(),
        ).toBeNull()
        await clearLedger(second, "last10m", { now })
        expect(
          second
            .query<{ value: string }, []>(
              "SELECT value FROM side_meta WHERE key = 'deletion_epoch'",
            )
            .get()?.value,
        ).toBe("1")
      } finally {
        second.close()
      }
    })
  })

  test("100 clears discard in-flight summary, render, and index commits and their results", async () => {
    await withLedger(async (db) => {
      for (let iteration = 0; iteration < 100; iteration++) {
        let release: () => void = () => {}
        const waiting = new Promise<void>((resolve) => {
          release = resolve
        })
        let started: () => void = () => {}
        const prepared = new Promise<void>((resolve) => {
          started = resolve
        })
        const operation = withFence(db, async (commit) => {
          started()
          await waiting
          return commit(() => {
            insertSummary(db, "resurrected", now - TEN_MINUTES_MS, now)
            db.query("INSERT INTO side_meta (key, value) VALUES ('rendered_marker', '1')").run()
            db.query("INSERT INTO side_meta (key, value) VALUES ('indexed_marker', '1')").run()
            return "stale-result"
          })
        })
        await prepared
        await clearLedger(db, "last10m", { now })
        release()

        expect(await operation).toEqual({ status: "discarded" })
        expect(ids(db, "context_awareness_summaries")).toEqual([])
        expect(
          db
            .query<{ value: string }, []>(
              "SELECT value FROM side_meta WHERE key = 'rendered_marker'",
            )
            .get(),
        ).toBeNull()
        expect(
          db
            .query<{ value: string }, []>(
              "SELECT value FROM side_meta WHERE key = 'indexed_marker'",
            )
            .get(),
        ).toBeNull()
      }
    })
  })
})
