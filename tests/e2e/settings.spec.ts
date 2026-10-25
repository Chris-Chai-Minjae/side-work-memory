import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Browser, type BrowserContext, chromium, type Page } from "playwright"
import { z } from "zod"
import { SettingsResourceSchema } from "../../src/contracts/rpc-resources"
import { SettingsSchema } from "../../src/contracts/settings"
import { startSettingsFixture } from "./settings-daemon-fixture"

type Fixture = Awaited<ReturnType<typeof startSettingsFixture>>
const RpcRequestSchema = z.object({ method: z.string(), params: z.unknown().optional() })
let browser: Browser
let webDirectory: string

beforeAll(async () => {
  webDirectory = mkdtempSync(join(tmpdir(), "side-settings-web-"))
  try {
    const built = Bun.spawnSync({
      cmd: [
        process.execPath,
        "build",
        "./src/web/index.html",
        "--target",
        "browser",
        "--minify",
        "--outdir",
        webDirectory,
      ],
      cwd: join(import.meta.dir, "..", ".."),
    })
    if (built.exitCode !== 0) throw new Error(built.stderr.toString())
    browser = await chromium.launch({ channel: "chrome", headless: true })
  } catch (error) {
    rmSync(webDirectory, { recursive: true, force: true })
    throw error
  }
}, 30_000)

afterAll(async () => {
  try {
    await browser?.close()
  } finally {
    Bun.gc(true)
    if (webDirectory) rmSync(webDirectory, { recursive: true, force: true })
  }
}, 30_000)

async function withPage(
  run: (page: Page, fixture: Fixture) => Promise<void>,
  inputMonitoring = true,
) {
  const fixture = await startSettingsFixture(webDirectory, inputMonitoring)
  let context: BrowserContext | null = null
  let page: Page | null = null
  try {
    expect(fixture.daemonPort).toBeGreaterThan(0)
    expect(fixture.port).toBe(fixture.daemonPort)
    expect(existsSync(fixture.relayPath)).toBe(false)
    expect(JSON.parse(readFileSync(fixture.webPublicationPath, "utf8"))).toEqual({
      port: fixture.port,
      tokenHash: fixture.tokenHash,
    })
    expect(readFileSync(fixture.webPublicationPath, "utf8")).not.toContain(fixture.token)
    context = await browser.newContext()
    page = await context.newPage()
    const scriptRequests: string[] = []
    const errors: string[] = []
    const rpcRequests: { readonly url: string; readonly authorization: string | undefined }[] = []
    const navigations: { readonly url: string; readonly authorization: string }[] = []
    page.on("request", (request) => {
      if (request.resourceType() === "script") scriptRequests.push(request.url())
      if (new URL(request.url()).pathname === "/rpc") {
        rpcRequests.push({ url: request.url(), authorization: request.headers()["authorization"] })
        const { method, params } = RpcRequestSchema.parse(request.postDataJSON())
        fixture.calls.push({
          method,
          params:
            method === "providers.setKey"
              ? { providerId: z.object({ providerId: z.string() }).parse(params).providerId }
              : params,
        })
      }
    })
    page.on("pageerror", (error) => errors.push(error.message))
    await page.route("**/*", async (route) => {
      if (route.request().isNavigationRequest()) {
        const authorization = `Bearer ${fixture.token}`
        navigations.push({ url: route.request().url(), authorization })
        await route.continue({
          headers: { ...route.request().headers(), authorization },
        })
      } else {
        await route.continue()
      }
    })
    const initialUrl = `http://127.0.0.1:${fixture.port}/?t=${fixture.token}#/settings/context-awareness`
    await page.goto(initialUrl, { waitUntil: "domcontentloaded" })
    await page.getByRole("heading", { name: "Side가 하루를 기억하도록" }).waitFor()
    const initialRequestUrl = new URL(initialUrl)
    initialRequestUrl.hash = ""
    expect(navigations).toEqual([
      { url: initialRequestUrl.href, authorization: `Bearer ${fixture.token}` },
    ])
    expect(page.url()).not.toContain("?t=")
    expect(scriptRequests).toEqual([])
    await run(page, fixture)
    expect(rpcRequests.length).toBeGreaterThan(0)
    for (const request of rpcRequests) {
      expect(request.url).toBe(`http://127.0.0.1:${fixture.daemonPort}/rpc`)
      expect(request.authorization).toBe(`Bearer ${fixture.token}`)
    }
    expect(existsSync(fixture.relayPath)).toBe(false)
    expect(errors).toEqual([])
  } finally {
    try {
      await page?.close()
    } finally {
      try {
        await context?.close()
      } finally {
        await fixture.close()
      }
    }
  }
}

