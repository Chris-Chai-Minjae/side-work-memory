import { afterEach, beforeEach, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { z } from "zod"
import { mountApp } from "../../src/web/main"
import { routeFromHash } from "../../src/web/router"
import type { FetchLike } from "../../src/web/rpc-client"

const summaryId = "01K5Z5V6Z6Z6Z6Z6Z6Z6Z6Z6Z6"
const providerId = "local"
const ProviderPatchSchema = z.array(
  z.union([
    z.object({
      id: z.string(),
      baseUrl: z.string().url(),
      models: z.array(z.string()),
      supportsToolChoice: z.boolean(),
      allowEvidence: z.boolean(),
    }),
    z.object({
      id: z.string(),
      kind: z.literal("claude-code-cli"),
      models: z.array(z.string()),
      allowEvidence: z.boolean(),
    }),
    z.object({
      id: z.string(),
      kind: z.literal("codex-cli"),
      models: z.array(z.string()),
      allowEvidence: z.boolean(),
    }),
  ]),
)
let browser: Window
let calls: { method: string; params: unknown }[]
let settings: Record<string, unknown>
let modelListing: unknown
const originalGlobals = new Map(
  (["window", "document", "Event", "KeyboardEvent"] as const).map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]),
)

beforeEach(() => {
  browser = new Window({
    url: "http://127.0.0.1:49152/?t=synthetic-token#/settings/context-awareness",
  })
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser })
  Object.defineProperty(globalThis, "document", { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, "Event", { configurable: true, value: browser.Event })
  Object.defineProperty(globalThis, "KeyboardEvent", {
    configurable: true,
    value: browser.KeyboardEvent,
  })
  calls = []
  modelListing = { status: "available", models: ["alpha", "beta"] }
  settings = {
    ui_language: "en",
    enabled: true,
    capture_typed_text: true,
    screen_ocr: false,
    aside_adapter: true,
    browser_history_enabled: false,
    retention_days: 14,
    rules: [{ scope: "app", behavior: "do_not_observe", bundleId: "com.example.Secret" }],
    summary_model: { provider: providerId, modelId: "small" },
    default_model: null,
    providers: [
      {
        id: providerId,
        base_url: "http://127.0.0.1:11434/v1",
        host: "127.0.0.1",
        models: ["small"],
        supports_tool_choice: true,
        allow_evidence: false,
        has_key: true,
        test_result: null,
      },
    ],
  }
})

afterEach(() => {
  browser.happyDOM.abort()
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
})

function response(method: string, params: unknown): unknown {
  switch (method) {
    case "status":
      return {
        enabled: true,
        state: "running",
        paused_until: null,
        banner: "none",
        health: { asideAdapter: "available" },
        stop_reason: null,
      }
    case "permissions":
    case "requestPermissions":
      return {
        accessibility: true,
        input_monitoring: true,
        screen_recording: false,
        automation: {},
      }
    case "settings.get":
      return settings
    case "settings.patch": {
      const patch = z.record(z.string(), z.unknown()).parse(params)
      for (const [key, value] of Object.entries(patch)) {
        if (key === "providers") {
          settings["providers"] = ProviderPatchSchema.parse(value).map((provider) =>
            "baseUrl" in provider
              ? {
                  id: provider.id,
                  base_url: provider.baseUrl,
                  host: new URL(provider.baseUrl).host,
                  models: provider.models,
                  supports_tool_choice: provider.supportsToolChoice,
                  allow_evidence: provider.allowEvidence,
                  has_key: true,
                  test_result: null,
                }
              : {
                  id: provider.id,
                  kind: provider.kind,
                  base_url: null,
                  host: "Claude Code service",
                  models: provider.models,
                  supports_tool_choice: false,
                  allow_evidence: provider.allowEvidence,
                  has_key: false,
                  test_result: null,
                },
          )
          continue
        }
        const resourceKey =
          key === "captureTypedText"
            ? "capture_typed_text"
            : key === "screenOcr"
              ? "screen_ocr"
              : key === "asideAdapter"
                ? "aside_adapter"
                : key === "browserHistoryEnabled"
                  ? "browser_history_enabled"
                  : key === "retentionDays"
                    ? "retention_days"
                    : key === "summaryModel"
                      ? "summary_model"
                      : key === "uiLanguage"
                        ? "ui_language"
                        : key
        settings[resourceKey] = value
      }
      return settings
    }
    case "summaryModelDefault":
      return { model: { provider: providerId, modelId: "small" }, source: "summaryModel" }
    case "historyStatus":
      return {
        store_bytes: 1024,
        average_bytes_per_day: 512,
        days_with_summaries: ["2026-09-24"],
        today_summary_states: { pending: 0, running: 0, done: 1, failed: 0, skipped: 0 },
      }
    case "historyList":
      return [
        {
          id: summaryId,
          kind: "10min",
          window_from: Date.parse("2026-09-24T09:00:00Z"),
          window_to: Date.parse("2026-09-24T09:10:00Z"),
          title: "Review notes",
          description: "Read sqlite notes",
          status: "done",
          citations: [],
        },
        {
          id: "01K5Z5V6Z6Z6Z6Z6Z6Z6Z6Z6Z7",
          kind: "6h",
          window_from: Date.parse("2026-09-24T06:00:00Z"),
          window_to: Date.parse("2026-09-24T12:00:00Z"),
          title: "Day overview",
          description: "Six-hour digest",
          status: "done",
          citations: [],
        },
      ]
    case "listApplications":
      return [
        { bundle_id: "com.example.Secret", name: "Secret", denied: true },
        { bundle_id: "com.example.Mail", name: "Mail", denied: false },
      ]
    case "appIcons":
      return []
    case "mcp.usage":
      return [{ client_name: "Claude Code", calls: { memory_search: 3 }, avg_latency_ms: 12 }]
    case "clear":
      return { deleted_events: 2, deleted_summaries: 1, deletion_epoch: 2 }
    case "providers.setKey":
      return { apiKeyRef: "keychain:synthetic" }
    case "providers.listModels":
      return modelListing
    case "providers.test":
      return { ok: true, latencyMs: 12, toolChoiceSupported: true }
    case "pause":
      return { paused_until: Number.MAX_SAFE_INTEGER }
    case "resume":
      return null
    default:
      throw new Error(`Unexpected RPC method ${method}`)
  }
}

