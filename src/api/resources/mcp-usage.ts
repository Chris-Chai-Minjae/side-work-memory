import type { z } from "zod"
import { RpcMethods } from "../../contracts/rpc"
import { AgentConnectionSchema, McpUsageSchema } from "../../contracts/rpc-resources"
import { readUsage } from "../../mcp/usage-log"

type McpUsageResult = z.output<(typeof RpcMethods)["mcp.usage"]["output"]>

function shellQuoted(path: string): string {
  return `"${path.replace(/[\\"$`]/gu, "\\$&")}"`
}

export function agentConnectionResource(binaryPath: string) {
  return AgentConnectionSchema.parse({
    binary_path: binaryPath,
    claude_code_command: `claude mcp add side -- ${shellQuoted(binaryPath)} mcp`,
    mcp_json_snippet: JSON.stringify(
      { mcpServers: { side: { command: binaryPath, args: ["mcp"] } } },
      null,
      2,
    ),
  })
}

export function createMcpUsageHandlers(dependencies: {
  readonly directory: string
  readonly now?: () => number
}): {
  readonly "mcp.usage": (params: unknown) => Promise<McpUsageResult>
} {
  return {
    async "mcp.usage"(params) {
      const { sinceMs } = RpcMethods["mcp.usage"].input.parse(params)
      const groups = new Map<
        string,
        { calls: Record<string, number>; latency: number; count: number }
      >()
      for (const row of await readUsage(
        dependencies.directory,
        sinceMs,
        dependencies.now?.() ?? Date.now(),
      )) {
        const group = groups.get(row.clientName) ?? { calls: {}, latency: 0, count: 0 }
        group.calls[row.tool] = (group.calls[row.tool] ?? 0) + 1
        group.latency += row.latencyMs
        group.count++
        groups.set(row.clientName, group)
      }
      return [...groups.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([clientName, group]) =>
          McpUsageSchema.parse({
            client_name: clientName,
            calls: group.calls,
            avg_latency_ms: Math.round(group.latency / group.count),
          }),
        )
    },
  }
}