test("P4-S1-T2: missing Input Monitoring shows permission action", async () => {
  await withPage(async (page, fixture) => {
    await page.getByText("권한이 필요합니다").waitFor()
    fixture.grantInputMonitoring()
    await page.getByRole("button", { name: "허용" }).click()
    await page.getByText("권한이 필요합니다").waitFor({ state: "hidden" })
    expect(fixture.calls.filter((call) => call.method === "requestPermissions")).toEqual([
      { method: "requestPermissions", params: { kinds: ["inputMonitoring"] } },
    ])
    expect(await fixture.callDaemon("permissions")).toMatchObject({ input_monitoring: true })
  }, false)
}, 30_000)

test("P4-S1-T2: disabling capture does not patch before confirmation", async () => {
  await withPage(async (page, fixture) => {
    await page.getByRole("switch", { name: "상황 인식 켜기" }).click()
    await page.getByRole("dialog", { name: "상황 인식을 끄시겠습니까?" }).waitFor()
    expect(fixture.calls.filter((call) => call.method === "settings.patch")).toHaveLength(0)
    await page.getByRole("dialog").getByRole("button", { name: "끄기" }).click()
    await page.waitForFunction(
      () => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "false",
    )
    expect(fixture.calls.filter((call) => call.method === "settings.patch")).toEqual([
      { method: "settings.patch", params: { enabled: false } },
    ])
    expect(
      SettingsSchema.parse(JSON.parse(readFileSync(fixture.settingsPath, "utf8"))).contextAwareness
        .enabled,
    ).toBe(false)
  })
}, 30_000)

test("Given Korean default, when English is selected, then the page, navigation, and saved setting switch on a fresh authenticated load", async () => {
  await withPage(async (page, fixture) => {
    expect(await page.locator("html").getAttribute("lang")).toBe("ko")
    await page.locator("#ui-language").selectOption("en")
    await page.getByRole("heading", { name: "Let Side remember your day" }).waitFor()
    await page.getByRole("navigation", { name: "Main navigation" }).getByText("History").waitFor()
    expect(
      SettingsSchema.parse(JSON.parse(readFileSync(fixture.settingsPath, "utf8"))).uiLanguage,
    ).toBe("en")
    expect(fixture.calls.filter((call) => call.method === "settings.patch")).toContainEqual({
      method: "settings.patch",
      params: { uiLanguage: "en" },
    })
    await page.goto(
      `http://127.0.0.1:${fixture.port}/?t=${fixture.token}#/settings/context-awareness`,
      { waitUntil: "domcontentloaded" },
    )
    await page.getByRole("heading", { name: "Let Side remember your day" }).waitFor()
    expect(await page.locator("html").getAttribute("lang")).toBe("en")
  })
}, 30_000)

test("P4-S1-T2: website exclusion normalizes URL to lowercase host", async () => {
  await withPage(async (page, fixture) => {
    await page.getByRole("button", { name: "추가", exact: true }).first().click()
    const dialog = page.getByRole("dialog", { name: "캡처하지 않음" })
    await dialog.getByRole("button", { name: "웹사이트" }).click()
    await dialog.getByRole("textbox", { name: "웹사이트" }).fill("https://Mail.Example.com/inbox")
    await dialog.getByRole("button", { name: "추가", exact: true }).click()
    await page.getByText("mail.example.com").waitFor()
    expect(
      SettingsResourceSchema.parse(await fixture.callDaemon("settings.get")).rules,
    ).toContainEqual({
      scope: "url",
      behavior: "do_not_observe",
      urlDomain: "mail.example.com",
    })
  })
}, 30_000)