const fakeFetch: FetchLike = async (_input, init) => {
  const packet = JSON.parse(String(init?.body))
  calls.push({ method: packet.method, params: packet.params })
  return Response.json({
    jsonrpc: "2.0",
    id: packet.id,
    result: response(packet.method, packet.params),
  })
}

function root(): HTMLDivElement {
  const element = document.createElement("div")
  document.body.append(element)
  return element
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 2))
}

function click(element: Element, selector: string): void {
  const button = element.querySelector<HTMLButtonElement>(selector)
  if (!button) throw new Error(`Missing button ${selector}`)
  button.click()
}

function change(element: Element, selector: string, value: string): void {
  const input = element.querySelector<HTMLInputElement | HTMLSelectElement>(selector)
  if (!input) throw new Error(`Missing input ${selector}`)
  input.value = value
  input.dispatchEvent(new Event("input", { bubbles: true }))
  input.dispatchEvent(new Event("change", { bubbles: true }))
}

test("renders S2 approved section and explanatory copy when RPC is ready", async () => {
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  expect(element.querySelector(".settings-page h1")?.textContent).toBe("Let Side remember your day")
  expect(element.querySelector(".settings-intro")?.textContent).toBe(
    "Side captures what you do in your browser and apps so agents can recall it later.",
  )
  expect(
    Array.from(element.querySelectorAll(".settings-section h2"), (heading) => heading.textContent),
  ).toEqual(["Capture", "Denylist", "Summaries", "History", "Connect agents"])
  expect(
    Array.from(element.querySelectorAll(".settings-copy"), (copy) => copy.textContent),
  ).toEqual([
    "Save the sentences you type. Side never stores keystrokes or password fields.",
    "When a page has no readable text, read it from the screen. Only the text is kept.",
    "When Aside Browser is in front, read the page through Aside for better text. Requires the Aside CLI.",
    "Off by default. When enabled, agents can search supported browser history. Side redacts sensitive data and respects your denylist.",
    "Side never captures what you do in these apps and websites.",
    "Side deletes raw captures after this many days. Summaries stay.",
  ])
  expect(element.textContent).toContain("History storage usage")
  expect(
    Array.from(element.querySelectorAll("#retention-days option"), (option) => option.textContent),
  ).toEqual(["1 day", "3 days", "7 days", "14 days", "30 days"])
  expect(element.querySelector(".provider-row")?.textContent).toContain(
    "Send evidence to this provider",
  )
  expect(element.querySelector(".provider-row .setting-meta")?.textContent).toContain("1 model")
  expect(element.querySelector(".provider-row .setting-meta")?.textContent).not.toContain(
    "1 models",
  )
  expect(element.textContent).toContain(
    "claude mcp add --scope user side -- '/Applications/Side.app/Contents/Resources/side' mcp",
  )
  expect(element.innerHTML).not.toContain("synthetic-token")
})

