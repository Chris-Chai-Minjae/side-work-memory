import type { Database } from "bun:sqlite"
import { pruneSummaryMarkers } from "../comprehension/queue"
import { HOUR_MS, RETENTION_DAYS_MAX, TEN_MINUTES_MS } from "../constants"

export type ClearTarget = "last10m" | "lastHour" | "today" | "all"

export type ClearOptions = {
  readonly now?: number
  readonly rotateKey?: () => void | Promise<void>
  readonly compactFrame?: (db: Database, frameId: string, now: number) => boolean
  readonly onDirtyDay?: (day: string) => void | Promise<void>
}

export type ClearResult = {
  readonly deletedEvents: number
  readonly deletedSummaries: number
  readonly deletionEpoch: number
  readonly dirtyDays: readonly string[]
}

type EventRow = { readonly occurred_at: number }
type SummaryRow = { readonly window_from: number; readonly window_to: number }
type BlobRow = {
  readonly id: string
  readonly frame_id: string | null
  readonly created_at: number
  readonly redacted_bytes: number
}

export class ClearRequiresKeyRotationError extends Error {
  readonly name = "ClearRequiresKeyRotationError"
  constructor() {
    super("Clear all requires a key rotation callback")
  }
}

export class ClearRequiresFrameScrubError extends Error {
  readonly name = "ClearRequiresFrameScrubError"
  constructor() {
    super("Clear would leave deleted content in a shared frame")
  }
}

function localDay(timestamp: number): string {
  return new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(timestamp)
}

function markSummaryDays(days: Set<string>, row: SummaryRow): void {
  const cursor = new Date(row.window_from)
  cursor.setHours(0, 0, 0, 0)
  while (cursor.getTime() <= row.window_to) {
    days.add(localDay(cursor.getTime()))
    cursor.setDate(cursor.getDate() + 1)
  }
}

function clearStart(target: ClearTarget, now: number): number | null {
  switch (target) {
    case "last10m":
      return now - TEN_MINUTES_MS
    case "lastHour":
      return now - HOUR_MS
    case "today": {
      const midnight = new Date(now)
      midnight.setHours(0, 0, 0, 0)
      return midnight.getTime()
    }
    case "all":
      return null
    default:
      return target satisfies never
  }
}

function decrementCounter(
  db: Database,
  day: string,
  field: "events" | "blobs" | "raw_bytes",
  amount: number,
): void {
  db.query(
    `UPDATE side_day_counters SET ${field} = MAX(0, COALESCE(${field}, 0) - ?) WHERE day = ?`,
  ).run(amount, day)
}

function incrementEpoch(db: Database): number {
  db.query(
    "INSERT INTO side_meta (key, value) VALUES ('deletion_epoch', '0') ON CONFLICT(key) DO NOTHING",
  ).run()
  db.query(
    "UPDATE side_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'deletion_epoch'",
  ).run()
  const value = db
    .query<{ value: string }, []>("SELECT value FROM side_meta WHERE key = 'deletion_epoch'")
    .get()?.value
  const epoch = Number(value)
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("Invalid deletion epoch")
  return epoch
}

