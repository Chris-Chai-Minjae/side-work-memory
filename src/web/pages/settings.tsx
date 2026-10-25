import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks"
import { z } from "zod"
import { GLANCE_MS, MS_PER_DAY, RETENTION_DAYS_MIN } from "../../constants"
import {
  AppIconSchema,
  ApplicationSchema,
  HistoryStatusSchema,
  HistorySummarySchema,
  McpUsageSchema,
  PermissionsSchema,
  ProviderModelListSchema,
  SettingsResourceSchema,
  SummaryModelDefaultSchema,
} from "../../contracts/rpc-resources"
import { RetentionChoiceSchema } from "../../contracts/settings"
import { ConfirmDialog } from "../components/confirm-dialog"
import { PauseControl } from "../components/pause-control"
import { PermissionBanner } from "../components/permission-banner"
import { t, type UiLanguage } from "../i18n"
import type { RpcClient } from "../rpc-client"
import { RpcError } from "../rpc-client"

export type SettingsDemoState =
  | "loading"
  | "error"
  | "empty"
  | "normal"
  | "permissions_needed"
  | "paused"

const StatusSchema = z.object({
  enabled: z.boolean(),
  state: z.enum(["starting", "running", "paused", "stopped"]),
  paused_until: z.number().nullable(),
  banner: z.enum(["none", "starting", "not_running", "permissions_needed", "some_unavailable"]),
  health: z.object({ asideAdapter: z.enum(["off", "available", "unavailable", "error"]) }),
})
const ProviderTestSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number(),
  toolChoiceSupported: z.boolean(),
  error: z.string().optional(),
})
const ModelListUnavailableMessages = {
  "provider-not-found": "This provider is no longer configured.",
  "key-not-configured": "Save an API key before discovering models.",
  "key-unavailable": "The API key is unavailable from Keychain.",
  "invalid-base-url": "Use an http(s) Base URL without credentials.",
  "redirect-blocked": "The model list redirected, so Side blocked the request.",
  "endpoint-unavailable": "This provider does not expose a model list.",
  "http-error": "The provider rejected the model list request.",
  "invalid-response": "The provider returned an invalid model list.",
  "request-failed": "Could not reach the provider model list.",
} as const

function providerTestMessage(language: UiLanguage, error: string | undefined): string {
  if (!error) return t(language, "Test failed")
  switch (error) {
    case "Provider or model is not configured":
    case "record_summary response failed validation":
    case "Provider test failed":
      return t(language, error)
    default:
      return language === "en" || /^HTTP [4-5]\d{2}$/u.test(error)
        ? error
        : t(language, "Test failed")
  }
}
const ClearSchema = z.object({ deleted_events: z.number().int().nonnegative() })
const IconListSchema = z.array(AppIconSchema)
const ApplicationListSchema = z.array(ApplicationSchema)
const HistoryListSchema = z.array(HistorySummarySchema)
const UsageListSchema = z.array(McpUsageSchema)
const ClearTargetSchema = z.enum(["last10m", "lastHour", "today", "all"])

type Status = z.infer<typeof StatusSchema>
type Settings = z.infer<typeof SettingsResourceSchema>
type Permissions = z.infer<typeof PermissionsSchema>
type HistoryStatus = z.infer<typeof HistoryStatusSchema>
type Summary = z.infer<typeof HistorySummarySchema>
type Application = z.infer<typeof ApplicationSchema>
type Usage = z.infer<typeof McpUsageSchema>
type Provider = Settings["providers"][number]
type Rule = Settings["rules"][number]
type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly data: SettingsData }

interface SettingsData {
  readonly status: Status
  readonly permissions: Permissions
  readonly settings: Settings
  readonly modelDefault: z.infer<typeof SummaryModelDefaultSchema>
  readonly historyStatus: HistoryStatus
  readonly summaries: readonly Summary[]
  readonly applications: readonly Application[]
  readonly icons: ReadonlyMap<string, string>
  readonly usage: readonly Usage[]
}

interface SettingsPageProps {
  readonly rpc: RpcClient
  readonly browser: Window
  readonly language: UiLanguage
  readonly onLanguageChange: (language: UiLanguage) => void
  readonly demoState?: SettingsDemoState
}

const BINARY_PATH = "/Applications/Side.app/Contents/Resources/side"

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function dateRange(day: string): { readonly from: number; readonly to: number } {
  const start = new Date(`${day}T00:00:00`)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { from: start.getTime(), to: end.getTime() }
}

function tenMinuteSummaries(value: unknown): Summary[] {
  return HistoryListSchema.parse(value).filter((summary) => summary.kind === "10min")
}