test("Given Korean settings, when the language selector changes, then the entire page and navigation switch and persist", async () => {
  settings["ui_language"] = "ko"
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  expect(element.querySelector(".settings-page h1")?.textContent).toBe("Side가 하루를 기억하도록")
  expect(element.querySelector('[aria-label="주 탐색"]')?.textContent).toContain("설정")
  expect(element.textContent).toContain("기록 보관 기간")
  expect(element.textContent).not.toContain("History storage usage")
  expect(element.querySelector<HTMLSelectElement>("#ui-language")?.value).toBe("ko")

  change(element, "#ui-language", "en")
  await settle()
  expect(calls.filter((call) => call.method === "settings.patch").at(-1)?.params).toEqual({
    uiLanguage: "en",
  })
  expect(settings["ui_language"]).toBe("en")
  expect(element.querySelector(".settings-page h1")?.textContent).toBe("Let Side remember your day")
  expect(element.querySelector('[aria-label="Main navigation"]')?.textContent).toContain("Settings")
  expect(element.textContent).toContain("History storage usage")

  change(element, "#ui-language", "ko")
  await settle()
  expect(settings["ui_language"]).toBe("ko")
  expect(element.querySelector(".settings-page h1")?.textContent).toBe("Side가 하루를 기억하도록")
})

test("Aside switch persists its value and shows an unchecked health state clearly", async () => {
  settings["ui_language"] = "ko"
  const offHealthFetch: FetchLike = async (_input, init) => {
    const packet = JSON.parse(String(init?.body))
    calls.push({ method: packet.method, params: packet.params })
    const result =
      packet.method === "status"
        ? {
            enabled: true,
            state: "running",
            paused_until: null,
            banner: "none",
            health: { asideAdapter: "off" },
            stop_reason: null,
          }
        : response(packet.method, packet.params)
    return Response.json({ jsonrpc: "2.0", id: packet.id, result })
  }
  const element = root()
  mountApp(element, window, offHealthFetch)
  await settle()
  const row = Array.from(element.querySelectorAll<HTMLElement>(".setting-row")).find((item) =>
    item.textContent?.includes("Aside Browser 페이지 내용 사용"),
  )
  if (!row) throw new Error("Missing Aside setting")
  const toggle = row.querySelector<HTMLButtonElement>('[role="switch"]')
  if (!toggle) throw new Error("Missing Aside switch")
  expect(toggle.getAttribute("aria-checked")).toBe("true")
  expect(row.querySelector(".setting-meta")?.textContent).toBe("아직 확인 전")

  toggle.click()
  await settle()
  expect(calls.filter((call) => call.method === "settings.patch").at(-1)?.params).toEqual({
    asideAdapter: false,
  })
  expect(toggle.getAttribute("aria-checked")).toBe("false")
  expect(row.querySelector(".setting-meta")?.textContent).toBe("꺼짐")

  toggle.click()
  await settle()
  expect(calls.filter((call) => call.method === "settings.patch").at(-1)?.params).toEqual({
    asideAdapter: true,
  })
  expect(toggle.getAttribute("aria-checked")).toBe("true")
  expect(row.querySelector(".setting-meta")?.textContent).toBe("아직 확인 전")
})

test("browser history switch is independent, defaults off, and persists its value", async () => {
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  const toggle = element.querySelector<HTMLButtonElement>(
    '[aria-label="Include browser history in recall"]',
  )
  if (!toggle) throw new Error("Missing browser history switch")
  expect(toggle.getAttribute("aria-checked")).toBe("false")

  toggle.click()
  await settle()

  expect(calls.filter((call) => call.method === "settings.patch").at(-1)?.params).toEqual({
    browserHistoryEnabled: true,
  })
  expect(settings["browser_history_enabled"]).toBe(true)
  expect(settings["enabled"]).toBe(true)
  expect(toggle.getAttribute("aria-checked")).toBe("true")
})

test("asks for missing Input Monitoring permission from the banner", async () => {
  const element = root()
  const permissionFetch: FetchLike = async (_input, init) => {
    const packet = JSON.parse(String(init?.body))
    const result =
      packet.method === "status"
        ? {
            enabled: true,
            state: "running",
            paused_until: null,
            banner: "permissions_needed",
            health: { asideAdapter: "available" },
          }
        : packet.method === "permissions"
          ? {
              accessibility: true,
              input_monitoring: false,
              screen_recording: false,
              automation: {},
            }
          : response(packet.method, packet.params)
    calls.push({ method: packet.method, params: packet.params })
    return Response.json({ jsonrpc: "2.0", id: packet.id, result })
  }
  mountApp(element, window, permissionFetch)
  await settle()
  expect(element.querySelector(".permission-banner")?.textContent).toBe("Permissions neededAllow")
  click(element, ".permission-banner button")
  await settle()
  expect(calls.find((call) => call.method === "requestPermissions")?.params).toEqual({
    kinds: ["inputMonitoring"],
  })
})

test("disable confirmation preserves settings until confirmed", async () => {
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  click(element, '[data-action="toggle-enabled"]')
  await settle()
  expect(element.querySelector('[role="dialog"] h2')?.textContent).toBe(
    "Disable Context Awareness?",
  )
  expect(element.querySelector('[role="dialog"] p')?.textContent).toBe(
    "Side will stop capturing your activity. Existing history stays on this device until it expires or you delete it.",
  )
  expect(calls.filter((call) => call.method === "settings.patch")).toHaveLength(0)
  click(element, '[role="dialog"] [data-action="confirm"]')
  await settle()
  expect(calls.find((call) => call.method === "settings.patch")?.params).toEqual({ enabled: false })
})

