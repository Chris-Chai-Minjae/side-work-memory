import type { Database } from "bun:sqlite"
import { pruneSummaryMarkers } from "../comprehension/queue"
import { CONTENT_BYTE_BUDGET, MS_PER_DAY, VACUUM_SLACK_MIN_BYTES } from "../constants"
import { truncateWal } from "../sqlite/checkpoint"
import { compactFrame } from "./frames"

export type LedgerGcResult = {
  readonly deletedEvents: number
  readonly deletedBlobs: number
  readonly deletedFrames: number
  readonly compactedFrames: number
}

type BlobRow = {
  readonly id: string
  readonly frame_id: string | null
  readonly redacted_bytes: number
}

function enforceContentBudget(db: Database): { events: number; blobs: BlobRow[] } {
  const total =
    db
      .query<{ bytes: number }, []>(
        "SELECT COALESCE(SUM(redacted_bytes), 0) AS bytes FROM context_awareness_blobs",
      )
      .get()?.bytes ?? 0
  if (total <= CONTENT_BYTE_BUDGET) return { events: 0, blobs: [] }

  let excess = total - CONTENT_BYTE_BUDGET
  const expired: BlobRow[] = []
  const candidates = db
    .query<BlobRow, []>(`
      SELECT id, frame_id, redacted_bytes FROM context_awareness_blobs
      ORDER BY created_at, id
    `)
    .all()
  for (const blob of candidates) {
    expired.push(blob)
    excess -= blob.redacted_bytes
    if (excess <= 0) break
  }

  let events = 0
  const changes = db.query<{ count: number }, []>("SELECT changes() AS count")
  const deleteEvents = db.query("DELETE FROM context_awareness_events WHERE blob_id = ?")
  const deleteBlob = db.query("DELETE FROM context_awareness_blobs WHERE id = ?")
  for (const blob of expired) {
    deleteEvents.run(blob.id)
    events += changes.get()?.count ?? 0
    deleteBlob.run(blob.id)
  }
  return { events, blobs: expired }
}

export function runLedgerGc(
  db: Database,
  masterKey: Buffer,
  options: { readonly now: number; readonly retentionDays: number },
): LedgerGcResult {
  const cutoff = options.now - options.retentionDays * MS_PER_DAY
  const deleted = db.transaction(() => {
    const changes = db.query<{ count: number }, []>("SELECT changes() AS count")
    db.query("DELETE FROM context_awareness_events WHERE occurred_at < ?").run(cutoff)
    let deletedEvents = changes.get()?.count ?? 0
    const budget = enforceContentBudget(db)
    deletedEvents += budget.events
    const affectedBlobs = db
      .query<BlobRow, []>(`
        SELECT id, frame_id, redacted_bytes FROM context_awareness_blobs
        WHERE NOT EXISTS (
          SELECT 1 FROM context_awareness_events
          WHERE context_awareness_events.blob_id = context_awareness_blobs.id
        )
      `)
      .all()
    db.query(`
        DELETE FROM context_awareness_blobs
        WHERE NOT EXISTS (
          SELECT 1 FROM context_awareness_events
          WHERE context_awareness_events.blob_id = context_awareness_blobs.id
        )
      `).run()
    const deletedBlobs = (changes.get()?.count ?? 0) + budget.blobs.length
    db.query(`
        DELETE FROM context_awareness_frames
        WHERE NOT EXISTS (
          SELECT 1 FROM context_awareness_blobs
          WHERE context_awareness_blobs.frame_id = context_awareness_frames.id
        )
      `).run()
    const deletedFrames = changes.get()?.count ?? 0
    const affectedFrames = new Set(
      [...affectedBlobs, ...budget.blobs].flatMap((blob) =>
        blob.frame_id === null ? [] : [blob.frame_id],
      ),
    )
    let compactedFrames = 0
    for (const frameId of affectedFrames) {
      if (compactFrame(db, masterKey, frameId, options.now)) compactedFrames++
    }
    pruneSummaryMarkers(db, options.now, options.retentionDays)
    return { deletedEvents, deletedBlobs, deletedFrames, compactedFrames }
  })()

  db.exec("PRAGMA incremental_vacuum")
  const freelist = db.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()
  const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get()
  if (!freelist || !pageSize) throw new Error("Ledger free page accounting is unavailable")
  if (freelist.freelist_count * pageSize.page_size >= VACUUM_SLACK_MIN_BYTES) db.exec("VACUUM")
  truncateWal(db)
  return deleted
}
