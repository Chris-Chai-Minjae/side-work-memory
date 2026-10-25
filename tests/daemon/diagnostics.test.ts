import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DaemonDiagnostics } from "../../src/daemon/diagnostics"

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "side-diagnostics-"))
  let now = 1_000
  const diagnostics = await DaemonDiagnostics.create(directory, () => now)
  return {
    directory,
    diagnostics,
    advance(value: number) {
      now += value
    },
  }
}

test("Given sensitive error text, diagnostics retain only bounded metadata and reset consecutive failures on capture", async () => {
  const { directory, diagnostics, advance } = await fixture()
  try {
    const error = Object.assign(new Error("https://private.invalid/?key=secret"), {
      code: "E_CAPTURE",
    })
    diagnostics.recordError("capture", error)
    advance(10)
    diagnostics.recordError("capture", error)
    expect(diagnostics.getSnapshot()).toEqual({
      last_error: {
        name: "Error",
        code: "E_CAPTURE",
        stage: "capture",
        timestamp: 1_010,
        consecutive_count: 2,
      },
      last_successful_capture_at: null,
    })
    advance(10)
    diagnostics.recordCaptureSuccess()
    advance(10)
    diagnostics.recordError("summary", new Error("another secret"))
    await diagnostics.flush()
    expect(diagnostics.getSnapshot().last_error?.consecutive_count).toBe(1)
    expect(diagnostics.getSnapshot().last_successful_capture_at).toBe(1_020)
    const log = readFileSync(join(directory, "run", "diagnostics.jsonl"), "utf8")
    expect(log).not.toContain("private.invalid")
    expect(log).not.toContain("secret")
    expect(statSync(join(directory, "run", "diagnostics.jsonl")).mode & 0o777).toBe(0o600)

    const restored = await DaemonDiagnostics.create(directory, () => 2_000)
    expect(restored.getSnapshot()).toEqual(diagnostics.getSnapshot())
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given corrupt rows and a full log, diagnostics ignore damage and rotate within three private files", async () => {
  const { directory, diagnostics } = await fixture()
  const run = join(directory, "run")
  mkdirSync(run, { recursive: true })
  const active = join(run, "diagnostics.jsonl")
  writeFileSync(active, `not-json\n${"x".repeat(262_144)}`)
  writeFileSync(join(run, "diagnostics.jsonl.1"), "old\n")
  writeFileSync(join(run, "diagnostics.jsonl.2"), "older\n")
  try {
    diagnostics.recordError("daemon", new Error("not persisted"))
    await diagnostics.flush()
    expect(readFileSync(active, "utf8")).toContain('"name":"Error"')
    expect(readFileSync(join(run, "diagnostics.jsonl.1"), "utf8")).toContain("not-json")
    expect(statSync(active).mode & 0o777).toBe(0o600)
    const restored = await DaemonDiagnostics.create(directory)
    expect(restored.getSnapshot().last_error?.consecutive_count).toBe(1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