test("Never observe normalizes a website before adding a deny rule", async () => {
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  click(element, '[data-action="add-rule"]')
  await settle()
  expect(element.querySelector('[role="dialog"] h2')?.textContent).toBe("Never observe")
  click(element, '[data-action="source-website"]')
  await settle()
  change(element, '[name="website"]', "https://Mail.Example.com./inbox")
  await settle()
  click(element, '[data-action="save-rule"]')
  await settle()
  expect(calls.find((call) => call.method === "settings.patch")?.params).toEqual({
    rules: [
      { scope: "app", behavior: "do_not_observe", bundleId: "com.example.Secret" },
      { scope: "url", urlDomain: "mail.example.com", behavior: "do_not_observe" },
    ],
  })
})

test("Never observe shows searchable app results and excludes denied apps", async () => {
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  click(element, '[data-action="add-rule"]')
  await settle()
  change(element, '[name="application"]', "Mail")
  await settle()
  expect(element.querySelector(".app-picker-list")?.textContent).toContain("Mail")
  expect(element.querySelector(".app-picker-list")?.textContent).not.toContain("Secret")
  click(element, '[data-action="select-app-com.example.Mail"]')
  await settle()
  expect(element.querySelector<HTMLInputElement>('[name="application"]')?.value).toBe(
    "com.example.Mail",
  )
  click(element, '[data-action="save-rule"]')
  await settle()
  click(element, '[data-action="add-rule"]')
  await settle()
  expect(element.querySelector(".app-picker-list")?.textContent).not.toContain("Mail")
})

test("Never observe closes on Escape and restores the Add button focus", async () => {
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  const trigger = element.querySelector<HTMLButtonElement>('[data-action="add-rule"]')
  if (!trigger) throw new Error("Missing Add rule button")
  trigger.focus()
  trigger.click()
  await settle()
  expect(element.querySelector('[role="dialog"]')).not.toBeNull()
  element
    .querySelector('[role="dialog"]')
    ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  await settle()
  expect(element.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

test("custom dialogs keep Tab focus inside and restore their trigger", async () => {
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  const triggers = [
    element.querySelector<HTMLButtonElement>('[data-action="add-rule"]'),
    element.querySelector<HTMLButtonElement>('[data-action="clear-history"]'),
    Array.from(element.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Add provider",
    ),
  ]
  for (const trigger of triggers) {
    if (!trigger) throw new Error("Missing dialog trigger")
    trigger.focus()
    trigger.click()
    await settle()
    const dialog = element.querySelector<HTMLElement>('[role="dialog"]')
    if (!dialog) throw new Error("Missing dialog")
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
      ),
    )
    const first = focusable[0]
    const last = focusable.at(-1)
    if (!first || !last) throw new Error("Missing dialog controls")
    expect(document.activeElement === first).toBe(true)
    last.focus()
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }))
    expect(document.activeElement === first).toBe(true)
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }))
    expect(document.activeElement === last).toBe(true)
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await settle()
    expect(element.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement === trigger).toBe(true)
  }
})

test("provider evidence requires host warning and cancellation preserves false", async () => {
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  click(element, '[data-action="evidence-local"]')
  await settle()
  expect(element.querySelector('[role="dialog"]')?.textContent).toContain(
    "Summaries send redacted activity from each 10-minute window to 127.0.0.1.",
  )
  click(element, '[role="dialog"] [data-action="cancel"]')
  expect(calls.filter((call) => call.method === "settings.patch")).toHaveLength(0)
})

test("provider test result appears beside the provider", async () => {
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  click(element, ".provider-actions button:last-child")
  await settle()
  expect(element.querySelector(".provider-row .provider-test-result")?.textContent).toBe(
    "Test passed",
  )
})

test.each([
  { language: "ko", expected: "제공자 또는 모델이 설정되어 있지 않습니다" },
  { language: "en", expected: "Provider or model is not configured" },
] as const)(
  "Given a failed provider test in $language, when rendered, then its useful error follows the UI language",
  async ({ language, expected }) => {
    settings["ui_language"] = language
    const failingFetch: FetchLike = async (input, init) => {
      const request = JSON.parse(String(init?.body))
      if (request.method !== "providers.test") return fakeFetch(input, init)
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          ok: false,
          latencyMs: 5,
          toolChoiceSupported: false,
          error: "Provider or model is not configured",
        },
      })
    }
    const element = root()
    mountApp(element, window, failingFetch)
    await settle()
    click(element, ".provider-actions button:last-child")
    await settle()
    expect(element.querySelector(".provider-row .provider-test-result")?.textContent).toBe(expected)
  },
)

