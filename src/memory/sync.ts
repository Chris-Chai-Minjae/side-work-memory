import type { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, renameSync } from "node:fs"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import {
  CA_INDEX_VERSION,
  MOSS_ADD_DOCS_BATCH_SIZE,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  SYNC_DEBOUNCE_MS,
} from "../constants"
import { type FenceResult, withFence } from "../ledger/fence"
import { truncateWal } from "../sqlite/checkpoint"
import { type ContextAwarenessChunk, chunkContextAwarenessDayPage } from "./chunk"
import { EMBEDDING_MODEL_ID } from "./embed"
import { putIndexedChunk } from "./index-db"

const ManifestSchema = z.record(
  z.string(),
  z.object({
    mtimeMs: z.number(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    chunkIds: z.array(z.string()),
  }),
)

type Manifest = z.infer<typeof ManifestSchema>
type MemoryFile = {
  readonly path: string
  readonly mtimeMs: number
  readonly sha256: string
  readonly content: string
}
type PreparedFile = {
  readonly path: string
  readonly chunks: readonly ContextAwarenessChunk[]
  readonly vectors: readonly Float32Array[]
}
type Embedder = { readonly embed: (text: string) => Promise<Float32Array> }

export type SyncOptions = {
  readonly ledgerDb: Database
  readonly indexDb: Database
  readonly dataDir: string
  readonly embedder: Embedder
  readonly beforeCommit?: () => void | Promise<void>
}

export type SyncResult = {
  readonly indexedFiles: number
  readonly deletedFiles: number
  readonly embeddedChunks: number
}

async function listMemoryFiles(memoryDir: string): Promise<readonly MemoryFile[]> {
  if (!existsSync(memoryDir)) return []
  const files: MemoryFile[] = []
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const filename = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(filename, path)
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const content = await readFile(filename)
        files.push({
          path,
          mtimeMs: (await stat(filename)).mtimeMs,
          sha256: createHash("sha256").update(content).digest("hex"),
          content: content.toString("utf8"),
        })
      }
    }
  }
  await visit(memoryDir, "")
  return files
}

async function readManifest(filename: string): Promise<Manifest> {
  if (!existsSync(filename)) return {}
  return ManifestSchema.parse(JSON.parse(await readFile(filename, "utf8")))
}

function minuteOfDay(time: string): number {
  const [hours, minutes] = time.split(":").map(Number)
  if (hours === undefined || minutes === undefined) throw new RangeError("Invalid chunk time")
  return hours * 60 + minutes
}

async function prepareFile(file: MemoryFile, embedder: Embedder): Promise<PreparedFile> {
  const chunks = [
    ...new Map(
      chunkContextAwarenessDayPage(file.path, file.content).map((chunk) => [chunk.id, chunk]),
    ).values(),
  ]
  const vectors: Float32Array[] = []
  for (let offset = 0; offset < chunks.length; offset += MOSS_ADD_DOCS_BATCH_SIZE) {
    const batch = chunks.slice(offset, offset + MOSS_ADD_DOCS_BATCH_SIZE)
    vectors.push(...(await Promise.all(batch.map((chunk) => embedder.embed(chunk.text)))))
  }
  return { path: file.path, chunks, vectors }
}

