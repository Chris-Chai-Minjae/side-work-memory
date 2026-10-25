import { constants as fsConstants } from "node:fs"
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "../constants"
import type { DaemonDiagnosticsSnapshot } from "../contracts/rpc-resources"

const MAX_FILE_BYTES = 262_144
const MAX_FILES = 3
const RETENTION_MS = 30 * 86_400_000
const DiagnosticErrorSchema = z.strictObject({
  type: z.literal("error"),
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/u),
  code: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,64}$/u)
    .nullable(),
  stage: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/u),
  timestamp: z.number().int().nonnegative(),
  consecutive_count: z.number().int().positive(),
})
const CaptureSuccessSchema = z.strictObject({
  type: z.literal("capture-success"),
  timestamp: z.number().int().nonnegative(),
})
const DiagnosticRecordSchema = z.union([DiagnosticErrorSchema, CaptureSuccessSchema])

type DiagnosticRecord = z.infer<typeof DiagnosticRecordSchema>

function logPath(directory: string, index = 0): string {
  return join(directory, "run", index === 0 ? "diagnostics.jsonl" : `diagnostics.jsonl.${index}`)
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

async function rotate(directory: string): Promise<void> {
  await rm(logPath(directory, MAX_FILES - 1), { force: true })
  for (let index = MAX_FILES - 2; index >= 0; index--) {
    try {
      await rename(logPath(directory, index), logPath(directory, index + 1))
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
}

async function prune(directory: string, now: number): Promise<void> {
  for (let index = 0; index < MAX_FILES; index++) {
    const path = logPath(directory, index)
    try {
      const metadata = await stat(path)
      if (now - metadata.mtimeMs > RETENTION_MS) await rm(path, { force: true })
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
}

export function errorMetadata(error: unknown): {
  readonly name: string
  readonly code: string | null
} {
  const rawName = error instanceof Error ? error.name : "Error"
  const name = /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(rawName) ? rawName : "Error"
  const rawCode = error !== null && typeof error === "object" && "code" in error ? error.code : null
  const code = String(rawCode ?? "")
  return { name, code: /^[A-Za-z0-9_.-]{1,64}$/u.test(code) ? code : null }
}

async function appendRecord(
  directory: string,
  record: DiagnosticRecord,
  now: number,
): Promise<void> {
  const runDirectory = join(directory, "run")
  await mkdir(runDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  await chmod(runDirectory, PRIVATE_DIRECTORY_MODE)
  await prune(directory, now)
  const line = `${JSON.stringify(record)}\n`
  let file = await open(
    logPath(directory),
    fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  )
  try {
    const metadata = await file.stat()
    if (metadata.size > 0 && metadata.size + Buffer.byteLength(line) > MAX_FILE_BYTES) {
      await file.close()
      await rotate(directory)
      file = await open(
        logPath(directory),
        fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      )
    }
    await file.chmod(PRIVATE_FILE_MODE)
    await file.writeFile(line)
  } finally {
    await file.close()
  }
}

async function readRecords(directory: string, now: number): Promise<DiagnosticRecord[]> {
  const records: DiagnosticRecord[] = []
  for (let index = MAX_FILES - 1; index >= 0; index--) {
    let content: string
    try {
      const file = await open(
        logPath(directory, index),
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      )
      try {
        const metadata = await file.stat()
        if (
          !metadata.isFile() ||
          metadata.size > MAX_FILE_BYTES ||
          now - metadata.mtimeMs > RETENTION_MS
        )
          continue
        content = await file.readFile("utf8")
      } finally {
        await file.close()
      }
    } catch (error) {
      if (missing(error)) continue
      throw error
    }
    for (const line of content.split("\n")) {
      if (!line) continue
      try {
        const parsed = DiagnosticRecordSchema.safeParse(JSON.parse(line))
        if (parsed.success) records.push(parsed.data)
      } catch {
        // Ignore an interrupted metadata-only line.
      }
    }
  }
  return records
}

export class DaemonDiagnostics {
  private snapshot: DaemonDiagnosticsSnapshot = {
    last_error: null,
    last_successful_capture_at: null,
  }
  private consecutiveErrors = 0
  private writes: Promise<void> = Promise.resolve()

  private constructor(
    private readonly directory: string,
    private readonly now: () => number,
  ) {}

  static async create(directory: string, now: () => number = Date.now): Promise<DaemonDiagnostics> {
    const diagnostics = new DaemonDiagnostics(directory, now)
    try {
      for (const record of await readRecords(directory, now())) {
        if (record.type === "error") {
          const { type: _, ...lastError } = record
          diagnostics.snapshot.last_error = lastError
          diagnostics.consecutiveErrors = record.consecutive_count
        } else {
          diagnostics.snapshot.last_successful_capture_at = record.timestamp
          diagnostics.consecutiveErrors = 0
        }
      }
    } catch {
      // Diagnostics remain available in memory if an old log is unreadable.
    }
    return diagnostics
  }

  getSnapshot(): DaemonDiagnosticsSnapshot {
    return {
      last_error: this.snapshot.last_error === null ? null : { ...this.snapshot.last_error },
      last_successful_capture_at: this.snapshot.last_successful_capture_at,
    }
  }

  recordError(stage: string, error: unknown): void {
    const timestamp = this.now()
    this.consecutiveErrors++
    const record = {
      type: "error" as const,
      ...errorMetadata(error),
      stage: /^[a-z][a-z0-9-]{0,47}$/u.test(stage) ? stage : "daemon",
      timestamp,
      consecutive_count: this.consecutiveErrors,
    }
    const { type: _, ...lastError } = record
    this.snapshot.last_error = lastError
    this.enqueue(record)
  }

  recordCaptureSuccess(): void {
    const record = { type: "capture-success" as const, timestamp: this.now() }
    this.snapshot.last_successful_capture_at = record.timestamp
    this.consecutiveErrors = 0
    this.enqueue(record)
  }

  async flush(): Promise<void> {
    await this.writes
  }

  private enqueue(record: DiagnosticRecord): void {
    this.writes = this.writes.then(async () => {
      try {
        await appendRecord(this.directory, record, this.now())
      } catch {
        // Diagnostics persistence must not stop capture or expose error contents.
      }
    })
  }
}
