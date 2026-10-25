import type { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { ulid } from "ulid"
import { z } from "zod"
import { createApplicationsHandlers } from "../api/resources/applications"
import { createEvidenceHandlers } from "../api/resources/evidence"
import { createHistoryHandlers } from "../api/resources/history"
import { createMcpUsageHandlers } from "../api/resources/mcp-usage"
import { createMemorySearchHandler } from "../api/resources/memory"
import { createProviderHandlers } from "../api/resources/providers"
import { createSettingsHandlers, createSettingsMutation } from "../api/resources/settings"
import { createStatusHandlers } from "../api/resources/status"
import { type ApiServer, startApiServer } from "../api/server"
import { AsideDomAdapter, AsideOutputError } from "../capture/aside-adapter"
import { CaptureScheduler, type SchedulerClock } from "../capture/scheduler"
import { targetKey } from "../capture/target"
import { DwellTracker } from "../comprehension/dwell"
import { enqueueSummaryJobs, markNonGlanceEvent } from "../comprehension/queue"
import { runSummaryPass } from "../comprehension/run"
import { dataDirectory, loadSettings, saveSettings } from "../config/index"
import {
  BROWSER_URL_POLL_MS,
  COMPREHENSION_INTERVAL_MS,
  FRAME_COLD_AGE_MS,
  GC_INTERVAL_MS,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  PRIVATE_UMASK,
  SELECTION_BURST_MS,
  SUPPRESSION_BUCKET_MS,
} from "../constants"
import type { HelperHealth } from "../contracts/protocol"
import { RpcMethods } from "../contracts/rpc"
import { deriveSubkey, keyedHash } from "../crypto/index"
import { HelperClient, HelperCommandFailureError, HelperUnavailableError } from "../helper/client"
import { clearFrameReadCache, sealColdBlobs } from "../ledger/frames"
import { runLedgerGc } from "../ledger/gc"
import { openLedger } from "../ledger/schema"
import { LedgerStats } from "../ledger/stats"
import { type LedgerEventInput, writeLedgerEvent } from "../ledger/write"
import { digestContextAwareness } from "../memory/digest"
import { EmbeddingManager } from "../memory/embed"
import { openIndexDb } from "../memory/index-db"
import { renderContextAwarenessDayPage } from "../memory/render"
import { bundledResourcePath } from "../memory/sqlite"
import { createMemoryIndexSyncScheduler, syncMemoryIndex } from "../memory/sync"
import { isDeniedApp, isDeniedHost } from "../policy/index"
import { normalizePageUrl } from "../policy/url"
import { createBrowserHistoryProvider } from "../recall/browser-history"
import { truncateWal } from "../sqlite/checkpoint"
import { DaemonDiagnostics } from "./diagnostics"
import { acquireDaemonLock } from "./lock"
import { Reconciler } from "./reconcile"

const BROWSER_BUNDLE_IDS = new Set([
  "at.studio.AsideBrowser",
  "com.google.Chrome",
  "com.apple.Safari",
  "company.thebrowser.Browser",
  "com.brave.Browser",
  "com.microsoft.edgemac",
])

const ObservationSchema = z.object({
  occurredAt: z.number().int().nonnegative(),
  source: z.enum(["mac_ax", "aside_dom"]),
  kind: z.enum([
    "session.started",
    "session.ended",
    "window.changed",
    "mouse.click",
    "mouse.context_menu",
    "mouse.drag",
    "keyboard.shortcut",
    "keyboard.submit",
    "keyboard.text_input",
    "selection.changed",
    "content.snapshot",
    "screen.ocr",
  ]),
  appName: z.string().nullish(),
  bundleId: z.string().nullish(),
  windowTitle: z.string().nullish(),
  url: z.string().nullish(),
  windowId: z.number().int().nullish(),
  role: z.string().nullish(),
  label: z.string().nullish(),
  chord: z.string().nullish(),
  reason: z.string().nullish(),
  shape: z.string().nullish(),
  trigger: z.string().nullish(),
  triggerAt: z.number().int().nonnegative().nullish(),
  text: z.string().nullish(),
  content: z.string().nullish(),
  suppressedFields: z.number().int().nonnegative().optional(),
})

type Observation = z.infer<typeof ObservationSchema>
type CaptureResult = { readonly observation: unknown; readonly triggerAt: number }
type Input = AsyncIterable<Uint8Array> & { destroy(): void }

export type DaemonOptions<TimerId = ReturnType<typeof setTimeout>> = {
  readonly directory?: string
  readonly input?: Input
  readonly output?: { write(line: string): number | boolean | undefined | Promise<number> }
  readonly clock?: SchedulerClock<TimerId>
  readonly asideAdapter?: AsideDomAdapter
  readonly onSigterm?: (callback: () => void) => () => void
  readonly onError?: (error: unknown) => void
  readonly embeddingManager?: Pick<EmbeddingManager, "embed" | "close">
  readonly browserHistoryRoot?: string
  readonly webDirectory?: string
}

function toLedgerEvent(event: Observation, sessionId: string | null): LedgerEventInput {
  const target = {
    ...(event.windowId == null ? {} : { windowId: event.windowId }),
    ...(event.role == null ? {} : { role: event.role }),
    ...(event.label == null ? {} : { label: event.label }),
  }
  const payload = {
    ...(event.chord == null ? {} : { chord: event.chord }),
    ...(event.reason == null ? {} : { reason: event.reason }),
    ...(event.shape == null ? {} : { shape: event.shape }),
    ...(event.trigger == null ? {} : { trigger: event.trigger }),
    ...(event.triggerAt == null ? {} : { triggerAt: event.triggerAt }),
  }
  const textKind =
    event.kind === "keyboard.text_input" ||
    event.kind === "selection.changed" ||
    event.kind === "content.snapshot" ||
    event.kind === "screen.ocr"
  const content = event.content ?? (textKind ? event.text : null)
  return {
    occurredAt: event.occurredAt,
    source: event.source,
    kind: event.kind,
    sessionId,
    ...(event.appName == null ? {} : { appName: event.appName }),
    ...(event.bundleId == null ? {} : { bundleId: event.bundleId }),
    ...(event.windowTitle == null ? {} : { windowTitle: event.windowTitle }),
    ...(event.suppressedFields == null ? {} : { fieldSuppressions: event.suppressedFields }),
    ...(event.url == null ? {} : { url: event.url }),
    ...(Object.keys(target).length === 0 ? {} : { target }),
    ...(Object.keys(payload).length === 0 ? {} : { payload }),
    ...(content == null ? {} : { content }),
  }
}

function countSuppression(db: Database, occurredAt: number): void {
  const day = new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(occurredAt)
  db.query(`
    INSERT INTO side_day_counters (day, events, blobs, raw_bytes, suppressions, masks)
    VALUES (?, 0, 0, 0, 1, 0)
    ON CONFLICT(day) DO UPDATE SET suppressions = COALESCE(suppressions, 0) + 1
  `).run(day)
}

function suppress(
  db: Database,
  key: Buffer,
  event: Observation,
  scope: "app" | "url",
  value: string,
): void {
  const termsKey = deriveSubkey(key, "terms")
  const hash = keyedHash(value, termsKey)
  termsKey.fill(0)
  const bucket = Math.floor(event.occurredAt / SUPPRESSION_BUCKET_MS) * SUPPRESSION_BUCKET_MS
  db.transaction(() => {
    db.query(`
      INSERT INTO side_suppressions (bucket_start, scope, key_hash, count) VALUES (?, ?, ?, 1)
      ON CONFLICT(bucket_start, scope, key_hash) DO UPDATE SET count = count + 1
    `).run(bucket, scope, hash)
    countSuppression(db, event.occurredAt)
  })()
}

function registerSigterm(callback: () => void): () => void {
  process.on("SIGTERM", callback)
  return () => process.off("SIGTERM", callback)
}

export async function runDaemon<TimerId = ReturnType<typeof setTimeout>>(
  options: DaemonOptions<TimerId> = {},
): Promise<void> {
  const previousUmask = process.umask(PRIVATE_UMASK)
  try {
    await runPrivateDaemon(options)
  } finally {
    process.umask(previousUmask)
  }
}

async function runPrivateDaemon<TimerId>(options: DaemonOptions<TimerId>): Promise<void> {
  const directory = options.directory ?? dataDirectory()
  const lock = acquireDaemonLock(directory)
  try {
    await runLockedDaemon(options, directory)
  } finally {
    lock.release()
  }
}

async function runLockedDaemon<TimerId>(
  options: DaemonOptions<TimerId>,
  directory: string,
): Promise<void> {
  const settings = await loadSettings(directory)
  const ledgerDirectory = join(directory, "context-awareness")
  mkdirSync(ledgerDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  chmodSync(ledgerDirectory, PRIVATE_DIRECTORY_MODE)
  const ledgerPath = join(ledgerDirectory, "ledger.db")
  const db = openLedger(ledgerPath)
  const stats = new LedgerStats(db, directory)
  const embeddingManager = options.embeddingManager ?? new EmbeddingManager(directory)
  const indexState: { db: Database | null } = { db: null }
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${ledgerPath}${suffix}`
    if (existsSync(path)) chmodSync(path, PRIVATE_FILE_MODE)
  }
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const realClock = {
    now: () => Date.now(),
    setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimeout: (id: ReturnType<typeof setTimeout>): void => clearTimeout(id),
  }
  const clock = options.clock ?? (realClock as unknown as SchedulerClock<TimerId>)
  const diagnostics = await DaemonDiagnostics.create(directory, () => clock.now())
  let indexSyncPending = Promise.resolve()
  const syncIndexNow = (): Promise<void> => {
    const run = indexSyncPending.then(async () => {
      indexState.db ??= openIndexDb(join(directory, "index.db"))
      await syncMemoryIndex({
        ledgerDb: db,
        indexDb: indexState.db,
        dataDir: directory,
        embedder: embeddingManager,
      })
    })
    indexSyncPending = run.then(
      () => {},
      () => {},
    )
    return run
  }
  const indexSync = createMemoryIndexSyncScheduler(syncIndexNow, {
    schedule(callback, delayMs) {
      const timer = clock.setTimeout(callback, delayMs)
      return () => clock.clearTimeout(timer)
    },
  })
  let reconciler: Reconciler<TimerId> | null = null
  let scheduler: CaptureScheduler<CaptureResult, TimerId> | null = null
  let foreground: string | null = null
  let foregroundDenied = false
  let lastBrowserBundle: string | null = null
  let lastBrowserUrl: string | null = null
  let latestHealth: HelperHealth | null = null
  let automationUnavailable = false
  const asideAdapter = options.asideAdapter ?? new AsideDomAdapter()
  let backgroundError: unknown = null
  let clearAllActive = false
  let rotationFailed = false
  let activeSessionId: string | null = null
  const pendingSelections = new Map<string, { event: Observation; timer: TimerId }>()
  const clearPendingSelections = (): void => {
    for (const pending of pendingSelections.values()) clock.clearTimeout(pending.timer)
    pendingSelections.clear()
  }
  const queueSelection = (event: Observation): void => {
    const key = JSON.stringify([
      event.bundleId ?? "",
      event.windowId ?? null,
      event.url == null ? null : normalizePageUrl(event.url),
      event.role ?? "",
      event.label ?? "",
    ])
    const previous = pendingSelections.get(key)
    if (previous) clock.clearTimeout(previous.timer)
    const timer = clock.setTimeout(() => {
      pendingSelections.delete(key)
      handleObservation(event, false)
    }, SELECTION_BURST_MS)
    pendingSelections.set(key, { event, timer })
  }
  const fail = (error: unknown, stage = "daemon"): void => {
    backgroundError = error
    diagnostics.recordError(stage, error)
    options.onError?.(error)
    input.destroy()
  }
  const dwell = new DwellTracker(clock, (eventId, occurredAt) => {
    const capture = reconciler?.currentSettings.contextAwareness
    if (
      reconciler?.state !== "running" ||
      !capture?.enabled ||
      (capture.pausedUntil !== null && capture.pausedUntil > clock.now()) ||
      foregroundDenied ||
      !latestHealth?.nativeCaptureAvailable ||
      !latestHealth.accessibilityTrusted ||
      !latestHealth.inputMonitoringTrusted ||
      latestHealth.secureInput
    )
      return
    try {
      markNonGlanceEvent(db, eventId, occurredAt)
    } catch (error) {
      fail(error)
    }
  })
  const markDeniedForeground = (event: Observation): void => {
    if (!event.bundleId || scheduler === null) return
    const previous = foreground === null ? undefined : scheduler.targets.get(foreground)
    const normalizedUrl = event.url == null ? null : normalizePageUrl(event.url)
    const identity = {
      bundleId: event.bundleId,
      windowId:
        event.windowId ?? (previous?.bundleId === event.bundleId ? previous.windowId : null),
      normalizedUrl,
    }
    scheduler.schedule(identity, "navigation")
    foreground = targetKey(identity)
    if (normalizedUrl !== null && BROWSER_BUNDLE_IDS.has(event.bundleId)) {
      lastBrowserBundle = event.bundleId
      lastBrowserUrl = normalizedUrl
    }
  }
  const acceptObservation = (event: Observation, fromCapture: boolean): string | null => {
    if (clearAllActive || reconciler?.state !== "running") {
      dwell.clear()
      clearPendingSelections()
      return null
    }
    if (
      !latestHealth?.nativeCaptureAvailable ||
      !latestHealth.accessibilityTrusted ||
      !latestHealth.inputMonitoringTrusted
    )
      return null
    const capture = reconciler.currentSettings.contextAwareness
    if (!capture.enabled || (capture.pausedUntil !== null && capture.pausedUntil > clock.now())) {
      dwell.clear()
      clearPendingSelections()
      return null
    }
    if (!capture.captureTypedText && event.kind === "keyboard.text_input") return null
    if (!capture.screenOcr && event.kind === "screen.ocr") return null
    if (event.kind === "screen.ocr" && !latestHealth.screenRecordingTrusted) return null
    if (latestHealth?.secureInput) clearPendingSelections()
    if (
      latestHealth?.secureInput &&
      (fromCapture ||
        event.kind.startsWith("keyboard.") ||
        event.kind === "selection.changed" ||
        event.kind === "content.snapshot" ||
        event.kind === "screen.ocr")
    ) {
      countSuppression(db, event.occurredAt)
      return null
    }
    const key = helper.getMasterKey()
    if (key === null) throw new HelperUnavailableError()
    try {
      const bundleId = event.bundleId ?? ""
      if (bundleId !== "" && isDeniedApp(bundleId, capture.rules)) {
        dwell.clear()
        clearPendingSelections()
        suppress(db, key, event, "app", bundleId)
        foregroundDenied = true
        markDeniedForeground(event)
        return null
      }
      const url = event.url == null ? null : URL.parse(event.url)
      if (event.url != null && (url === null || !["http:", "https:"].includes(url.protocol))) {
        if (event.kind === "window.changed") dwell.clear()
        return null
      }
      const host = url?.hostname.toLowerCase()
      if (host && isDeniedHost(host, capture.rules)) {
        dwell.clear()
        clearPendingSelections()
        suppress(db, key, event, "url", host)
        foregroundDenied = true
        markDeniedForeground(event)
        return null
      }
      const sessionId = event.kind === "session.started" ? ulid(event.occurredAt) : activeSessionId
      const written = writeLedgerEvent(db, key, toLedgerEvent(event, sessionId))
      diagnostics.recordCaptureSuccess()
      if (event.kind === "session.started") activeSessionId = sessionId
      if (event.kind === "session.ended") activeSessionId = null
      if (bundleId !== "") foregroundDenied = false
      return written.id
    } finally {
      key.fill(0)
    }
  }
  function handleObservation(raw: unknown, deferSelection = true): void {
    const event = ObservationSchema.parse(raw)
    if (event.kind === "session.ended") clearPendingSelections()
    if (event.kind === "selection.changed" && deferSelection) {
      const capture = reconciler?.currentSettings.contextAwareness
      const host = event.url == null ? null : URL.parse(event.url)?.hostname.toLowerCase()
      const denied =
        (event.bundleId != null && isDeniedApp(event.bundleId, capture?.rules ?? [])) ||
        (host != null && isDeniedHost(host, capture?.rules ?? []))
      if (reconciler?.state !== "running" || latestHealth?.secureInput || denied) {
        acceptObservation(event, false)
        return
      }
      queueSelection(event)
      return
    }
    if (event.bundleId && BROWSER_BUNDLE_IDS.has(event.bundleId)) {
      if (lastBrowserBundle !== event.bundleId) lastBrowserUrl = null
      lastBrowserBundle = event.bundleId
      if (event.url != null) lastBrowserUrl = normalizePageUrl(event.url)
    } else if (event.bundleId) {
      lastBrowserBundle = null
      lastBrowserUrl = null
    }
    const eventId = acceptObservation(event, false)
    if (event.kind === "session.ended") dwell.clear()
    if (eventId === null || !scheduler || !event.bundleId) return
    if (
      event.kind === "session.started" ||
      event.kind === "session.ended" ||
      event.kind === "content.snapshot" ||
      event.kind === "screen.ocr"
    )
      return
    const identity = {
      bundleId: event.bundleId,
      windowId: event.windowId ?? null,
      normalizedUrl: event.url == null ? null : normalizePageUrl(event.url),
    }
    const key = targetKey(identity)
    const firstSeen = scheduler.targets.get(key) === undefined
    const interaction =
      event.kind.startsWith("mouse.") ||
      event.kind.startsWith("keyboard.") ||
      event.kind === "selection.changed"
    const trigger = firstSeen
      ? "discovery"
      : interaction
        ? "interaction"
        : event.reason === "activation" || event.reason === "focus"
          ? "activation"
          : "navigation"
    foreground = key
    dwell.observe(key, eventId, event.occurredAt)
    scheduler.schedule(identity, trigger)
  }
  const helper = new HelperClient({
    input,
    output,
    onHealth: (health) => {
      if (latestHealth?.pid !== health.pid) automationUnavailable = false
      latestHealth = health
      if (
        !health.nativeCaptureAvailable ||
        !health.accessibilityTrusted ||
        !health.inputMonitoringTrusted ||
        health.secureInput
      ) {
        dwell.clear()
        clearPendingSelections()
      }
      void reconciler?.healthChanged(health).catch(fail)
    },
    onEvent: (raw) => handleObservation(raw),
    onProtocolError: (error) => diagnostics.recordError("helper", error),
  })
  const control = {
    start(): void {
      if (scheduler === null) {
        scheduler = new CaptureScheduler({
          clock,
          getForegroundTargetKey: () => foreground,
          getGate: (target) => {
            const capture = reconciler?.currentSettings.contextAwareness
            const rules = capture?.rules ?? []
            const host = target.currentUrl === null ? null : URL.parse(target.currentUrl)?.hostname
            return {
              paused:
                reconciler?.state !== "running" ||
                foregroundDenied ||
                !capture?.enabled ||
                (capture.pausedUntil !== null && capture.pausedUntil > clock.now()),
              denied:
                isDeniedApp(target.bundleId, rules) || (host != null && isDeniedHost(host, rules)),
              secureInput: latestHealth?.secureInput ?? false,
              idle: latestHealth?.idle ?? false,
            }
          },
          capture: async (target, trigger) => {
            const triggerAt = clock.now()
            let adapterForeground = foreground === target.key ? target.bundleId : null
            let expectedNormalizedUrl = ""
            if (
              adapterForeground === "at.studio.AsideBrowser" &&
              reconciler?.currentSettings.contextAwareness.asideAdapter
            ) {
              try {
                const currentUrl = await helper.sendCommand({
                  type: "command",
                  name: "browser.url",
                  args: { bundleId: target.bundleId },
                })
                if (
                  typeof currentUrl !== "string" ||
                  target.normalizedUrl === null ||
                  target.windowId === null ||
                  normalizePageUrl(currentUrl) !== target.normalizedUrl ||
                  foreground !== target.key ||
                  reconciler?.state !== "running" ||
                  !reconciler.currentSettings.contextAwareness.asideAdapter
                )
                  adapterForeground = null
                else expectedNormalizedUrl = target.normalizedUrl
              } catch {
                adapterForeground = null
              }
            }
            const captureAx = async () => ({
              mode: "ax" as const,
              observation: await helper.sendCommand({
                type: "command",
                name: "capture.request",
                args: { targetKey: target.key, shape: "ax", trigger },
              }),
            })
            const result = await asideAdapter.capture({
              enabled: reconciler?.currentSettings.contextAwareness.asideAdapter ?? false,
              foregroundBundleId: adapterForeground,
              expectedNormalizedUrl,
              captureAx,
            })
            if ("mode" in result) return { triggerAt, observation: result.observation }
            let postUrl: unknown = null
            try {
              postUrl = await helper.sendCommand({
                type: "command",
                name: "browser.url",
                args: { bundleId: target.bundleId },
              })
            } catch {
              // Native capture may still provide a permitted AX fallback.
            }
            let native: Awaited<ReturnType<typeof captureAx>> | null = null
            try {
              native = await captureAx()
            } catch (error) {
              if (!(error instanceof HelperCommandFailureError) || error.reason !== "empty-content")
                throw error
            }
            const verified =
              native === null ? null : ObservationSchema.safeParse(native.observation)
            if (
              verified !== null &&
              (!verified.success ||
                verified.data.source !== "mac_ax" ||
                verified.data.bundleId !== target.bundleId ||
                verified.data.windowId !== target.windowId ||
                verified.data.url == null ||
                normalizePageUrl(verified.data.url) !== target.normalizedUrl)
            )
              throw new AsideOutputError()
            if (
              typeof postUrl !== "string" ||
              normalizePageUrl(postUrl) !== target.normalizedUrl ||
              (verified?.success && verified.data.kind !== "content.snapshot") ||
              foreground !== target.key ||
              reconciler?.state !== "running" ||
              !reconciler.currentSettings.contextAwareness.asideAdapter
            ) {
              if (native === null) throw new AsideOutputError()
              return { triggerAt, observation: native.observation }
            }
            return {
              triggerAt,
              observation: {
                kind: "content.snapshot",
                source: result.source,
                occurredAt: clock.now(),
                bundleId: target.bundleId,
                windowId: target.windowId,
                url: result.rawUrl,
                content: result.content,
                ...(result.suppressedFields === undefined
                  ? {}
                  : { suppressedFields: result.suppressedFields }),
                shape: result.shape,
                trigger,
              },
            }
          },
          onResult: (result, target) => {
            const event = ObservationSchema.parse(result.observation)
            if (event.bundleId !== target.bundleId) return
            if (
              target.windowId !== null &&
              event.windowId != null &&
              event.windowId !== target.windowId
            )
              return
            if (
              target.normalizedUrl !== null &&
              event.url != null &&
              normalizePageUrl(event.url) !== target.normalizedUrl
            ) {
              dwell.clear()
              const host = URL.parse(event.url)?.hostname.toLowerCase()
              if (
                host &&
                isDeniedHost(host, reconciler?.currentSettings.contextAwareness.rules ?? [])
              ) {
                acceptObservation(event, true)
              }
              return
            }
            const accepted = acceptObservation(
              {
                ...event,
                triggerAt: result.triggerAt,
                shape:
                  event.shape ??
                  (event.kind === "content.snapshot" && event.source === "mac_ax" ? "ax" : null),
              },
              true,
            )
            if (!accepted) return
            const identified = {
              bundleId: target.bundleId,
              windowId: event.windowId ?? target.windowId,
              normalizedUrl: event.url == null ? target.normalizedUrl : normalizePageUrl(event.url),
            }
            if (identified.normalizedUrl !== null && BROWSER_BUNDLE_IDS.has(target.bundleId)) {
              lastBrowserBundle = target.bundleId
              lastBrowserUrl = identified.normalizedUrl
            }
            const identifiedKey = targetKey(identified)
            if (foreground === target.key || foreground === identifiedKey) {
              dwell.observe(identifiedKey, accepted, event.occurredAt)
            }
            if (identifiedKey !== target.key && scheduler) {
              foreground = identifiedKey
              scheduler.schedule(identified, "navigation")
            }
          },
          onError: (error) => {
            diagnostics.recordError("capture", error)
            options.onError?.(error)
          },
        })
      }
      scheduler.start()
    },
    stop(): void {
      dwell.clear()
      clearPendingSelections()
      scheduler?.stop()
      scheduler = null
      foreground = null
      foregroundDenied = false
      lastBrowserBundle = null
      lastBrowserUrl = null
    },
    pause(): void {
      dwell.clear()
      clearPendingSelections()
      scheduler?.pause()
    },
    resume(): void {
      scheduler?.resume()
    },
  }
  reconciler = new Reconciler({
    settings,
    clock,
    helper,
    scheduler: control,
    saveSettings: (next) => saveSettings(directory, next),
    onError: fail,
  })
  const mutateSettings = createSettingsMutation(reconciler, (next) => saveSettings(directory, next))
  const { captureKeyReadInvalidation, ...providerHandlers } = createProviderHandlers({
    directory,
    reconciler,
    helper,
    mutateSettings,
  })
  let kickSummaryPass: () => void = () => {}
  const historyHandlers = createHistoryHandlers({
    db,
    directory,
    stats,
    now: () => clock.now(),
    getMasterKey: () => helper.getMasterKey(),
    getRetentionDays: () => reconciler.currentSettings.contextAwareness.retentionDays,
    onSummariesRetried: () => kickSummaryPass(),
    rotateKey: async () => {
      try {
        const result = await helper.sendCommand({ type: "command", name: "keychain.rotate" })
        helper.replaceMasterKey(result)
        clearFrameReadCache(db)
      } catch (error) {
        rotationFailed = true
        helper.discardMasterKey()
        clearFrameReadCache(db)
        throw error
      }
    },
    afterClear: syncIndexNow,
  })
  const apiHandlers = {
    ...createStatusHandlers({
      reconciler,
      health: helper.health,
      helper,
      saveSettings: (next) => saveSettings(directory, next),
      getToday: () => stats.snapshot(clock.now()).today,
      getStopReason: () =>
        rotationFailed
          ? "keychain-locked"
          : backgroundError !== null
            ? "daemon-error"
            : reconciler.currentSettings.contextAwareness.enabled &&
                !(
                  reconciler.currentSettings.contextAwareness.summaryModel ??
                  reconciler.currentSettings.defaultModel
                )
              ? "no-summary-model"
              : null,
      automationUnavailable: () => automationUnavailable,
      getAsideAdapterHealth: () => asideAdapter.health,
      onAutomationPermissions: (automation) => {
        automationUnavailable = Object.values(automation).some((granted) => !granted)
      },
      now: () => clock.now(),
      getDiagnostics: () => diagnostics.getSnapshot(),
      mutateSettings,
    }),
    ...createSettingsHandlers({ directory, reconciler, mutateSettings }),
    ...providerHandlers,
    ...createMcpUsageHandlers({ directory, now: () => clock.now() }),
    ...historyHandlers,
    clear: async (params: unknown) => {
      const request = RpcMethods.clear.input.parse(params)
      if (clearAllActive) throw new Error("Clear all is already in progress or failed")
      if (request.target !== "all") return historyHandlers.clear(request)
      clearAllActive = true
      try {
        await reconciler.setCaptureBlocked(true)
        await Promise.resolve(summaryPass)
        const result = await historyHandlers.clear(request)
        await reconciler.setCaptureBlocked(false)
        clearAllActive = false
        return result
      } catch (error) {
        rotationFailed = true
        throw error
      }
    },
    ...createApplicationsHandlers({
      getSettings: () => reconciler.currentSettings,
      helper,
    }),
    ...createEvidenceHandlers({
      db,
      getMasterKey: () => helper.getMasterKey(),
      browserHistory: (request) =>
        createBrowserHistoryProvider({
          applicationSupportPath:
            options.browserHistoryRoot ?? join(homedir(), "Library", "Application Support"),
          settings: reconciler.currentSettings.contextAwareness,
          now: () => clock.now(),
        })(request),
    }),
    digest: async (value: unknown) => {
      const request = RpcMethods.digest.input.parse(value)
      if (!reconciler.currentSettings.contextAwareness.enabled)
        return { days: 0, summaries: 0, failed: 0 }
      let result: { days: number; summaries: number; failed: number }
      if (request?.day) {
        try {
          const page = await renderContextAwarenessDayPage(db, directory, request.day, clock.now())
          result =
            page.status === "committed"
              ? { days: 1, summaries: page.value.summaries, failed: 0 }
              : { days: 0, summaries: 0, failed: 0 }
        } catch {
          result = { days: 0, summaries: 0, failed: 1 }
        }
      } else {
        result = await digestContextAwareness(db, directory, clock.now())
      }
      if (result.days > 0) indexSync.schedule()
      return result
    },
    memorySearch: createMemorySearchHandler({
      ledgerDb: db,
      getIndexDb: () => (indexState.db ??= openIndexDb(join(directory, "index.db"))),
      embedder: embeddingManager,
      dataDir: directory,
      now: () => clock.now(),
    }),
  }
  const pollForegroundUrl = async (): Promise<void> => {
    if (
      reconciler.state !== "running" ||
      latestHealth?.secureInput ||
      foreground === null ||
      scheduler === null
    )
      return
    const target = scheduler.targets.get(foreground)
    if (!target || !BROWSER_BUNDLE_IDS.has(target.bundleId)) return
    let raw: unknown
    try {
      raw = await helper.sendCommand({
        type: "command",
        name: "browser.url",
        args: { bundleId: target.bundleId },
      })
    } catch {
      dwell.clear()
      return
    }
    if (typeof raw !== "string") {
      dwell.clear()
      return
    }
    const normalized = normalizePageUrl(raw)
    if (normalized === null) {
      dwell.clear()
      return
    }
    if (foreground !== target.key || reconciler.state !== "running") return
    if (lastBrowserBundle === target.bundleId && lastBrowserUrl === normalized) return
    lastBrowserBundle = target.bundleId
    lastBrowserUrl = normalized
    if (normalized === target.normalizedUrl) return
    const event: Observation = {
      occurredAt: clock.now(),
      source: "mac_ax",
      kind: "window.changed",
      bundleId: target.bundleId,
      windowId: target.windowId,
      url: normalized,
      reason: "navigation",
    }
    const eventId = acceptObservation(event, false)
    if (eventId === null) return
    const identity = {
      bundleId: target.bundleId,
      windowId: target.windowId,
      normalizedUrl: normalized,
    }
    foreground = targetKey(identity)
    dwell.observe(foreground, eventId, event.occurredAt)
    scheduler.schedule(identity, "navigation")
  }
  const maintain = (gc: boolean): void => {
    if (clearAllActive) return
    const key = helper.getMasterKey()
    if (key === null) throw new HelperUnavailableError()
    try {
      if (gc)
        runLedgerGc(db, key, {
          now: clock.now(),
          retentionDays: reconciler.currentSettings.contextAwareness.retentionDays,
        })
      sealColdBlobs(db, key, clock.now())
    } finally {
      key.fill(0)
    }
  }
  let gcTimer: TimerId | null = null
  let sealTimer: TimerId | null = null
  let enqueueTimer: TimerId | null = null
  let hourlyDigestTimer: TimerId | null = null
  let urlPollTimer: TimerId | null = null
  let closing = false
  let summaryPass: Promise<void> | null = null
  let queuedSummaryPass = false
  kickSummaryPass = (): void => {
    if (
      closing ||
      clearAllActive ||
      backgroundError !== null ||
      !reconciler.currentSettings.contextAwareness.enabled
    )
      return
    if (summaryPass !== null) {
      queuedSummaryPass = true
      return
    }
    queuedSummaryPass = false
    const settings = reconciler.currentSettings
    summaryPass = runSummaryPass({
      db,
      settings,
      getCurrentSettings: () => reconciler.currentSettings,
      dataDir: directory,
      now: clock.now(),
      getMasterKey: () => helper.getMasterKey(),
      onDigested: () => indexSync.schedule(),
      getApiKey: async (ref) => {
        const invalidateKeyRead = captureKeyReadInvalidation(settings)
        try {
          const secret = await helper.sendCommand({
            type: "command",
            name: "keychain.get",
            args: { ref },
          })
          if (typeof secret === "string" && secret.length > 0) return secret
          invalidateKeyRead(ref)
          return undefined
        } catch (error) {
          invalidateKeyRead(ref)
          throw error
        }
      },
    }).then(() => {})
    void summaryPass.catch(fail).finally(() => {
      summaryPass = null
      if (queuedSummaryPass) kickSummaryPass()
    })
  }
  const armUrlPoll = (): void => {
    urlPollTimer = clock.setTimeout(() => {
      urlPollTimer = null
      void pollForegroundUrl()
        .catch(fail)
        .finally(() => {
          if (!closing && backgroundError === null) armUrlPoll()
        })
    }, BROWSER_URL_POLL_MS)
  }
  const armGc = (): void => {
    gcTimer = clock.setTimeout(() => {
      try {
        maintain(true)
      } catch (error) {
        fail(error)
        return
      }
      armGc()
    }, GC_INTERVAL_MS)
  }
  const armSeal = (): void => {
    sealTimer = clock.setTimeout(() => {
      try {
        maintain(false)
      } catch (error) {
        fail(error)
        return
      }
      armSeal()
    }, FRAME_COLD_AGE_MS)
  }
  const armEnqueue = (): void => {
    enqueueTimer = clock.setTimeout(() => {
      enqueueTimer = null
      try {
        if (reconciler.currentSettings.contextAwareness.enabled) {
          enqueueSummaryJobs(db, clock.now())
          kickSummaryPass()
        }
      } catch (error) {
        fail(error)
        return
      }
      if (!closing) armEnqueue()
    }, COMPREHENSION_INTERVAL_MS)
  }
  const armHourlyDigest = (): void => {
    const nextHour = new Date(clock.now())
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0)
    hourlyDigestTimer = clock.setTimeout(() => {
      hourlyDigestTimer = null
      kickSummaryPass()
      if (!closing) armHourlyDigest()
    }, nextHour.getTime() - clock.now())
  }
  let sigterm = false
  let signalStop: () => void = () => {}
  const stopped = new Promise<void>((resolve) => {
    signalStop = resolve
  })
  const unregister = (options.onSigterm ?? registerSigterm)(() => {
    sigterm = true
    helper.close()
    input.destroy()
    signalStop()
  })
  const running = helper.run()
  let apiServer: ApiServer | null = null
  try {
    apiServer = await startApiServer({
      directory,
      handlers: apiHandlers,
      webDirectory:
        options.webDirectory ??
        (existsSync(bundledResourcePath(process.execPath, "web", "index.html"))
          ? bundledResourcePath(process.execPath, "web")
          : join(import.meta.dir, "..", "web", "dist")),
      webExecutablePath: process.execPath,
    })
    await helper.waitForHello()
    const sessionReply = await helper.sendCommand({
      type: "command",
      name: "web.session",
      args: { port: apiServer.port, token: apiServer.token },
    })
    if (sessionReply !== null) throw new TypeError("Invalid web session acknowledgement")
    maintain(true)
    armGc()
    armSeal()
    armEnqueue()
    armHourlyDigest()
    armUrlPoll()
    if (latestHealth) await reconciler.healthChanged(latestHealth)
    await reconciler.start()
    await Promise.race([running, stopped])
    if (backgroundError !== null) throw backgroundError
  } catch (error) {
    if (backgroundError !== error) diagnostics.recordError("daemon", error)
    if (!sigterm || !(error instanceof HelperUnavailableError)) throw error
  } finally {
    closing = true
    await apiServer?.stop()
    if (urlPollTimer !== null) clock.clearTimeout(urlPollTimer)
    if (gcTimer !== null) clock.clearTimeout(gcTimer)
    if (sealTimer !== null) clock.clearTimeout(sealTimer)
    if (enqueueTimer !== null) clock.clearTimeout(enqueueTimer)
    if (hourlyDigestTimer !== null) clock.clearTimeout(hourlyDigestTimer)
    dwell.clear()
    unregister()
    helper.close()
    input.destroy()
    control.stop()
    await running.catch(() => {})
    await Promise.resolve(summaryPass).catch(() => {})
    await indexSyncPending
    await diagnostics.flush()
    await embeddingManager.close()
    try {
      if (indexState.db) truncateWal(indexState.db)
    } finally {
      indexState.db?.close()
      try {
        truncateWal(db)
      } finally {
        db.close()
      }
    }
  }
}