export async function syncMemoryIndex(options: SyncOptions): Promise<FenceResult<SyncResult>> {
  const { ledgerDb, indexDb, dataDir, embedder } = options
  const memoryDir = join(dataDir, "memory")
  const manifestPath = join(memoryDir, "memory-index.json")
  return withFence(ledgerDb, async (commit) => {
    const previous = await readManifest(manifestPath)
    const files = await listMemoryFiles(memoryDir)
    const currentPaths = new Set(files.map((file) => file.path))
    const next: Manifest = {}
    const changed: PreparedFile[] = []
    const indexed = indexDb.query<
      { id: string; index_version: number; embedded_model: string },
      [string]
    >("SELECT id, index_version, embedded_model FROM chunks WHERE path = ?")

    for (const file of files) {
      const old = previous[file.path]
      const rows = indexed.all(file.path)
      const intact =
        old?.sha256 === file.sha256 &&
        old.chunkIds.length === rows.length &&
        rows.every(
          (row) =>
            old.chunkIds.includes(row.id) &&
            row.index_version === CA_INDEX_VERSION &&
            row.embedded_model === EMBEDDING_MODEL_ID,
        )
      if (intact) {
        next[file.path] = { ...old, mtimeMs: file.mtimeMs }
        continue
      }
      const prepared = await prepareFile(file, embedder)
      changed.push(prepared)
      next[file.path] = {
        mtimeMs: file.mtimeMs,
        sha256: file.sha256,
        chunkIds: prepared.chunks.map((chunk) => chunk.id),
      }
    }

    const stalePaths = new Set(
      indexDb
        .query<{ path: string }, []>("SELECT DISTINCT path FROM chunks")
        .all()
        .map(({ path }) => path),
    )
    for (const path of Object.keys(previous)) stalePaths.add(path)
    for (const path of currentPaths) stalePaths.delete(path)
    const deleted = [...stalePaths]
    const result = {
      indexedFiles: changed.length,
      deletedFiles: deleted.length,
      embeddedChunks: changed.reduce((sum, file) => sum + file.chunks.length, 0),
    }
    const manifestChanged =
      !existsSync(manifestPath) || JSON.stringify(previous) !== JSON.stringify(next)
    let temporary: string | null = null
    if (manifestChanged) {
      await mkdir(memoryDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
      temporary = join(memoryDir, `.memory-index-${randomUUID()}.tmp`)
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
        flag: "wx",
        mode: PRIVATE_FILE_MODE,
      })
    }
    try {
      await options.beforeCommit?.()
      const committed = commit(() => {
        indexDb
          .transaction(() => {
            const remove = indexDb.query("DELETE FROM chunks WHERE path = ?")
            for (const path of deleted) remove.run(path)
            for (const file of changed) {
              remove.run(file.path)
              for (const [index, chunk] of file.chunks.entries()) {
                const embedding = file.vectors[index]
                if (!embedding) throw new RangeError("Missing prepared embedding")
                putIndexedChunk(
                  indexDb,
                  {
                    ...chunk,
                    windowFrom: minuteOfDay(chunk.windowFrom),
                    windowTo: minuteOfDay(chunk.windowTo),
                    indexVersion: CA_INDEX_VERSION,
                    embeddedModel: EMBEDDING_MODEL_ID,
                  },
                  embedding,
                )
              }
            }
            if (temporary) renameSync(temporary, manifestPath)
          })
          .immediate()
        return result
      })
      if (committed.status === "committed" && (deleted.length > 0 || changed.length > 0)) {
        truncateWal(indexDb)
      }
      return committed
    } finally {
      if (temporary) await rm(temporary, { force: true })
    }
  })
}

type SchedulerClock = {
  readonly schedule: (callback: () => void, delayMs: number) => () => void
}

const systemClock: SchedulerClock = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
}

export function createMemoryIndexSyncScheduler(
  run: () => Promise<void>,
  clock: SchedulerClock = systemClock,
): { readonly schedule: () => Promise<void> } {
  let cancel: (() => void) | null = null
  let pending: PromiseWithResolvers<void> | null = null
  let inFlight = Promise.resolve()
  return {
    schedule() {
      if (!pending) pending = Promise.withResolvers<void>()
      cancel?.()
      const job = pending
      cancel = clock.schedule(() => {
        cancel = null
        pending = null
        const running = inFlight.then(run)
        inFlight = running.then(
          () => {},
          () => {},
        )
        void running.then(job.resolve, job.reject)
      }, SYNC_DEBOUNCE_MS)
      return job.promise
    },
  }
}
