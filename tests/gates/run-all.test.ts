import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeGateCommand, runReleaseGates } from "../../scripts/gates/run-all"

test("Given all synthetic checks pass, when gates run, then physical and provider gates remain blocked", async () => {
  const commands: string[] = []
  const result = await runReleaseGates(async (argv) => {
    commands.push(argv.join(" "))
    return { exitCode: 0, durationMs: 1 }
  })

  expect(result.status).toBe("BLOCKED")
  expect(result.gates.map((gate) => gate.id)).toEqual([
    "G0",
    "G1",
    "G2",
    "G3",
    "G4",
    "G5",
    "G6",
    "G7",
    "G7b",
    "G8",
    "G9",
    "G10",
    "G11",
  ])
  expect(result.gates.filter((gate) => gate.status === "BLOCKED").map((gate) => gate.id)).toEqual([
    "G1",
    "G2",
    "G7",
  ])
  const g0 = result.gates.find((gate) => gate.id === "G0")
  expect(g0?.commands).toHaveLength(7)
  expect(commands).toEqual(
    expect.arrayContaining([
      "bun run test:swift",
      "bun run build",
      "bun run smoke:bundle",
      "sh apps/side-mac/scripts/sign-notarize.sh preflight apps/side-mac/.build/release/Side.app",
    ]),
  )
  expect(g0?.commands.every((command) => command.timeoutMs > 0)).toBe(true)
  expect(commands).not.toContain("bun run scripts/gates/g7-injection.ts")
  expect(
    commands.every((command) => !command.includes(".aside") && !command.includes("g1-canary.ts")),
  ).toBe(true)
})

test("Given one failed command, when gates run, then its gate and the release fail", async () => {
  const result = await runReleaseGates(async (argv) => ({
    exitCode: argv.includes("tests/ledger/delete.test.ts") ? 1 : 0,
    durationMs: 1,
  }))

  expect(result.status).toBe("FAIL")
  expect(result.gates.find((gate) => gate.id === "G3")?.status).toBe("FAIL")
  expect(result.gates.find((gate) => gate.id === "G7")?.status).toBe("BLOCKED")
})

test("Given a missing tool, when a command cannot start, then the gate fails with bounded evidence", async () => {
  const result = await runReleaseGates(async (argv) => {
    if (argv.includes("test:swift")) throw new Error("tool unavailable")
    return { exitCode: 0, durationMs: 1 }
  })

  const gate = result.gates.find((item) => item.id === "G0")
  const failed = gate?.commands.find((command) => command.exitCode === null)
  expect(gate?.status).toBe("FAIL")
  expect(failed?.error).toBe("command failed to start")
})

test("Given a command exceeds its deadline, then its group is stopped and its log is retained", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-gate-timeout-"))
  const logPath = join(directory, "timeout.log")
  try {
    const result = await executeGateCommand(["sh", "-c", "printf started; sleep 30"], {
      timeoutMs: 50,
      logPath,
    })
    expect(result.exitCode).toBeNull()
    expect(result.timedOut).toBe(true)
    expect(result.logPath).toBe(logPath)
    expect(result.durationMs).toBeLessThan(5_000)
    expect(readFileSync(logPath, "utf8")).toContain("started")
    expect(readFileSync(logPath, "utf8")).toContain("timeout after 50 ms")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