test("provider key uses the local key method and disappears from the form after saving", async () => {
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  click(element, ".provider-actions button")
  await settle()
  change(element, "#provider-key", "synthetic-secret")
  await settle()
  click(element, '.provider-dialog button[type="submit"]')
  await settle()
  expect(calls.find((call) => call.method === "providers.setKey")?.params).toEqual({
    providerId,
    apiKey: "synthetic-secret",
  })
  expect(calls.find((call) => call.method === "settings.patch")?.params).toEqual({
    providers: [
      {
        id: providerId,
        baseUrl: "http://127.0.0.1:11434/v1",
        models: ["small"],
        supportsToolChoice: true,
        allowEvidence: false,
      },
    ],
  })
  expect(element.innerHTML).not.toContain("synthetic-secret")
})

test("Given a saved Side provider, when discovering models, then IDs are editable before saving", async () => {
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  click(element, '[data-action="discover-local"]')
  await settle()
  expect(calls.find((call) => call.method === "providers.listModels")?.params).toEqual({
    providerId: "local",
  })
  expect(element.querySelector<HTMLInputElement>("#provider-models")?.value).toBe("alpha, beta")
  expect(calls.filter((call) => call.method === "settings.patch")).toHaveLength(0)
  change(element, "#provider-models", "alpha")
  await settle()
  click(element, '.provider-dialog button[type="submit"]')
  await settle()
  expect(calls.find((call) => call.method === "settings.patch")?.params).toMatchObject({
    providers: [{ id: "local", models: ["alpha"] }],
  })
})

test("Given an endpoint without model listing, when discovering, then existing IDs remain editable", async () => {
  modelListing = {
    status: "unavailable",
    models: [],
    reason: "endpoint-unavailable",
    httpStatus: 404,
  }
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  click(element, '[data-action="discover-local"]')
  await settle()
  expect(element.querySelector<HTMLInputElement>("#provider-models")?.value).toBe("small")
  expect(element.querySelector(".provider-dialog [role=alert]")?.textContent).toContain(
    "Enter Model IDs manually",
  )
  change(element, "#provider-models", "manual-model")
  await settle()
  click(element, '.provider-dialog button[type="submit"]')
  await settle()
  expect(calls.find((call) => call.method === "settings.patch")?.params).toMatchObject({
    providers: [{ id: "local", models: ["manual-model"] }],
  })
})

test("Given an empty provider form, when choosing presets, then only public URL and model fields are filled", async () => {
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  click(element, '[data-action="add-provider"]')
  await settle()
  click(element, '[data-action="preset-mimo"]')
  await settle()
  expect(element.querySelector<HTMLInputElement>("#provider-name")?.value).toBe(
    "Xiaomi MiMo Token Plan Singapore",
  )
  expect(element.querySelector<HTMLInputElement>("#provider-url")?.value).toBe(
    "https://token-plan-sgp.xiaomimimo.com/v1",
  )
  expect(element.querySelector<HTMLInputElement>("#provider-models")?.value).toBe("mimo-v2.6-pro")
  expect(
    element.querySelector<HTMLInputElement>('.provider-dialog input[type="checkbox"]')?.checked,
  ).toBe(false)
  click(element, '[data-action="preset-minimax"]')
  await settle()
  expect(element.querySelector<HTMLInputElement>("#provider-name")?.value).toBe("MiniMax M3")
  expect(element.querySelector<HTMLInputElement>("#provider-url")?.value).toBe(
    "https://api.minimax.io/v1",
  )
  expect(element.querySelector<HTMLInputElement>("#provider-models")?.value).toBe("MiniMax-M3")
  expect(
    element.querySelector<HTMLInputElement>('.provider-dialog input[type="checkbox"]')?.checked,
  ).toBe(true)
  click(element, '[data-action="preset-openai"]')
  await settle()
  expect(element.querySelector<HTMLInputElement>("#provider-name")?.value).toBe("OpenAI API")
  expect(element.querySelector<HTMLInputElement>("#provider-url")?.value).toBe(
    "https://api.openai.com/v1",
  )
  expect(element.querySelector<HTMLInputElement>("#provider-models")?.value).toBe("")
  expect(
    element.querySelector<HTMLInputElement>('.provider-dialog input[type="checkbox"]')?.checked,
  ).toBe(true)
  expect(element.querySelector<HTMLInputElement>("#provider-key")?.value).toBe("")
  expect(calls.filter((call) => call.method === "settings.patch")).toHaveLength(0)
})

