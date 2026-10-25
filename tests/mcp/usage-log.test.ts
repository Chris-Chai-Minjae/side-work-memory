import { expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendUsage, MCP_USAGE_MAX_FILE_BYTES, readUsage } from "../../src/mcp/usage-log"

const now = Date.now()
const record = {
  timestamp: now,
  clientName: "synthetic",
  tool: "history_search" as const,
  resultCount: 1,
  latencyMs: 5,
}

test("Given a full usage log, append rotates at the size cap and keeps five private files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-mcp-rotation-"))
  const run = join(directory, "run")
  mkdirSync(run)
  const active = join(run, "mcp-usage.jsonl")
  writeFileSync(active, "x".repeat(MCP_USAGE_MAX_FILE_BYTES))
  for (let index = 1; index <= 4; index++) {
    writeFileSync(join(run, `mcp-usage.jsonl.${index}`), `generation-${index}\n`)
  }
  try {
    await appendUsage(directory, record)
    expect(readFileSync(active, "utf8")).toContain('"clientName":"synthetic"')
    expect(readFileSync(join(run, "mcp-usage.jsonl.4"), "utf8")).toContain("generation-3")
    expect(existsSync(join(run, "mcp-usage.jsonl.5"))).toBe(false)
    expect(statSync(active).mode & 0o777).toBe(0o600)
    expect(await readUsage(directory, now - 1, now)).toEqual([record])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given expired and corrupt usage rows, reads prune retention and ignore damage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-mcp-retention-"))
  const run = join(directory, "run")
  mkdirSync(run)
  const active = join(run, "mcp-usage.jsonl")
  writeFileSync(
    active,
    `not-json\n${JSON.stringify({ ...record, timestamp: now - 31 * 86_400_000 })}\n`,
  )
  const expired = new Date(now - 31 * 86_400_000)
  utimesSync(active, expired, expired)
  try {
    expect(await readUsage(directory, 0, now)).toEqual([])
    expect(existsSync(active)).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given a symlinked usage log, append refuses to follow it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-mcp-nofollow-"))
  const run = join(directory, "run")
  mkdirSync(run)
  const target = join(directory, "target")
  writeFileSync(target, "unchanged")
  symlinkSync(target, join(run, "mcp-usage.jsonl"))
  try {
    await expect(appendUsage(directory, record)).rejects.toThrow()
    expect(readFileSync(target, "utf8")).toBe("unchanged")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
