import { saveSettings } from "../../config/index"
import { SettingsResourceSchema } from "../../contracts/rpc-resources"
import { type Settings, SettingsPatchSchema, SettingsSchema } from "../../contracts/settings"
import type { RpcHandlers } from "../rpc"

type SettingsReconciler = {
  readonly currentSettings: Settings
  settingsPatched(next: Settings): Promise<void>
}

type SettingsDependencies = {
  readonly directory: string
  readonly reconciler: SettingsReconciler
  readonly mutateSettings?: SettingsMutation
}

export type SettingsMutation = (update: (current: Settings) => Settings) => Promise<Settings>

export function createSettingsMutation(
  reconciler: SettingsReconciler,
  save: (next: Settings) => Promise<void>,
): SettingsMutation {
  let pending = Promise.resolve()
  return (update) => {
    const job = pending.then(async () => {
      const next = SettingsSchema.parse(update(reconciler.currentSettings))
      await save(next)
      await reconciler.settingsPatched(next)
      return reconciler.currentSettings
    })
    pending = job.then(
      () => {},
      () => {},
    )
    return job
  }
}

function toResource(settings: Settings) {
  const capture = settings.contextAwareness
  return SettingsResourceSchema.parse({
    ui_language: settings.uiLanguage,
    enabled: capture.enabled,
    capture_typed_text: capture.captureTypedText,
    screen_ocr: capture.screenOcr,
    aside_adapter: capture.asideAdapter,
    browser_history_enabled: capture.browserHistoryEnabled,
    retention_days: capture.retentionDays,
    rules: capture.rules,
    summary_model: capture.summaryModel ?? null,
    default_model: settings.defaultModel ?? null,
    providers: settings.providers.map((provider) =>
      provider.kind === "claude-code-cli" || provider.kind === "codex-cli"
        ? {
            id: provider.id,
            kind: provider.kind,
            base_url: null,
            host: provider.kind === "codex-cli" ? "OpenAI (Codex login)" : "Claude Code service",
            models: provider.models,
            supports_tool_choice: false,
            allow_evidence: provider.allowEvidence,
            has_key: false,
            test_result: null,
          }
        : {
            id: provider.id,
            kind: "openai-compatible",
            base_url: provider.baseUrl,
            host: new URL(provider.baseUrl).host,
            models: provider.models,
            supports_tool_choice: provider.supportsToolChoice,
            allow_evidence: provider.allowEvidence,
            has_key: Boolean(provider.apiKeyRef),
            test_result: null,
          },
    ),
  })
}

function mergeSettings(current: Settings, value: unknown): Settings {
  const patch = SettingsPatchSchema.parse(value)
  const { defaultModel, providers, summary, summaryModel, uiLanguage, ...capturePatch } = patch
  const oldRefs = new Map(
    current.providers.flatMap((provider) =>
      provider.kind === "claude-code-cli" || provider.kind === "codex-cli"
        ? []
        : [[provider.id, { baseUrl: provider.baseUrl, ref: provider.apiKeyRef }] as const],
    ),
  )
  return SettingsSchema.parse({
    ...current,
    ...(uiLanguage === undefined ? {} : { uiLanguage }),
    contextAwareness: {
      ...current.contextAwareness,
      ...capturePatch,
      ...(summaryModel === undefined ? {} : { summaryModel: summaryModel ?? undefined }),
    },
    ...(defaultModel === undefined ? {} : { defaultModel: defaultModel ?? undefined }),
    ...(summary === undefined ? {} : { summary }),
    ...(providers === undefined
      ? {}
      : {
          providers: providers.map((provider) =>
            provider.kind === "claude-code-cli" || provider.kind === "codex-cli"
              ? {
                  id: provider.id,
                  kind: provider.kind,
                  models: provider.models,
                  allowEvidence: provider.allowEvidence,
                }
              : {
                  id: provider.id,
                  baseUrl: provider.baseUrl,
                  models: provider.models,
                  supportsToolChoice: provider.supportsToolChoice,
                  allowEvidence: provider.allowEvidence,
                  ...(oldRefs.get(provider.id)?.baseUrl === provider.baseUrl
                    ? { apiKeyRef: oldRefs.get(provider.id)?.ref }
                    : {}),
                },
          ),
        }),
  })
}

export function createSettingsHandlers(
  dependencies: SettingsDependencies,
): Pick<RpcHandlers, "settings.get" | "settings.patch" | "summaryModelDefault"> {
  const mutateSettings =
    dependencies.mutateSettings ??
    createSettingsMutation(dependencies.reconciler, (next) =>
      saveSettings(dependencies.directory, next),
    )
  return {
    "settings.get": () => toResource(dependencies.reconciler.currentSettings),
    "settings.patch": async (value) =>
      toResource(await mutateSettings((current) => mergeSettings(current, value))),
    summaryModelDefault: () => {
      const settings = dependencies.reconciler.currentSettings
      if (settings.contextAwareness.summaryModel)
        return { model: settings.contextAwareness.summaryModel, source: "summaryModel" }
      if (settings.defaultModel) return { model: settings.defaultModel, source: "defaultModel" }
      return { model: null, source: "none" }
    },
  }
}
