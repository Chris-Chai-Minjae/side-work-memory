import { type RecordSummaryArguments, RecordSummaryArgumentsSchema } from "../contracts/summary"
import { redact } from "../redact/index"
import type { Briefing } from "./briefing"

export type ValidatedSummary = RecordSummaryArguments & { readonly body: string }

export type SummaryValidation =
  | { readonly ok: true; readonly summary: ValidatedSummary }
  | {
      readonly ok: false
      readonly rules: readonly string[]
      readonly previousToolArguments: unknown
    }

function maskOutput(value: unknown, path = ""): { value: unknown; rules: readonly string[] } {
  if (typeof value === "string") {
    const result = redact(value)
    return {
      value: result.text,
      rules: [
        ...result.masks.map(({ rule }) => `${path || "record_summary"}: output contains ${rule}`),
        ...(value.includes("\uFFFD")
          ? [`${path || "record_summary"}: output contains replacement character`]
          : []),
      ],
    }
  }
  if (Array.isArray(value)) {
    const parts = value.map((item, index) => maskOutput(item, `${path}.${index}`))
    return { value: parts.map((part) => part.value), rules: parts.flatMap((part) => part.rules) }
  }
  if (value !== null && typeof value === "object") {
    const parts = Object.entries(value).map(([key, item]) => {
      const maskedKey = redact(key)
      const safePath = path ? `${path}.${maskedKey.text}` : maskedKey.text
      const masked = maskOutput(item, safePath)
      return {
        key: maskedKey.text,
        value: masked.value,
        rules: [
          ...maskedKey.masks.map(
            ({ rule }) => `${path || "record_summary"}: field name contains ${rule}`,
          ),
          ...masked.rules,
        ],
      }
    })
    return {
      value: Object.fromEntries(parts.map(({ key, value: item }) => [key, item])),
      rules: parts.flatMap((part) => part.rules),
    }
  }
  return { value, rules: [] }
}

function subsetRules(value: unknown, briefing: Briefing): string[] {
  const rules: string[] = []
  if (value === null || typeof value !== "object" || Array.isArray(value)) return rules
  let validRefs = 0
  if ("citations" in value && Array.isArray(value.citations)) {
    for (const [index, citation] of value.citations.entries()) {
      if (
        citation !== null &&
        typeof citation === "object" &&
        "ref" in citation &&
        typeof citation.ref === "string"
      ) {
        if (briefing.evidenceIds.has(citation.ref)) validRefs++
        else rules.push(`citations.${index}.ref: id must appear in briefing`)
      }
    }
  }
  for (const [field, allowed] of [
    ["sourceIds", briefing.evidenceIds],
    ["apps", briefing.apps],
    ["domains", briefing.domains],
  ] as const) {
    const entries = Object.entries(value).find(([key]) => key === field)?.[1]
    if (!Array.isArray(entries)) continue
    for (const [index, entry] of entries.entries()) {
      if (typeof entry !== "string") continue
      if (allowed.has(entry)) {
        if (field === "sourceIds") validRefs++
      } else {
        rules.push(
          `${field}.${index}: ${field === "sourceIds" ? "id" : "value"} must appear in briefing`,
        )
      }
    }
  }
  if (validRefs === 0 && briefing.evidenceIds.size > 0)
    rules.push("citations/sourceIds: at least one ref must appear in briefing")
  return rules
}

export function validateRecordSummary(input: unknown, briefing: Briefing): SummaryValidation {
  let argumentsValue = input
  if (typeof input === "string") {
    try {
      argumentsValue = JSON.parse(input)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      const masked = maskOutput(input)
      return {
        ok: false,
        rules: ["record_summary: arguments must be valid JSON", ...masked.rules],
        previousToolArguments: masked.value,
      }
    }
  }
  const parsed = RecordSummaryArgumentsSchema.safeParse(argumentsValue)
  const masked = maskOutput(argumentsValue)
  const rules = [
    ...(parsed.success
      ? []
      : parsed.error.issues.map((issue) => {
          const path = issue.path.join(".") || "record_summary"
          return issue.code === "custom" && path === "title"
            ? "title: must be nonempty"
            : `${path}: ${issue.code}`
        })),
    ...subsetRules(argumentsValue, briefing),
    ...masked.rules,
  ]
  if (rules.length > 0 || !parsed.success) {
    return { ok: false, rules, previousToolArguments: masked.value }
  }
  return {
    ok: true,
    summary: {
      ...parsed.data,
      citations: parsed.data.citations.map(({ ref }) => ({ ref })),
      body: `${parsed.data.description.join("\n")}\n\n${parsed.data.memorySummary}`,
    },
  }
}
