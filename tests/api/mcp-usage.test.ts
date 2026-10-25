import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentConnectionResource, createMcpUsageHandlers } from "../../src/api/resources/mcp-usage"

test("Given three MCP calls from two clients, usage groups tool counts and average latency", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-api-mcp-usage-"))
  const run = join(directory, "run")
  mkdirSync(run)
  const now = new Date(2026, 8, 24, 12).getTime()
  const rows = [
    {
      timestamp: now - 2_000,
      clientName: "Claude Code",
      tool: "history_search",
      resultCount: 2,
      latencyMs: 100,
    },
    {
      timestamp: now - 1_000,
      clientName: "Claude Code",
      tool: "history_read",
      resultCount: 1,
      latencyMs: 200,
    },
    { timestamp: now, clientName: "Aside", tool: "memory_search", resultCount: 1, latencyMs: 90 },
    {
      timestamp: now - 172_800_000,
      clientName: "Claude Code",
      tool: "history_search",
      resultCount: 1,
      latencyMs: 900,
    },
  ]
  writeFileSync(
    join(run, "mcp-usage.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  )
  try {
    const handlers = createMcpUsageHandlers({ directory, now: () => now })
    expect(await handlers["mcp.usage"]({ sinceMs: now - 86_400_000 })).toEqual([
      { client_name: "Aside", calls: { memory_search: 1 }, avg_latency_ms: 90 },
      {
        client_name: "Claude Code",
        calls: { history_search: 1, history_read: 1 },
        avg_latency_ms: 150,
      },
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given no usage file, the approved read method returns an empty list", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-api-mcp-empty-"))
  try {
    expect(await createMcpUsageHandlers({ directory })["mcp.usage"]({ sinceMs: 0 })).toEqual([])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given a bundle path with spaces, connection instructions quote it safely", () => {
  const resource = agentConnectionResource("/Applications/Side Preview.app/Contents/Resources/side")
  expect(resource.binary_path).toBe("/Applications/Side Preview.app/Contents/Resources/side")
  expect(resource.claude_code_command).toContain(
    '"/Applications/Side Preview.app/Contents/Resources/side" mcp',
  )
  expect(JSON.parse(resource.mcp_json_snippet)).toEqual({
    mcpServers: {
      side: { command: "/Applications/Side Preview.app/Contents/Resources/side", args: ["mcp"] },
    },
  })
})
