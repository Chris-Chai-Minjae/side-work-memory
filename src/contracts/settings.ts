import { z } from "zod"

const bundleIdOrDomain = z.string().regex(/^[A-Za-z0-9.-]+$/)
const hostname = bundleIdOrDomain.transform((value) => value.toLowerCase().replace(/\.$/u, ""))

export const RuleSchema = z.discriminatedUnion("scope", [
  z.strictObject({
    scope: z.literal("app"),
    behavior: z.enum(["observe", "do_not_observe"]),
    bundleId: bundleIdOrDomain,
  }),
  z.strictObject({
    scope: z.literal("url"),
    behavior: z.enum(["observe", "do_not_observe"]),
    urlDomain: hostname,
  }),
])

export const ModelRefSchema = z.strictObject({ provider: z.string(), modelId: z.string() })

const OpenAICompatibleProviderSchema = z.strictObject({
  id: z.string(),
  kind: z.literal("openai-compatible").optional(),
  baseUrl: z.string().url(),
  apiKeyRef: z.string().optional(),
  models: z.array(z.string()),
  supportsToolChoice: z.boolean().default(true),
  allowEvidence: z.boolean().default(false),
})

const ClaudeCodeCliProviderSchema = z.strictObject({
  id: z.string(),
  kind: z.literal("claude-code-cli"),
  models: z.array(z.string().regex(/^claude-[A-Za-z0-9-]+$/)),
  allowEvidence: z.boolean().default(false),
})

const CodexCliProviderSchema = z.strictObject({
  id: z.string(),
  kind: z.literal("codex-cli"),
  models: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)),
  allowEvidence: z.boolean().default(false),
})

export const ProviderSchema = z.union([
  OpenAICompatibleProviderSchema,
  ClaudeCodeCliProviderSchema,
  CodexCliProviderSchema,
])
const ProvidersSchema = z
  .array(ProviderSchema)
  .refine(
    (providers) => new Set(providers.map((provider) => provider.id)).size === providers.length,
    { message: "Provider IDs must be unique" },
  )

const RulesSchema = z.array(RuleSchema).max(500)
const RetentionDaysSchema = z.number().int().min(1).max(30)
export const RetentionChoiceSchema = z.union([
  z.literal(1),
  z.literal(3),
  z.literal(7),
  z.literal(14),
  z.literal(30),
])
export const UiLanguageSchema = z.enum(["ko", "en"])
const ModelOverrideSchema = z.strictObject({
  match: z.string(),
  reasoningEffort: z.enum(["low", "medium", "high"]),
  fastMode: z.boolean(),
})
const DEFAULT_MODEL_OVERRIDES = [
  { match: "^gpt-\\d+(\\.\\d+)*-luna(-\\d{8})?$", reasoningEffort: "high", fastMode: false },
  { match: "^claude-haiku-", reasoningEffort: "high", fastMode: false },
] as const
const SummarySchema = z.strictObject({
  modelOverrides: z
    .array(ModelOverrideSchema)
    .default(() => DEFAULT_MODEL_OVERRIDES.map((item) => ({ ...item }))),
})

export const SettingsSchema = z.strictObject({
  version: z.literal(2),
  uiLanguage: UiLanguageSchema.default("ko"),
  contextAwareness: z.strictObject({
    enabled: z.boolean().default(false),
    pausedUntil: z.number().int().nullable().default(null),
    rules: RulesSchema.default([]),
    retentionDays: RetentionDaysSchema.default(14),
    captureTypedText: z.boolean().default(true),
    screenOcr: z.boolean().default(true),
    summaryModel: ModelRefSchema.optional(),
    asideAdapter: z.boolean().default(false),
    browserHistoryEnabled: z.boolean().default(false),
  }),
  defaultModel: ModelRefSchema.optional(),
  providers: ProvidersSchema.default([]),
  summary: SummarySchema.prefault({}),
})

export const SettingsPatchSchema = z.strictObject({
  uiLanguage: UiLanguageSchema.optional(),
  enabled: z.boolean().optional(),
  pausedUntil: z.number().int().nullable().optional(),
  rules: RulesSchema.optional(),
  retentionDays: RetentionChoiceSchema.optional(),
  captureTypedText: z.boolean().optional(),
  screenOcr: z.boolean().optional(),
  summaryModel: ModelRefSchema.nullable().optional(),
  asideAdapter: z.boolean().optional(),
  browserHistoryEnabled: z.boolean().optional(),
  defaultModel: ModelRefSchema.nullable().optional(),
  providers: ProvidersSchema.optional(),
  summary: SummarySchema.optional(),
})

export type Settings = z.infer<typeof SettingsSchema>
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>