test("Claude Code login can be selected without entering an API URL or key", async () => {
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  click(element, '[data-action="add-provider"]')
  await settle()
  click(element, '[data-action="preset-claude-code"]')
  await settle()
  expect(element.textContent).toContain("Using an existing CLI login is at your own risk.")
  expect(element.querySelector("#provider-url")).toBeNull()
  expect(element.querySelector("#provider-key")).toBeNull()
  change(element, "#provider-models", "claude-sonnet-4-5")
  await settle()
  click(element, '.provider-dialog button[type="submit"]')
  await settle()
  expect(calls.find((call) => call.method === "settings.patch")?.params).toMatchObject({
    providers: [
      { id: "local" },
      {
        id: "Claude Code",
        kind: "claude-code-cli",
        models: ["claude-sonnet-4-5"],
        allowEvidence: false,
      },
    ],
  })
  expect(calls.some((call) => call.method === "providers.setKey")).toBe(false)
})

test("OpenAI Codex login can be saved without an API URL or key while manual OpenAI API remains", async () => {
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  click(element, '[data-action="add-provider"]')
  await settle()
  expect(element.querySelector('[data-action="preset-openai"]')).not.toBeNull()
  click(element, '[data-action="preset-codex"]')
  await settle()
  expect(element.textContent).toContain("Using an existing CLI login is at your own risk.")
  expect(element.querySelector("#provider-url")).toBeNull()
  expect(element.querySelector("#provider-key")).toBeNull()
  change(element, "#provider-models", "gpt-6-luna")
  await settle()
  click(element, '.provider-dialog button[type="submit"]')
  await settle()
  expect(calls.find((call) => call.method === "settings.patch")?.params).toMatchObject({
    providers: [
      { id: "local" },
      {
        id: "OpenAI (Codex login)",
        kind: "codex-cli",
        models: ["gpt-6-luna"],
        allowEvidence: false,
      },
    ],
  })
  expect(calls.some((call) => call.method === "providers.setKey")).toBe(false)
})

test("Korean provider form explains CLI login terms and usage limits", async () => {
  settings["ui_language"] = "ko"
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  click(element, '[data-action="add-provider"]')
  await settle()
  click(element, '[data-action="preset-codex"]')
  await settle()
  expect(element.textContent).toContain("기존 CLI 로그인 사용은 사용자 책임입니다.")
  expect(element.textContent).toContain("각 제공자의 약관과 사용량 한도를 확인하세요.")
})

test("Claude Code provider rejects a model name outside the explicit claude ID format", async () => {
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  click(element, '[data-action="add-provider"]')
  await settle()
  click(element, '[data-action="preset-claude-code"]')
  await settle()
  change(element, "#provider-models", "sonnet")
  await settle()
  click(element, '.provider-dialog button[type="submit"]')
  await settle()
  expect(element.querySelector('.provider-dialog [role="alert"]')?.textContent).toContain("claude-")
  expect(calls.some((call) => call.method === "settings.patch")).toBe(false)
})

test("Given a new custom provider without a model ID, when saving, then it can be discovered later", async () => {
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  click(element, '[data-action="add-provider"]')
  await settle()
  change(element, "#provider-name", "Custom provider")
  change(element, "#provider-url", "https://example.invalid/v1")
  await settle()
  click(element, '.provider-dialog button[type="submit"]')
  await settle()
  expect(calls.find((call) => call.method === "settings.patch")?.params).toMatchObject({
    providers: [
      { id: "local", models: ["small"] },
      { id: "Custom provider", baseUrl: "https://example.invalid/v1", models: [] },
    ],
  })
  expect(element.textContent).toContain("Custom provider")
})

test("provider URLs reject embedded credentials and non-HTTP schemes before RPC", async () => {
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  click(element, ".provider-actions button")
  await settle()
  for (const url of ["https://user:secret@provider.example/v1", "file:///tmp/provider"]) {
    change(element, "#provider-url", url)
    await settle()
    click(element, '.provider-dialog button[type="submit"]')
    await settle()
    expect(element.querySelector(".provider-dialog [role=alert]")?.textContent).toBe(
      "Use an http(s) Base URL without credentials.",
    )
  }
  expect(calls.filter((call) => call.method === "settings.patch")).toHaveLength(0)
})

test("Aside Copy matches the shown command and args snippet", async () => {
  const element = root()
  let copied = ""
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => (copied = value) },
  })
  mountApp(element, window, fakeFetch)
  await settle()
  const aside = Array.from(element.querySelectorAll<HTMLElement>(".agent-connection")).find(
    (connection) => connection.querySelector("h3")?.textContent === "Aside",
  )
  if (!aside) throw new Error("Missing Aside connection")
  click(aside, "button")
  await settle()
  const snippet = aside.querySelector("code")?.textContent
  if (snippet == null) throw new Error("Missing Aside snippet")
  expect(copied).toBe(snippet)
})

