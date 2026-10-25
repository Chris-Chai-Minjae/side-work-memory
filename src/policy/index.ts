import type { z } from "zod"
import hardBlockedBundleIds from "../../specs/shared/hard-blocked-bundle-ids.json"
import { PAUSE_INDEFINITE } from "../constants"
import type { RuleSchema } from "../contracts/settings"

export type DenyRule = z.infer<typeof RuleSchema>

export type CapturePolicy = {
  readonly enabled: boolean
  readonly pausedUntil: number | null
  readonly rules: readonly DenyRule[]
}

export const HARD_BLOCKED_BUNDLE_IDS: readonly string[] = hardBlockedBundleIds

function canonicalHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/u, "")
}

export function isDeniedHost(hostname: string, rules: readonly DenyRule[]): boolean {
  const host = canonicalHostname(hostname)
  return rules.some((rule) => {
    if (rule.scope !== "url" || rule.behavior !== "do_not_observe") return false
    const denied = canonicalHostname(rule.urlDomain)
    return host === denied || host.endsWith(`.${denied}`)
  })
}

export function isDeniedApp(bundleId: string, rules: readonly DenyRule[]): boolean {
  return (
    HARD_BLOCKED_BUNDLE_IDS.some((hardBlocked) => hardBlocked === bundleId) ||
    rules.some(
      (rule) =>
        rule.scope === "app" && rule.behavior === "do_not_observe" && rule.bundleId === bundleId,
    )
  )
}

export function shouldCapture(
  policy: CapturePolicy,
  bundleId: string,
  url: string | null,
  now: number,
): boolean {
  if (!policy.enabled || policy.pausedUntil === PAUSE_INDEFINITE) return false
  if (policy.pausedUntil !== null && now < policy.pausedUntil) return false
  if (isDeniedApp(bundleId, policy.rules)) return false
  if (url === null) return true
  const parsed = URL.parse(url)
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return false
  return !isDeniedHost(parsed.hostname, policy.rules)
}
