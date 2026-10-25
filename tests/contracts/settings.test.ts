import { expect, test } from "bun:test"
import { SettingsPatchSchema, SettingsSchema } from "../../src/contracts/settings"

test("Given minimal v2 settings, when parsed, then approved defaults are applied", () => {
  const result = SettingsSchema.safeParse({ version: 2, contextAwareness: {} })
  expect(result.success).toBe(true)
  if (result.success) {
    expect(result.data).toMatchObject({
      version: 2,
      uiLanguage: "ko",
      contextAwareness: {
        enabled: false,
        pausedUntil: null,
        rules: [],
        retentionDays: 14,
        captureTypedText: true,
        screenOcr: true,
        asideAdapter: false,
        browserHistoryEnabled: false,
      },
      providers: [],
      summary: {
        modelOverrides: [
          {
            match: "^gpt-\\d+(\\.\\d+)*-luna(-\\d{8})?$",
            reasoningEffort: "high",
            fastMode: false,
          },
          { match: "^claude-haiku-", reasoningEffort: "high", fastMode: false },
        ],
      },
    })
  }
})

test("Given saved v2 settings without a language, when parsed, then Korean is the migration default", () => {
  const existing = SettingsSchema.parse({ version: 2, contextAwareness: { enabled: true } })
  expect(existing.uiLanguage).toBe("ko")
  expect(existing.contextAwareness.enabled).toBe(true)
})

test("Given a UI language patch, when parsed, then only Korean or English is accepted", () => {
  expect(SettingsPatchSchema.parse({ uiLanguage: "en" })).toEqual({ uiLanguage: "en" })
  expect(SettingsPatchSchema.parse({ uiLanguage: "ko" })).toEqual({ uiLanguage: "ko" })
  expect(SettingsPatchSchema.safeParse({ uiLanguage: "fr" }).success).toBe(false)
})

test.each([
  { version: 1, contextAwareness: {} },
  { version: 2, contextAwareness: { retentionDays: 31 } },
  {
    version: 2,
    contextAwareness: {
      rules: Array(501).fill({ scope: "app", behavior: "observe", bundleId: "com.example.App" }),
    },
  },
  {
    version: 2,
    contextAwareness: {
      rules: [{ scope: "url", behavior: "do_not_observe", urlDomain: "https://example.com" }],
    },
  },
  {
    version: 2,
    contextAwareness: {},
    providers: [{ id: "p", baseUrl: "https://example.com", models: [], apiKey: "secret" }],
  },
])("Given an invalid v2 setting, when parsed, then it is rejected", (value) => {
  expect(SettingsSchema.safeParse(value).success).toBe(false)
})

test("Given a provider with no explicit booleans, when parsed, then consent stays off", () => {
  const result = SettingsSchema.safeParse({
    version: 2,
    contextAwareness: {},
    providers: [{ id: "p", baseUrl: "https://example.com", models: ["model"] }],
  })
  expect(result.success).toBe(true)
  if (result.success)
    expect(result.data).toMatchObject({
      providers: [{ supportsToolChoice: true, allowEvidence: false }],
    })
})

test("Given duplicate provider IDs across kinds, when settings or a patch is parsed, then both are rejected", () => {
  const providers = [
    { id: "p", baseUrl: "https://first.fixture.invalid/v1", models: ["m"] },
    { id: "p", kind: "claude-code-cli", models: ["claude-synthetic"] },
  ]
  expect(SettingsSchema.safeParse({ version: 2, contextAwareness: {}, providers }).success).toBe(
    false,
  )
  expect(SettingsPatchSchema.safeParse({ providers }).success).toBe(false)
})

test("Given a Claude Code CLI provider, when parsed, then consent defaults off and URL/key/command settings are rejected", () => {
  const record = {
    id: "claude",
    kind: "claude-code-cli" as const,
    models: ["claude-sonnet-4-6"],
  }
  const parsed = SettingsSchema.parse({
    version: 2,
    contextAwareness: {},
    providers: [record],
  })
  expect(parsed.providers[0]).toEqual({ ...record, allowEvidence: false })
  for (const extra of [
    { baseUrl: "https://example.invalid/v1" },
    { apiKeyRef: "provider/claude" },
    { command: "/tmp/claude" },
    { supportsToolChoice: true },
  ]) {
    expect(
      SettingsSchema.safeParse({
        version: 2,
        contextAwareness: {},
        providers: [{ ...record, ...extra }],
      }).success,
    ).toBe(false)
  }
  expect(SettingsPatchSchema.safeParse({ providers: [record] }).success).toBe(true)
})

test("Given a Codex login provider, when parsed, then consent defaults off and API credentials are rejected", () => {
  const record = {
    id: "codex",
    kind: "codex-cli" as const,
    models: ["gpt-6-luna"],
  }
  const parsed = SettingsSchema.parse({ version: 2, contextAwareness: {}, providers: [record] })
  expect(parsed.providers[0]).toEqual({ ...record, allowEvidence: false })
  for (const extra of [
    { baseUrl: "https://api.openai.com/v1" },
    { apiKeyRef: "provider/codex" },
    { command: "/tmp/codex" },
  ]) {
    expect(
      SettingsSchema.safeParse({
        version: 2,
        contextAwareness: {},
        providers: [{ ...record, ...extra }],
      }).success,
    ).toBe(false)
  }
})

test("Given separate settings parses, when defaults are created, then mutable lists are independent", () => {
  const first = SettingsSchema.parse({ version: 2, contextAwareness: {} })
  const second = SettingsSchema.parse({ version: 2, contextAwareness: {} })
  expect(first.contextAwareness.rules).not.toBe(second.contextAwareness.rules)
  expect(first.providers).not.toBe(second.providers)
  expect(first.summary.modelOverrides).not.toBe(second.summary.modelOverrides)
})

test("Given a flat camelCase UI patch, when parsed, then only the selected leaves are accepted", () => {
  expect(SettingsPatchSchema.safeParse({ enabled: true, screenOcr: false }).success).toBe(true)
  expect(SettingsPatchSchema.safeParse({ contextAwareness: { enabled: true } }).success).toBe(false)
  expect(SettingsPatchSchema.safeParse({ version: 1 }).success).toBe(false)
})

test("Given URL rules with DNS trailing dots, when settings and patches are parsed, then canonical hostnames are stored", () => {
  const rule = { scope: "url", behavior: "do_not_observe", urlDomain: "Mail.Example.COM." } as const
  expect(
    SettingsSchema.parse({ version: 2, contextAwareness: { rules: [rule] } }).contextAwareness
      .rules,
  ).toEqual([{ ...rule, urlDomain: "mail.example.com" }])
  expect(SettingsPatchSchema.parse({ rules: [rule] }).rules).toEqual([
    { ...rule, urlDomain: "mail.example.com" },
  ])
  expect(SettingsPatchSchema.parse({ browserHistoryEnabled: true })).toEqual({
    browserHistoryEnabled: true,
  })
})

test("Given a disk-only retention value, when parsed through each boundary, then only disk settings allow it", () => {
  expect(
    SettingsSchema.safeParse({ version: 2, contextAwareness: { retentionDays: 2 } }).success,
  ).toBe(true)
  expect(SettingsPatchSchema.safeParse({ retentionDays: 2 }).success).toBe(false)
})
