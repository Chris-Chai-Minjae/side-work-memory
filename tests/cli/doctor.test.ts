import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runDoctor } from "../../src/cli/doctor"

test("Given a missing custom SQLite path, doctor reports FAIL, remediation, and exit 1", async () => {
  const lines: string[] = []
  const result = await runDoctor({
    write: (line) => lines.push(line),
    checkCustomSqlite: () => false,
    checkVec0: () => false,
    checkModelCache: () => true,
    async rpc(method) {
      if (method === "status") return { health: { pid: 10 }, stop_reason: null }
      if (method === "permissions")
        return { accessibility: true, input_monitoring: true, screen_recording: true }
      if (method === "settings.get") return { screen_ocr: false, providers: [] }
      throw new TypeError(`Unexpected ${method}`)
    },
  })
  expect(result).toBe(1)
  expect(lines.join("\n")).toContain("FAIL custom SQLite")
  expect(lines.join("\n")).toContain("Install or bundle libsqlite3.dylib")
  expect(lines.join("\n")).toContain("SKIP provider connection")
})

test("Given connected helper, permissions, cache, SQLite, vec0 and a synthetic provider probe, doctor passes", async () => {
  const calls: string[] = []
  const lines: string[] = []
  const result = await runDoctor({
    write: (line) => lines.push(line),
    checkCustomSqlite: () => true,
    checkVec0: () => true,
    checkModelCache: () => true,
    async rpc(method, params) {
      calls.push(method)
      if (method === "status") return { health: { pid: 10 }, stop_reason: null }
      if (method === "permissions")
        return { accessibility: true, input_monitoring: true, screen_recording: true }
      if (method === "settings.get")
        return {
          screen_ocr: true,
          summary_model: { provider: "synthetic", modelId: "probe-model" },
          providers: [{ id: "synthetic", has_key: true, models: ["probe-model"] }],
        }
      if (method === "providers.test") {
        expect(params).toEqual({ providerId: "synthetic", modelId: "probe-model" })
        return { ok: true, toolChoiceSupported: true }
      }
      throw new TypeError(`Unexpected ${method}`)
    },
  })
  expect(result).toBe(0)
  expect(calls).toEqual(["status", "settings.get", "permissions", "providers.test"])
  expect(lines.filter((line) => line.startsWith("PASS"))).toHaveLength(6)
})

test("Given a selected Codex CLI login provider, when its synthetic probe succeeds, then doctor passes without a Keychain key", async () => {
  const lines: string[] = []
  const calls: string[] = []
  const result = await runDoctor({
    write: (line) => lines.push(line),
    checkCustomSqlite: () => true,
    checkVec0: () => true,
    checkModelCache: () => true,
    async rpc(method, params) {
      calls.push(method)
      if (method === "status") return { health: { pid: 10 }, stop_reason: null }
      if (method === "permissions") return { accessibility: true, input_monitoring: true }
      if (method === "settings.get")
        return {
          screen_ocr: false,
          summary_model: { provider: "codex", modelId: "gpt-test" },
          providers: [{ id: "codex", kind: "codex-cli", has_key: false, models: ["gpt-test"] }],
        }
      if (method === "providers.test") {
        expect(params).toEqual({ providerId: "codex", modelId: "gpt-test" })
        return { ok: true }
      }
      throw new TypeError(`Unexpected ${method}`)
    },
  })
  expect(result).toBe(0)
  expect(calls).toContain("providers.test")
  expect(lines.join("\n")).toContain("PASS provider connection")
})

test("Given a working selected provider and an unset fallback key, when checked, then fallback is skipped without failing doctor", async () => {
  const lines: string[] = []
  const calls: string[] = []
  const result = await runDoctor({
    write: (line) => lines.push(line),
    checkCustomSqlite: () => true,
    checkVec0: () => true,
    checkModelCache: () => true,
    async rpc(method) {
      calls.push(method)
      if (method === "status") return { health: { pid: 10 }, stop_reason: null }
      if (method === "permissions") return { accessibility: true, input_monitoring: true }
      if (method === "settings.get")
        return {
          screen_ocr: false,
          summary_model: { provider: "primary", modelId: "test-model" },
          providers: [
            { id: "primary", kind: "openai-compatible", has_key: true, models: ["test-model"] },
            { id: "fallback", kind: "openai-compatible", has_key: false, models: ["other"] },
          ],
        }
      if (method === "providers.test") return { ok: true }
      throw new TypeError(`Unexpected ${method}`)
    },
  })
  expect(result).toBe(0)
  expect(calls.filter((method) => method === "providers.test")).toHaveLength(1)
  expect(lines.join("\n")).toContain("SKIP provider fallback (openai-compatible): API key not set")
  expect(lines.join("\n")).toContain("PASS provider connection")
})

