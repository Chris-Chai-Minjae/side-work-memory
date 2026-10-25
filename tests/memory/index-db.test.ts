import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openIndexDb, putIndexedChunk, searchNearest } from "../../src/memory/index-db"

test("Given a new index, when opened, then trigram FTS and 384-dimensional cosine vec0 are available", () => {
  const directory = mkdtempSync(join(tmpdir(), "side-index-schema-"))
  try {
    const db = openIndexDb(join(directory, "index.db"))
    try {
      const schema = db
        .query<{ name: string; sql: string }, []>(
          "SELECT name, sql FROM sqlite_master WHERE name IN ('chunks', 'chunks_fts', 'chunks_vec') ORDER BY name",
        )
        .all()
      expect(schema.map(({ name }) => name)).toEqual(["chunks", "chunks_fts", "chunks_vec"])
      expect(schema.find(({ name }) => name === "chunks_fts")?.sql).toContain("tokenize='trigram'")
      expect(schema.find(({ name }) => name === "chunks_vec")?.sql).toContain(
        "float[384] distance_metric=cosine",
      )
      expect(
        db.query<{ secure_delete: number }, []>("PRAGMA secure_delete").get()?.secure_delete,
      ).toBe(1)
    } finally {
      db.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given Korean and English chunks, when indexed, then trigram text and cosine KNN find the relevant chunk", () => {
  const directory = mkdtempSync(join(tmpdir(), "side-index-knn-"))
  try {
    const db = openIndexDb(join(directory, "index.db"))
    try {
      const relevant = new Float32Array(384)
      const unrelated = new Float32Array(384)
      const query = new Float32Array(384)
      relevant[0] = 1
      unrelated[1] = 1
      query[0] = 0.9
      query[1] = 0.1
      const base = {
        path: "episodic/context-awareness-2026-09-24.md",
        day: "2026-09-24",
        windowFrom: 1,
        windowTo: 2,
        heading: "sqlite extension",
        summaryId: "synthetic-summary",
        indexVersion: 2,
        embeddedModel: "synthetic-model",
      }
      putIndexedChunk(
        db,
        { ...base, id: "relevant", text: "SQLite 확장 로딩 문서 데이터베이스" },
        relevant,
      )
      putIndexedChunk(
        db,
        { ...base, id: "unrelated", text: "Dinner recipe and shopping" },
        unrelated,
      )
      expect(
        db
          .query<{ id: string }, [string]>(
            "SELECT c.id FROM chunks_fts f JOIN chunks c ON c.rowid=f.rowid WHERE chunks_fts MATCH ?",
          )
          .all("데이터베이스")
          .map(({ id }) => id),
      ).toEqual(["relevant"])
      expect(searchNearest(db, query, 2).map(({ id }) => id)).toEqual(["relevant", "unrelated"])
    } finally {
      db.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given an indexed chunk, when replaced and deleted, then FTS and vectors do not retain stale entries", () => {
  const directory = mkdtempSync(join(tmpdir(), "side-index-replace-"))
  try {
    const db = openIndexDb(join(directory, "index.db"))
    try {
      const embedding = new Float32Array(384)
      embedding[0] = 1
      const chunk = {
        id: "synthetic",
        path: "episodic/context-awareness-2026-09-24.md",
        day: "2026-09-24",
        windowFrom: 1,
        windowTo: 2,
        heading: "Original",
        text: "데이터베이스 원본 내용",
        summaryId: "synthetic-summary",
        indexVersion: 2,
        embeddedModel: "synthetic-model",
      }
      putIndexedChunk(db, chunk, embedding)
      putIndexedChunk(db, { ...chunk, text: "로컬 임베딩 교체 내용" }, embedding)
      expect(
        db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM chunks_fts WHERE chunks_fts MATCH ?",
          )
          .get("데이터베이스")?.count,
      ).toBe(0)
      expect(searchNearest(db, embedding, 10)).toHaveLength(1)
      db.query("DELETE FROM chunks WHERE id = ?").run(chunk.id)
      expect(searchNearest(db, embedding, 10)).toHaveLength(0)
    } finally {
      db.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
