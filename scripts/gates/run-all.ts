import { spawn } from "node:child_process"
import { createWriteStream, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"

type GateStatus = "PASS" | "FAIL" | "BLOCKED"

export type CommandEvidence = {
  readonly argv: readonly string[]
  readonly exitCode: number | null
  readonly durationMs: number
  readonly timeoutMs: number
  readonly logPath?: string
  readonly timedOut?: boolean
  readonly error?: string
}

export type GateResult = {
  readonly id: string
  readonly status: GateStatus
  readonly commands: readonly CommandEvidence[]
  readonly remaining?: string
}

export type ReleaseResult = {
  readonly status: GateStatus
  readonly gates: readonly GateResult[]
}

type CommandOptions = {
  readonly timeoutMs: number
  readonly logPath?: string
}

type CommandResult = {
  readonly exitCode: number | null
  readonly durationMs: number
  readonly logPath?: string
  readonly timedOut?: boolean
  readonly error?: string
}

type CommandRunner = (argv: readonly string[], options: CommandOptions) => Promise<CommandResult>

type GatePlan = {
  readonly id: string
  readonly commands: readonly (readonly string[])[]
  readonly remaining?: string
}

const test = (...files: string[]): readonly string[] => ["bun", "test", ...files]

// All inputs are repository tests with synthetic fixtures. No user data root or credential path is accepted.
const GATES: readonly GatePlan[] = [
  {
    id: "G0",
    commands: [
      ["npx", "tsc", "--noEmit"],
      ["npx", "biome", "check", "."],
      test(),
      ["bun", "run", "test:swift"],
      ["bun", "run", "build"],
      ["bun", "run", "smoke:bundle"],
      [
        "sh",
        "apps/side-mac/scripts/sign-notarize.sh",
        "preflight",
        "apps/side-mac/.build/release/Side.app",
      ],
    ],
  },
  {
    id: "G1",
    commands: [
      test(
        "tests/gates/g1-canary.test.ts",
        "tests/redact.test.ts",
        "tests/integration/phase1.test.ts",
      ),
    ],
    remaining:
      "Run fixed canaries through an isolated Side capture, then scan its ledger/index/memory/log bytes.",
  },
  {
    id: "G2",
    commands: [test("tests/policy.test.ts", "tests/integration/phase1.test.ts")],
    remaining:
      "Use blocked app and domain for 10 minutes on a permitted test Mac; verify zero events and positive suppressions.",
  },
  {
    id: "G3",
    commands: [test("tests/ledger/delete.test.ts", "tests/memory/render.test.ts")],
  },
  {
    id: "G4",
    commands: [
      test("tests/comprehension/contract.test.ts", "tests/comprehension/providers.test.ts"),
    ],
  },
  { id: "G5", commands: [test("tests/constants.test.ts")] },
  { id: "G6", commands: [test("tests/ledger/schema.test.ts")] },
  {
    id: "G7",
    commands: [test("tests/comprehension/neutralize.test.ts")],
    remaining:
      "The ten-fixture provider response gate needs authorized synthetic provider credentials; the live credential-reading script is excluded.",
  },
  { id: "G7b", commands: [test("tests/api/evidence.test.ts", "tests/mcp/server.test.ts")] },
  { id: "G8", commands: [test("tests/ledger/gc.test.ts")] },
  { id: "G9", commands: [test("tests/config.test.ts", "tests/api/server.test.ts")] },
  { id: "G10", commands: [test("tests/api/server.test.ts")] },
  { id: "G11", commands: [test("tests/comprehension/providers.test.ts")] },
]

function timeoutFor(argv: readonly string[]): number {
  if (argv.includes("build")) return 300_000
  if (argv[0] === "swift" || argv.includes("test:swift")) return 360_000
  if (argv.includes("smoke:bundle")) return 90_000
  return 120_000
}

export async function runReleaseGates(run: CommandRunner): Promise<ReleaseResult> {
  const gates: GateResult[] = []
  for (const gate of GATES) {
    const commands: CommandEvidence[] = []
    for (const argv of gate.commands) {
      const timeoutMs = timeoutFor(argv)
      try {
        const result = await run(argv, { timeoutMs })
        commands.push({ argv, timeoutMs, ...result })
      } catch {
        commands.push({
          argv,
          exitCode: null,
          durationMs: 0,
          timeoutMs,
          error: "command failed to start",
        })
      }
    }
    const failed = commands.some((command) => command.exitCode !== 0)
    gates.push({
      id: gate.id,
      status: failed ? "FAIL" : gate.remaining ? "BLOCKED" : "PASS",
      commands,
      ...(gate.remaining ? { remaining: gate.remaining } : {}),
    })
  }
  return {
    status: gates.some((gate) => gate.status === "FAIL")
      ? "FAIL"
      : gates.some((gate) => gate.status === "BLOCKED")
        ? "BLOCKED"
        : "PASS",
    gates,
  }
}

const MAX_LOG_BYTES = 4 * 1024 * 1024

export async function executeGateCommand(
  argv: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const started = performance.now()
  const logPath = options.logPath
  if (logPath) mkdirSync(resolve(logPath, ".."), { recursive: true })
  const log = logPath ? createWriteStream(logPath, { flags: "wx" }) : null
  let logBytes = 0
  const append = (chunk: Buffer) => {
    if (!log || logBytes >= MAX_LOG_BYTES) return
    const bounded = chunk.subarray(0, MAX_LOG_BYTES - logBytes)
    logBytes += bounded.length
    log.write(bounded)
    if (logBytes === MAX_LOG_BYTES) log.write("\n[log truncated at 4 MiB]\n")
  }
  const executable = argv[0]
  if (!executable) throw new TypeError("Expected a command")
  const child = spawn(executable, [...argv.slice(1)], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", append)
  child.stderr.on("data", append)
  const terminate = (signal: NodeJS.Signals) => {
    const pid = child.pid
    if (!pid) {
      child.kill(signal)
      return
    }
    try {
      process.kill(process.platform === "win32" ? pid : -pid, signal)
    } catch {
      child.kill(signal)
    }
  }
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    append(Buffer.from(`\n[timeout after ${options.timeoutMs} ms]\n`))
    terminate("SIGTERM")
    const force = setTimeout(() => terminate("SIGKILL"), 5_000)
    force.unref()
  }, options.timeoutMs)
  try {
    const { exitCode, startError } = await new Promise<{
      exitCode: number | null
      startError?: string
    }>((resolveExit) => {
      let startError: string | undefined
      child.once("error", (error) => {
        startError = error.message
      })
      child.once("close", (code) =>
        resolveExit({ exitCode: code, ...(startError ? { startError } : {}) }),
      )
    })
    return {
      exitCode,
      durationMs: Math.round(performance.now() - started),
      ...(logPath ? { logPath } : {}),
      ...(timedOut ? { timedOut: true, error: `timed out after ${options.timeoutMs} ms` } : {}),
      ...(startError ? { error: `command failed to start: ${startError}` } : {}),
    }
  } finally {
    clearTimeout(timeout)
    if (log) await new Promise<void>((resolveLog) => log.end(resolveLog))
  }
}

if (import.meta.main) {
  const logDirectory = join(
    "dist",
    "gates",
    `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`,
  )
  let sequence = 0
  const result = await runReleaseGates((argv, options) => {
    sequence += 1
    const name = `${String(sequence).padStart(2, "0")}-${(argv[0] ?? "command").replaceAll("/", "-")}.log`
    return executeGateCommand(argv, { ...options, logPath: join(logDirectory, name) })
  })
  process.stdout.write(`${JSON.stringify({ logDirectory, ...result }, null, 2)}\n`)
  process.exitCode = result.status === "PASS" ? 0 : result.status === "FAIL" ? 1 : 2
}
