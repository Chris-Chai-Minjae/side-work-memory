import { z } from "zod"
import { HelperHealthSchema } from "./protocol"
import { ModelRefSchema, RetentionChoiceSchema, RuleSchema, UiLanguageSchema } from "./settings"

const EpochMs = z.number().int()
const NonnegativeInt = z.number().int().nonnegative()
const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)
const SourceRef = z.string().regex(/^[es]:[0-9A-HJKMNP-TV-Z]{26}$/)

export const DayCountersSchema = z.strictObject({
  events: NonnegativeInt,
  blobs: NonnegativeInt,
  rawBytes: NonnegativeInt,
  suppressions: NonnegativeInt,
  masks: NonnegativeInt,
  sessions: NonnegativeInt,
  lastEventAt: EpochMs.optional(),
})

export const DaemonDiagnosticsSchema = z.strictObject({
  last_error: z
    .strictObject({
      name: z.string(),
      code: z.string().nullable(),
      stage: z.string(),
      timestamp: EpochMs,
      consecutive_count: NonnegativeInt,
    })
    .nullable(),
  last_successful_capture_at: EpochMs.nullable(),
})

export type DaemonDiagnosticsSnapshot = z.infer<typeof DaemonDiagnosticsSchema>

export const CaptureStatusSchema = z.strictObject({
  enabled: z.boolean(),
  state: z.enum(["starting", "running", "paused", "stopped"]),
  paused_until: EpochMs.nullable(),
  banner: z.enum(["none", "starting", "not_running", "permissions_needed", "some_unavailable"]),
  stop_reason: z.string().nullable(),
  health: HelperHealthSchema,
  today: DayCountersSchema,
  url_denied: z.boolean(),
  diagnostics: DaemonDiagnosticsSchema,
})

export const PermissionsSchema = z.strictObject({
  accessibility: z.boolean(),
  input_monitoring: z.boolean(),
  screen_recording: z.boolean(),
  automation: z.record(z.string(), z.boolean()),
})

export const PauseResultSchema = z.strictObject({ paused_until: EpochMs.nullable() })

export const ProviderTestResultSchema = z.strictObject({
  ok: z.boolean(),
  latencyMs: NonnegativeInt,
  toolChoiceSupported: z.boolean(),
  error: z.string().optional(),
})

export const ProviderKeyStatusSchema = z
  .strictObject({
    stored: z.boolean().nullable(),
    accessible: z.boolean().nullable(),
  })
  .refine((value) => value.accessible !== true || value.stored === true)

export const ProviderKeyAuthorizationSchema = z.strictObject({ authorized: z.boolean() })

export const ProviderModelListSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available"), models: z.array(z.string()) }),
  z.strictObject({
    status: z.literal("unavailable"),
    models: z.tuple([]),
    reason: z.enum([
      "provider-not-found",
      "key-not-configured",
      "key-unavailable",
      "invalid-base-url",
      "redirect-blocked",
      "endpoint-unavailable",
      "http-error",
      "invalid-response",
      "request-failed",
    ]),
    httpStatus: z.number().int().min(300).max(599).optional(),
  }),
])

export const ProviderResourceSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(["openai-compatible", "claude-code-cli", "codex-cli"]).default("openai-compatible"),
  base_url: z.string().url().nullable(),
  host: z.string(),
  models: z.array(z.string()),
  supports_tool_choice: z.boolean(),
  allow_evidence: z.boolean(),
  has_key: z.boolean(),
  test_result: ProviderTestResultSchema.nullable(),
})

export const SettingsResourceSchema = z.strictObject({
  ui_language: UiLanguageSchema,
  enabled: z.boolean(),
  capture_typed_text: z.boolean(),
  screen_ocr: z.boolean(),
  aside_adapter: z.boolean(),
  browser_history_enabled: z.boolean(),
  retention_days: RetentionChoiceSchema,
  rules: z.array(RuleSchema).max(500),
  summary_model: ModelRefSchema.nullable(),
  default_model: ModelRefSchema.nullable(),
  providers: z.array(ProviderResourceSchema),
})

export const ApplicationSchema = z.strictObject({
  bundle_id: z.string(),
  name: z.string(),
  denied: z.boolean(),
})

export const AppIconSchema = z.strictObject({
  bundle_id: z.string(),
  icon_png_base64: z.string(),
})

export const SummaryModelDefaultSchema = z.strictObject({
  model: ModelRefSchema.nullable(),
  source: z.enum(["summaryModel", "defaultModel", "none"]),
})

export const HistoryStatusSchema = z.strictObject({
  store_bytes: NonnegativeInt,
  average_bytes_per_day: NonnegativeInt,
  days_with_summaries: z.array(z.iso.date()),
  today_summary_states: z.strictObject({
    pending: NonnegativeInt,
    running: NonnegativeInt,
    done: NonnegativeInt,
    failed: NonnegativeInt,
    skipped: NonnegativeInt,
  }),
})

export const CitationSchema = z.strictObject({
  ref: SourceRef,
  title: z.string().optional(),
  url: z.string().optional(),
})

export const HistorySummarySchema = z.strictObject({
  id: Ulid,
  kind: z.enum(["10min", "6h"]),
  window_from: EpochMs,
  window_to: EpochMs,
  title: z.string(),
  description: z.string(),
  status: z.enum(["pending", "running", "done", "failed", "skipped"]),
  citations: z.array(CitationSchema),
})

export const DayPageSchema = z.strictObject({
  date: z.iso.date(),
  markdown: z.string().nullable(),
  updated_at: z.iso.datetime({ offset: true }),
})

export const EvidenceSchema = z.strictObject({
  id: SourceRef,
  occurred_at: EpochMs,
  app: z.string(),
  title: z.string(),
  url: z.string().url().nullable(),
  text: z.string(),
  expired: z.boolean(),
})

export const ClearOperationSchema = z.strictObject({
  deleted_events: NonnegativeInt,
  deleted_summaries: NonnegativeInt,
  deletion_epoch: NonnegativeInt,
})

export const McpUsageSchema = z.strictObject({
  client_name: z.string(),
  calls: z.record(z.string(), NonnegativeInt),
  avg_latency_ms: NonnegativeInt,
})

export const AgentConnectionSchema = z.strictObject({
  binary_path: z.string(),
  claude_code_command: z.string(),
  mcp_json_snippet: z.string(),
})
