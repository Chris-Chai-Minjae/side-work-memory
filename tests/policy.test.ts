import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  HARD_BLOCKED_BUNDLE_IDS,
  isDeniedApp as isDeniedAppV2,
  isDeniedHost as isDeniedHostV2,
  shouldCapture as shouldCaptureV2,
} from "../src/policy/index"
import { normalizePageUrl } from "../src/policy/url"

describe("capture policy", () => {
  test("Given an HTTPS URL with query and fragment, when normalized, then only its page path remains", () => {
    expect(normalizePageUrl("https://example.com/a?token=secret#private")).toBe(
      "https://example.com/a",
    )
  })

  test("Given a browser-internal URL, when normalized, then capture is rejected", () => {
    expect(normalizePageUrl("chrome://settings/passwords")).toBeNull()
  })
})

describe("v2 deny rules", () => {
  const urlRule = [
    { scope: "url", behavior: "do_not_observe", urlDomain: "mail.example.com" },
  ] as const
  const hardBlocked = [
    ["com.minjaechai.Side"],
    ["com.1password.1password"],
    ["com.agilebits.onepassword7"],
    ["com.apple.keychainaccess"],
    ["com.apple.systempreferences"],
    ["com.apple.Passwords"],
    ["com.bitwarden.desktop"],
    ["org.keepassxc.keepassxc"],
  ] as const

  test.each([
    ["mail.example.com", true],
    ["a.mail.example.com", true],
    ["notmail.example.com", false],
    ["mail.example.com.evil.test", false],
  ] as const)(
    "Given a mail.example.com deny rule, when checking %s, then denial matches",
    (host, denied) => {
      expect(isDeniedHostV2(host, urlRule)).toBe(denied)
    },
  )

  test.each([
    ["MAIL.EXAMPLE.COM.", "mail.example.com"],
    ["mail.example.com", "MAIL.EXAMPLE.COM."],
    ["a.mail.example.com.", "mail.example.com."],
  ] as const)(
    "Given DNS-equivalent host %s and rule %s, when checked, then trailing dots and case are canonicalized",
    (host, urlDomain) => {
      expect(isDeniedHostV2(host, [{ scope: "url", behavior: "do_not_observe", urlDomain }])).toBe(
        true,
      )
    },
  )

  test("Given only an observe URL rule, when checking its host, then it is not denied", () => {
    const rules = [{ scope: "url", behavior: "observe", urlDomain: "mail.example.com" }] as const
    expect(isDeniedHostV2("mail.example.com", rules)).toBe(false)
  })

  test.each(["before", "after"] as const)(
    "Given an observe URL rule %s a deny rule, when checking its host, then it is denied",
    (order) => {
      const observe = { scope: "url", behavior: "observe", urlDomain: "mail.example.com" } as const
      const rules = order === "before" ? [observe, ...urlRule] : [...urlRule, observe]
      expect(isDeniedHostV2("mail.example.com", rules)).toBe(true)
    },
  )

  test.each([
    ["com.example.Mail", true],
    ["com.example.MailExtra", false],
  ] as const)(
    "Given an app deny rule, when checking %s, then denial matches",
    (bundleId, denied) => {
      const rules = [
        { scope: "app", behavior: "do_not_observe", bundleId: "com.example.Mail" },
      ] as const
      expect(isDeniedAppV2(bundleId, rules)).toBe(denied)
    },
  )

  test.each(hardBlocked)(
    "Given no user rules, when checking hard-blocked %s, then it is denied",
    (bundleId) => {
      expect(isDeniedAppV2(bundleId, [])).toBe(true)
    },
  )

  test("Given the canonical hard block list, when TS and bundled Swift copies are compared, then every ID is identical", () => {
    const canonical = JSON.parse(
      readFileSync(
        join(import.meta.dir, "..", "specs", "shared", "hard-blocked-bundle-ids.json"),
        "utf8",
      ),
    )
    const swift = JSON.parse(
      readFileSync(
        join(
          import.meta.dir,
          "..",
          "apps",
          "side-mac",
          "Sources",
          "SideCaptureKit",
          "Resources",
          "hard-blocked-bundle-ids.json",
        ),
        "utf8",
      ),
    )
    expect([...HARD_BLOCKED_BUNDLE_IDS]).toEqual(canonical)
    expect(swift).toEqual(canonical)
  })

  test.each(hardBlocked)(
    "Given an observe rule for hard-blocked %s, when checked, then it remains denied",
    (bundleId) => {
      expect(isDeniedAppV2(bundleId, [{ scope: "app", behavior: "observe", bundleId }])).toBe(true)
    },
  )

  test("Given a lookalike bundle ID, when checked, then it is not hard-blocked", () => {
    expect(isDeniedAppV2("com.minjaechai.SideHelper", [])).toBe(false)
  })

  test("Given only an observe app rule, when checked, then it does not deny the app", () => {
    expect(
      isDeniedAppV2("com.example.Mail", [
        { scope: "app", behavior: "observe", bundleId: "com.example.Mail" },
      ]),
    ).toBe(false)
  })

  const policy = { enabled: true, pausedUntil: null, rules: urlRule } as const
  test.each([
    ["disabled", { ...policy, enabled: false }, "com.example.Browser", null, false],
    [
      "indefinite pause",
      { ...policy, pausedUntil: Number.MAX_SAFE_INTEGER },
      "com.example.Browser",
      null,
      false,
    ],
    ["active pause", { ...policy, pausedUntil: 200 }, "com.example.Browser", null, false],
    ["expired pause", { ...policy, pausedUntil: 99 }, "com.example.Browser", null, true],
    ["hard-blocked app", policy, "com.minjaechai.Side", null, false],
    ["denied subdomain", policy, "com.example.Browser", "https://a.mail.example.com/inbox", false],
    ["unrelated host", policy, "com.example.Browser", "https://notmail.example.com/inbox", true],
  ] as const)(
    "Given %s, when checking capture, then the policy decision is returned",
    (_caseName, settings, bundleId, url, allowed) => {
      expect(shouldCaptureV2(settings, bundleId, url, 100)).toBe(allowed)
    },
  )
})