test("P4-S1-T2: evidence consent warns with host and cancel leaves it off", async () => {
  await withPage(async (page, fixture) => {
    await page.getByRole("switch", { name: "이 제공자에게 증거 전송 local" }).click()
    const dialog = page.getByRole("dialog", { name: "이 제공자에게 증거를 전송하시겠습니까?" })
    await dialog
      .getByText(
        "요약을 만들 때 10분 단위로 가린 활동을 다음 제공자에게 전송합니다: fixture.invalid.",
      )
      .waitFor()
    await dialog.getByRole("button", { name: "취소" }).click()
    expect(
      SettingsResourceSchema.parse(await fixture.callDaemon("settings.get")).providers[0]
        ?.allow_evidence,
    ).toBe(false)
    expect(fixture.calls.filter((call) => call.method === "settings.patch")).toHaveLength(0)
  })
}, 30_000)

test("P4-S1-T2: saved provider key never appears in settings response", async () => {
  await withPage(async (page, fixture) => {
    await page.getByRole("button", { name: "편집" }).click()
    const dialog = page.getByRole("dialog", { name: "제공자 편집" })
    await dialog.getByRole("textbox", { name: "API 키" }).fill("synthetic-only-key")
    await dialog.getByRole("button", { name: "제공자 저장" }).click()
    await page.getByText("키 저장됨").waitFor()
    const response = await fetch(`http://127.0.0.1:${fixture.port}/rpc`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixture.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "settings.get" }),
    })
    const body = await response.text()
    expect(body).not.toContain("synthetic-only-key")
    expect(JSON.parse(body).result.providers[0].has_key).toBe(true)
    const saved = readFileSync(fixture.settingsPath, "utf8")
    expect(saved).not.toContain("synthetic-only-key")
    const savedProvider = SettingsSchema.parse(JSON.parse(saved)).providers[0]
    const expectedRef = `provider/local/${createHash("sha256")
      .update(JSON.stringify(["local", "https://fixture.invalid/v1"]))
      .digest("hex")}`
    expect(
      savedProvider?.kind === "claude-code-cli" || savedProvider?.kind === "codex-cli"
        ? undefined
        : savedProvider?.apiKeyRef,
    ).toBe(expectedRef)
    expect(fixture.helperCalls.filter((call) => call.name === "keychain.set")).toEqual([
      { name: "keychain.set", ref: expectedRef, keyMatched: true },
    ])
    expect(fixture.calls.filter((call) => call.method === "providers.setKey")).toEqual([
      { method: "providers.setKey", params: { providerId: "local" } },
    ])
  })
}, 30_000)

test("P4-S1-V: all sixteen Settings RPC methods are registered on the daemon", async () => {
  const methods = [
    "status",
    "permissions",
    "settings.get",
    "summaryModelDefault",
    "historyStatus",
    "listApplications",
    "mcp.usage",
    "historyList",
    "appIcons",
    "settings.patch",
    "pause",
    "resume",
    "requestPermissions",
    "clear",
    "providers.setKey",
    "providers.test",
  ] as const
  expect(methods).toHaveLength(16)
  const fixture = await startSettingsFixture(webDirectory)
  try {
    for (const method of methods) {
      await expect(fixture.callDaemon(method, "invalid-params")).rejects.toThrow("(-32602)")
    }
    await expect(
      fixture.callDaemon("unregistered.settings.probe", "invalid-params"),
    ).rejects.toThrow("(-32601)")
  } finally {
    await fixture.close()
  }
}, 30_000)

test("P4-S1-T2: direct Settings RPC rejects missing and incorrect Bearer", async () => {
  await withPage(async (_page, fixture) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "settings.get" })
    for (const headers of [{}, { Authorization: "Bearer wrong" }]) {
      const response = await fetch(`http://127.0.0.1:${fixture.daemonPort}/rpc`, {
        method: "POST",
        headers,
        body,
      })
      expect(response.status).toBe(401)
    }
  })
}, 30_000)
