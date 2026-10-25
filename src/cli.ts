import { errorMetadata } from "./daemon/diagnostics"

const CLIENT_COMMANDS = new Set([
  "status",
  "search",
  "read",
  "memory",
  "pause",
  "resume",
  "clear",
  "digest",
  "doctor",
])

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help"
  if (command === "help") {
    console.log(
      "Commands: daemon | mcp | status | search | read | memory | pause | resume | clear | digest | doctor",
    )
    return
  }
  if (command === "daemon") {
    const { runDaemon } = await import("./daemon/index")
    await runDaemon()
    return
  }
  if (command === "mcp") {
    const { runMcpServer } = await import("./mcp/server")
    await runMcpServer()
    return
  }
  if (CLIENT_COMMANDS.has(command)) {
    const { createInterface } = await import("node:readline/promises")
    const { callDaemon } = await import("./cli/client")
    const { runClientCommand } = await import("./cli/commands")
    const { runDoctor } = await import("./cli/doctor")
    const write = (line: string) => console.log(line)
    const rpc = (method: Parameters<typeof callDaemon>[0], params: unknown) =>
      callDaemon(method, params)
    process.exitCode = await runClientCommand(process.argv.slice(2), {
      rpc,
      write,
      confirmClearAll: async () => {
        if (!process.stdin.isTTY) return false
        const reader = createInterface({ input: process.stdin, output: process.stdout })
        try {
          return (
            (await reader.question("Clear all Context Awareness? Type yes to delete: ")).trim() ===
            "yes"
          )
        } finally {
          reader.close()
        }
      },
      doctor: () => runDoctor({ rpc, write }),
    })
    return
  }
  throw new Error(`Unknown command: ${command}`)
}

try {
  await main()
} catch (error) {
  const metadata = errorMetadata(error)
  console.error(
    metadata.name === "DaemonUnavailableError"
      ? "Side is not running. Open Side.app."
      : metadata.name === "HelperUnavailableError"
        ? "Helper is unavailable"
        : `Side command failed (${metadata.name}${metadata.code === null ? "" : `/${metadata.code}`})`,
  )
  process.exitCode = 1
}
