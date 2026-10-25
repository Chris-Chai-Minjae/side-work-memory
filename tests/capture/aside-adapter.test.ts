import { describe, expect, test } from "bun:test"
import { suppressAriaFields } from "../../src/capture/aria-fields"
import { AsideDomAdapter, resolveAsideExecutable } from "../../src/capture/aside-adapter"

const asideBundleId = "at.studio.AsideBrowser"
const axSnapshot = { source: "mac_ax", shape: "ax", content: "synthetic AX content" } as const
const validOutput =
  'Aside REPL banner\nSIDE_ASIDE_SNAPSHOT {"kind":"snapshot","content":"synthetic ARIA tree","beforeTabId":"tab-1","beforeUrl":"https://allowed.example/page?view=1","afterTabId":"tab-1","afterUrl":"https://allowed.example/page?view=1","attachedUrl":"https://allowed.example/page?view=1"}\n'

describe("AsideDomAdapter", () => {
  test("Given sensitive and ordinary input descendants, when sanitized, then all input values are removed", () => {
    const tree = [
      "- 'textbox \"Password: answer\"': SYNTHETIC_PRIVATE_VALUE",
      '- combobox "Choice":',
      '  - option "SYNTHETIC_SELECTION" [selected]',
      '- textbox "Password":',
      "  - text: SYNTHETIC_NESTED_VALUE",
      '- heading "Public heading" [level=1]',
      '- link "Guide": /guide',
    ].join("\n")

    const safe = suppressAriaFields(tree)

    expect(safe.tree).not.toContain("SYNTHETIC_PRIVATE_VALUE")
    expect(safe.tree).not.toContain("SYNTHETIC_SELECTION")
    expect(safe.tree).not.toContain("SYNTHETIC_NESTED_VALUE")
    expect(safe.tree).toContain('- heading "Public heading" [level=1]')
    expect(safe.tree).toContain('- link "Guide": /guide')
    expect(safe.suppressed).toBe(3)
  })

  test("Given input values in an ARIA snapshot, when captured, then all input values are removed", async () => {
    const tree = [
      '- heading "Project plan"',
      '- link "Guide": /guide',
      '- textbox "Password": FAKE_PASSWORD_VALUE',
      '- textbox "OTP": 123456',
      '- textbox "Card Number": 4111111111111111',
      '- textbox "Notes": private draft text',
      "- searchbox: private search term",
      '- combobox "Choice": private option',
    ].join("\n")
    const output = `SIDE_ASIDE_SNAPSHOT ${JSON.stringify({
      kind: "snapshot",
      content: tree,
      beforeTabId: "tab-1",
      beforeUrl: "https://allowed.example/page",
      afterTabId: "tab-1",
      afterUrl: "https://allowed.example/page",
      attachedUrl: "https://allowed.example/page",
    })}\n`
    const adapter = new AsideDomAdapter(async () => output)

    const result = await adapter.capture({
      enabled: true,
      foregroundBundleId: asideBundleId,
      expectedNormalizedUrl: "https://allowed.example/page",
      captureAx: async () => axSnapshot,
    })

    expect(result).toEqual({
      source: "aside_dom",
      shape: "aria",
      rawUrl: "https://allowed.example/page",
      suppressedFields: 6,
      content: [
        '- heading "Project plan"',
        '- link "Guide": /guide',
        '- textbox "Password": [redacted:field]',
        '- textbox "OTP": [redacted:field]',
        '- textbox "Card Number": [redacted:field]',
        '- textbox "Notes": [redacted:field]',
        "- searchbox: [redacted:field]",
        '- combobox "Choice": [redacted:field]',
      ].join("\n"),
    })
  })

  test("resolves Aside from absolute user or system paths with the app's restricted PATH", () => {
    const home = "/Users/example"
    expect(resolveAsideExecutable(home, (path) => path === `${home}/.local/bin/aside`)).toBe(
      `${home}/.local/bin/aside`,
    )
    expect(resolveAsideExecutable(home, (path) => path === "/opt/homebrew/bin/aside")).toBe(
      "/opt/homebrew/bin/aside",
    )
    expect(resolveAsideExecutable(home, () => false)).toBe("aside")
  })

  test("uses AX and marks health unavailable when the aside binary is missing", async () => {
    // Given opt-in and Aside in the foreground, with no CLI executable.
    let fallbackCalls = 0
    const adapter = new AsideDomAdapter(async () => {
      throw Object.assign(new Error("missing binary"), { code: "ENOENT" })
    })

    // When a capture is requested.
    const result = await adapter.capture({
      enabled: true,
      foregroundBundleId: asideBundleId,
      expectedNormalizedUrl: "https://allowed.example/page",
      captureAx: async () => {
        fallbackCalls++
        return axSnapshot
      },
    })

    // Then AX remains usable and helper health shows unavailable.
    expect(result).toEqual(axSnapshot)
    expect(fallbackCalls).toBe(1)
    expect(adapter.health).toBe("unavailable")
  })

  test.each([
    ["opt-in is off", asideBundleId, false],
    ["another app is foreground", "com.example.Other", true],
  ])("never invokes the CLI when %s", async (_label, foregroundBundleId, enabled) => {
    // Given a runner that records any attempted Aside invocation.
    let runCalls = 0
    const adapter = new AsideDomAdapter(async () => {
      runCalls++
      return validOutput
    })

    // When capture is requested outside the two approved gates.
    const result = await adapter.capture({
      enabled,
      foregroundBundleId,
      expectedNormalizedUrl: "https://allowed.example/page",
      captureAx: async () => axSnapshot,
    })

    // Then no Aside process is spawned and AX is returned.
    expect(result).toEqual(axSnapshot)
    expect(runCalls).toBe(0)
    expect(adapter.health).toBe("off")
  })

  test("spawns one repl per eligible capture and returns a validated ARIA snapshot", async () => {
    // Given synthetic successful stdout from the documented REPL sequence.
    const calls: { command: string; args: readonly string[]; timeoutMs: number }[] = []
    const adapter = new AsideDomAdapter(async (command, args, timeoutMs) => {
      calls.push({ command, args, timeoutMs })
      return validOutput
    })
    const capture = () =>
      adapter.capture({
        enabled: true,
        foregroundBundleId: asideBundleId,
        expectedNormalizedUrl: "https://allowed.example/page",
        captureAx: async () => axSnapshot,
      })

    // When two captures are requested.
    const first = await capture()
    const second = await capture()

    // Then each capture invokes a fresh repl with the 5 second deadline.
    expect(first).toEqual({
      source: "aside_dom",
      shape: "aria",
      content: "synthetic ARIA tree",
      rawUrl: "https://allowed.example/page?view=1",
    })
    expect(second).toEqual(first)
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.command).toBe("aside")
      expect(call.args[0]).toBe("repl")
      expect(call.timeoutMs).toBe(5_000)
      const script = call.args[1] ?? ""
      expect(script).toContain("listBrowserTabs()")
      expect(script).toContain("attachBrowserTab(before.targetId)")
      expect(script).toContain("snapshot(page)")
      expect(script.indexOf("listBrowserTabs()")).toBeLessThan(
        script.indexOf("attachBrowserTab(before.targetId)"),
      )
      expect(script.indexOf("attachBrowserTab(before.targetId)")).toBeLessThan(
        script.indexOf("snapshot(page)"),
      )
    }
    expect(adapter.health).toBe("available")
  })

  test("rejects malformed stdout, escalates after three failures, then recovers", async () => {
    // Given three invalid successful outputs: wrong type, unknown object, and no marker.
    let attempts = 0
    let fallbackCalls = 0
    const invalidOutputs = [
      'SIDE_ASIDE_SNAPSHOT {"kind":"snapshot","content":42}\n',
      'SIDE_ASIDE_SNAPSHOT {"kind":"snapshot","content":{"role":"document"}}\n',
      "Aside REPL banner only\n",
    ]
    const adapter = new AsideDomAdapter(async () => {
      attempts++
      return invalidOutputs[attempts - 1] ?? validOutput
    })
    const capture = () =>
      adapter.capture({
        enabled: true,
        foregroundBundleId: asideBundleId,
        expectedNormalizedUrl: "https://allowed.example/page",
        captureAx: async () => {
          fallbackCalls++
          return axSnapshot
        },
      })

    // When three invalid captures and then one valid capture occur.
    expect(await capture()).toEqual(axSnapshot)
    expect(adapter.health).toBe("unavailable")
    expect(await capture()).toEqual(axSnapshot)
    expect(adapter.health).toBe("unavailable")
    expect(await capture()).toEqual(axSnapshot)
    expect(adapter.health).toBe("error")
    const recovered = await capture()

    // Then all failures used AX and a valid result restores availability.
    expect(fallbackCalls).toBe(3)
    expect(recovered).toEqual({
      source: "aside_dom",
      shape: "aria",
      content: "synthetic ARIA tree",
      rawUrl: "https://allowed.example/page?view=1",
    })
    expect(adapter.health).toBe("available")
  })

  test("ignores valid-looking stdout from a failed CLI exit", async () => {
    // Given a process failure whose error object carries a valid-looking stdout string.
    const adapter = new AsideDomAdapter(async () => {
      throw Object.assign(new Error("exit failure"), { code: 1, stdout: validOutput })
    })

    // When the adapter captures while enabled and foregrounded.
    const result = await adapter.capture({
      enabled: true,
      foregroundBundleId: asideBundleId,
      expectedNormalizedUrl: "https://allowed.example/page",
      captureAx: async () => axSnapshot,
    })

    // Then failed-process output is ignored and AX is used.
    expect(result).toEqual(axSnapshot)
    expect(adapter.health).toBe("unavailable")
  })

  test("falls back after a five second CLI timeout", async () => {
    // Given an injected runner that times out at the requested deadline.
    let requestedTimeout = 0
    const adapter = new AsideDomAdapter(async (_command, _args, timeoutMs) => {
      requestedTimeout = timeoutMs
      throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
    })

    // When Aside capture is attempted.
    const result = await adapter.capture({
      enabled: true,
      foregroundBundleId: asideBundleId,
      expectedNormalizedUrl: "https://allowed.example/page",
      captureAx: async () => axSnapshot,
    })

    // Then it requests a five second timeout and returns AX.
    expect(requestedTimeout).toBe(5_000)
    expect(result).toEqual(axSnapshot)
    expect(adapter.health).toBe("unavailable")
  })

  test.each([
    ["changed tab", validOutput.replace('"afterTabId":"tab-1"', '"afterTabId":"tab-2"')],
    [
      "changed raw URL",
      validOutput.replace(
        '"afterUrl":"https://allowed.example/page?view=1"',
        '"afterUrl":"https://deny.example/private"',
      ),
    ],
    [
      "changed query on the same page",
      validOutput.replace(
        '"afterUrl":"https://allowed.example/page?view=1"',
        '"afterUrl":"https://allowed.example/page?view=2"',
      ),
    ],
    [
      "changed attached page",
      validOutput.replace(
        '"attachedUrl":"https://allowed.example/page?view=1"',
        '"attachedUrl":"https://deny.example/private"',
      ),
    ],
    ["unidentified tab", validOutput.replace('"beforeTabId":"tab-1"', '"beforeTabId":""')],
  ])("discards DOM when %s", async (_label, output) => {
    const adapter = new AsideDomAdapter(async () => output)
    const result = await adapter.capture({
      enabled: true,
      foregroundBundleId: asideBundleId,
      expectedNormalizedUrl: "https://allowed.example/page",
      captureAx: async () => axSnapshot,
    })
    expect(result).toEqual(axSnapshot)
  })
})
