import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSettingsHandlers } from "../../src/api/resources/settings"
import { handleRpcBody } from "../../src/api/rpc"
import { loadSettings, saveSettings } from "../../src/config/index"
import { type Settings, SettingsSchema } from "../../src/contracts/settings"

function apiKeyRefOf(provider: Settings["providers"][number] | undefined): string | undefined {
  return provider?.kind === "claude-code-cli" || provider?.kind === "codex-cli"
    ? undefined
    : provider?.apiKeyRef
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "side-api-settings-"))
  let current = SettingsSchema.parse({
    version: 2,
    contextAwareness: { enabled: false, retentionDays: 14 },
    defaultModel: { provider: "synthetic", modelId: "default" },
    providers: [
      {
        id: "synthetic",
        baseUrl: "https://provider.fixture.invalid/v1",
        apiKeyRef: "synthetic-keychain-ref-private",
        models: ["default", "summary"],
        allowEvidence: false,
      },
    ],
  })
  await saveSettings(directory, current)
  const applied: Settings[] = []
  const handlers = createSettingsHandlers({
    directory,
    reconciler: {
      get currentSettings() {
        return current
      },
      async settingsPatched(next) {
        applied.push(next)
        current = next
      },
    },
  })
  return { directory, handlers, applied, current: () => current }
}

function rpc(method: string, params?: unknown) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    ...(params === undefined ? {} : { params }),
  })
}

