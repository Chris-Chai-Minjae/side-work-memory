import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Browser, type BrowserContext, chromium, type Page } from "playwright"
import { z } from "zod"
import {
  DayPageSchema,
  EvidenceSchema,
  HistoryStatusSchema,
} from "../../src/contracts/rpc-resources"
import { day, emptyDay, nextDay, previousDay, startDayFixture } from "./day-view-fixture"

type Fixture = Awaited<ReturnType<typeof startDayFixture>>
const RpcRequestSchema = z.object({ method: z.string(), params: z.unknown().optional() })
type PageOptions = {
  readonly route?: (fixture: Fixture) => string
}

let browser: Browser
let webDirectory: string

beforeAll(async () => {
  webDirectory = mkdtempSync(join(tmpdir(), "side-day-web-"))
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
})

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
  options: PageOptions = {},
): Promise<void> {
  const fixture = await startDayFixture(webDirectory)
  let context: BrowserContext | null = null
  let page: Page | null = null
  try {
    expect(fixture.port).toBe(fixture.daemonPort)
    expect(existsSync(fixture.relayPath)).toBe(false)
    expect(JSON.parse(readFileSync(fixture.webPublicationPath, "utf8"))).toEqual({
      port: fixture.port,
      tokenHash: fixture.tokenHash,
    })
    expect(readFileSync(fixture.webPublicationPath, "utf8")).not.toContain(fixture.token)
    context = await browser.newContext({
      timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    page = await context.newPage()
    page.setDefaultTimeout(10_000)
    const errors: string[] = []
    const rpcRequests: { readonly url: string; readonly authorization: string | undefined }[] = []
    const navigations: { readonly url: string; readonly authorization: string }[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/rpc") {
        rpcRequests.push({ url: request.url(), authorization: request.headers()["authorization"] })
        const { method, params } = RpcRequestSchema.parse(request.postDataJSON())
        fixture.rpcCalls.push({ method, params })
      }
    })
    await page.addInitScript(() => {
      HTMLElement.prototype.scrollIntoView = function () {
        document.documentElement.dataset["scrolledTo"] = this.id
      }
    })
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
    const hash = options.route?.(fixture) ?? `#/history/${day}`
    const initialUrl = `http://127.0.0.1:${fixture.port}/?t=${fixture.token}${hash}`
    await page.goto(initialUrl, {
      waitUntil: "domcontentloaded",
      timeout: 10_000,
    })
    await page.getByRole("heading", { name: `기록 · ${hash.slice(10, 20)}` }).waitFor()
    const initialRequestUrl = new URL(initialUrl)
    initialRequestUrl.hash = ""
    expect(navigations).toEqual([
      { url: initialRequestUrl.href, authorization: `Bearer ${fixture.token}` },
    ])
    expect(page.url()).not.toContain("?t=")
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

test("P4-S2-T2: a rendered day shows the overview, ten-minute section, and Sources", async () => {
  await withPage(async (page, fixture) => {
    await page.getByRole("heading", { name: "하루 개요" }).waitFor()
    await page
      .getByRole("heading", { name: new RegExp(`Synthetic research.*${fixture.summaryRef}`) })
      .waitFor()
    expect(await page.locator(".day-sources").count()).toBe(1)
    expect(await page.locator(".day-sources").textContent()).toContain("출처:")
    expect(await page.locator(`[data-ref="${fixture.sourceRef}"]`).count()).toBe(1)
    expect(await page.locator(".day-markdown script").count()).toBe(0)
    expect(await page.locator(".day-markdown").textContent()).toContain("<script>")
    expect(await page.evaluate(() => Reflect.get(window, "__dayExecuted"))).toBeUndefined()
    expect(await page.locator('[data-action="previous-day"]').getAttribute("href")).toBe(
      `#/history/${previousDay}`,
    )
    expect(await page.locator('[data-action="next-day"]').getAttribute("href")).toBe(
      `#/history/${nextDay}`,
    )
    expect(await page.locator(".day-back-link").getAttribute("href")).toBe(
      "#/settings/context-awareness",
    )
    expect(await page.locator('[data-action="clear-today"]').count()).toBe(0)
    HistoryStatusSchema.parse(await fixture.callDaemon("historyStatus"))
    DayPageSchema.parse(await fixture.callDaemon("day.get", { date: day }))
    EvidenceSchema.parse(await fixture.callDaemon("read", { id: fixture.sourceRef }))
  })
}, 30_000)

test("P4-S2-T2: an evidence link reads once and keeps script-like content as text", async () => {
  await withPage(async (page, fixture) => {
    await page.locator(`[data-ref="${fixture.sourceRef}"]`).click()
    await page.getByRole("heading", { name: "Synthetic source" }).waitFor()
    expect(fixture.rpcCalls.filter((call) => call.method === "read")).toEqual([
      { method: "read", params: { id: fixture.sourceRef } },
    ])
    expect(await page.locator(".untrusted-text").textContent()).toContain(
      "&lt;script&gt;window.__evidenceExecuted = true&lt;/script&gt;",
    )
    expect(await page.locator(".untrusted-text script").count()).toBe(0)
    expect(
      await page
        .locator(".untrusted-text span")
        .first()
        .evaluate((node) => node.firstChild?.nodeType),
    ).toBe(3)
    expect(await page.evaluate(() => Reflect.get(window, "__evidenceExecuted"))).toBeUndefined()
  })
}, 30_000)

test("P4-S2-T2: an expired source links to its citing summary", async () => {
  await withPage(async (page, fixture) => {
    await page.locator(`[data-ref="${fixture.expiredRef}"]`).click()
    await page.getByText("원본 증거가 만료되었습니다.").waitFor()
    const citation = page.getByRole("link", { name: "인용한 요약 보기" })
    expect(await citation.getAttribute("href")).toBe(`#/history/${day}#${fixture.summaryRef}`)
    await citation.click()
    await page.locator(`html[data-scrolled-to="${fixture.summaryRef}"]`).waitFor()
  })
}, 30_000)

test("P4-S2-T2: a literal null day response shows the empty state and adjacent dates", async () => {
  await withPage(
    async (page, fixture) => {
      expect(await fixture.callDaemon("day.get", { date: emptyDay })).toBeNull()
      await page.getByText("이 날짜에는 요약이 없습니다.").waitFor()
      expect(await page.locator('[data-action="previous-day"]').getAttribute("href")).toBe(
        `#/history/${day}`,
      )
      expect(await page.locator('[data-action="next-day"]').getAttribute("href")).toBe(
        `#/history/${nextDay}`,
      )
    },
    { route: () => `#/history/${emptyDay}` },
  )
}, 30_000)

test("Given an empty Day view, when resized, then both desktop cards align and mobile cards stack", async () => {
  await withPage(
    async (page) => {
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.getByText("이 날짜에는 요약이 없습니다.").waitFor()
      await page.getByRole("button", { name: "어두운 테마" }).click()
      const desktop = await page.evaluate(() => {
        const empty = document
          .querySelector(".day-columns > .state-message")
          ?.getBoundingClientRect()
        const evidence = document
          .querySelector(".day-columns > .evidence-panel")
          ?.getBoundingClientRect()
        return empty && evidence
          ? {
              emptyBottom: empty.bottom,
              evidenceBottom: evidence.bottom,
              emptyLeft: empty.left,
              evidenceLeft: evidence.left,
            }
          : null
      })
      expect(desktop).not.toBeNull()
      if (!desktop) throw new Error("Empty Day cards are missing")
      expect(Math.abs(desktop.emptyBottom - desktop.evidenceBottom)).toBeLessThanOrEqual(1)
      expect(desktop.evidenceLeft).toBeGreaterThan(desktop.emptyLeft)
      await page.screenshot({
        path: join(tmpdir(), "side-empty-day-desktop-task_44f840f138a4.png"),
      })

      await page.setViewportSize({ width: 375, height: 812 })
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      expect(await page.locator(".app-header").count()).toBe(1)
      const mobile = await page.evaluate(() => {
        const empty = document
          .querySelector(".day-columns > .state-message")
          ?.getBoundingClientRect()
        const evidence = document
          .querySelector(".day-columns > .evidence-panel")
          ?.getBoundingClientRect()
        return empty && evidence
          ? {
              emptyBottom: empty.bottom,
              evidenceTop: evidence.top,
              emptyLeft: empty.left,
              evidenceLeft: evidence.left,
              evidenceRight: evidence.right,
            }
          : null
      })
      expect(mobile).not.toBeNull()
      if (!mobile) throw new Error("Responsive Day cards are missing")
      expect(Math.abs(mobile.evidenceLeft - mobile.emptyLeft)).toBeLessThanOrEqual(1)
      expect(mobile.evidenceTop).toBeGreaterThan(mobile.emptyBottom)
      expect(mobile.evidenceRight).toBeLessThanOrEqual(375)
      await page.screenshot({ path: join(tmpdir(), "side-empty-day-mobile-task_44f840f138a4.png") })
    },
    { route: () => `#/history/${emptyDay}` },
  )
}, 30_000)

test("P4-S2-T2: a summary hash scrolls to the matching section", async () => {
  await withPage(
    async (page, fixture) => {
      await page.locator(`html[data-scrolled-to="${fixture.summaryRef}"]`).waitFor()
    },
    { route: (fixture) => `#/history/${day}#${fixture.summaryRef}` },
  )
}, 30_000)

test("P4-S2-V: date navigation opens the adjacent summary date", async () => {
  await withPage(async (page) => {
    await page.locator('[data-action="next-day"]').click()
    await page.getByRole("heading", { name: `기록 · ${nextDay}` }).waitFor()
    expect(new URL(page.url()).hash).toBe(`#/history/${nextDay}`)
  })
}, 30_000)

test("P4-S2-V: previous navigation opens the earlier summary date", async () => {
  await withPage(async (page) => {
    await page.locator('[data-action="previous-day"]').click()
    await page.getByRole("heading", { name: `기록 · ${previousDay}` }).waitFor()
    expect(new URL(page.url()).hash).toBe(`#/history/${previousDay}`)
  })
}, 30_000)

test("P4-S2-V: the Day view Settings link changes the route", async () => {
  await withPage(async (page) => {
    await page.locator(".day-back-link").click()
    expect(new URL(page.url()).hash).toBe("#/settings/context-awareness")
  })
}, 30_000)

test("P4-S2-V: today-only Clear confirms before calling the daemon and reloads the page", async () => {
  await withPage(
    async (page, fixture) => {
      await page.getByRole("heading", { name: "Today synthetic summary" }).waitFor()
      await page.locator('[data-action="clear-today"]').click()
      await page.getByRole("dialog", { name: "기록 삭제" }).waitFor()
      expect(fixture.rpcCalls.filter((call) => call.method === "clear")).toHaveLength(0)
      await page.getByRole("dialog").getByRole("button", { name: "오늘 기록 삭제" }).click()
      await page.getByText("이 날짜에는 요약이 없습니다.").waitFor()
      expect(fixture.rpcCalls.filter((call) => call.method === "clear")).toEqual([
        { method: "clear", params: { target: "today" } },
      ])
      expect(fixture.rpcCalls.filter((call) => call.method === "day.get")).toHaveLength(2)
      expect(await fixture.callDaemon("day.get", { date: fixture.today })).toBeNull()
    },
    { route: (fixture) => `#/history/${fixture.today}` },
  )
}, 30_000)

test("P4-S2-V: unauthenticated Day view RPC receives HTTP 401", async () => {
  await withPage(async (_page, fixture) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "day.get", params: { date: day } })
    for (const headers of [{}, { Authorization: "Bearer wrong" }]) {
      const daemon = await fetch(`http://127.0.0.1:${fixture.daemonPort}/rpc`, {
        method: "POST",
        headers,
        body,
      })
      expect(daemon.status).toBe(401)
    }
  })
}, 30_000)
