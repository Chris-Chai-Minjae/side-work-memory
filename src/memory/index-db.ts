import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { load as loadVec } from "sqlite-vec"
import { EMBEDDING_DIMENSIONS } from "../constants"
import { bundledResourcePath, configureSqlite } from "./sqlite"

export type IndexedChunk = {
  readonly id: string
  readonly path: string
  readonly day: string
  readonly windowFrom: number | null
  readonly windowTo: number | null
  readonly heading: string
  readonly text: string
  readonly summaryId: string | null
  readonly indexVersion: number
  readonly embeddedModel: string
}

export function openIndexDb(path: string): Database {
  configureSqlite()
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  try {
    const bundledVec = bundledResourcePath(process.execPath, "lib", "vec0.dylib")
    if (existsSync(bundledVec)) db.loadExtension(bundledVec)
    else loadVec(db)
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY, path TEXT NOT NULL, day TEXT NOT NULL,
        window_from INTEGER, window_to INTEGER, heading TEXT NOT NULL,
        text TEXT NOT NULL, summary_id TEXT, index_version INTEGER NOT NULL,
        embedded_model TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        heading, text, content='chunks', content_rowid='rowid', tokenize='trigram'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        chunk_rowid INTEGER PRIMARY KEY,
        embedding float[${EMBEDDING_DIMENSIONS}] distance_metric=cosine
      );
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, heading, text) VALUES (new.rowid, new.heading, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, heading, text)
          VALUES ('delete', old.rowid, old.heading, old.text);
        DELETE FROM chunks_vec WHERE chunk_rowid = old.rowid;
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, heading, text)
          VALUES ('delete', old.rowid, old.heading, old.text);
        INSERT INTO chunks_fts(rowid, heading, text) VALUES (new.rowid, new.heading, new.text);
      END;
    `)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function putIndexedChunk(db: Database, chunk: IndexedChunk, embedding: Float32Array): void {
  if (embedding.length !== EMBEDDING_DIMENSIONS)
    throw new RangeError(`Expected ${EMBEDDING_DIMENSIONS}-dimensional embedding`)
  db.transaction(() => {
    db.query("DELETE FROM chunks WHERE id = ?").run(chunk.id)
    db.query(
      `INSERT INTO chunks (id, path, day, window_from, window_to, heading, text,
        summary_id, index_version, embedded_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      chunk.id,
      chunk.path,
      chunk.day,
      chunk.windowFrom,
      chunk.windowTo,
      chunk.heading,
      chunk.text,
      chunk.summaryId,
      chunk.indexVersion,
      chunk.embeddedModel,
    )
    const row = db
      .query<{ rowid: number }, [string]>("SELECT rowid FROM chunks WHERE id = ?")
      .get(chunk.id)
    if (!row) throw new Error("Indexed chunk row is missing")
    db.query("INSERT INTO chunks_vec (chunk_rowid, embedding) VALUES (?, ?)").run(
      row.rowid,
      embedding,
    )
  })()
}

export function searchNearest(
  db: Database,
  embedding: Float32Array,
  limit: number,
): readonly { readonly id: string; readonly distance: number }[] {
  if (embedding.length !== EMBEDDING_DIMENSIONS)
    throw new RangeError(`Expected ${EMBEDDING_DIMENSIONS}-dimensional embedding`)
  return db
    .query<{ id: string; distance: number }, [Float32Array, number]>(
      `SELECT c.id, v.distance FROM chunks_vec v
       JOIN chunks c ON c.rowid = v.chunk_rowid
       WHERE v.embedding MATCH ? AND k = ? ORDER BY v.distance`,
    )
    .all(embedding, limit)
}