test("P4-R2-T1: settings.get exposes provider host and has_key without the Keychain ref", async () => {
  const { directory, handlers } = await fixture()
  try {
    const response = await handleRpcBody(rpc("settings.get"), handlers)
    expect(response).toMatchObject({
      result: {
        enabled: false,
        ui_language: "ko",
        retention_days: 14,
        providers: [
          {
            id: "synthetic",
            host: "provider.fixture.invalid",
            has_key: true,
            test_result: null,
          },
        ],
      },
    })
    expect(JSON.stringify(response)).not.toContain("synthetic-keychain-ref-private")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given browser history remains off by default, when enabled through RPC, then the independent setting persists", async () => {
  const { directory, handlers } = await fixture()
  try {
    expect(await handleRpcBody(rpc("settings.get"), handlers)).toMatchObject({
      result: { browser_history_enabled: false },
    })
    expect(
      await handleRpcBody(rpc("settings.patch", { browserHistoryEnabled: true }), handlers),
    ).toMatchObject({ result: { browser_history_enabled: true, enabled: false } })
    expect((await loadSettings(directory)).contextAwareness.browserHistoryEnabled).toBe(true)
    expect((await loadSettings(directory)).contextAwareness.enabled).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given an existing settings file, when language is patched, then the root choice persists and reads back", async () => {
  const { directory, handlers } = await fixture()
  try {
    const response = await handleRpcBody(rpc("settings.patch", { uiLanguage: "en" }), handlers)
    expect(response).toMatchObject({ result: { ui_language: "en" } })
    expect(await handleRpcBody(rpc("settings.get"), handlers)).toMatchObject({
      result: { ui_language: "en" },
    })
    expect((await loadSettings(directory)).uiLanguage).toBe("en")
    expect((await loadSettings(directory)).contextAwareness.enabled).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given a pre-language settings file, when loaded, then Korean defaults without changing other fields", async () => {
  const { directory } = await fixture()
  try {
    const filename = join(directory, "settings.json")
    const oldSettings = SettingsSchema.parse({
      version: 2,
      contextAwareness: { enabled: true, retentionDays: 7 },
    })
    const { uiLanguage: _uiLanguage, ...legacyShape } = oldSettings
    writeFileSync(filename, JSON.stringify(legacyShape))
    const loaded = await loadSettings(directory)
    expect(loaded.uiLanguage).toBe("ko")
    expect(loaded.contextAwareness.enabled).toBe(true)
    expect(loaded.contextAwareness.retentionDays).toBe(7)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("P4-R2-T1: invalid retention choice is rejected before write or reconcile", async () => {
  const { directory, handlers, applied } = await fixture()
  try {
    const file = join(directory, "settings.json")
    const before = readFileSync(file, "utf8")
    const response = await handleRpcBody(rpc("settings.patch", { retentionDays: 5 }), handlers)
    expect(response).toMatchObject({ error: { code: -32602 } })
    expect(readFileSync(file, "utf8")).toBe(before)
    expect(applied).toHaveLength(0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given duplicate provider IDs, settings.patch rejects them before write or reconcile", async () => {
  const { directory, handlers, applied } = await fixture()
  try {
    const file = join(directory, "settings.json")
    const before = readFileSync(file, "utf8")
    const response = await handleRpcBody(
      rpc("settings.patch", {
        providers: [
          { id: "p", baseUrl: "https://first.fixture.invalid/v1", models: ["m"] },
          { id: "p", baseUrl: "https://second.fixture.invalid/v1", models: ["m"] },
        ],
      }),
      handlers,
    )
    expect(response).toMatchObject({ error: { code: -32602 } })
    expect(readFileSync(file, "utf8")).toBe(before)
    expect(applied).toHaveLength(0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("P4-R2-T1: a partial patch preserves unrelated settings, saves atomically and reconciles", async () => {
  const { directory, handlers, applied, current } = await fixture()
  try {
    const response = await handleRpcBody(
      rpc("settings.patch", {
        enabled: true,
        retentionDays: 7,
        captureTypedText: false,
        summaryModel: { provider: "synthetic", modelId: "summary" },
      }),
      handlers,
    )
    expect(response).toMatchObject({
      result: {
        enabled: true,
        retention_days: 7,
        capture_typed_text: false,
        screen_ocr: true,
        summary_model: { provider: "synthetic", modelId: "summary" },
      },
    })
    expect(applied).toHaveLength(1)
    expect(current().contextAwareness.rules).toEqual([])
    expect((await loadSettings(directory)).contextAwareness.retentionDays).toBe(7)
    expect(apiKeyRefOf((await loadSettings(directory)).providers[0])).toBe(
      "synthetic-keychain-ref-private",
    )
    const choice = await handleRpcBody(rpc("summaryModelDefault"), handlers)
    expect(choice).toMatchObject({
      result: { model: { provider: "synthetic", modelId: "summary" }, source: "summaryModel" },
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("P4-R2-T1: clearing the summary override falls back to default and patching default null clears it", async () => {
  const { directory, handlers } = await fixture()
  try {
    await handleRpcBody(
      rpc("settings.patch", { summaryModel: { provider: "synthetic", modelId: "summary" } }),
      handlers,
    )
    await handleRpcBody(rpc("settings.patch", { summaryModel: null }), handlers)
    expect(await handleRpcBody(rpc("summaryModelDefault"), handlers)).toMatchObject({
      result: { model: { provider: "synthetic", modelId: "default" }, source: "defaultModel" },
    })
    await handleRpcBody(rpc("settings.patch", { defaultModel: null }), handlers)
    expect(await handleRpcBody(rpc("summaryModelDefault"), handlers)).toMatchObject({
      result: { model: null, source: "none" },
    })
    const stored = await loadSettings(directory)
    expect(stored.contextAwareness.summaryModel).toBeUndefined()
    expect(stored.defaultModel).toBeUndefined()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("P4-R2-T1: settings.patch cannot write a supplied API key reference or leak it in output", async () => {
  const { directory, handlers } = await fixture()
  try {
    const raw = "synthetic-raw-key-should-never-persist"
    const response = await handleRpcBody(
      rpc("settings.patch", {
        providers: [
          {
            id: "synthetic",
            baseUrl: "https://provider.fixture.invalid/v1",
            models: ["default"],
            apiKeyRef: raw,
          },
        ],
      }),
      handlers,
    )
    expect(response).toMatchObject({ result: { providers: [{ has_key: true }] } })
    expect(readFileSync(join(directory, "settings.json"), "utf8")).not.toContain(raw)
    expect(JSON.stringify(response)).not.toContain(raw)
    expect(apiKeyRefOf((await loadSettings(directory)).providers[0])).toBe(
      "synthetic-keychain-ref-private",
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("P4-R2-T1: concurrent partial patches retain both independent changes", async () => {
  const { directory, handlers } = await fixture()
  try {
    await Promise.all([
      handleRpcBody(rpc("settings.patch", { captureTypedText: false }), handlers),
      handleRpcBody(rpc("settings.patch", { screenOcr: false }), handlers),
    ])
    const stored = await loadSettings(directory)
    expect(stored.contextAwareness.captureTypedText).toBe(false)
    expect(stored.contextAwareness.screenOcr).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Claude Code CLI provider patches and reads without a URL or Keychain reference", async () => {
  const { directory, handlers } = await fixture()
  try {
    const response = await handleRpcBody(
      rpc("settings.patch", {
        providers: [
          {
            id: "Claude Code",
            kind: "claude-code-cli",
            models: ["claude-sonnet-4-5"],
            allowEvidence: false,
          },
        ],
      }),
      handlers,
    )
    expect(response).toMatchObject({
      result: {
        providers: [
          {
            id: "Claude Code",
            kind: "claude-code-cli",
            base_url: null,
            host: "Claude Code service",
            models: ["claude-sonnet-4-5"],
            allow_evidence: false,
            has_key: false,
          },
        ],
      },
    })
    const saved = (await loadSettings(directory)).providers[0]
    expect(saved).toEqual({
      id: "Claude Code",
      kind: "claude-code-cli",
      models: ["claude-sonnet-4-5"],
      allowEvidence: false,
    })
    expect(JSON.stringify(response)).not.toContain("synthetic-keychain-ref-private")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Codex CLI provider patches and reads without a URL or Keychain reference", async () => {
  const { directory, handlers } = await fixture()
  try {
    const response = await handleRpcBody(
      rpc("settings.patch", {
        providers: [
          {
            id: "OpenAI (Codex login)",
            kind: "codex-cli",
            models: ["gpt-6-luna"],
            allowEvidence: false,
          },
        ],
      }),
      handlers,
    )
    expect(response).toMatchObject({
      result: {
        providers: [
          {
            id: "OpenAI (Codex login)",
            kind: "codex-cli",
            base_url: null,
            host: "OpenAI (Codex login)",
            has_key: false,
            allow_evidence: false,
          },
        ],
      },
    })
    expect((await loadSettings(directory)).providers[0]).toEqual({
      id: "OpenAI (Codex login)",
      kind: "codex-cli",
      models: ["gpt-6-luna"],
      allowEvidence: false,
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Changing a provider URL detaches its old Keychain key", async () => {
  const { directory, handlers } = await fixture()
  try {
    const response = await handleRpcBody(
      rpc("settings.patch", {
        providers: [
          {
            id: "synthetic",
            baseUrl: "https://different.fixture.invalid/v1",
            models: ["default"],
            supportsToolChoice: true,
            allowEvidence: false,
          },
        ],
      }),
      handlers,
    )
    expect(response).toMatchObject({ result: { providers: [{ has_key: false }] } })
    expect(apiKeyRefOf((await loadSettings(directory)).providers[0])).toBeUndefined()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