test("Given a selected provider whose synthetic probe fails, when checked, then doctor fails without printing the response", async () => {
  const lines: string[] = []
  const result = await runDoctor({
    write: (line) => lines.push(line),
    checkCustomSqlite: () => true,
    checkVec0: () => true,
    checkModelCache: () => true,
    async rpc(method) {
      if (method === "status") return { health: { pid: 10 }, stop_reason: null }
      if (method === "permissions") return { accessibility: true, input_monitoring: true }
      if (method === "settings.get")
        return {
          screen_ocr: false,
          default_model: { provider: "primary", modelId: "test-model" },
          providers: [
            { id: "primary", kind: "openai-compatible", has_key: true, models: ["test-model"] },
          ],
        }
      if (method === "providers.test")
        return { ok: false, error: "synthetic-secret-should-not-appear" }
      throw new TypeError(`Unexpected ${method}`)
    },
  })
  expect(result).toBe(1)
  expect(lines.join("\n")).toContain("FAIL provider connection")
  expect(lines.join("\n")).not.toContain("synthetic-secret-should-not-appear")
})

test("Given daemon diagnostics, doctor prints only operational metadata and the last capture time", async () => {
  const lines: string[] = []
  await runDoctor({
    write: (line) => lines.push(line),
    checkCustomSqlite: () => true,
    checkVec0: () => true,
    checkModelCache: () => true,
    async rpc(method) {
      if (method === "status")
        return {
          health: { pid: 10 },
          stop_reason: null,
          diagnostics: {
            last_error: {
              name: "TypeError",
              code: "E_CAPTURE",
              stage: "capture",
              timestamp: 1_000,
              consecutive_count: 2,
            },
            last_successful_capture_at: 900,
          },
        }
      if (method === "permissions")
        return { accessibility: true, input_monitoring: true, screen_recording: true }
      if (method === "settings.get") return { screen_ocr: false, providers: [] }
      throw new TypeError(`Unexpected ${method}`)
    },
  })
  expect(lines.join("\n")).toContain("WARN daemon diagnostics")
  expect(lines.join("\n")).toContain("TypeError/E_CAPTURE")
  expect(lines.join("\n")).toContain("consecutive 2")
  expect(lines.join("\n")).toContain("1970-01-01T00:00:00.900Z")
})

test("Given missing required TCC permissions, doctor fails without requesting them", async () => {
  const lines: string[] = []
  const calls: string[] = []
  const result = await runDoctor({
    write: (line) => lines.push(line),
    checkCustomSqlite: () => true,
    checkVec0: () => true,
    checkModelCache: () => true,
    async rpc(method) {
      calls.push(method)
      if (method === "status") return { health: { pid: 10 }, stop_reason: null }
      if (method === "permissions")
        return { accessibility: false, input_monitoring: true, screen_recording: false }
      if (method === "settings.get") return { screen_ocr: false, providers: [] }
      throw new TypeError(`Unexpected ${method}`)
    },
  })
  expect(result).toBe(1)
  expect(lines.join("\n")).toContain("FAIL permissions")
  expect(calls).not.toContain("requestPermissions")
})

test("Given an isolated empty Side root, the real CLI doctor exits 1 without creating a ledger", () => {
  const directory = mkdtempSync(join(tmpdir(), "side-cli-doctor-process-"))
  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "src/cli.ts", "doctor"],
      env: { ...process.env, SIDE_DATA_DIR: directory, LCA_DATA_DIR: directory },
      stdin: "ignore",
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain("FAIL Keychain")
    expect(result.stdout.toString()).toContain("FAIL model cache")
    expect(existsSync(join(directory, "context-awareness", "ledger.db"))).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
