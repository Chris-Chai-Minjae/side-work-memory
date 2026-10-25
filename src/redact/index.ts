export type RedactionRule =
  | "private-key-block"
  | "aws-access-key"
  | "jwt"
  | "slack-token"
  | "api-key"
  | "bearer-token"
  | "kr-rrn"
  | "field"
  | "labeled-secret"
  | "otp-numeric"
  | "card-number"

export type RedactionResult = {
  readonly text: string
  readonly masks: ReadonlyArray<{ readonly rule: RedactionRule; readonly count: number }>
}

type Match = {
  readonly start: number
  readonly end: number
  readonly rule: RedactionRule
}

const MASK = "[redacted:capture]"

const PATTERNS = [
  {
    rule: "private-key-block",
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
  },
  { rule: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu },
  { rule: "jwt", pattern: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/gu },
  { rule: "slack-token", pattern: /\bxox[abprs]-[\w-]{10,}\b/gu },
  {
    rule: "api-key",
    pattern:
      /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,}|\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9_-]{20,}|\bgithub_pat_[A-Za-z0-9_]{22,}|\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bglpat-[A-Za-z0-9_-]{20,}|\bya29\.[A-Za-z0-9_-]{20,}|\bAIza[0-9A-Za-z_-]{35}\b|\bxai-[A-Za-z0-9]{20,}|\bhf_[A-Za-z0-9]{30,}/gu,
  },
  {
    rule: "bearer-token",
    pattern: /\b(?:Authorization\s*:\s*)?Bearer\s+[A-Za-z0-9._~+/=-]{16,}/giu,
  },
  { rule: "kr-rrn", pattern: /\b\d{6}-?[1-4]\d{6}\b/gu },
  {
    rule: "labeled-secret",
    pattern:
      /\b(?:api[_ -]?key|access[_ -]?token|secret|password|passwd)(?:\s*[:=]\s*|\s+is\s+)\S+|(?:토큰|비밀번호|암호|인증번호)\s*(?:[:=]|은|는)\s*\S+/giu,
  },
  { rule: "card-number", pattern: /\b(?:\d[ -]?){12,18}\d\b/gu },
] as const satisfies ReadonlyArray<{ readonly rule: RedactionRule; readonly pattern: RegExp }>

function validCard(candidate: string): boolean {
  const digits = candidate.replace(/\D/gu, "")
  if (digits.length < 13 || digits.length > 19) return false

  let sum = 0
  let doubled = false
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = Number(digits[index])
    if (doubled) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    doubled = !doubled
  }
  return sum % 10 === 0
}

function validRrn(candidate: string): boolean {
  const digits = candidate.replace("-", "")
  const month = Number(digits.slice(2, 4))
  const day = Number(digits.slice(4, 6))
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
}

function collectMatches(text: string): Match[] {
  const matches: Match[] = []
  for (const { rule, pattern } of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (rule === "card-number" && !validCard(match[0])) continue
      if (rule === "kr-rrn" && !validRrn(match[0])) continue
      matches.push({ start: match.index, end: match.index + match[0].length, rule })
    }
  }

  const contexts = /\b(?:otp|code)\b|인증/giu
  const numbers = [...text.matchAll(/\b\d{4,8}\b/gu)]
  for (const context of text.matchAll(contexts)) {
    const offset = context.index + context[0].length
    const limit = offset + 40
    for (const number of numbers) {
      if (number.index < offset) continue
      if (number.index >= limit) break
      if (number.index + number[0].length > limit) continue
      matches.push({
        start: number.index,
        end: number.index + number[0].length,
        rule: "otp-numeric",
      })
    }
  }
  return matches
}

export function redact(text: string): RedactionResult {
  const matches = collectMatches(text).sort(
    (left, right) => left.start - right.start || right.end - left.end,
  )
  const selected: Match[] = []
  for (const match of matches) {
    const previous = selected.at(-1)
    if (!previous || match.start >= previous.end) {
      selected.push(match)
    } else if (match.end > previous.end) {
      selected[selected.length - 1] = { ...previous, end: match.end }
    }
  }

  const chunks: string[] = []
  const counts = new Map<RedactionRule, number>()
  let cursor = 0
  for (const match of selected) {
    chunks.push(text.slice(cursor, match.start), MASK)
    counts.set(match.rule, (counts.get(match.rule) ?? 0) + 1)
    cursor = match.end
  }
  chunks.push(text.slice(cursor))

  const masks: Array<{ readonly rule: RedactionRule; readonly count: number }> = []
  for (const rule of [...PATTERNS.map((item) => item.rule), "otp-numeric"] as const) {
    const count = counts.get(rule)
    if (count !== undefined) masks.push({ rule, count })
  }
  return { text: chunks.join(""), masks }
}