test("connection commands use the served executable path and shell-quote it", async () => {
  const meta = document.createElement("meta")
  meta.name = "side-executable"
  meta.content = "/Applications/Side's Test.app/Contents/Resources/side"
  document.head.append(meta)
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  const claude = Array.from(element.querySelectorAll<HTMLElement>(".agent-connection")).find(
    (connection) => connection.querySelector("h3")?.textContent === "Claude Code",
  )
  expect(claude?.querySelector("code")?.textContent).toBe(
    "claude mcp add --scope user side -- '/Applications/Side'\\''s Test.app/Contents/Resources/side' mcp",
  )
  const codex = Array.from(element.querySelectorAll<HTMLElement>(".agent-connection")).find(
    (connection) => connection.querySelector("h3")?.textContent === "Codex",
  )
  expect(codex?.querySelector("code")?.textContent).toBe(
    "codex mcp add side -- '/Applications/Side'\\''s Test.app/Contents/Resources/side' mcp",
  )
  const cursor = Array.from(element.querySelectorAll<HTMLElement>(".agent-connection")).find(
    (connection) => connection.querySelector("h3")?.textContent === "Cursor",
  )
  expect(JSON.parse(cursor?.querySelector("code")?.textContent ?? "")).toEqual({
    mcpServers: {
      side: {
        command: "/Applications/Side's Test.app/Contents/Resources/side",
        args: ["mcp"],
      },
    },
  })
})

test("history summary link resolves to its day route with source anchor", async () => {
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  const href = element.querySelector<HTMLAnchorElement>(".summary-link")?.getAttribute("href")
  expect(href).toBe(`#/history/2026-09-24#s:${summaryId}`)
  expect(routeFromHash(href ?? "")).toEqual({ kind: "history", date: "2026-09-24" })
  expect(element.querySelectorAll(".summary-link")).toHaveLength(1)
  expect(element.textContent).not.toContain("Day overview")
})

test("settings demo keeps the Settings navigation active", async () => {
  window.location.hash = "#/demo/phase-4/s1-settings?state=normal"
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  expect(
    element
      .querySelector<HTMLAnchorElement>('.nav-links a[href="#/settings/context-awareness"]')
      ?.getAttribute("aria-current"),
  ).toBe("page")
})

test("clear history asks twice for All history and reports deleted event count", async () => {
  const element = root()
  mountApp(element, window, fakeFetch)
  await settle()
  click(element, '[data-action="clear-history"]')
  await settle()
  change(element, '[name="clear-target"]', "all")
  await settle()
  expect(element.querySelector('[role="dialog"]')?.textContent).toContain(
    "Clear all Context Awareness?",
  )
  click(element, '[data-action="confirm-clear"]')
  await settle()
  expect(calls.find((call) => call.method === "clear")?.params).toEqual({ target: "all" })
  expect(element.querySelector('[role="status"]')?.textContent).toContain("Cleared 2 events.")
})

test("clear history loads summaries for the newly selected surviving day", async () => {
  const element = root()
  let cleared = false
  const historyFetch: FetchLike = async (_input, init) => {
    const packet = JSON.parse(String(init?.body))
    calls.push({ method: packet.method, params: packet.params })
    let result: unknown
    if (packet.method === "clear") {
      cleared = true
      result = { deleted_events: 2, deleted_summaries: 1, deletion_epoch: 2 }
    } else if (packet.method === "historyStatus") {
      result = {
        store_bytes: 1024,
        average_bytes_per_day: 512,
        days_with_summaries: cleared ? ["2026-09-23"] : ["2026-09-23", "2026-09-24"],
        today_summary_states: { pending: 0, running: 0, done: 1, failed: 0, skipped: 0 },
      }
    } else if (packet.method === "historyList") {
      const day = packet.params?.from === Date.parse("2026-09-23T00:00:00")
      result = day
        ? [
            {
              id: summaryId,
              kind: "10min",
              window_from: Date.parse("2026-09-23T09:00:00Z"),
              window_to: Date.parse("2026-09-23T09:10:00Z"),
              title: "Previous day",
              description: "Surviving summary",
              status: "done",
              citations: [],
            },
          ]
        : cleared
          ? []
          : response(packet.method, packet.params)
    } else {
      result = response(packet.method, packet.params)
    }
    return Response.json({ jsonrpc: "2.0", id: packet.id, result })
  }
  mountApp(element, window, historyFetch)
  await settle()
  click(element, '[data-action="clear-history"]')
  await settle()
  change(element, '[name="clear-target"]', "today")
  click(element, '[data-action="confirm-clear"]')
  await settle()
  expect(element.querySelector<HTMLSelectElement>("#history-day")?.value).toBe("2026-09-23")
  expect(element.querySelector(".summary-link")?.textContent ?? "").toContain("Previous day")
})

