import type { Database } from "bun:sqlite"

export class SqliteCheckpointBusyError extends Error {
  readonly name = "SqliteCheckpointBusyError"

  constructor() {
    super("WAL checkpoint could not truncate while a reader is active")
  }
}

export function truncateWal(db: Database): void {
  const checkpoint = db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get()
  if (!checkpoint) throw new Error("WAL checkpoint status is unavailable")
  if (checkpoint.busy !== 0) throw new SqliteCheckpointBusyError()
}