function normalizeDomain(value: string): string | null {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`)
    const domain = url.hostname.toLowerCase().replace(/\.$/u, "")
    return /^[A-Za-z0-9.-]+$/.test(domain) ? domain : null
  } catch (error) {
    if (error instanceof TypeError) return null
    throw error
  }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function patchProvider(provider: Provider) {
  if (provider.kind === "claude-code-cli" || provider.kind === "codex-cli")
    return {
      id: provider.id,
      kind: provider.kind,
      models: provider.models,
      allowEvidence: provider.allow_evidence,
    }
  if (!provider.base_url) throw new TypeError("Missing provider URL")
  return {
    id: provider.id,
    baseUrl: provider.base_url,
    models: provider.models,
    supportsToolChoice: provider.supports_tool_choice,
    allowEvidence: provider.allow_evidence,
  }
}

function isFocusable(value: Element | null): value is Element & { focus: () => void } {
  return value !== null && "focus" in value && typeof value.focus === "function"
}

function demoClient(state: SettingsDemoState): RpcClient {
  let enabled = true
  let uiLanguage: UiLanguage = "ko"
  let pausedUntil: number | null = state === "paused" ? Number.MAX_SAFE_INTEGER : null
  let rules: Rule[] = []
  return {
    async call(method, params) {
      if (state === "loading") return new Promise<unknown>(() => {})
      if (state === "error") throw new RpcError("Demo settings unavailable")
      if (method === "status")
        return {
          enabled,
          state: state === "paused" ? "paused" : "running",
          paused_until: pausedUntil,
          banner: state === "permissions_needed" ? "permissions_needed" : "none",
          health: { asideAdapter: "available" },
        }
      if (method === "permissions" || method === "requestPermissions")
        return {
          accessibility: true,
          input_monitoring: state !== "permissions_needed",
          screen_recording: false,
          automation: {},
        }
      if (method === "settings.get" || method === "settings.patch") {
        if (method === "settings.patch") {
          const patch = z.record(z.string(), z.unknown()).parse(params)
          if (typeof patch["enabled"] === "boolean") enabled = patch["enabled"]
          if (patch["uiLanguage"] === "ko" || patch["uiLanguage"] === "en")
            uiLanguage = patch["uiLanguage"]
          if (Array.isArray(patch["rules"]))
            rules = z.array(SettingsResourceSchema.shape.rules.element).parse(patch["rules"])
        }
        return {
          ui_language: uiLanguage,
          enabled,
          capture_typed_text: true,
          screen_ocr: false,
          aside_adapter: true,
          browser_history_enabled: false,
          retention_days: 14,
          rules,
          summary_model: null,
          default_model: null,
          providers: [],
        }
      }
      if (method === "summaryModelDefault") return { model: null, source: "none" }
      if (method === "historyStatus")
        return {
          store_bytes: state === "empty" ? 0 : 1024,
          average_bytes_per_day: state === "empty" ? 0 : 512,
          days_with_summaries: state === "empty" ? [] : ["2026-09-24"],
          today_summary_states: { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 },
        }
      if (method === "historyList")
        return state === "empty"
          ? []
          : [
              {
                id: "01K5Z5V6Z6Z6Z6Z6Z6Z6Z6Z6Z6",
                kind: "10min",
                window_from: Date.parse("2026-09-24T09:00:00Z"),
                window_to: Date.parse("2026-09-24T09:10:00Z"),
                title: uiLanguage === "ko" ? "메모 검토" : "Review notes",
                description: uiLanguage === "ko" ? "sqlite 메모를 읽음" : "Read sqlite notes",
                status: "done",
                citations: [],
              },
            ]
      if (method === "listApplications" || method === "appIcons" || method === "mcp.usage")
        return []
      if (method === "pause") {
        const request = z
          .union([z.object({ until: z.number() }), z.object({ durationMs: z.number() })])
          .parse(params)
        pausedUntil = "until" in request ? request.until : Date.now() + request.durationMs
        return { paused_until: pausedUntil }
      }
      if (method === "resume") {
        pausedUntil = null
        return null
      }
      if (method === "clear") return { deleted_events: 0, deleted_summaries: 0, deletion_epoch: 0 }
      if (method === "providers.test") return { ok: true, latencyMs: 0, toolChoiceSupported: true }
      if (method === "providers.setKey") return { apiKeyRef: "demo" }
      if (method === "providers.listModels")
        return { status: "unavailable", models: [], reason: "key-not-configured" }
      throw new RpcError("Unsupported demo method")
    },
  }
}

async function loadData(rpc: RpcClient): Promise<SettingsData> {
  const [
    statusValue,
    permissionsValue,
    settingsValue,
    modelValue,
    historyValue,
    appsValue,
    usageValue,
  ] = await Promise.all([
    rpc.call("status"),
    rpc.call("permissions"),
    rpc.call("settings.get"),
    rpc.call("summaryModelDefault"),
    rpc.call("historyStatus"),
    rpc.call("listApplications"),
    rpc.call("mcp.usage", { sinceMs: Date.now() - MS_PER_DAY }),
  ])
  const settings = SettingsResourceSchema.parse(settingsValue)
  const historyStatus = HistoryStatusSchema.parse(historyValue)
  const day = [...historyStatus.days_with_summaries].sort().at(-1)
  const applications = ApplicationListSchema.parse(appsValue)
  const iconIds = applications.map((app) => app.bundle_id)
  const [summariesValue, iconsValue] = await Promise.all([
    day ? rpc.call("historyList", dateRange(day)) : Promise.resolve([]),
    iconIds.length ? rpc.call("appIcons", { bundleIds: iconIds }) : Promise.resolve([]),
  ])
  return {
    status: StatusSchema.parse(statusValue),
    permissions: PermissionsSchema.parse(permissionsValue),
    settings,
    modelDefault: SummaryModelDefaultSchema.parse(modelValue),
    historyStatus,
    summaries: tenMinuteSummaries(summariesValue),
    applications,
    icons: new Map(
      IconListSchema.parse(iconsValue).map((icon) => [icon.bundle_id, icon.icon_png_base64]),
    ),
    usage: UsageListSchema.parse(usageValue),
  }
}

export function SettingsPage({
  rpc,
  browser,
  demoState,
  language,
  onLanguageChange,
}: SettingsPageProps) {
  const binaryPath =
    browser.document.querySelector<HTMLMetaElement>('meta[name="side-executable"]')?.content ??
    BINARY_PATH
  const CLAUDE_COMMAND = `claude mcp add --scope user side -- ${shellQuote(binaryPath)} mcp`
  const CODEX_COMMAND = `codex mcp add side -- ${shellQuote(binaryPath)} mcp`
  const ASIDE_SNIPPET = `command: ${JSON.stringify(binaryPath)}\nargs: mcp`
  const MCP_JSON = JSON.stringify(
    { mcpServers: { side: { command: binaryPath, args: ["mcp"] } } },
    null,
    2,
  )
  const client = useMemo(() => (demoState ? demoClient(demoState) : rpc), [demoState, rpc])
  const [load, setLoad] = useState<Load>({ kind: "loading" })
  const [reload, setReload] = useState(0)
  const [selectedDay, setSelectedDay] = useState("")
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState("")
  const [dialog, setDialog] = useState<
    "none" | "disable" | "rule" | "clear" | "evidence" | "provider"
  >("none")
  const [ruleSource, setRuleSource] = useState<"app" | "url">("app")
  const [ruleInput, setRuleInput] = useState("")
  const [ruleError, setRuleError] = useState("")
  const [clearTarget, setClearTarget] = useState<"last10m" | "lastHour" | "today" | "all">(
    "last10m",
  )
  const [evidenceProvider, setEvidenceProvider] = useState<string | null>(null)
  const [editingProvider, setEditingProvider] = useState<string | null>(null)
  const [providerKind, setProviderKind] = useState<
    "openai-compatible" | "claude-code-cli" | "codex-cli"
  >("openai-compatible")
  const [providerName, setProviderName] = useState("")
  const [providerUrl, setProviderUrl] = useState("")
  const [providerModels, setProviderModels] = useState("")
  const [providerToolChoice, setProviderToolChoice] = useState(true)
  const [apiKey, setApiKey] = useState("")
  const [providerError, setProviderError] = useState("")
  const [providerTestResults, setProviderTestResults] = useState<
    Readonly<Record<string, z.infer<typeof ProviderTestSchema>>>
  >({})
  const dialogTrigger = useRef<{ focus: () => void } | null>(null)
  const historyRequest = useRef(0)

  useEffect(() => {
    historyRequest.current += 1
    let active = true
    setLoad({ kind: "loading" })
    loadData(client).then(
      (data) => {
        if (!active) return
        setSelectedDay([...data.historyStatus.days_with_summaries].sort().at(-1) ?? "")
        setLoad({ kind: "ready", data })
        onLanguageChange(data.settings.ui_language)
      },
      () => {
        if (active) setLoad({ kind: "error" })
      },
    )
    return () => {
      active = false
    }
  }, [client, reload, onLanguageChange])

  useEffect(() => {
    if (demoState) return
    const timer = browser.setInterval(() => {
      client.call("status").then(
        (value) =>
          setLoad((current) =>
            current.kind === "ready"
              ? { kind: "ready", data: { ...current.data, status: StatusSchema.parse(value) } }
              : current,
          ),
        () => setNotice(t(language, "Could not refresh capture status.")),
      )
    }, GLANCE_MS)
    return () => browser.clearInterval(timer)
  }, [browser, client, demoState, language])

  useLayoutEffect(() => {
    if (dialog === "none" || dialog === "disable" || dialog === "evidence") return
    const previous = browser.document.activeElement
    if (isFocusable(previous)) {
      dialogTrigger.current = previous
    }
    browser.document
      .querySelector<HTMLElement>(
        '[role="dialog"] button:not(:disabled), [role="dialog"] input:not(:disabled), [role="dialog"] select:not(:disabled)',
      )
      ?.focus()
    return () => {
      dialogTrigger.current?.focus()
      dialogTrigger.current = null
    }
  }, [browser, dialog])

  function closeOnEscape(event: KeyboardEvent): void {
    if (event.key === "Tab") {
      const dialog = event.currentTarget as HTMLElement | null
      const focusable = dialog?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
      )
      const first = focusable?.[0]
      const last = focusable?.[focusable.length - 1]
      if (first && last) {
        if (event.shiftKey && browser.document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && browser.document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
      return
    }
    if (event.key !== "Escape") return
    event.preventDefault()
    setApiKey("")
    setDialog("none")
  }

  async function update(patch: Record<string, unknown>): Promise<boolean> {
    setBusy(true)
    try {
      const settings = SettingsResourceSchema.parse(await client.call("settings.patch", patch))
      setLoad((current) =>
        current.kind === "ready" ? { kind: "ready", data: { ...current.data, settings } } : current,
      )
      onLanguageChange(settings.ui_language)
      setNotice("")
      return true
    } catch {
      setNotice(t(language, "Could not save settings."))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function run(
    method: "pause" | "resume" | "requestPermissions",
    params?: unknown,
  ): Promise<void> {
    setBusy(true)
    try {
      await client.call(method, params)
      setReload((value) => value + 1)
    } catch {
      setNotice(t(language, "Could not update capture."))
    } finally {
      setBusy(false)
    }
  }

  if (load.kind === "loading")
    return (
      <div class="settings-page">
        <p role="status" class="state-message">
          {t(language, "Loading…")}
        </p>
      </div>
    )
  if (load.kind === "error")
    return (
      <div class="settings-page">
        <div role="alert" class="state-message">
          <p>{t(language, "Could not load settings.")}</p>
          <button
            type="button"
            class="button button-secondary"
            onClick={() => setReload((value) => value + 1)}
          >
            {t(language, "Retry")}
          </button>
        </div>
      </div>
    )

  const data = load.data
  const { status, permissions, settings, historyStatus, summaries, applications, icons, usage } =
    data
  const missingKinds = [
    ...(permissions.accessibility ? [] : ["accessibility"]),
    ...(permissions.input_monitoring ? [] : ["inputMonitoring"]),
    ...(settings.screen_ocr && !permissions.screen_recording ? ["screenRecording"] : []),
  ]
  const deniedRules = settings.rules.filter((rule) => rule.behavior === "do_not_observe")
  const deniedAppIds = new Set(
    deniedRules.filter((rule) => rule.scope === "app").map((rule) => rule.bundleId),
  )
  const currentProvider = settings.providers.find((provider) => provider.id === evidenceProvider)
  const modelOptions = settings.providers.flatMap((provider) =>
    provider.models.map((modelId) => ({ provider: provider.id, modelId })),
  )
  const selectedModelIndex = modelOptions.findIndex(
    (option) =>
      option.provider === settings.summary_model?.provider &&
      option.modelId === settings.summary_model.modelId,
  )
  const providerHost = (host: string): string =>
    host === "Claude Code service" ? t(language, "Claude Code service") : host

  async function copyText(value: string): Promise<void> {
    if (!browser.navigator.clipboard) {
      setNotice(t(language, "Clipboard unavailable."))
      return
    }
    try {
      await browser.navigator.clipboard.writeText(value)
      setNotice(t(language, "Copied."))
    } catch {
      setNotice(t(language, "Could not copy."))
    }
  }

  async function chooseDay(day: string): Promise<void> {
    const request = ++historyRequest.current
    const previousDay = selectedDay
    setSelectedDay(day)
    try {
      const value = await client.call("historyList", dateRange(day))
      const next = tenMinuteSummaries(value)
      if (request !== historyRequest.current) return
      setLoad((current) =>
        current.kind === "ready"
          ? { kind: "ready", data: { ...current.data, summaries: next } }
          : current,
      )
      setNotice("")
    } catch {
      if (request === historyRequest.current) {
        setSelectedDay(previousDay)
        setNotice(t(language, "Could not load history."))
      }
    }
  }

  async function clearHistory(): Promise<void> {
    historyRequest.current += 1
    setBusy(true)
    let deletedEvents: number | null = null
    try {
      const result = ClearSchema.parse(await client.call("clear", { target: clearTarget }))
      deletedEvents = result.deleted_events
      setDialog("none")
      setNotice(
        language === "ko"
          ? `${t(language, "Cleared")} ${result.deleted_events}${t(language, "events.")}`
          : `Cleared ${result.deleted_events} events.`,
      )
      const refreshedStatus = HistoryStatusSchema.parse(await client.call("historyStatus"))
      const nextDay = refreshedStatus.days_with_summaries.includes(selectedDay)
        ? selectedDay
        : ([...refreshedStatus.days_with_summaries].sort().at(-1) ?? "")
      const listValue = nextDay ? await client.call("historyList", dateRange(nextDay)) : []
      setSelectedDay(nextDay)
      setLoad((current) =>
        current.kind === "ready"
          ? {
              kind: "ready",
              data: {
                ...current.data,
                historyStatus: refreshedStatus,
                summaries: tenMinuteSummaries(listValue),
              },
            }
          : current,
      )
    } catch {
      setNotice(
        deletedEvents === null
          ? t(language, "Could not clear history.")
          : language === "ko"
            ? `${t(language, "Cleared")} ${deletedEvents}${t(language, "events.")} ${t(language, "Could not refresh history.")}`
            : `Cleared ${deletedEvents} events. Could not refresh history.`,
      )
    } finally {
      setBusy(false)
    }
  }

  function openProvider(provider?: Provider): void {
    setEditingProvider(provider?.id ?? null)
    setProviderKind(provider?.kind ?? "openai-compatible")
    setProviderName(provider?.id ?? "")
    setProviderUrl(provider?.base_url ?? "")
    setProviderModels(provider?.models.join(", ") ?? "")
    setProviderToolChoice(provider?.supports_tool_choice ?? true)
    setApiKey("")
    setProviderError("")
    setDialog("provider")
  }

  async function discoverModels(provider: Provider): Promise<void> {
    setBusy(true)
    try {
      const result = ProviderModelListSchema.parse(
        await client.call("providers.listModels", { providerId: provider.id }),
      )
      openProvider(provider)
      if (result.status === "available") {
        if (result.models.length > 0) setProviderModels(result.models.join(", "))
        else setProviderError(t(language, "No models were returned. Enter Model IDs manually."))
      } else {
        const httpStatus = result.httpStatus ? ` (HTTP ${result.httpStatus})` : ""
        setProviderError(
          `${t(language, ModelListUnavailableMessages[result.reason])}${httpStatus} ${t(language, "Enter Model IDs manually.")}`,
        )
      }
    } catch {
      // no-excuse-ok: catch -- the settings UI presents one safe fallback for RPC failures.
      openProvider(provider)
      setProviderError(t(language, "Could not discover models. Enter Model IDs manually."))
    } finally {
      setBusy(false)
    }
  }

  async function saveProvider(event: Event): Promise<void> {
    event.preventDefault()
    const models = providerModels
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
    let baseUrl = ""
    if (providerKind === "openai-compatible") {
      try {
        const url = new URL(providerUrl)
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
          setProviderError(t(language, "Use an http(s) Base URL without credentials."))
          return
        }
        baseUrl = url.toString()
      } catch (error) {
        if (!(error instanceof TypeError)) throw error
        setProviderError(t(language, "Enter a valid Base URL."))
        return
      }
    } else {
      if (
        models.length === 0 ||
        models.some((model) =>
          providerKind === "claude-code-cli"
            ? !/^claude-[A-Za-z0-9-]+$/.test(model)
            : !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model),
        )
      ) {
        setProviderError(
          t(
            language,
            providerKind === "claude-code-cli"
              ? "Enter explicit Claude Code model IDs beginning with claude-."
              : "Enter an explicit Codex model ID, such as gpt-6-luna.",
          ),
        )
        return
      }
    }
    if (!providerName.trim()) {
      setProviderError(t(language, "Enter a provider name."))
      return
    }
    const providerId = editingProvider ?? providerName.trim()
    if (!editingProvider && settings.providers.some((provider) => provider.id === providerId)) {
      setProviderError(t(language, "A provider with this name already exists."))
      return
    }
    const current = settings.providers.find((provider) => provider.id === editingProvider)
    const nextProvider =
      providerKind === "claude-code-cli" || providerKind === "codex-cli"
        ? {
            id: providerId,
            kind: providerKind,
            models,
            allowEvidence: current?.allow_evidence ?? false,
          }
        : {
            id: providerId,
            baseUrl,
            models,
            supportsToolChoice: providerToolChoice,
            allowEvidence: current?.allow_evidence ?? false,
          }
    const next = settings.providers
      .filter((provider) => provider.id !== editingProvider)
      .map(patchProvider)
    const secret = apiKey
    setApiKey("")
    setBusy(true)
    try {
      SettingsResourceSchema.parse(
        await client.call("settings.patch", { providers: [...next, nextProvider] }),
      )
      if (secret && providerKind === "openai-compatible")
        await client.call("providers.setKey", { providerId, apiKey: secret })
      setDialog("none")
      setReload((value) => value + 1)
    } catch {
      setProviderError(t(language, "Could not save provider."))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="settings-page content-stack">
      <div class="settings-heading">
        <h1>{t(language, "Let Side remember your day")}</h1>
        <p class="settings-intro">
          {t(
            language,
            "Side captures what you do in your browser and apps so agents can recall it later.",
          )}
        </p>
        <div class="setting-row">
          <label for="ui-language">
            <strong>{t(language, "Display language")}</strong>
          </label>
          <select
            id="ui-language"
            value={settings.ui_language}
            disabled={busy}
            onChange={(event) => void update({ uiLanguage: event.currentTarget.value })}
          >
            <option value="ko">{t(language, "Korean")}</option>
            <option value="en">{t(language, "English")}</option>
          </select>
        </div>
      </div>
      <PermissionBanner
        language={language}
        banner={status.banner}
        busy={busy}
        onAllow={() => run("requestPermissions", { kinds: missingKinds })}
      />
      {notice && (
        <p role="status" class="state-message">
          {notice}
        </p>
      )}

      <section class="settings-section" aria-labelledby="capture-heading">
        <h2 id="capture-heading">{t(language, "Capture")}</h2>
        <div class="setting-row">
          <div>
            <strong>{t(language, "Enable Context Awareness")}</strong>
          </div>
          <button
            type="button"
            role="switch"
            aria-label={t(language, "Enable Context Awareness")}
            aria-checked={settings.enabled}
            class="setting-switch"
            data-action="toggle-enabled"
            disabled={busy}
            onClick={() => {
              if (settings.enabled) setDialog("disable")
              else {
                void update({ enabled: true, pausedUntil: null }).then((saved) => {
                  if (saved && missingKinds.length)
                    void run("requestPermissions", { kinds: missingKinds })
                })
              }
            }}
          >
            <span />
          </button>
        </div>
        <div class="setting-row">
          <PauseControl
            language={language}
            pausedUntil={status.paused_until}
            busy={busy || !settings.enabled}
            onPause={(value) => void run("pause", value)}
            onResume={() => void run("resume")}
          />
        </div>
        <div class="setting-row">
          <div>
            <strong>{t(language, "Capture typed text")}</strong>
            <p class="settings-copy">
              {t(
                language,
                "Save the sentences you type. Side never stores keystrokes or password fields.",
              )}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label={t(language, "Capture typed text")}
            aria-checked={settings.capture_typed_text}
            class="setting-switch"
            disabled={busy}
            onClick={() => void update({ captureTypedText: !settings.capture_typed_text })}
          >
            <span />
          </button>
        </div>
        <div class="setting-row">
          <div>
            <strong>{t(language, "Allow Screen Recording")}</strong>
            <p class="settings-copy">
              {t(
                language,
                "When a page has no readable text, read it from the screen. Only the text is kept.",
              )}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label={t(language, "Allow Screen Recording")}
            aria-checked={settings.screen_ocr}
            class="setting-switch"
            disabled={busy}
            onClick={() => {
              const next = !settings.screen_ocr
              void update({ screenOcr: next }).then((saved) => {
                if (saved && next && !permissions.screen_recording)
                  void run("requestPermissions", { kinds: ["screenRecording"] })
              })
            }}
          >
            <span />
          </button>
        </div>
        <div class="setting-row">
          <div>
            <strong>{t(language, "Use Aside Browser page content")}</strong>
            <p class="settings-copy">
              {t(
                language,
                "When Aside Browser is in front, read the page through Aside for better text. Requires the Aside CLI.",
              )}
            </p>
            <span class="setting-meta">
              {t(
                language,
                settings.aside_adapter && status.health.asideAdapter === "off"
                  ? "Not checked yet"
                  : status.health.asideAdapter,
              )}
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-label={t(language, "Use Aside Browser page content")}
            aria-checked={settings.aside_adapter}
            class="setting-switch"
            disabled={busy}
            onClick={() => void update({ asideAdapter: !settings.aside_adapter })}
          >
            <span />
          </button>
        </div>
        <div class="setting-row">
          <div>
            <strong>{t(language, "Include browser history in recall")}</strong>
            <p class="settings-copy">
              {t(
                language,
                "Off by default. When enabled, agents can search supported browser history. Side redacts sensitive data and respects your denylist.",
              )}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label={t(language, "Include browser history in recall")}
            aria-checked={settings.browser_history_enabled}
            class="setting-switch"
            disabled={busy}
            onClick={() =>
              void update({ browserHistoryEnabled: !settings.browser_history_enabled })
            }
          >
            <span />
          </button>
        </div>
      </section>

      <section class="settings-section" aria-labelledby="denylist-heading">
        <div class="section-heading">
          <h2 id="denylist-heading">{t(language, "Denylist")}</h2>
          <button
            type="button"
            class="button button-secondary"
            data-action="add-rule"
            onClick={() => {
              setRuleSource("app")
              setRuleInput("")
              setRuleError("")
              setDialog("rule")
            }}
          >
            {t(language, "Add")}
          </button>
        </div>
        <p class="settings-copy">
          {t(language, "Side never captures what you do in these apps and websites.")}
        </p>
        {deniedRules.length === 0 ? (
          <p class="supporting-text">{t(language, "No apps or websites added.")}</p>
        ) : (
          <ul class="settings-list">
            {deniedRules.map((rule, index) => {
              const app =
                rule.scope === "app"
                  ? applications.find((item) => item.bundle_id === rule.bundleId)
                  : undefined
              const icon = rule.scope === "app" ? icons.get(rule.bundleId) : undefined
              return (
                <li key={`${rule.scope}-${index}`} class="settings-list-row">
                  <span class="rule-icon">
                    {icon && /^[A-Za-z0-9+/=]+$/.test(icon) ? (
                      <img alt="" src={`data:image/png;base64,${icon}`} width="32" height="32" />
                    ) : rule.scope === "app" ? (
                      t(language, "App")
                    ) : (
                      t(language, "Web")
                    )}
                  </span>
                  <span class="rule-label">
                    <strong>
                      {rule.scope === "app" ? (app?.name ?? rule.bundleId) : rule.urlDomain}
                    </strong>
                    {rule.scope === "app" && <small>{rule.bundleId}</small>}
                  </span>
                  <button
                    type="button"
                    class="button button-secondary"
                    aria-label={`${t(language, "Remove")} ${rule.scope === "app" ? rule.bundleId : rule.urlDomain}`}
                    disabled={busy}
                    onClick={() =>
                      void update({ rules: settings.rules.filter((item) => item !== rule) })
                    }
                  >
                    {t(language, "Remove")}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section class="settings-section" aria-labelledby="summaries-heading">
        <h2 id="summaries-heading">{t(language, "Summaries")}</h2>
        <div class="setting-row">
          <div>
            <label for="summary-model">
              <strong>{t(language, "Summary model")}</strong>
            </label>
            <p class="supporting-text">
              {t(language, "Default")}:{" "}
              {data.modelDefault.model
                ? `${data.modelDefault.model.provider} / ${data.modelDefault.model.modelId}`
                : t(language, "None")}
            </p>
          </div>
          <select
            id="summary-model"
            value={selectedModelIndex < 0 ? "" : String(selectedModelIndex)}
            disabled={busy}
            onChange={(event) => {
              const selected =
                event.currentTarget.value === ""
                  ? undefined
                  : modelOptions[Number(event.currentTarget.value)]
              void update({ summaryModel: selected ?? null })
            }}
          >
            <option value="">{t(language, "Default")}</option>
            {modelOptions.map((option, index) => (
              <option key={`${option.provider}/${option.modelId}`} value={index}>
                {option.provider} / {option.modelId}
              </option>
            ))}
          </select>
        </div>
        <div class="section-heading">
          <h3>{t(language, "Model providers")}</h3>
          <button
            type="button"
            class="button button-secondary"
            data-action="add-provider"
            onClick={() => openProvider()}
          >
            {t(language, "Add provider")}
          </button>
        </div>
        {settings.providers.length === 0 ? (
          <p class="supporting-text">{t(language, "No model providers added.")}</p>
        ) : (
          <ul class="settings-list">
            {settings.providers.map((provider) => (
              <li key={provider.id} class="provider-row">
                <div class="provider-main">
                  <strong>{provider.id}</strong>
                  <span class="setting-meta">
                    {providerHost(provider.host)} · {provider.models.length}{" "}
                    {t(language, provider.models.length === 1 ? "model" : "models")}{" "}
                    {provider.has_key ? `· ${t(language, "Key saved")}` : ""}
                  </span>
                </div>
                <span class="setting-meta">{t(language, "Send evidence to this provider")}</span>
                <button
                  type="button"
                  role="switch"
                  aria-label={`${t(language, "Send evidence to this provider")} ${provider.id}`}
                  aria-checked={provider.allow_evidence}
                  data-action={`evidence-${provider.id}`}
                  class="setting-switch"
                  disabled={busy}
                  onClick={() => {
                    if (provider.allow_evidence)
                      void update({
                        providers: settings.providers.map((item) =>
                          patchProvider(
                            item.id === provider.id ? { ...item, allow_evidence: false } : item,
                          ),
                        ),
                      })
                    else {
                      setEvidenceProvider(provider.id)
                      setDialog("evidence")
                    }
                  }}
                >
                  <span />
                </button>
                <div class="provider-actions">
                  <button
                    type="button"
                    class="button button-secondary"
                    onClick={() => openProvider(provider)}
                  >
                    {t(language, "Edit")}
                  </button>
                  <button
                    type="button"
                    class="button button-secondary"
                    disabled={busy}
                    onClick={() =>
                      void update({
                        providers: settings.providers
                          .filter((item) => item.id !== provider.id)
                          .map(patchProvider),
                      })
                    }
                  >
                    {t(language, "Delete")}
                  </button>
                  {provider.kind === "openai-compatible" && (
                    <button
                      type="button"
                      class="button button-secondary"
                      data-action={`discover-${provider.id}`}
                      disabled={busy}
                      onClick={() => void discoverModels(provider)}
                    >
                      {t(language, "Discover models")}
                    </button>
                  )}
                  <button
                    type="button"
                    class="button button-secondary"
                    disabled={busy || !provider.models[0]}
                    onClick={() => {
                      const modelId = provider.models[0]
                      if (!modelId) return
                      setBusy(true)
                      client
                        .call("providers.test", { providerId: provider.id, modelId })
                        .then(
                          (value) => {
                            const result = ProviderTestSchema.parse(value)
                            setProviderTestResults((current) => ({
                              ...current,
                              [provider.id]: result,
                            }))
                          },
                          () => setNotice(t(language, "Provider test failed.")),
                        )
                        .finally(() => setBusy(false))
                    }}
                  >
                    {t(language, "Test")}
                  </button>
                </div>
                {(providerTestResults[provider.id] ?? provider.test_result) && (
                  <span class="setting-meta provider-test-result">
                    {(providerTestResults[provider.id] ?? provider.test_result)?.ok
                      ? t(language, "Test passed")
                      : providerTestMessage(
                          language,
                          (providerTestResults[provider.id] ?? provider.test_result)?.error,
                        )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <div class="setting-row">
          <div>
            <label for="retention-days">
              <strong>{t(language, "Retention")}</strong>
            </label>
            <p class="settings-copy">
              {t(language, "Side deletes raw captures after this many days. Summaries stay.")}
            </p>
          </div>
          <select
            id="retention-days"
            value={settings.retention_days}
            disabled={busy}
            onChange={(event) => void update({ retentionDays: Number(event.currentTarget.value) })}
          >
            {RetentionChoiceSchema.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.value} {t(language, option.value === RETENTION_DAYS_MIN ? "day" : "days")}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section class="settings-section" aria-labelledby="history-heading">
        <div class="section-heading">
          <h2 id="history-heading">{t(language, "History")}</h2>
          <button
            type="button"
            class="button button-secondary"
            data-action="clear-history"
            onClick={() => {
              setClearTarget("last10m")
              setDialog("clear")
            }}
          >
            {t(language, "Clear history")}
          </button>
        </div>
        <label for="history-day">{t(language, "Day")}</label>
        <select
          id="history-day"
          value={selectedDay}
          disabled={busy || historyStatus.days_with_summaries.length === 0}
          onChange={(event) => void chooseDay(event.currentTarget.value)}
        >
          {historyStatus.days_with_summaries.length === 0 ? (
            <option value="">{t(language, "No days with summaries")}</option>
          ) : (
            historyStatus.days_with_summaries.map((day) => (
              <option key={day} value={day}>
                {day}
              </option>
            ))
          )}
        </select>
        {summaries.length === 0 ? (
          <p class="supporting-text">{t(language, "No summaries yet.")}</p>
        ) : (
          <ul class="settings-list">
            {summaries.map((summary) => (
              <li key={summary.id}>
                <a class="summary-link" href={`#/history/${selectedDay}#s:${summary.id}`}>
                  <time>
                    {new Date(summary.window_from).toLocaleTimeString(
                      language === "ko" ? "ko-KR" : "en-US",
                      {
                        hour: "numeric",
                        minute: "2-digit",
                      },
                    )}
                  </time>
                  <strong>{summary.title}</strong>
                  <span>{summary.description}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
        <div class="storage">
          <strong>{t(language, "History storage usage")}</strong>
          <progress
            value={historyStatus.store_bytes}
            max={Math.max(
              historyStatus.store_bytes,
              historyStatus.average_bytes_per_day * settings.retention_days,
              1,
            )}
            title={`${t(language, "Storage used")} · ${t(language, "Average usage")}: ${formatBytes(historyStatus.average_bytes_per_day)} / ${t(language, "day")}`}
          />
          <span class="setting-meta">
            {t(language, "Storage used")}: {formatBytes(historyStatus.store_bytes)}
          </span>
          <span class="setting-meta">
            {t(language, "Average usage")}: {formatBytes(historyStatus.average_bytes_per_day)} /{" "}
            {t(language, "day")}
          </span>
        </div>
      </section>

      <section class="settings-section" aria-labelledby="agents-heading">
        <h2 id="agents-heading">{t(language, "Connect agents")}</h2>
        <div class="agent-connection">
          <h3>Claude Code</h3>
          <pre>
            <code>{CLAUDE_COMMAND}</code>
          </pre>
          <button
            type="button"
            class="button button-secondary"
            onClick={() => void copyText(CLAUDE_COMMAND)}
          >
            {t(language, "Copy")}
          </button>
        </div>
        <div class="agent-connection">
          <h3>Codex</h3>
          <pre>
            <code>{CODEX_COMMAND}</code>
          </pre>
          <button
            type="button"
            class="button button-secondary"
            onClick={() => void copyText(CODEX_COMMAND)}
          >
            {t(language, "Copy")}
          </button>
        </div>
        <div class="agent-connection">
          <h3>Cursor</h3>
          <pre>
            <code>{MCP_JSON}</code>
          </pre>
          <button
            type="button"
            class="button button-secondary"
            onClick={() => void copyText(MCP_JSON)}
          >
            {t(language, "Copy")}
          </button>
        </div>
        <div class="agent-connection">
          <h3>Aside</h3>
          <p>{t(language, "Settings → MCP → Add server")}</p>
          <pre>
            <code>{ASIDE_SNIPPET}</code>
          </pre>
          <button
            type="button"
            class="button button-secondary"
            onClick={() => void copyText(ASIDE_SNIPPET)}
          >
            {t(language, "Copy")}
          </button>
        </div>
        <h3>{t(language, "Recent 24h MCP calls")}</h3>
        {usage.length === 0 ? (
          <p class="supporting-text">{t(language, "No agent calls yet.")}</p>
        ) : (
          <ul class="settings-list">
            {usage.map((item) => (
              <li key={item.client_name} class="settings-list-row">
                <span>{item.client_name}</span>
                <strong>{Object.values(item.calls).reduce((sum, count) => sum + count, 0)}</strong>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        language={language}
        open={dialog === "disable"}
        title={t(language, "Disable Context Awareness?")}
        body={t(
          language,
          "Side will stop capturing your activity. Existing history stays on this device until it expires or you delete it.",
        )}
        confirmLabel={t(language, "Disable")}
        busy={busy}
        onCancel={() => setDialog("none")}
        onConfirm={() => {
          setDialog("none")
          void update({ enabled: false })
        }}
      />
      <ConfirmDialog
        language={language}
        open={dialog === "evidence"}
        title={t(language, "Send evidence to this provider?")}
        body={`${t(language, "Summaries send redacted activity from each 10-minute window to")} ${providerHost(currentProvider?.host ?? "")}.`}
        confirmLabel={t(language, "Allow")}
        busy={busy}
        onCancel={() => setDialog("none")}
        onConfirm={() => {
          if (currentProvider)
            void update({
              providers: settings.providers.map((provider) =>
                patchProvider(
                  provider.id === currentProvider.id
                    ? { ...provider, allow_evidence: true }
                    : provider,
                ),
              ),
            })
          setDialog("none")
        }}
      />
      {dialog === "rule" && (
        <div class="dialog-backdrop">
          <form
            class="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rule-dialog-title"
            onKeyDown={closeOnEscape}
            onSubmit={(event) => {
              event.preventDefault()
              const value = ruleSource === "url" ? normalizeDomain(ruleInput) : ruleInput.trim()
              if (!value || !/^[A-Za-z0-9.-]+$/.test(value)) {
                setRuleError(t(language, "Enter a valid domain or bundle ID."))
                return
              }
              const rule: Rule =
                ruleSource === "url"
                  ? { scope: "url", urlDomain: value, behavior: "do_not_observe" }
                  : { scope: "app", bundleId: value, behavior: "do_not_observe" }
              setDialog("none")
              void update({ rules: [...settings.rules, rule] })
            }}
          >
            <h2 id="rule-dialog-title">{t(language, "Never observe")}</h2>
            <p>{t(language, "Source")}</p>
            <div class="segmented">
              <button
                type="button"
                class="button button-secondary"
                aria-pressed={ruleSource === "app"}
                data-action="source-application"
                onClick={() => {
                  setRuleSource("app")
                  setRuleInput("")
                }}
              >
                {t(language, "Application")}
              </button>
              <button
                type="button"
                class="button button-secondary"
                aria-pressed={ruleSource === "url"}
                data-action="source-website"
                onClick={() => {
                  setRuleSource("url")
                  setRuleInput("")
                }}
              >
                {t(language, "Website")}
              </button>
            </div>
            {ruleSource === "app" ? (
              <>
                <label for="rule-app">
                  {t(language, "Search applications or enter bundle ID")}
                </label>
                <input
                  id="rule-app"
                  name="application"
                  value={ruleInput}
                  onInput={(event) => setRuleInput(event.currentTarget.value)}
                />
                <ul class="app-picker-list">
                  {applications
                    .filter((app) => !app.denied && !deniedAppIds.has(app.bundle_id))
                    .filter((app) =>
                      `${app.name} ${app.bundle_id}`
                        .toLowerCase()
                        .includes(ruleInput.toLowerCase()),
                    )
                    .map((app) => {
                      const icon = icons.get(app.bundle_id)
                      return (
                        <li key={app.bundle_id}>
                          <button
                            type="button"
                            class="app-picker-option"
                            data-action={`select-app-${app.bundle_id}`}
                            onClick={() => setRuleInput(app.bundle_id)}
                          >
                            {icon && /^[A-Za-z0-9+/=]+$/.test(icon) ? (
                              <img
                                alt=""
                                src={`data:image/png;base64,${icon}`}
                                width="32"
                                height="32"
                              />
                            ) : (
                              <span class="rule-icon">{t(language, "App")}</span>
                            )}
                            <span>
                              {app.name} · {app.bundle_id}
                            </span>
                          </button>
                        </li>
                      )
                    })}
                </ul>
              </>
            ) : (
              <>
                <label for="rule-website">{t(language, "Website")}</label>
                <input
                  id="rule-website"
                  name="website"
                  value={ruleInput}
                  onInput={(event) => setRuleInput(event.currentTarget.value)}
                />
              </>
            )}
            {ruleError && <p role="alert">{ruleError}</p>}
            <div class="dialog-actions">
              <button
                type="button"
                class="button button-secondary"
                onClick={() => setDialog("none")}
              >
                {t(language, "Cancel")}
              </button>
              <button
                type="submit"
                class="button button-primary"
                data-action="save-rule"
                disabled={busy}
              >
                {t(language, "Add")}
              </button>
            </div>
          </form>
        </div>
      )}
      {dialog === "clear" && (
        <div class="dialog-backdrop">
          <div
            class="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="clear-dialog-title"
            onKeyDown={closeOnEscape}
          >
            <h2 id="clear-dialog-title">{t(language, "Clear history")}</h2>
            <label for="clear-target">{t(language, "Clear")}</label>
            <select
              id="clear-target"
              name="clear-target"
              value={clearTarget}
              onChange={(event) =>
                setClearTarget(ClearTargetSchema.parse(event.currentTarget.value))
              }
            >
              <option value="last10m">{t(language, "Last 10 minutes")}</option>
              <option value="lastHour">{t(language, "Last hour")}</option>
              <option value="today">{t(language, "Today")}</option>
              <option value="all">{t(language, "All history")}</option>
            </select>
            {clearTarget === "all" && <p>{t(language, "Clear all Context Awareness?")}</p>}
            <div class="dialog-actions">
              <button
                type="button"
                class="button button-secondary"
                onClick={() => setDialog("none")}
              >
                {t(language, "Cancel")}
              </button>
              <button
                type="button"
                class="button button-destructive"
                data-action="confirm-clear"
                disabled={busy}
                onClick={() => void clearHistory()}
              >
                {t(language, "Clear history")}
              </button>
            </div>
          </div>
        </div>
      )}
      {dialog === "provider" && (
        <div class="dialog-backdrop">
          <form
            class="confirm-dialog provider-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="provider-dialog-title"
            onKeyDown={closeOnEscape}
            onSubmit={(event) => void saveProvider(event)}
          >
            <h2 id="provider-dialog-title">
              {t(language, editingProvider ? "Edit provider" : "Add provider")}
            </h2>
            {!editingProvider && (
              <div class="provider-actions">
                <button
                  type="button"
                  class="button button-secondary"
                  data-action="preset-mimo"
                  onClick={() => {
                    setProviderKind("openai-compatible")
                    setProviderName("Xiaomi MiMo Token Plan Singapore")
                    setProviderUrl("https://token-plan-sgp.xiaomimimo.com/v1")
                    setProviderModels("mimo-v2.6-pro")
                    setProviderToolChoice(false)
                    setApiKey("")
                  }}
                >
                  {t(language, "MiMo 2.6 Pro (Singapore)")}
                </button>
                <button
                  type="button"
                  class="button button-secondary"
                  data-action="preset-minimax"
                  onClick={() => {
                    setProviderKind("openai-compatible")
                    setProviderName("MiniMax M3")
                    setProviderUrl("https://api.minimax.io/v1")
                    setProviderModels("MiniMax-M3")
                    setProviderToolChoice(true)
                    setApiKey("")
                  }}
                >
                  MiniMax M3
                </button>
                <button
                  type="button"
                  class="button button-secondary"
                  data-action="preset-openai"
                  onClick={() => {
                    setProviderKind("openai-compatible")
                    setProviderName("OpenAI API")
                    setProviderUrl("https://api.openai.com/v1")
                    setProviderModels("")
                    setProviderToolChoice(true)
                    setApiKey("")
                  }}
                >
                  OpenAI API
                </button>
                <button
                  type="button"
                  class="button button-secondary"
                  data-action="preset-codex"
                  onClick={() => {
                    setProviderKind("codex-cli")
                    setProviderName("OpenAI (Codex login)")
                    setProviderUrl("")
                    setProviderModels("gpt-6-luna")
                    setApiKey("")
                  }}
                >
                  {t(language, "OpenAI (Codex login)")}
                </button>
                <button
                  type="button"
                  class="button button-secondary"
                  data-action="preset-claude-code"
                  onClick={() => {
                    setProviderKind("claude-code-cli")
                    setProviderName("Claude Code")
                    setProviderUrl("")
                    setProviderModels("")
                    setApiKey("")
                  }}
                >
                  {t(language, "Claude Code login")}
                </button>
              </div>
            )}
            <label for="provider-name">{t(language, "Name")}</label>
            <input
              id="provider-name"
              value={providerName}
              disabled={editingProvider !== null}
              onInput={(event) => setProviderName(event.currentTarget.value)}
            />
            {providerKind === "openai-compatible" && (
              <>
                <label for="provider-url">Base URL</label>
                <input
                  id="provider-url"
                  type="url"
                  value={providerUrl}
                  onInput={(event) => setProviderUrl(event.currentTarget.value)}
                />
              </>
            )}
            <label for="provider-models">{t(language, "Model IDs")}</label>
            <input
              id="provider-models"
              value={providerModels}
              onInput={(event) => setProviderModels(event.currentTarget.value)}
            />
            {providerKind === "claude-code-cli" ? (
              <p class="supporting-text">
                {t(
                  language,
                  "Uses your existing Claude Code login. Enter an explicit model ID. Summaries are sent to the Claude Code service only after you allow evidence below.",
                )}
              </p>
            ) : providerKind === "codex-cli" ? (
              <p class="supporting-text">
                {t(
                  language,
                  "Uses your existing Codex CLI ChatGPT login. No API key is needed. A login stored only in Keychain is not supported. Summaries are sent to OpenAI only after you allow evidence below. MiMo remains the recommended primary provider.",
                )}
              </p>
            ) : (
              <>
                <p class="supporting-text">
                  {t(
                    language,
                    "Optional. Discover models after saving, or enter Model IDs separated by commas.",
                  )}
                </p>
                <label for="provider-key">{t(language, "API key")}</label>
                <input
                  id="provider-key"
                  type="password"
                  value={apiKey}
                  autocomplete="off"
                  onInput={(event) => setApiKey(event.currentTarget.value)}
                />
                <label class="checkbox-label">
                  <input
                    type="checkbox"
                    checked={providerToolChoice}
                    onChange={(event) => setProviderToolChoice(event.currentTarget.checked)}
                  />{" "}
                  {t(language, "Supports forced tool calls")}
                </label>
              </>
            )}
            {providerKind !== "openai-compatible" && (
              <p class="supporting-text">
                {t(
                  language,
                  "Using an existing CLI login is at your own risk. Check each provider's terms and usage limits.",
                )}
              </p>
            )}
            {providerError && <p role="alert">{providerError}</p>}
            <div class="dialog-actions">
              <button
                type="button"
                class="button button-secondary"
                onClick={() => {
                  setApiKey("")
                  setDialog("none")
                }}
              >
                {t(language, "Cancel")}
              </button>
              <button type="submit" class="button button-primary" disabled={busy}>
                {t(language, "Save provider")}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