export async function clearLedger(
  db: Database,
  target: ClearTarget,
  options: ClearOptions = {},
): Promise<ClearResult> {
  const now = options.now ?? Date.now()
  if (!Number.isSafeInteger(now) || now < 0)
    throw new RangeError("Clear time must be a nonnegative safe integer")
  if (target === "all" && !options.rotateKey) throw new ClearRequiresKeyRotationError()
  const start = clearStart(target, now)

  const result = db.transaction((): ClearResult => {
    const deletionEpoch = incrementEpoch(db)
    const events =
      start === null
        ? db.query<EventRow, []>("SELECT occurred_at FROM context_awareness_events").all()
        : db
            .query<EventRow, [number, number]>(
              "SELECT occurred_at FROM context_awareness_events WHERE occurred_at BETWEEN ? AND ?",
            )
            .all(start, now)
    const summaries =
      start === null
        ? db
            .query<SummaryRow, []>("SELECT window_from, window_to FROM context_awareness_summaries")
            .all()
        : db
            .query<SummaryRow, [number, number]>(
              "SELECT window_from, window_to FROM context_awareness_summaries WHERE window_from < ? AND window_to > ?",
            )
            .all(now, start)
    const dirty = new Set(events.map((row) => localDay(row.occurred_at)))
    for (const summary of summaries) markSummaryDays(dirty, summary)
    if (start === null) {
      for (const row of db.query<{ day: string }, []>("SELECT day FROM side_day_counters").all()) {
        dirty.add(row.day)
      }
      for (const row of db
        .query<{ key: string }, []>("SELECT key FROM side_meta WHERE key LIKE 'dirty_day:%'")
        .all()) {
        dirty.add(row.key.slice("dirty_day:".length))
      }
    }

    if (start === null) db.query("DELETE FROM context_awareness_events").run()
    else
      db.query("DELETE FROM context_awareness_events WHERE occurred_at BETWEEN ? AND ?").run(
        start,
        now,
      )

    const orphans = db
      .query<BlobRow, []>(`
      SELECT b.id, b.frame_id, b.created_at, b.redacted_bytes
      FROM context_awareness_blobs b
      WHERE NOT EXISTS (SELECT 1 FROM context_awareness_events e WHERE e.blob_id = b.id)
    `)
      .all()
    const affectedFrames = [
      ...new Set(orphans.flatMap((row) => (row.frame_id === null ? [] : [row.frame_id]))),
    ]
    const sharedFrames = affectedFrames.filter(
      (id) =>
        db
          .query<{ id: string }, [string]>(`
      SELECT b.id FROM context_awareness_blobs b
      WHERE b.frame_id = ? AND EXISTS (
        SELECT 1 FROM context_awareness_events e WHERE e.blob_id = b.id
      ) LIMIT 1
    `)
          .get(id) !== null,
    )
    if (sharedFrames.length > 0 && !options.compactFrame) throw new ClearRequiresFrameScrubError()

    db.query(
      "DELETE FROM context_awareness_blobs WHERE NOT EXISTS (SELECT 1 FROM context_awareness_events e WHERE e.blob_id = context_awareness_blobs.id)",
    ).run()
    for (const frameId of affectedFrames) {
      const compacted = options.compactFrame?.(db, frameId, now) ?? false
      if (sharedFrames.includes(frameId) && !compacted) throw new ClearRequiresFrameScrubError()
    }
    db.query(
      "DELETE FROM context_awareness_frames WHERE NOT EXISTS (SELECT 1 FROM context_awareness_blobs b WHERE b.frame_id = context_awareness_frames.id)",
    ).run()

    if (start === null) db.query("DELETE FROM context_awareness_summaries").run()
    else
      db.query(
        "DELETE FROM context_awareness_summaries WHERE window_from < ? AND window_to > ?",
      ).run(now, start)

    if (start === null) {
      db.query("DELETE FROM side_day_counters").run()
      db.query("DELETE FROM side_suppressions").run()
    } else {
      for (const event of events) decrementCounter(db, localDay(event.occurred_at), "events", 1)
      for (const blob of orphans) {
        const day = localDay(blob.created_at)
        decrementCounter(db, day, "blobs", 1)
        decrementCounter(db, day, "raw_bytes", blob.redacted_bytes)
      }
    }
    const dirtyDays = [...dirty].sort()
    const markDirty = db.query(
      "INSERT INTO side_meta (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'",
    )
    for (const day of dirtyDays) markDirty.run(`dirty_day:${day}`)
    pruneSummaryMarkers(db, now, RETENTION_DAYS_MAX)
    return {
      deletedEvents: events.length,
      deletedSummaries: summaries.length,
      deletionEpoch,
      dirtyDays,
    }
  })()

  let rotationFailed = false
  let rotationError: unknown
  try {
    if (target === "all") await options.rotateKey?.()
  } catch (error) {
    rotationFailed = true
    rotationError = error
  }
  let renderFailed = false
  let renderError: unknown
  for (const day of result.dirtyDays) {
    try {
      await options.onDirtyDay?.(day)
    } catch (error) {
      if (!renderFailed) renderError = error
      renderFailed = true
    }
  }
  if (rotationFailed) throw rotationError
  if (renderFailed) throw renderError
  return result
}