test("clear history reports a refresh failure without claiming deletion failed", async () => {
  const element = root()
  let cleared = false
  const historyFetch: FetchLike = async (_input, init) => {
    const packet = JSON.parse(String(init?.body))
    if (packet.method === "clear") cleared = true
    if (packet.method === "historyStatus" && cleared) {
      return Response.json({
        jsonrpc: "2.0",
        id: packet.id,
        error: { code: -32000, message: "Refresh unavailable" },
      })
    }
    return Response.json({
      jsonrpc: "2.0",
      id: packet.id,
      result: response(packet.method, packet.params),
    })
  }
  mountApp(element, window, historyFetch)
  await settle()
  click(element, '[data-action="clear-history"]')
  await settle()
  click(element, '[data-action="confirm-clear"]')
  await settle()
  expect(element.querySelector('[role="status"]')?.textContent).toContain(
    "Cleared 2 events. Could not refresh history.",
  )
})

test("history day picker ignores a late response for an earlier selection", async () => {
  const element = root()
  const pending: { day: string; resolve: (response: Response) => void; id: number }[] = []
  let initialList = true
  const historyFetch: FetchLike = async (_input, init) => {
    const packet = JSON.parse(String(init?.body))
    const day = new Date(packet.params?.from ?? 0).toLocaleDateString("en-CA")
    if (packet.method === "historyList" && !initialList) {
      return new Promise((resolve) => pending.push({ day, resolve, id: packet.id }))
    }
    let result = response(packet.method, packet.params)
    if (packet.method === "historyStatus") {
      result = { ...(result as object), days_with_summaries: ["2026-09-23", "2026-09-24"] }
    }
    if (packet.method === "historyList") initialList = false
    return Response.json({ jsonrpc: "2.0", id: packet.id, result })
  }
  mountApp(element, window, historyFetch)
  await settle()
  change(element, "#history-day", "2026-09-23")
  await settle()
  change(element, "#history-day", "2026-09-24")
  await settle()
  expect(pending.map((item) => item.day)).toEqual(["2026-09-23", "2026-09-24"])
  for (const day of ["2026-09-24", "2026-09-23"]) {
    const item = pending.find((candidate) => candidate.day === day)
    if (!item) throw new Error(`Missing ${day} request`)
    item.resolve(
      Response.json({
        jsonrpc: "2.0",
        id: item.id,
        result: [
          {
            id: summaryId,
            kind: "10min",
            window_from: Date.parse(`${day}T09:00:00Z`),
            window_to: Date.parse(`${day}T09:10:00Z`),
            title: day,
            description: "Day summary",
            status: "done",
            citations: [],
          },
        ],
      }),
    )
    await settle()
  }
  expect(element.querySelector<HTMLSelectElement>("#history-day")?.value).toBe("2026-09-24")
  expect(element.querySelector(".summary-link")?.textContent ?? "").toContain("2026-09-24")
})

test("history day picker keeps the previous day when the new day fails to load", async () => {
  const element = root()
  const historyFetch: FetchLike = async (_input, init) => {
    const packet = JSON.parse(String(init?.body))
    if (
      packet.method === "historyList" &&
      packet.params?.from === Date.parse("2026-09-23T00:00:00")
    ) {
      return Response.json({
        jsonrpc: "2.0",
        id: packet.id,
        error: { code: -32000, message: "Unavailable" },
      })
    }
    const result =
      packet.method === "historyStatus"
        ? {
            ...(response(packet.method, packet.params) as object),
            days_with_summaries: ["2026-09-23", "2026-09-24"],
          }
        : response(packet.method, packet.params)
    return Response.json({ jsonrpc: "2.0", id: packet.id, result })
  }
  mountApp(element, window, historyFetch)
  await settle()
  change(element, "#history-day", "2026-09-23")
  await settle()
  expect(element.querySelector<HTMLSelectElement>("#history-day")?.value).toBe("2026-09-24")
  expect(element.querySelector(".summary-link")?.textContent ?? "").toContain("Review notes")
  expect(element.querySelector('[role="status"]')?.textContent).toContain("Could not load history.")
})

test.each(["loading", "error", "empty", "normal", "permissions_needed", "paused"])(
  "settings demo %s renders without live RPC",
  async (state) => {
    window.history.replaceState(
      null,
      "",
      `/?t=synthetic-token#/demo/phase-4/s1-settings?state=${state}`,
    )
    const element = root()
    let networkCalls = 0
    mountApp(element, window, async () => {
      networkCalls++
      throw new Error("Unexpected network call")
    })
    await settle()
    expect(networkCalls).toBe(0)
    expect(window.location.search).toBe("")
    const expected = {
      loading: "불러오는 중…",
      error: "설정을 불러올 수 없습니다.",
      empty: "아직 요약이 없습니다.",
      normal: "Side가 하루를 기억하도록",
      permissions_needed: "권한이 필요합니다",
      paused: "직접 재개할 때까지 일시정지됨",
    } as const
    const expectedText = Object.entries(expected).find(([name]) => name === state)?.[1]
    if (!expectedText) throw new Error(`Unknown demo state: ${state}`)
    expect(element.textContent).toContain(expectedText)
  },
)
