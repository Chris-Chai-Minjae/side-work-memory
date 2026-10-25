import { constants as fsConstants } from "node:fs"
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "../constants"

export const MCP_USAGE_MAX_FILE_BYTES = 1_048_576
export const MCP_USAGE_MAX_FILES = 5
export const MCP_USAGE_RETENTION_MS = 30 * 86_400_000

const UsageRecordSchema = z.strictObject({
  timestamp: z.number().int().nonnegative(),
  clientName: z.string().min(1).max(128),
  tool: z.enum(["history_search", "history_read", "memory_search"]),
  resultCount: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
})

export type UsageRecord = z.infer<typeof UsageRecordSchema>

let writes: Promise<void> = Promise.resolve()

function usagePath(directory: string, index = 0): string {
  return join(directory, "run", index === 0 ? "mcp-usage.jsonl" : `mcp-usage.jsonl.${index}`)
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

async function rotate(directory: string): Promise<void> {
  await rm(usagePath(directory, MCP_USAGE_MAX_FILES - 1), { force: true })
  for (let index = MCP_USAGE_MAX_FILES - 2; index >= 0; index--) {
    try {
      await rename(usagePath(directory, index), usagePath(directory, index + 1))
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
}

async function prune(directory: string, now: number): Promise<void> {
  for (let index = 0; index < MCP_USAGE_MAX_FILES; index++) {
    const path = usagePath(directory, index)
    try {
      const metadata = await stat(path)
      if (now - metadata.mtimeMs > MCP_USAGE_RETENTION_MS) await rm(path, { force: true })
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
}

async function append(directory: string, record: UsageRecord): Promise<void> {
  const runDirectory = join(directory, "run")
  await mkdir(runDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  await chmod(runDirectory, PRIVATE_DIRECTORY_MODE)
  await prune(directory, record.timestamp)
  const line = `${JSON.stringify(UsageRecordSchema.parse(record))}\n`
  let file = await open(
    usagePath(directory),
    fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  )
  try {
    const metadata = await file.stat()
    if (metadata.size > 0 && metadata.size + Buffer.byteLength(line) > MCP_USAGE_MAX_FILE_BYTES) {
      await file.close()
      await rotate(directory)
      file = await open(
        usagePath(directory),
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

export function appendUsage(directory: string, record: UsageRecord): Promise<void> {
  const result = writes.then(() => append(directory, record))
  writes = result.then(
    () => {},
    () => {},
  )
  return result
}

export async function readUsage(
  directory: string,
  sinceMs: number,
  now = Date.now(),
): Promise<readonly UsageRecord[]> {
  await prune(directory, now)
  const rows: UsageRecord[] = []
  const retentionFrom = now - MCP_USAGE_RETENTION_MS
  for (let index = MCP_USAGE_MAX_FILES - 1; index >= 0; index--) {
    let content: string
    try {
      const file = await open(
        usagePath(directory, index),
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      )
      try {
        const metadata = await file.stat()
        if (
          !metadata.isFile() ||
          metadata.size > MCP_USAGE_MAX_FILE_BYTES ||
          metadata.mtimeMs < Math.max(sinceMs, retentionFrom)
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
        const parsed = UsageRecordSchema.safeParse(JSON.parse(line))
        if (
          parsed.success &&
          parsed.data.timestamp >= sinceMs &&
          parsed.data.timestamp >= retentionFrom
        )
          rows.push(parsed.data)
      } catch {
        // Ignore an interrupted or malformed metadata-only log line.
      }
    }
  }
  return rows
}
