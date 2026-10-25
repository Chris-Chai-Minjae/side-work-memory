import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { PassThrough } from "node:stream"
import { ulid } from "ulid"
import { AsideDomAdapter } from "../../src/capture/aside-adapter"
import { CaptureScheduler } from "../../src/capture/scheduler"
import { targetKey } from "../../src/capture/target"
import { enqueueSummaryJobs } from "../../src/comprehension/queue"
import { loadSettings, saveSettings } from "../../src/config/index"
import {
  ACTIVATION_INTERVAL_MS,
  BROWSER_URL_POLL_MS,
  CAPTURE_DEBOUNCE_MS,
  EMBEDDING_DIMENSIONS,
  FRAME_COLD_AGE_MS,
  GLANCE_MS,
  MS_PER_DAY,
  SELECTION_BURST_MS,
  SWEEP_INTERVAL_MS,
  SYNC_DEBOUNCE_MS,
  TEN_MINUTES_MS,
} from "../../src/constants"
import { type DaemonToAppMessage, DaemonToAppMessageSchema } from "../../src/contracts/protocol"
import { SettingsSchema } from "../../src/contracts/settings"
import { deriveSubkey, open } from "../../src/crypto/index"
import { runDaemon } from "../../src/daemon/index"
import { Reconciler } from "../../src/daemon/reconcile"
import type { HelperCommandRequest } from "../../src/helper/client"
import { clearLedger } from "../../src/ledger/delete"
import { readBlobContent } from "../../src/ledger/frames"
import { openLedger } from "../../src/ledger/schema"
import { LedgerStats } from "../../src/ledger/stats"
import { writeLedgerEvent } from "../../src/ledger/write"
import { openIndexDb } from "../../src/memory/index-db"
import { health, hello } from "../helper/fixture"
import { FakeClock } from "../mocks/fake-clock"

function fixture(enabled: boolean, pausedUntil: number | null = null) {
  const clock = new FakeClock(1_000_000)
  const commands: HelperCommandRequest[] = []
  const scheduler = { starts: 0, stops: 0, paused: false }
  const saved: ReturnType<typeof SettingsSchema.parse>[] = []
  const settings = SettingsSchema.parse({
    version: 2,
    contextAwareness: {
      enabled,
      pausedUntil,
      rules: [{ scope: "app", behavior: "do_not_observe", bundleId: "invalid.fixture.denied" }],
      captureTypedText: false,
      screenOcr: true,
    },
  })
  const reconciler = new Reconciler({
    settings,
    clock,
    helper: {
      async sendCommand(command: HelperCommandRequest): Promise<unknown> {
        commands.push(command)
        return null
      },
    },
    scheduler: {
      start: () => {
        scheduler.starts++
      },
      stop: () => {
        scheduler.stops++
      },
      pause: () => {
        scheduler.paused = true
      },
      resume: () => {
        scheduler.paused = false
      },
    },
    saveSettings: async (next) => {
      saved.push(next)
    },
  })
  return { clock, commands, scheduler, reconciler, saved, settings }
}

describe("daemon reconciler", () => {
  test("Given enabled settings and missing permissions, when health grants them, then capture runs with the approved observer configuration", async () => {
    const { commands, reconciler, scheduler } = fixture(true)
    await reconciler.start()
    await reconciler.healthChanged({
      ...health,
      accessibilityTrusted: false,
      inputMonitoringTrusted: false,
      screenRecordingTrusted: false,
    })
    expect(commands).toContainEqual({
      type: "command",
      name: "requestPermissions",
      args: { kinds: ["accessibility", "inputMonitoring", "screenRecording"] },
    })

    await reconciler.healthChanged(health)
    expect(reconciler.state).toBe("running")
    expect(scheduler.starts).toBe(1)
    expect(scheduler.paused).toBe(false)
    expect(commands.at(-1)).toEqual({
      type: "command",
      name: "observer.configure",
      args: {
        deniedBundleIds: expect.arrayContaining(["invalid.fixture.denied"]),
        captureTypedText: false,
        screenOcr: true,
        paused: false,
      },
    })
  })

  test("Given running capture, when settings are patched to disabled, then observer pauses without changing deletion epoch", async () => {
    const { commands, reconciler, scheduler, settings } = fixture(true)
    await reconciler.healthChanged(health)
    await reconciler.start()
    const disabled = SettingsSchema.parse({
      ...settings,
      contextAwareness: { ...settings.contextAwareness, enabled: false },
    })
    await reconciler.settingsPatched(disabled)
    expect(reconciler.state).toBe("stopped")
    expect(scheduler.stops).toBe(1)
    expect(commands.at(-1)).toMatchObject({ name: "observer.configure", args: { paused: true } })
  })

  test("Given a timed pause, when its deadline expires, then the timer reconciles and resumes capture", async () => {
    const until = 1_000_000 + TEN_MINUTES_MS
    const { clock, commands, reconciler, saved, scheduler } = fixture(true, until)
    await reconciler.healthChanged(health)
    await reconciler.start()
    expect(reconciler.state).toBe("paused")
    expect(scheduler.paused).toBe(true)
    clock.advanceBy(TEN_MINUTES_MS)
    await reconciler.waitForIdle()
    expect(reconciler.state).toBe("running")
    expect(scheduler.paused).toBe(false)
    expect(saved.at(-1)?.contextAwareness.pausedUntil).toBeNull()
    expect(commands.at(-1)).toMatchObject({ name: "observer.configure", args: { paused: false } })
  })

  test("Given the same missing permissions in repeated health reports, when enable reconciles, then it requests each set once", async () => {
    const { commands, reconciler } = fixture(true)
    const missing = { ...health, accessibilityTrusted: false, inputMonitoringTrusted: false }
    await reconciler.healthChanged(missing)
    await reconciler.start()
    await reconciler.healthChanged(missing)
    expect(commands.filter((command) => command.name === "requestPermissions")).toHaveLength(1)
    await reconciler.healthChanged(health)
    await reconciler.healthChanged(missing)
    expect(commands.filter((command) => command.name === "requestPermissions")).toHaveLength(2)
  })

  test("Given a restarted helper, when its pid changes, then the same observer settings are resent", async () => {
    const { commands, reconciler } = fixture(true)
    await reconciler.healthChanged(health)
    await reconciler.start()
    await reconciler.healthChanged({ ...health, pid: health.pid + 1 })
    expect(commands.filter((command) => command.name === "observer.configure")).toHaveLength(2)
  })

  test("Given capture is running, when helper health becomes unavailable and recovers, then observer stops and resumes", async () => {
    const { commands, reconciler, scheduler } = fixture(true)
    await reconciler.healthChanged(health)
    await reconciler.start()
    await reconciler.healthChanged({ ...health, nativeCaptureAvailable: false })
    expect(reconciler.state).toBe("stopped")
    expect(scheduler.stops).toBe(1)
    expect(commands.at(-1)).toMatchObject({ name: "observer.configure", args: { paused: true } })
    await reconciler.healthChanged(health)
    expect(reconciler.state).toBe("running")
    expect(scheduler.starts).toBe(2)
  })

  test("Given disabled capture with a stale pause, when enabled again, then it clears and saves the pause before running", async () => {
    const { reconciler, saved, scheduler, settings } = fixture(false, 1_000_000 + TEN_MINUTES_MS)
    await reconciler.healthChanged(health)
    await reconciler.start()
    await reconciler.settingsPatched(
      SettingsSchema.parse({
        ...settings,
        contextAwareness: { ...settings.contextAwareness, enabled: true },
      }),
    )
    expect(reconciler.state).toBe("running")
    expect(scheduler.starts).toBe(1)
    expect(saved.at(-1)?.contextAwareness.pausedUntil).toBeNull()
  })

  test("Given disabled capture and missing permission, when enabled then granted and restarted, the real scheduler can capture", async () => {
    const clock = new FakeClock(1_000_000)
    const settings = SettingsSchema.parse({ version: 2, contextAwareness: { enabled: false } })
    const commands: HelperCommandRequest[] = []
    const identity = { bundleId: "invalid.fixture.allowed", windowId: null, normalizedUrl: null }
    let captures = 0
    const scheduler = new CaptureScheduler({
      clock,
      getForegroundTargetKey: () => targetKey(identity),
      getGate: () => ({ paused: false, denied: false, secureInput: false, idle: false }),
      capture: async () => {
        captures++
        return null
      },
      onResult: () => {},
      onError: (error) => {
        throw error
      },
    })
    const reconciler = new Reconciler({
      settings,
      clock,
      scheduler,
      helper: {
        sendCommand: async (command: HelperCommandRequest) => {
          commands.push(command)
          return null
        },
      },
      saveSettings: async () => {},
    })
    const enabled = SettingsSchema.parse({
      ...settings,
      contextAwareness: { ...settings.contextAwareness, enabled: true },
    })
    await reconciler.healthChanged({ ...health, accessibilityTrusted: false })
    await reconciler.start()
    await reconciler.settingsPatched(enabled)
    expect(commands).toContainEqual({
      type: "command",
      name: "requestPermissions",
      args: { kinds: ["accessibility"] },
    })
    await reconciler.healthChanged(health)
    await reconciler.settingsPatched(settings)
    await reconciler.settingsPatched(enabled)
    expect(reconciler.state).toBe("running")
    scheduler.schedule(identity, "discovery")
    clock.advanceBy(CAPTURE_DEBOUNCE_MS)
    await Bun.sleep(1)
    expect(captures).toBe(1)
    scheduler.stop()
  })
})

test("Given a fake helper grants permissions, when enabled Side receives Swift events, then it runs and writes mapped ledger rows", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-daemon-test-"))
  const input = new PassThrough()
  const output = new PassThrough()
  const commands: DaemonToAppMessage[] = []
  const occurredAt = new Date("2026-09-24T12:00:00+09:00").getTime()
  const key = Buffer.alloc(32, 7)
  const enabled = SettingsSchema.parse({ version: 2, contextAwareness: { enabled: true } })
  await saveSettings(directory, enabled)
  let emitted = false
  createInterface({ input: output }).on("line", (line) => {
    const command = DaemonToAppMessageSchema.parse(JSON.parse(line))
    commands.push(command)
    if (command.type !== "command") return
    input.write(`${JSON.stringify({ type: "result", id: command.id, ok: true, data: null })}\n`)
    if (command.name === "requestPermissions")
      input.write(`${JSON.stringify({ type: "health", health })}\n`)
    if (command.name === "observer.configure" && !command.args.paused && !emitted) {
      emitted = true
      input.write(
        `${JSON.stringify({
          type: "event",
          event: {
            kind: "keyboard.text_input",
            source: "mac_ax",
            occurredAt,
            bundleId: "invalid.fixture.editor",
            appName: "Synthetic Editor",
            windowTitle: "Synthetic Window",
            windowId: 42,
            role: "AXTextField",
            label: "Synthetic field",
            text: "Synthetic typed content",
            reason: "synthetic test",
          },
        })}\n`,
      )
      input.end()
    }
  })
  try {
    const running = runDaemon({ directory, input, output })
    input.write(`${JSON.stringify(hello)}\n`)
    input.write(
      `${JSON.stringify({
        type: "health",
        health: {
          ...health,
          accessibilityTrusted: false,
          inputMonitoringTrusted: false,
        },
      })}\n`,
    )
    await running

    expect(commands).toContainEqual(expect.objectContaining({ name: "requestPermissions" }))
    expect(commands).toContainEqual(
      expect.objectContaining({
        name: "observer.configure",
        args: expect.objectContaining({ paused: false }),
      }),
    )
    const db = openLedger(join(directory, "context-awareness", "ledger.db"))
    try {
      const event = db
        .query<{ id: string; blob_id: string; target: string; payload: string }, []>(
          "SELECT id, blob_id, target, payload FROM context_awareness_events",
        )
        .get()
      expect(event).toBeDefined()
      if (!event) throw new Error("Synthetic event missing")
      expect(readBlobContent(db, key, event.blob_id)).toBe("Synthetic typed content")
      const evidenceKey = deriveSubkey(key, "evidence")
      expect(
        open<{ role: string; label: string; windowId: number }>(
          event.target,
          evidenceKey,
          `context_awareness_events:target:${event.id}`,
        ),
      ).toEqual({
        role: "AXTextField",
        label: "Synthetic field",
        windowId: 42,
      })
      expect(
        open<{ reason: string }>(
          event.payload,
          evidenceKey,
          `context_awareness_events:payload:${event.id}`,
        ),
      ).toMatchObject({
        reason: "synthetic test",
      })
    } finally {
      db.close()
    }
  } finally {
    input.destroy()
    output.destroy()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given the CLI surface, when help or a daemon-backed client command runs, then only the daemon owns the ledger", () => {
  const directory = mkdtempSync(join(tmpdir(), "side-cli-test-"))
  const run = (command: string) =>
    Bun.spawnSync({
      cmd: [process.execPath, "src/cli.ts", command],
      env: { ...process.env, SIDE_DATA_DIR: directory, LCA_DATA_DIR: directory },
      stdin: "ignore",
    })
  try {
    const help = run("help")
    expect(help.exitCode).toBe(0)
    expect(help.stdout.toString()).toContain("daemon")
    expect(help.stdout.toString()).toContain("memory")
    const status = run("status")
    expect(status.exitCode).toBe(1)
    expect(status.stderr.toString()).toContain("Side is not running. Open Side.app.")
    const daemon = run("daemon")
    expect(daemon.exitCode).toBe(1)
    expect(daemon.stderr.toString()).toContain("Helper is unavailable")
    expect(existsSync(join(directory, "context-awareness", "ledger.db"))).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await Bun.sleep(1)
  }
  throw new Error("Synthetic helper did not reach the expected state")
}

async function launchFakeHelper(
  directory: string,
  options: {
    clock?: FakeClock
    asideAdapter?: AsideDomAdapter
    browserUrl?: () => string | null
    browserUrlError?: () => "incognito" | "unavailable" | null
    onSigterm?: (callback: () => void) => () => void
    onError?: (error: unknown) => void
    browserHistoryRoot?: string
    permissionReply?: unknown
    embeddingManager?: {
      embed(text: string): Promise<Float32Array>
      close(): Promise<void>
    }
    keychainGet?: () => { ok: boolean; data?: string | null }
  } = {},
) {
  const input = new PassThrough()
  const output = new PassThrough()
  const commands: DaemonToAppMessage[] = []
  let ready = false
  createInterface({ input: output }).on("line", (line) => {
    const message = DaemonToAppMessageSchema.parse(JSON.parse(line))
    commands.push(message)
    if (message.type !== "command") return
    if (message.name !== "capture.request") {
      const keychainGet = message.name === "keychain.get" ? options.keychainGet?.() : undefined
      const error =
        message.name === "browser.url"
          ? options.browserUrlError?.()
          : keychainGet?.ok === false
            ? "unavailable"
            : null
      if (error) {
        input.write(`${JSON.stringify({ type: "result", id: message.id, ok: false, error })}\n`)
      } else {
        const data =
          message.name === "browser.url"
            ? (options.browserUrl?.() ?? null)
            : message.name === "permissions"
              ? (options.permissionReply ?? null)
              : message.name === "keychain.set"
                ? { ref: message.args.ref }
                : message.name === "keychain.authorize"
                  ? { authorized: true }
                  : message.name === "keychain.get"
                    ? (keychainGet?.data ?? null)
                    : null
        input.write(`${JSON.stringify({ type: "result", id: message.id, ok: true, data })}\n`)
      }
    }
    if (message.name === "observer.configure" && !message.args.paused) ready = true
  })
  const running = runDaemon({ directory, input, output, ...options })
  input.write(`${JSON.stringify(hello)}\n`)
  input.write(`${JSON.stringify({ type: "health", health })}\n`)
  await waitFor(() => ready)
  return {
    input,
    output,
    commands,
    running,
    send(event: Record<string, unknown>): void {
      input.write(`${JSON.stringify({ type: "event", event })}\n`)
    },
    reply(command: DaemonToAppMessage, data: unknown): void {
      if (command.type !== "command") throw new Error("Expected helper command")
      input.write(`${JSON.stringify({ type: "result", id: command.id, ok: true, data })}\n`)
    },
    replyError(command: DaemonToAppMessage, error: string): void {
      if (command.type !== "command") throw new Error("Expected helper command")
      input.write(`${JSON.stringify({ type: "result", id: command.id, ok: false, error })}\n`)
    },
    async close(): Promise<void> {
      input.end()
      await running
      input.destroy()
      output.destroy()
    },
  }
}

test("Given helper session boundaries, when events and a capture are stored, then ledger rows share each session ULID and stats count both sessions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-session-test-"))
  const clock = new FakeClock(new Date("2026-09-24T12:00:00+09:00").getTime())
  await saveSettings(
    directory,
    SettingsSchema.parse({ version: 2, contextAwareness: { enabled: true } }),
  )
  const helper = await launchFakeHelper(directory, { clock })
  const db = openLedger(join(directory, "context-awareness", "ledger.db"))
  const bundleId = "invalid.fixture.editor"
  const event = (kind: string, occurredAt: number) => ({ kind, source: "mac_ax", occurredAt })
  const rows = () =>
    db
      .query<{ kind: string; session_id: string | null }, []>(
        "SELECT kind, session_id FROM context_awareness_events ORDER BY rowid",
      )
      .all()
  try {
    helper.send(event("session.started", clock.now()))
    helper.send({ ...event("window.changed", clock.now() + 1), bundleId })
    await waitFor(() => rows().length === 2)
    clock.advanceBy(CAPTURE_DEBOUNCE_MS)
    await waitFor(() =>
      helper.commands.some(
        (command) => command.type === "command" && command.name === "capture.request",
      ),
    )
    const request = helper.commands.find(
      (command) => command.type === "command" && command.name === "capture.request",
    )
    if (!request) throw new Error("Expected synthetic capture request")
    helper.reply(request, {
      ...event("content.snapshot", clock.now()),
      bundleId,
      content: "Synthetic session capture",
    })
    await waitFor(() => rows().length === 3)
    helper.send(event("session.ended", clock.now() + 1))
    helper.send({ ...event("window.changed", clock.now() + 2), bundleId })
    helper.send(event("session.started", clock.now() + 3))
    helper.send({ ...event("mouse.click", clock.now() + 4), bundleId })
    helper.send(event("session.ended", clock.now() + 5))
    await waitFor(() => rows().length === 8)

    const stored = rows()
    expect(stored.map((row) => row.kind)).toEqual([
      "session.started",
      "window.changed",
      "content.snapshot",
      "session.ended",
      "window.changed",
      "session.started",
      "mouse.click",
      "session.ended",
    ])
    const firstSessionId = stored[0]?.session_id
    const secondSessionId = stored[5]?.session_id
    expect(firstSessionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u)
    expect(secondSessionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u)
    expect(secondSessionId).not.toBe(firstSessionId)
    expect(stored.slice(0, 4).map((row) => row.session_id)).toEqual(Array(4).fill(firstSessionId))
    expect(stored[4]?.session_id).toBeNull()
    expect(stored.slice(5).map((row) => row.session_id)).toEqual(Array(3).fill(secondSessionId))
    expect(new LedgerStats(db, directory).snapshot(clock.now())).toMatchObject({
      sessions: 2,
      today: { sessions: 2 },
    })
  } finally {
    db.close()
    await helper.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given selection bursts, when fake time advances, then each target and field keeps only its latest event after two seconds", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-selection-debounce-test-"))
  const clock = new FakeClock(Date.now())
  await saveSettings(
    directory,
    SettingsSchema.parse({ version: 2, contextAwareness: { enabled: true } }),
  )
  const helper = await launchFakeHelper(directory, { clock })
  const db = openLedger(join(directory, "context-awareness", "ledger.db"))
  const event = (text: string, label = "Editor") => ({
    kind: "selection.changed",
    source: "mac_ax",
    occurredAt: clock.now(),
    bundleId: "invalid.fixture.editor",
    windowId: 7,
    role: "AXTextArea",
    label,
    text,
  })
  const rows = () =>
    db
      .query<{ id: string; blob_id: string }, []>(
        "SELECT id, blob_id FROM context_awareness_events WHERE kind = 'selection.changed' ORDER BY rowid",
      )
      .all()
  try {
    helper.send(event("first"))
    await Bun.sleep(10)
    clock.advanceBy(SELECTION_BURST_MS / 2)
    helper.send(event("latest"))
    await Bun.sleep(10)
    clock.advanceBy(SELECTION_BURST_MS / 2)
    helper.send(event("other field", "Other editor"))
    await Bun.sleep(10)
    expect(rows()).toHaveLength(0)
    clock.advanceBy(SELECTION_BURST_MS / 2)
    await waitFor(() => rows().length === 1)
    clock.advanceBy(SELECTION_BURST_MS / 2)
    await waitFor(() => rows().length === 2)
    const contents = rows().map((row) => readBlobContent(db, Buffer.alloc(32, 7), row.blob_id))
    expect(contents).toEqual(["latest", "other field"])
  } finally {
    db.close()
    await helper.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test.each(["pause", "stop", "denylist", "secure input", "session ended"] as const)(
  "Given a pending selection, when capture is discarded by %s, then the timer never persists it",
  async (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), "side-selection-discard-test-"))
    const clock = new FakeClock(Date.now())
    await saveSettings(
      directory,
      SettingsSchema.parse({
        version: 2,
        contextAwareness: {
          enabled: true,
          rules: [{ scope: "app", behavior: "do_not_observe", bundleId: "invalid.fixture.denied" }],
        },
      }),
    )
    const helper = await launchFakeHelper(directory, { clock })
    const db = openLedger(join(directory, "context-awareness", "ledger.db"))
    const event = {
      kind: "selection.changed",
      source: "mac_ax",
      occurredAt: clock.now(),
      bundleId: "invalid.fixture.editor",
      windowId: 7,
      role: "AXTextArea",
      label: "Editor",
      text: "must be discarded",
    }
    try {
      helper.send(event)
      await Bun.sleep(10)
      if (scenario === "secure input") {
        helper.input.write(
          `${JSON.stringify({ type: "health", health: { ...health, secureInput: true } })}\n`,
        )
      } else if (scenario === "denylist") {
        helper.send({ ...event, bundleId: "invalid.fixture.denied" })
      } else if (scenario === "session ended") {
        helper.send({ kind: "session.ended", source: "mac_ax", occurredAt: clock.now() })
      } else {
        const response = await fetch("http://localhost/rpc", {
          unix: join(directory, "run", "daemon.sock"),
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: scenario === "pause" ? "pause" : "settings.patch",
            params: scenario === "pause" ? { durationMs: 900_000 } : { enabled: false },
          }),
        })
        expect((await response.json()).error).toBeUndefined()
      }
      await Bun.sleep(10)
      clock.advanceBy(SELECTION_BURST_MS)
      await Bun.sleep(10)
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM context_awareness_events WHERE kind = 'selection.changed'",
          )
          .get()?.count,
      ).toBe(0)
    } finally {
      db.close()
      await helper.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

test.each(["readable AX", "empty AX"])(
  "Given opted-in Aside foreground with %s, when native URL and tab identity stay stable, then the ARIA snapshot reaches the ledger",
  async (axState) => {
    const directory = mkdtempSync(join(tmpdir(), "side-aside-integration-test-"))
    const clock = new FakeClock(Date.now())
    const key = Buffer.alloc(32, 7)
    const url = "https://allowed.example/aside"
    const rawUrl = `${url}?view=1`
    let replCalls = 0
    let preflightSeen = false
    let preflightSeenAtRepl = false
    const asideAdapter = new AsideDomAdapter(async () => {
      replCalls++
      preflightSeenAtRepl = preflightSeen
      return `SIDE_ASIDE_SNAPSHOT ${JSON.stringify({ kind: "snapshot", content: "Synthetic ARIA tree", beforeTabId: "tab-1", beforeUrl: rawUrl, afterTabId: "tab-1", afterUrl: rawUrl, attachedUrl: rawUrl })}\n`
    })
    await saveSettings(
      directory,
      SettingsSchema.parse({
        version: 2,
        contextAwareness: { enabled: true, asideAdapter: true },
      }),
    )
    const helper = await launchFakeHelper(directory, {
      clock,
      asideAdapter,
      browserUrl: () => {
        preflightSeen = true
        return rawUrl
      },
    })
    try {
      helper.send({
        kind: "window.changed",
        source: "mac_ax",
        occurredAt: clock.now(),
        bundleId: "at.studio.AsideBrowser",
        url,
        windowId: 42,
      })
      const db = openLedger(join(directory, "context-awareness", "ledger.db"))
      try {
        await waitFor(
          () =>
            db
              .query<{ count: number }, []>(
                "SELECT COUNT(*) AS count FROM context_awareness_events",
              )
              .get()?.count === 1,
        )
        clock.advanceBy(CAPTURE_DEBOUNCE_MS)
        await waitFor(() =>
          helper.commands.some(
            (command) => command.type === "command" && command.name === "capture.request",
          ),
        )
        const verification = helper.commands.find(
          (command) => command.type === "command" && command.name === "capture.request",
        )
        if (!verification) throw new Error("Expected native postcapture verification")
        if (axState === "empty AX") helper.replyError(verification, "empty-content")
        else
          helper.reply(verification, {
            kind: "content.snapshot",
            source: "mac_ax",
            occurredAt: clock.now(),
            bundleId: "at.studio.AsideBrowser",
            windowId: 42,
            url,
            content: "Synthetic AX verification",
            shape: "ax",
          })
        await waitFor(
          () =>
            db
              .query<{ count: number }, []>(
                "SELECT COUNT(*) AS count FROM context_awareness_events",
              )
              .get()?.count === 2,
        )
        const snapshot = db
          .query<{ id: string; blob_id: string; payload: string }, []>(
            "SELECT id, blob_id, payload FROM context_awareness_events WHERE source = 'aside_dom'",
          )
          .get()
        expect(snapshot).toBeDefined()
        if (!snapshot) throw new Error("Synthetic ARIA event missing")
        expect(readBlobContent(db, key, snapshot.blob_id)).toBe("Synthetic ARIA tree")
        const evidenceKey = deriveSubkey(key, "evidence")
        expect(
          open<{ shape: string }>(
            snapshot.payload,
            evidenceKey,
            `context_awareness_events:payload:${snapshot.id}`,
          ).shape,
        ).toBe("aria")
        expect(replCalls).toBe(1)
        expect(preflightSeenAtRepl).toBe(true)
        expect(
          helper.commands.filter(
            (command) => command.type === "command" && command.name === "browser.url",
          ),
        ).toHaveLength(2)
        expect(
          helper.commands.filter(
            (command) => command.type === "command" && command.name === "capture.request",
          ),
        ).toHaveLength(1)
      } finally {
        db.close()
      }
    } finally {
      await helper.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

for (const scenario of [
  { name: "denied tab", switchedUrl: "https://deny.example/private", nativeError: "unavailable" },
  {
    name: "private window",
    switchedUrl: "https://allowed.example/aside?view=1",
    nativeError: "incognito",
  },
] as const) {
  test(`Given Aside switches to a ${scenario.name} after precheck, when the snapshot completes, then DOM is discarded`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "side-aside-switch-test-"))
    const clock = new FakeClock(Date.now())
    const url = "https://allowed.example/aside"
    let switched = false
    let replCalls = 0
    let captureErrors = 0
    const asideAdapter = new AsideDomAdapter(async () => {
      replCalls++
      switched = true
      return `SIDE_ASIDE_SNAPSHOT ${JSON.stringify({
        kind: "snapshot",
        content: "Synthetic forbidden DOM content",
        beforeTabId: scenario.name === "denied tab" ? "tab-2" : "tab-1",
        beforeUrl: scenario.switchedUrl,
        afterTabId: scenario.name === "denied tab" ? "tab-2" : "tab-1",
        afterUrl: scenario.switchedUrl,
        attachedUrl: scenario.switchedUrl,
      })}\n`
    })
    await saveSettings(
      directory,
      SettingsSchema.parse({
        version: 2,
        contextAwareness: {
          enabled: true,
          asideAdapter: true,
          rules: [{ scope: "url", behavior: "do_not_observe", urlDomain: "deny.example" }],
        },
      }),
    )
    const helper = await launchFakeHelper(directory, {
      clock,
      asideAdapter,
      browserUrl: () => (switched ? scenario.switchedUrl : url),
      browserUrlError: () =>
        switched && scenario.nativeError === "incognito" ? "incognito" : null,
      onError: () => {
        captureErrors++
      },
    })
    try {
      helper.send({
        kind: "window.changed",
        source: "mac_ax",
        occurredAt: clock.now(),
        bundleId: "at.studio.AsideBrowser",
        windowId: 42,
        url,
      })
      const db = openLedger(join(directory, "context-awareness", "ledger.db"))
      try {
        await waitFor(
          () =>
            db
              .query<{ count: number }, []>(
                "SELECT COUNT(*) AS count FROM context_awareness_events",
              )
              .get()?.count === 1,
        )
        clock.advanceBy(CAPTURE_DEBOUNCE_MS)
        await waitFor(() =>
          helper.commands.some(
            (command) => command.type === "command" && command.name === "capture.request",
          ),
        )
        const request = helper.commands.find(
          (command) => command.type === "command" && command.name === "capture.request",
        )
        if (!request) throw new Error("Expected AX fallback or verification")
        helper.replyError(request, scenario.nativeError)
        await waitFor(() => captureErrors === 1)
        expect(replCalls).toBe(1)
        expect(
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count,
        ).toBe(1)
        expect(
          db
            .query<{ count: number }, []>(
              "SELECT COUNT(*) AS count FROM context_awareness_events WHERE source = 'aside_dom'",
            )
            .get()?.count,
        ).toBe(0)
      } finally {
        db.close()
      }
    } finally {
      await helper.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
}

test("Given Aside changes windows after DOM capture, when native verification returns another window, then DOM is discarded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-aside-window-switch-test-"))
  const clock = new FakeClock(Date.now())
  const url = "https://allowed.example/aside"
  let captureErrors = 0
  const asideAdapter = new AsideDomAdapter(
    async () =>
      `SIDE_ASIDE_SNAPSHOT ${JSON.stringify({
        kind: "snapshot",
        content: "Synthetic wrong-window DOM",
        beforeTabId: "tab-1",
        beforeUrl: url,
        afterTabId: "tab-1",
        afterUrl: url,
        attachedUrl: url,
      })}\n`,
  )
  await saveSettings(
    directory,
    SettingsSchema.parse({
      version: 2,
      contextAwareness: { enabled: true, asideAdapter: true },
    }),
  )
  const helper = await launchFakeHelper(directory, {
    clock,
    asideAdapter,
    browserUrl: () => url,
    onError: () => {
      captureErrors++
    },
  })
  try {
    helper.send({
      kind: "window.changed",
      source: "mac_ax",
      occurredAt: clock.now(),
      bundleId: "at.studio.AsideBrowser",
      windowId: 42,
      url,
    })
    const db = openLedger(join(directory, "context-awareness", "ledger.db"))
    try {
      await waitFor(
        () =>
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count === 1,
      )
      clock.advanceBy(CAPTURE_DEBOUNCE_MS)
      await waitFor(() =>
        helper.commands.some(
          (command) => command.type === "command" && command.name === "capture.request",
        ),
      )
      const verification = helper.commands.find(
        (command) => command.type === "command" && command.name === "capture.request",
      )
      if (!verification) throw new Error("Expected native verification")
      helper.reply(verification, {
        kind: "content.snapshot",
        source: "mac_ax",
        occurredAt: clock.now(),
        bundleId: "at.studio.AsideBrowser",
        windowId: 43,
        url,
        content: "Synthetic other-window AX",
        shape: "ax",
      })
      await waitFor(() => captureErrors === 1)
      expect(
        db
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
          .get()?.count,
      ).toBe(1)
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM context_awareness_events WHERE source = 'aside_dom'",
          )
          .get()?.count,
      ).toBe(0)
    } finally {
      db.close()
    }
  } finally {
    await helper.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given Aside changes from window 42 to 43 at the same URL, when native verification rejects the requested window, then DOM is discarded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-aside-rejected-window-test-"))
  const clock = new FakeClock(Date.now())
  const url = "https://allowed.example/aside"
  let captureErrors = 0
  const asideAdapter = new AsideDomAdapter(
    async () =>
      `SIDE_ASIDE_SNAPSHOT ${JSON.stringify({
        kind: "snapshot",
        content: "Synthetic wrong-window DOM",
        beforeTabId: "tab-1",
        beforeUrl: url,
        afterTabId: "tab-1",
        afterUrl: url,
        attachedUrl: url,
      })}\n`,
  )
  await saveSettings(
    directory,
    SettingsSchema.parse({
      version: 2,
      contextAwareness: { enabled: true, asideAdapter: true },
    }),
  )
  const helper = await launchFakeHelper(directory, {
    clock,
    asideAdapter,
    browserUrl: () => url,
    onError: () => {
      captureErrors++
    },
  })
  try {
    helper.send({
      kind: "window.changed",
      source: "mac_ax",
      occurredAt: clock.now(),
      bundleId: "at.studio.AsideBrowser",
      windowId: 42,
      url,
    })
    const db = openLedger(join(directory, "context-awareness", "ledger.db"))
    try {
      await waitFor(
        () =>
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count === 1,
      )
      clock.advanceBy(CAPTURE_DEBOUNCE_MS)
      await waitFor(() =>
        helper.commands.some(
          (command) => command.type === "command" && command.name === "capture.request",
        ),
      )
      const verification = helper.commands.find(
        (command) => command.type === "command" && command.name === "capture.request",
      )
      if (!verification) throw new Error("Expected native verification")
      expect(verification.args.targetKey).toBe(`at.studio.AsideBrowser|42|${url}`)
      helper.replyError(verification, "unavailable")
      await waitFor(() => captureErrors === 1)
      expect(
        db
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
          .get()?.count,
      ).toBe(1)
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM context_awareness_events WHERE source = 'aside_dom'",
          )
          .get()?.count,
      ).toBe(0)
    } finally {
      db.close()
    }
  } finally {
    await helper.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

for (const scenario of [
  { name: "private window", url: null, error: "incognito" },
  { name: "unknown browser state", url: null, error: "unavailable" },
  { name: "changed foreground URL", url: "https://allowed.example/other", error: null },
] as const) {
  test(`Given opted-in Aside with a stale foreground target, when it transitions to ${scenario.name}, then REPL is skipped and no private content reaches the ledger`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "side-aside-private-test-"))
    const clock = new FakeClock(Date.now())
    const url = "https://allowed.example/aside"
    let transitioned = false
    let replCalls = 0
    let captureErrors = 0
    const asideAdapter = new AsideDomAdapter(async () => {
      replCalls++
      return 'SIDE_ASIDE_SNAPSHOT {"kind":"snapshot","content":"Synthetic private content"}\n'
    })
    await saveSettings(
      directory,
      SettingsSchema.parse({
        version: 2,
        contextAwareness: { enabled: true, asideAdapter: true },
      }),
    )
    const helper = await launchFakeHelper(directory, {
      clock,
      asideAdapter,
      browserUrl: () => (transitioned ? scenario.url : url),
      browserUrlError: () => (transitioned ? scenario.error : null),
      onError: () => {
        captureErrors++
      },
    })
    try {
      helper.send({
        kind: "window.changed",
        source: "mac_ax",
        occurredAt: clock.now(),
        bundleId: "at.studio.AsideBrowser",
        url,
      })
      const db = openLedger(join(directory, "context-awareness", "ledger.db"))
      try {
        await waitFor(
          () =>
            db
              .query<{ count: number }, []>(
                "SELECT COUNT(*) AS count FROM context_awareness_events",
              )
              .get()?.count === 1,
        )
        transitioned = true
        clock.advanceBy(CAPTURE_DEBOUNCE_MS)
        await waitFor(
          () =>
            replCalls > 0 ||
            helper.commands.some(
              (command) => command.type === "command" && command.name === "browser.url",
            ),
        )
        expect(replCalls).toBe(0)
        await waitFor(() =>
          helper.commands.some(
            (command) => command.type === "command" && command.name === "capture.request",
          ),
        )
        const request = helper.commands.find(
          (command) => command.type === "command" && command.name === "capture.request",
        )
        if (!request) throw new Error("Expected AX fallback request")
        helper.replyError(request, scenario.error ?? "unavailable")
        await waitFor(() => captureErrors === 1)
        expect(
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count,
        ).toBe(1)
      } finally {
        db.close()
      }
    } finally {
      await helper.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
}

test("Given a foreground browser, when its URL changes without an AX event, then the approved helper poll records navigation once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-browser-poll-test-"))
  const clock = new FakeClock(Date.now())
  let browserUrl = "https://allowed.example/first"
  await saveSettings(
    directory,
    SettingsSchema.parse({ version: 2, contextAwareness: { enabled: true } }),
  )
  const helper = await launchFakeHelper(directory, { clock, browserUrl: () => browserUrl })
  try {
    helper.send({
      kind: "window.changed",
      source: "mac_ax",
      occurredAt: clock.now(),
      bundleId: "com.google.Chrome",
      url: browserUrl,
      windowId: 7,
    })
    const db = openLedger(join(directory, "context-awareness", "ledger.db"))
    try {
      await waitFor(
        () =>
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count === 1,
      )
      browserUrl = "https://allowed.example/second?discard=1"
      clock.advanceBy(BROWSER_URL_POLL_MS)
      await waitFor(() =>
        helper.commands.some(
          (command) => command.type === "command" && command.name === "browser.url",
        ),
      )
      await waitFor(
        () =>
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count === 2,
      )
      const latest = db
        .query<{ id: string; url: string }, []>(
          "SELECT id, url FROM context_awareness_events ORDER BY occurred_at DESC, id DESC LIMIT 1",
        )
        .get()
      if (!latest) throw new Error("Expected polled navigation")
      const evidenceKey = deriveSubkey(Buffer.alloc(32, 7), "evidence")
      expect(
        open<string>(latest.url, evidenceKey, `context_awareness_events:url:${latest.id}`),
      ).toBe("https://allowed.example/second")
      clock.advanceBy(BROWSER_URL_POLL_MS)
      await Bun.sleep(1)
      expect(
        db
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
          .get()?.count,
      ).toBe(2)
    } finally {
      db.close()
    }
  } finally {
    await helper.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given a browser URL poll reaches a denied host, when sweep runs later, then neither a ledger row nor AX recapture appears", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-browser-poll-denied-test-"))
  const clock = new FakeClock(Date.now())
  let browserUrl = "https://allowed.example/page"
  await saveSettings(
    directory,
    SettingsSchema.parse({
      version: 2,
      contextAwareness: {
        enabled: true,
        rules: [{ scope: "url", behavior: "do_not_observe", urlDomain: "deny.example" }],
      },
    }),
  )
  const helper = await launchFakeHelper(directory, { clock, browserUrl: () => browserUrl })
  const event = {
    kind: "window.changed",
    source: "mac_ax",
    occurredAt: clock.now(),
    bundleId: "com.google.Chrome",
    windowId: 42,
    url: browserUrl,
  }
  try {
    helper.send(event)
    const db = openLedger(join(directory, "context-awareness", "ledger.db"))
    try {
      await waitFor(
        () =>
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count === 1,
      )
      clock.advanceBy(CAPTURE_DEBOUNCE_MS)
      await waitFor(() =>
        helper.commands.some(
          (command) => command.type === "command" && command.name === "capture.request",
        ),
      )
      const request = helper.commands.find(
        (command) => command.type === "command" && command.name === "capture.request",
      )
      if (!request) throw new Error("Expected initial allowed capture")
      helper.reply(request, {
        ...event,
        kind: "content.snapshot",
        content: "Synthetic allowed page",
      })
      await waitFor(
        () =>
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count === 2,
      )
      await Bun.sleep(1)
      browserUrl = "https://deny.example/private"
      clock.advanceBy(BROWSER_URL_POLL_MS - CAPTURE_DEBOUNCE_MS)
      await waitFor(
        () =>
          db.query<{ count: number }, []>("SELECT SUM(count) AS count FROM side_suppressions").get()
            ?.count === 1,
      )
      expect(
        db
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
          .get()?.count,
      ).toBe(2)
      clock.advanceBy(SWEEP_INTERVAL_MS + CAPTURE_DEBOUNCE_MS)
      await Bun.sleep(1)
      expect(
        helper.commands.filter(
          (command) => command.type === "command" && command.name === "capture.request",
        ),
      ).toHaveLength(1)
    } finally {
      db.close()
    }
  } finally {
    await helper.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given opted-in Aside with a failed synthetic REPL, when capture runs, then the helper AX result is stored", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-aside-fallback-test-"))
  const clock = new FakeClock(Date.now())
  const url = "https://allowed.example/aside"
  const asideAdapter = new AsideDomAdapter(async () => {
    throw new Error("Synthetic REPL failure")
  })
  await saveSettings(
    directory,
    SettingsSchema.parse({
      version: 2,
      contextAwareness: { enabled: true, asideAdapter: true },
    }),
  )
  const helper = await launchFakeHelper(directory, { clock, asideAdapter, browserUrl: () => url })
  try {
    const event = {
      kind: "window.changed",
      source: "mac_ax",
      occurredAt: clock.now(),
      bundleId: "at.studio.AsideBrowser",
      url,
      windowId: 42,
    }
    helper.send(event)
    const db = openLedger(join(directory, "context-awareness", "ledger.db"))
    try {
      await waitFor(
        () =>
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count === 1,
      )
      clock.advanceBy(CAPTURE_DEBOUNCE_MS)
      await waitFor(() =>
        helper.commands.some(
          (command) => command.type === "command" && command.name === "capture.request",
        ),
      )
      const request = helper.commands.find(
        (command) => command.type === "command" && command.name === "capture.request",
      )
      if (!request) throw new Error("Expected AX fallback request")
      helper.reply(request, {
        ...event,
        kind: "content.snapshot",
        content: "Synthetic AX fallback",
      })
      await waitFor(
        () =>
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count === 2,
      )
      expect(
        db
          .query<{ source: string }, []>(
            "SELECT source FROM context_awareness_events WHERE kind = 'content.snapshot'",
          )
          .get()?.source,
      ).toBe("mac_ax")
      const snapshot = db
        .query<{ id: string; payload: string }, []>(
          "SELECT id, payload FROM context_awareness_events WHERE kind = 'content.snapshot'",
        )
        .get()
      if (!snapshot) throw new Error("Expected AX fallback ledger event")
      const evidenceKey = deriveSubkey(Buffer.alloc(32, 7), "evidence")
      expect(
        open<{ shape: string; triggerAt: number }>(
          snapshot.payload,
          evidenceKey,
          `context_awareness_events:payload:${snapshot.id}`,
        ),
      ).toMatchObject({ shape: "ax", triggerAt: clock.now() })
      expect(asideAdapter.health).toBe("unavailable")
    } finally {
      db.close()
    }
  } finally {
    await helper.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given synthetic denied app and URL inputs, when daemon receives them, then only hashed suppressions remain and new targets use discovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-policy-test-"))
  const clock = new FakeClock(Date.now())
  await saveSettings(
    directory,
    SettingsSchema.parse({
      version: 2,
      contextAwareness: {
        enabled: true,
        rules: [
          { scope: "app", behavior: "do_not_observe", bundleId: "invalid.fixture.denied" },
          { scope: "url", behavior: "do_not_observe", urlDomain: "deny.example" },
        ],
      },
    }),
  )
  const helper = await launchFakeHelper(directory, { clock })
  const event = {
    kind: "window.changed",
    source: "mac_ax",
    occurredAt: clock.now(),
    reason: "activation",
  }
  try {
    helper.send({ ...event, bundleId: "invalid.fixture.denied", appName: "Denied Synthetic App" })
    helper.send({ ...event, bundleId: "invalid.fixture.browser", url: "https://deny.example/path" })
    const ledgerPath = join(directory, "context-awareness", "ledger.db")
    const db = openLedger(ledgerPath)
    try {
      await waitFor(
        () =>
          db.query<{ count: number }, []>("SELECT SUM(count) AS count FROM side_suppressions").get()
            ?.count === 2,
      )
      expect(
        db
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
          .get()?.count,
      ).toBe(0)
      expect(
        db.query<{ suppressions: number }, []>("SELECT suppressions FROM side_day_counters").get()
          ?.suppressions,
      ).toBe(2)
      helper.send({
        ...event,
        bundleId: "invalid.fixture.allowed",
        windowTitle: "Allowed synthetic window",
      })
      await waitFor(
        () =>
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count === 1,
      )
      clock.advanceBy(CAPTURE_DEBOUNCE_MS)
      await waitFor(() =>
        helper.commands.some(
          (command) => command.type === "command" && command.name === "capture.request",
        ),
      )
      const first = helper.commands.find(
        (command) => command.type === "command" && command.name === "capture.request",
      )
      expect(first).toMatchObject({ args: { trigger: "discovery" } })
      if (!first) throw new Error("Expected discovery capture")
      helper.reply(first, {
        ...event,
        kind: "content.snapshot",
        bundleId: "invalid.fixture.allowed",
        content: "Synthetic snapshot",
      })
      await waitFor(
        () =>
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count === 2,
      )
      helper.send({ ...event, kind: "mouse.click", bundleId: "invalid.fixture.allowed" })
      await waitFor(
        () =>
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count === 3,
      )
      clock.advanceBy(ACTIVATION_INTERVAL_MS)
      await waitFor(
        () =>
          helper.commands.filter(
            (command) => command.type === "command" && command.name === "capture.request",
          ).length === 2,
      )
      expect(helper.commands.at(-1)).toMatchObject({
        name: "capture.request",
        args: { trigger: "interaction" },
      })
      const second = helper.commands.at(-1)
      if (!second) throw new Error("Expected interaction capture")
      helper.reply(second, {
        ...event,
        kind: "content.snapshot",
        bundleId: "invalid.fixture.allowed",
        content: "Synthetic interaction snapshot",
      })
      await waitFor(
        () =>
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count === 4,
      )
      await Bun.sleep(1)
      helper.send({ ...event, occurredAt: clock.now(), bundleId: "invalid.fixture.allowed" })
      await waitFor(
        () =>
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count === 5,
      )
      clock.advanceBy(ACTIVATION_INTERVAL_MS)
      await waitFor(
        () =>
          helper.commands.filter(
            (command) => command.type === "command" && command.name === "capture.request",
          ).length === 3,
      )
      expect(helper.commands.at(-1)).toMatchObject({
        name: "capture.request",
        args: { trigger: "activation" },
      })
    } finally {
      db.close()
    }
  } finally {
    await helper.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given a capture in flight, when secure input activates before its response, then its content is discarded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-race-test-"))
  const clock = new FakeClock(Date.now())
  await saveSettings(
    directory,
    SettingsSchema.parse({ version: 2, contextAwareness: { enabled: true } }),
  )
  const helper = await launchFakeHelper(directory, { clock })
  const event = {
    kind: "window.changed",
    source: "mac_ax",
    occurredAt: clock.now(),
    bundleId: "invalid.fixture.allowed",
  }
  try {
    helper.send(event)
    const db = openLedger(join(directory, "context-awareness", "ledger.db"))
    try {
      await waitFor(
        () =>
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count === 1,
      )
      clock.advanceBy(CAPTURE_DEBOUNCE_MS)
      await waitFor(() =>
        helper.commands.some(
          (command) => command.type === "command" && command.name === "capture.request",
        ),
      )
      const request = helper.commands.find(
        (command) => command.type === "command" && command.name === "capture.request",
      )
      if (!request) throw new Error("Expected capture request")
      helper.input.write(
        `${JSON.stringify({ type: "health", health: { ...health, secureInput: true } })}\n`,
      )
      helper.reply(request, {
        ...event,
        kind: "content.snapshot",
        content: "Synthetic secret-like response",
      })
      await Bun.sleep(10)
      expect(
        db
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
          .get()?.count,
      ).toBe(1)
      expect(
        db.query<{ suppressions: number }, []>("SELECT suppressions FROM side_day_counters").get()
          ?.suppressions,
      ).toBe(1)
    } finally {
      db.close()
    }
  } finally {
    await helper.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given an initially unidentified browser target, when its capture reveals window and URL, then the result is stored and navigation uses the new identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-browser-identity-test-"))
  const clock = new FakeClock(Date.now())
  await saveSettings(
    directory,
    SettingsSchema.parse({ version: 2, contextAwareness: { enabled: true } }),
  )
  const helper = await launchFakeHelper(directory, { clock })
  const event = {
    kind: "window.changed",
    source: "mac_ax",
    occurredAt: clock.now(),
    bundleId: "invalid.fixture.browser",
  }
  try {
    helper.send(event)
    const db = openLedger(join(directory, "context-awareness", "ledger.db"))
    try {
      await waitFor(
        () =>
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count === 1,
      )
      clock.advanceBy(CAPTURE_DEBOUNCE_MS)
      await waitFor(() =>
        helper.commands.some(
          (command) => command.type === "command" && command.name === "capture.request",
        ),
      )
      const request = helper.commands.find(
        (command) => command.type === "command" && command.name === "capture.request",
      )
      if (!request) throw new Error("Expected browser discovery capture")
      helper.reply(request, {
        ...event,
        kind: "content.snapshot",
        windowId: 42,
        url: "https://allowed.example/page?private=1",
        content: "Synthetic browser page",
      })
      await waitFor(
        () =>
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count === 2,
      )
      const snapshot = db
        .query<{ id: string; url: string }, []>(
          "SELECT id, url FROM context_awareness_events WHERE kind = 'content.snapshot'",
        )
        .get()
      if (!snapshot) throw new Error("Expected browser snapshot")
      const evidenceKey = deriveSubkey(Buffer.alloc(32, 7), "evidence")
      expect(
        open<string>(snapshot.url, evidenceKey, `context_awareness_events:url:${snapshot.id}`),
      ).toBe("https://allowed.example/page")
      clock.advanceBy(CAPTURE_DEBOUNCE_MS)
      await waitFor(
        () =>
          helper.commands.filter(
            (command) => command.type === "command" && command.name === "capture.request",
          ).length === 2,
      )
      expect(helper.commands.at(-1)).toMatchObject({
        name: "capture.request",
        args: {
          targetKey: "invalid.fixture.browser|42|https://allowed.example/page",
          trigger: "navigation",
        },
      })
    } finally {
      db.close()
    }
  } finally {
    await helper.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given navigation to a denied URL during an AX request, when its old response arrives, then no stale snapshot or repeat capture survives", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-denied-navigation-test-"))
  const clock = new FakeClock(Date.now())
  await saveSettings(
    directory,
    SettingsSchema.parse({
      version: 2,
      contextAwareness: {
        enabled: true,
        rules: [{ scope: "url", behavior: "do_not_observe", urlDomain: "deny.example" }],
      },
    }),
  )
  const helper = await launchFakeHelper(directory, { clock })
  const oldPage = {
    kind: "window.changed",
    source: "mac_ax",
    occurredAt: clock.now(),
    bundleId: "com.google.Chrome",
    windowId: 42,
    url: "https://allowed.example/start",
  }
  try {
    helper.send(oldPage)
    const db = openLedger(join(directory, "context-awareness", "ledger.db"))
    try {
      await waitFor(
        () =>
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count === 1,
      )
      clock.advanceBy(CAPTURE_DEBOUNCE_MS)
      await waitFor(() =>
        helper.commands.some(
          (command) => command.type === "command" && command.name === "capture.request",
        ),
      )
      const request = helper.commands.find(
        (command) => command.type === "command" && command.name === "capture.request",
      )
      if (!request) throw new Error("Expected old-page capture")
      helper.send({ ...oldPage, occurredAt: clock.now(), url: "https://deny.example/private" })
      await waitFor(
        () =>
          db.query<{ count: number }, []>("SELECT SUM(count) AS count FROM side_suppressions").get()
            ?.count === 1,
      )
      helper.reply(request, {
        ...oldPage,
        kind: "content.snapshot",
        content: "Stale synthetic content",
      })
      await Bun.sleep(10)
      expect(
        db
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
          .get()?.count,
      ).toBe(1)
      clock.advanceBy(SWEEP_INTERVAL_MS + CAPTURE_DEBOUNCE_MS)
      await Bun.sleep(1)
      expect(
        helper.commands.filter(
          (command) => command.type === "command" && command.name === "capture.request",
        ),
      ).toHaveLength(1)
    } finally {
      db.close()
    }
  } finally {
    await helper.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given an unknown browser target, when its first AX response reveals a denied URL, then the denial is counted without a recapture", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-denied-result-test-"))
  const clock = new FakeClock(Date.now())
  await saveSettings(
    directory,
    SettingsSchema.parse({
      version: 2,
      contextAwareness: {
        enabled: true,
        rules: [{ scope: "url", behavior: "do_not_observe", urlDomain: "deny.example" }],
      },
    }),
  )
  const helper = await launchFakeHelper(directory, { clock })
  const event = {
    kind: "window.changed",
    source: "mac_ax",
    occurredAt: clock.now(),
    bundleId: "com.google.Chrome",
  }
  try {
    helper.send(event)
    const db = openLedger(join(directory, "context-awareness", "ledger.db"))
    try {
      await waitFor(
        () =>
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count === 1,
      )
      clock.advanceBy(CAPTURE_DEBOUNCE_MS)
      await waitFor(() =>
        helper.commands.some(
          (command) => command.type === "command" && command.name === "capture.request",
        ),
      )
      const request = helper.commands.find(
        (command) => command.type === "command" && command.name === "capture.request",
      )
      if (!request) throw new Error("Expected discovery capture")
      helper.reply(request, {
        ...event,
        kind: "content.snapshot",
        windowId: 42,
        url: "https://deny.example/private",
        content: "Excluded synthetic page",
      })
      await waitFor(
        () =>
          db.query<{ count: number }, []>("SELECT SUM(count) AS count FROM side_suppressions").get()
            ?.count === 1,
      )
      expect(
        db
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
          .get()?.count,
      ).toBe(1)
      clock.advanceBy(SWEEP_INTERVAL_MS + CAPTURE_DEBOUNCE_MS)
      await Bun.sleep(1)
      expect(
        helper.commands.filter(
          (command) => command.type === "command" && command.name === "capture.request",
        ),
      ).toHaveLength(1)
    } finally {
      db.close()
    }
  } finally {
    await helper.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given cold and expired synthetic evidence, when daemon starts and receives SIGTERM, then maintenance runs and ledger files are private", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-maintenance-test-"))
  const clock = new FakeClock(Date.now())
  const key = Buffer.alloc(32, 7)
  const ledgerDirectory = join(directory, "context-awareness")
  const ledgerPath = join(ledgerDirectory, "ledger.db")
  await saveSettings(
    directory,
    SettingsSchema.parse({ version: 2, contextAwareness: { enabled: true } }),
  )
  const { mkdirSync } = await import("node:fs")
  mkdirSync(ledgerDirectory, { recursive: true })
  const seeded = openLedger(ledgerPath)
  writeLedgerEvent(seeded, key, {
    occurredAt: clock.now() - 15 * MS_PER_DAY,
    source: "mac_ax",
    kind: "content.snapshot",
    content: "Expired synthetic evidence",
  })
  writeLedgerEvent(seeded, key, {
    occurredAt: clock.now() - FRAME_COLD_AGE_MS - 1,
    source: "mac_ax",
    kind: "content.snapshot",
    content: "Cold synthetic evidence",
  })
  seeded.close()
  let terminate: () => void = () => {
    throw new Error("SIGTERM handler missing")
  }
  const helper = await launchFakeHelper(directory, {
    clock,
    onSigterm: (callback) => {
      terminate = callback
      return () => {}
    },
  })
  let terminated = false
  try {
    const db = openLedger(ledgerPath)
    try {
      expect(
        db
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
          .get()?.count,
      ).toBe(1)
      expect(
        db
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_frames")
          .get()?.count,
      ).toBe(1)
      helper.send({
        kind: "content.snapshot",
        source: "mac_ax",
        occurredAt: clock.now(),
        bundleId: "invalid.fixture.allowed",
        content: "Later synthetic evidence",
      })
      await waitFor(
        () =>
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count === 2,
      )
      clock.advanceBy(FRAME_COLD_AGE_MS)
      expect(
        db
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_frames")
          .get()?.count,
      ).toBe(2)
      for (const suffix of ["", "-wal", "-shm"]) {
        expect(statSync(`${ledgerPath}${suffix}`).mode & 0o777).toBe(0o600)
      }
    } finally {
      db.close()
    }
    terminate()
    terminated = true
    await helper.running
    expect(existsSync(`${ledgerPath}-wal`) ? statSync(`${ledgerPath}-wal`).size : 0).toBe(0)
  } finally {
    if (!terminated) terminate()
    await helper.running
    helper.input.destroy()
    helper.output.destroy()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given an accepted foreground page, when held for five seconds, then its surviving event qualifies one closed window", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-dwell-qualified-test-"))
  const start = new Date(2026, 8, 24, 10, 0).getTime()
  const clock = new FakeClock(start)
  await saveSettings(
    directory,
    SettingsSchema.parse({ version: 2, contextAwareness: { enabled: true } }),
  )
  const helper = await launchFakeHelper(directory, { clock })
  const db = openLedger(join(directory, "context-awareness", "ledger.db"))
  try {
    helper.send({
      kind: "window.changed",
      source: "mac_ax",
      occurredAt: clock.now(),
      bundleId: "invalid.fixture.browser",
      windowId: 1,
      url: "https://allowed.example/work",
    })
    await waitFor(
      () =>
        db
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
          .get()?.count === 1,
    )
    const event = db.query<{ id: string }, []>("SELECT id FROM context_awareness_events").get()
    if (!event) throw new Error("Expected accepted synthetic event")

    clock.advanceBy(GLANCE_MS - 1)
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM side_meta WHERE key LIKE 'summary_non_glance_event:%'",
        )
        .get()?.count,
    ).toBe(0)
    clock.advanceBy(1)
    expect(
      db
        .query<{ value: string }, [string]>("SELECT value FROM side_meta WHERE key = ?")
        .get(`summary_non_glance_event:${event.id}`)?.value,
    ).toBe(String(start))

    clock.advanceBy(TEN_MINUTES_MS - GLANCE_MS)
    expect(
      db
        .query<{ window_from: number }, []>(
          "SELECT window_from FROM context_awareness_summaries WHERE kind = '10min'",
        )
        .all(),
    ).toEqual([{ window_from: start }])
  } finally {
    db.close()
    await helper.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given a short foreground glance followed by another page, when enqueue runs, then only the held page's window qualifies", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-dwell-switch-test-"))
  const windowStart = new Date(2026, 8, 24, 10, 0).getTime()
  const clock = new FakeClock(windowStart + TEN_MINUTES_MS - 2_000)
  await saveSettings(
    directory,
    SettingsSchema.parse({ version: 2, contextAwareness: { enabled: true } }),
  )
  const helper = await launchFakeHelper(directory, { clock })
  const db = openLedger(join(directory, "context-awareness", "ledger.db"))
  try {
    const page = {
      kind: "window.changed",
      source: "mac_ax",
      bundleId: "invalid.fixture.browser",
      windowId: 1,
    }
    helper.send({ ...page, occurredAt: clock.now(), url: "https://allowed.example/first" })
    await waitFor(
      () =>
        db
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
          .get()?.count === 1,
    )
    const first = db.query<{ id: string }, []>("SELECT id FROM context_awareness_events").get()
    if (!first) throw new Error("Expected first synthetic event")
    clock.advanceBy(3_000)
    helper.send({ ...page, occurredAt: clock.now(), url: "https://allowed.example/second" })
    await waitFor(
      () =>
        db
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
          .get()?.count === 2,
    )
    clock.advanceBy(GLANCE_MS)
    expect(
      db
        .query<{ key: string }, []>(
          "SELECT key FROM side_meta WHERE key LIKE 'summary_non_glance_event:%'",
        )
        .all(),
    ).toHaveLength(1)
    expect(
      db
        .query<{ value: string }, [string]>("SELECT value FROM side_meta WHERE key = ?")
        .get(`summary_non_glance_event:${first.id}`),
    ).toBeNull()

    enqueueSummaryJobs(db, windowStart + 2 * TEN_MINUTES_MS)
    expect(
      db
        .query<{ window_from: number }, []>(
          "SELECT window_from FROM context_awareness_summaries WHERE kind = '10min'",
        )
        .all(),
    ).toEqual([{ window_from: windowStart + TEN_MINUTES_MS }])
  } finally {
    db.close()
    await helper.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given a short accepted glance followed by a denied page, when the dwell deadline passes, then no event or window qualifies", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-dwell-denied-test-"))
  const start = new Date(2026, 8, 24, 10, 0).getTime()
  const clock = new FakeClock(start)
  await saveSettings(
    directory,
    SettingsSchema.parse({
      version: 2,
      contextAwareness: {
        enabled: true,
        rules: [{ scope: "url", behavior: "do_not_observe", urlDomain: "deny.example" }],
      },
    }),
  )
  const helper = await launchFakeHelper(directory, { clock })
  const db = openLedger(join(directory, "context-awareness", "ledger.db"))
  try {
    const page = {
      kind: "window.changed",
      source: "mac_ax",
      bundleId: "invalid.fixture.browser",
      windowId: 1,
    }
    helper.send({ ...page, occurredAt: clock.now(), url: "https://allowed.example/page" })
    await waitFor(
      () =>
        db
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
          .get()?.count === 1,
    )
    clock.advanceBy(GLANCE_MS - 2_000)
    helper.send({ ...page, occurredAt: clock.now(), url: "https://deny.example/private" })
    await waitFor(
      () =>
        db.query<{ count: number }, []>("SELECT SUM(count) AS count FROM side_suppressions").get()
          ?.count === 1,
    )
    clock.advanceBy(2_000)
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM side_meta WHERE key LIKE 'summary_non_glance_event:%'",
        )
        .get()?.count,
    ).toBe(0)
    enqueueSummaryJobs(db, start + TEN_MINUTES_MS)
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM context_awareness_summaries WHERE kind = '10min'",
        )
        .get()?.count,
    ).toBe(0)
  } finally {
    db.close()
    await helper.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given an accepted event cleared during a dwell, when the deadline passes, then no stale marker or job is created", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-dwell-clear-test-"))
  const start = new Date(2026, 8, 24, 10, 0).getTime()
  const clock = new FakeClock(start)
  await saveSettings(
    directory,
    SettingsSchema.parse({ version: 2, contextAwareness: { enabled: true } }),
  )
  const helper = await launchFakeHelper(directory, { clock })
  const db = openLedger(join(directory, "context-awareness", "ledger.db"))
  try {
    helper.send({
      kind: "window.changed",
      source: "mac_ax",
      occurredAt: clock.now(),
      bundleId: "invalid.fixture.app",
      windowId: 1,
    })
    await waitFor(
      () =>
        db
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
          .get()?.count === 1,
    )
    clock.advanceBy(GLANCE_MS - 1)
    await clearLedger(db, "last10m", { now: clock.now() })
    clock.advanceBy(1)
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM side_meta WHERE key LIKE 'summary_non_glance_event:%'",
        )
        .get()?.count,
    ).toBe(0)
    enqueueSummaryJobs(db, start + TEN_MINUTES_MS)
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM context_awareness_summaries WHERE kind = '10min'",
        )
        .get()?.count,
    ).toBe(0)
  } finally {
    db.close()
    await helper.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given a browser page whose URL poll enters private mode, when the old dwell deadline passes, then it does not qualify", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-dwell-private-test-"))
  const start = new Date(2026, 8, 24, 10, 0).getTime()
  const clock = new FakeClock(start)
  await saveSettings(
    directory,
    SettingsSchema.parse({ version: 2, contextAwareness: { enabled: true } }),
  )
  const helper = await launchFakeHelper(directory, {
    clock,
    browserUrlError: () => "incognito",
  })
  const db = openLedger(join(directory, "context-awareness", "ledger.db"))
  try {
    helper.send({
      kind: "window.changed",
      source: "mac_ax",
      occurredAt: clock.now(),
      bundleId: "com.google.Chrome",
      windowId: 1,
      url: "https://allowed.example/page",
    })
    await waitFor(
      () =>
        db
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
          .get()?.count === 1,
    )
    clock.advanceBy(BROWSER_URL_POLL_MS)
    await waitFor(() =>
      helper.commands.some(
        (command) => command.type === "command" && command.name === "browser.url",
      ),
    )
    await Bun.sleep(1)
    clock.advanceBy(GLANCE_MS - BROWSER_URL_POLL_MS)
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM side_meta WHERE key LIKE 'summary_non_glance_event:%'",
        )
        .get()?.count,
    ).toBe(0)
    enqueueSummaryJobs(db, start + TEN_MINUTES_MS)
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM context_awareness_summaries WHERE kind = '10min'",
        )
        .get()?.count,
    ).toBe(0)
  } finally {
    db.close()
    await helper.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("Given a short accepted dwell, when the daemon stops, then its deadline cannot qualify the event", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-dwell-stop-test-"))
  const clock = new FakeClock(new Date(2026, 8, 24, 10, 0).getTime())
  await saveSettings(
    directory,
    SettingsSchema.parse({ version: 2, contextAwareness: { enabled: true } }),
  )
  const helper = await launchFakeHelper(directory, { clock })
  const db = openLedger(join(directory, "context-awareness", "ledger.db"))
  let closed = false
  try {
    helper.send({
      kind: "window.changed",
      source: "mac_ax",
      occurredAt: clock.now(),
      bundleId: "invalid.fixture.app",
      windowId: 1,
    })
    await waitFor(
      () =>
        db
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
          .get()?.count === 1,
    )
    clock.advanceBy(GLANCE_MS - 2_000)
    await helper.close()
    closed = true
    clock.advanceBy(2_000)
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM side_meta WHERE key LIKE 'summary_non_glance_event:%'",
        )
        .get()?.count,
    ).toBe(0)
  } finally {
    db.close()
    if (!closed) await helper.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test.each(["failed", "empty"])(
  "Given authorized synthetic keys, when a background summary key read is %s, then only its provider status becomes unknown",
  async (readResult) => {
    const directory = mkdtempSync(join(tmpdir(), "side-daemon-summary-key-test-"))
    const clock = new FakeClock(new Date(2026, 8, 24, 9, 0).getTime())
    await saveSettings(
      directory,
      SettingsSchema.parse({
        version: 2,
        contextAwareness: { enabled: true, summaryModel: { provider: "primary", modelId: "fake" } },
        providers: [
          {
            id: "primary",
            baseUrl: "https://fixture.invalid/v1",
            models: ["fake"],
            apiKeyRef: "provider/synthetic/primary",
            allowEvidence: true,
          },
          {
            id: "other",
            baseUrl: "https://fixture.invalid/v1",
            models: ["fake"],
            apiKeyRef: "provider/synthetic/other",
            allowEvidence: false,
          },
        ],
      }),
    )
    const helper = await launchFakeHelper(directory, {
      clock,
      keychainGet: () => ({ ok: readResult !== "failed", data: null }),
    })
    const db = openLedger(join(directory, "context-awareness", "ledger.db"))
    const call = async (method: string, providerId: string) => {
      const response = await fetch("http://localhost/rpc", {
        unix: join(directory, "run", "daemon.sock"),
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { providerId } }),
      })
      return response.json()
    }
    try {
      for (const id of ["primary", "other"]) {
        expect(await call("providers.authorizeKey", id)).toMatchObject({
          result: { authorized: true },
        })
        expect(await call("providers.keyStatus", id)).toMatchObject({
          result: { stored: true, accessible: true },
        })
      }
      helper.send({
        kind: "window.changed",
        source: "mac_ax",
        occurredAt: clock.now(),
        appName: "Synthetic Browser",
        bundleId: "invalid.fixture.browser",
        windowId: 1,
        url: "https://fixture.invalid/page",
      })
      await waitFor(
        () =>
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count === 1,
      )
      clock.advanceBy(TEN_MINUTES_MS)
      await waitFor(() =>
        helper.commands.some(
          (command) =>
            command.type === "command" &&
            command.name === "keychain.get" &&
            command.args.ref === "provider/synthetic/primary",
        ),
      )
      let status: unknown
      for (let attempt = 0; attempt < 100; attempt++) {
        status = await call("providers.keyStatus", "primary")
        if (JSON.stringify(status).includes('"accessible":null')) break
        await Bun.sleep(1)
      }
      expect(status).toMatchObject({ result: { stored: null, accessible: null } })
      expect(await call("providers.keyStatus", "other")).toMatchObject({
        result: { stored: true, accessible: true },
      })
    } finally {
      db.close()
      await helper.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

test("Given a closed qualified window and an allowed fake provider, when the comprehension timer runs, then the daemon writes a cited day page", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-daemon-summary-test-"))
  const start = new Date(2026, 8, 24, 9, 0).getTime()
  const clock = new FakeClock(start)
  let embeddings = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const payload = (await request.json()) as { messages: { role: string; content: string }[] }
      const ref = payload.messages
        .find(({ role }) => role === "user")
        ?.content.match(/e:[0-9A-HJKMNP-TV-Z]{26}/)?.[0]
      return Response.json({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: "record_summary",
                    arguments: JSON.stringify({
                      title: "Synthetic page",
                      description: ["Reviewed a synthetic page."],
                      memorySummary: "The user viewed a synthetic page.",
                      apps: ["Synthetic Browser"],
                      domains: ["fixture.invalid"],
                      citations: [{ ref }],
                      sourceIds: [ref],
                    }),
                  },
                },
              ],
            },
          },
        ],
      })
    },
  })
  await saveSettings(
    directory,
    SettingsSchema.parse({
      version: 2,
      contextAwareness: { enabled: true, summaryModel: { provider: "fake", modelId: "fake" } },
      providers: [
        { id: "fake", baseUrl: `${server.url}v1`, models: ["fake"], allowEvidence: true },
      ],
    }),
  )
  const helper = await launchFakeHelper(directory, {
    clock,
    embeddingManager: {
      async embed() {
        embeddings++
        const vector = new Float32Array(EMBEDDING_DIMENSIONS)
        vector[0] = 1
        return vector
      },
      async close() {},
    },
  })
  const db = openLedger(join(directory, "context-awareness", "ledger.db"))
  try {
    helper.send({
      kind: "window.changed",
      source: "mac_ax",
      occurredAt: clock.now(),
      appName: "Synthetic Browser",
      bundleId: "invalid.fixture.browser",
      windowId: 1,
      url: "https://fixture.invalid/page",
    })
    await waitFor(
      () =>
        db
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
          .get()?.count === 1,
    )
    clock.advanceBy(TEN_MINUTES_MS)
    const page = join(directory, "memory", "episodic", "context-awareness-2026-09-24.md")
    await waitFor(() => existsSync(page))
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM context_awareness_summaries WHERE status = 'done' AND digested_at IS NOT NULL",
        )
        .get()?.count,
    ).toBe(1)
    await Bun.sleep(1)
    clock.advanceBy(SYNC_DEBOUNCE_MS)
    const indexPath = join(directory, "index.db")
    await waitFor(() => existsSync(indexPath))
    const indexDb = openIndexDb(indexPath)
    try {
      await waitFor(
        () =>
          (indexDb.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM chunks").get()
            ?.count ?? 0) > 0,
      )
      expect(embeddings).toBeGreaterThan(0)
      expect(existsSync(join(directory, "memory", "memory-index.json"))).toBe(true)
    } finally {
      indexDb.close()
    }
  } finally {
    db.close()
    await helper.close()
    server.stop(true)
    rmSync(directory, { recursive: true, force: true })
  }
})

test.each(["Context Awareness disabled", "provider consent revoked"])(
  "Given %s during a provider response, when repair is due, then the daemon sends no more evidence",
  async (revocation) => {
    const directory = mkdtempSync(join(tmpdir(), "side-daemon-revoke-test-"))
    const clock = new FakeClock(new Date(2026, 8, 24, 9, 0).getTime())
    let requests = 0
    let started: () => void = () => {}
    let release: () => void = () => {}
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        requests++
        if (requests === 1) {
          started()
          await held
        }
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "record_summary",
                      arguments: JSON.stringify({ title: "" }),
                    },
                  },
                ],
              },
            },
          ],
        })
      },
    })
    await saveSettings(
      directory,
      SettingsSchema.parse({
        version: 2,
        contextAwareness: { enabled: true, summaryModel: { provider: "fake", modelId: "fake" } },
        providers: [
          { id: "fake", baseUrl: `${server.url}v1`, models: ["fake"], allowEvidence: true },
        ],
      }),
    )
    const helper = await launchFakeHelper(directory, { clock })
    const db = openLedger(join(directory, "context-awareness", "ledger.db"))
    try {
      helper.send({
        kind: "window.changed",
        source: "mac_ax",
        occurredAt: clock.now(),
        appName: "Synthetic Browser",
        bundleId: "invalid.fixture.browser",
        windowId: 1,
        url: "https://fixture.invalid/page",
      })
      await waitFor(
        () =>
          db
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
            .get()?.count === 1,
      )
      clock.advanceBy(TEN_MINUTES_MS)
      await firstStarted
      const response = await fetch("http://localhost/rpc", {
        unix: join(directory, "run", "daemon.sock"),
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "settings.patch",
          params:
            revocation === "Context Awareness disabled"
              ? { enabled: false }
              : {
                  providers: [
                    {
                      id: "fake",
                      baseUrl: `${server.url}v1`,
                      models: ["fake"],
                      allowEvidence: false,
                    },
                  ],
                },
        }),
      })
      expect((await response.json()).result).toMatchObject(
        revocation === "Context Awareness disabled"
          ? { enabled: false }
          : { providers: [{ id: "fake", allow_evidence: false }] },
      )
      release()
      await waitFor(
        () =>
          db
            .query<{ count: number }, []>(
              "SELECT COUNT(*) AS count FROM context_awareness_summaries WHERE status = 'pending' AND attempt_count = 1",
            )
            .get()?.count === 1,
      )
      expect(requests).toBe(1)
    } finally {
      release()
      db.close()
      await helper.close()
      server.stop(true)
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

test("Given a live fake helper, when UDS RPC reads status and evidence, then daemon serves and closes the socket", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-daemon-api-test-"))
  const clock = new FakeClock(new Date(2026, 8, 24, 9, 0).getTime())
  await saveSettings(
    directory,
    SettingsSchema.parse({
      version: 2,
      contextAwareness: { enabled: true },
      providers: [
        {
          id: "synthetic",
          baseUrl: "https://fixture.invalid/v1",
          models: ["probe-model"],
        },
      ],
    }),
  )
  const helper = await launchFakeHelper(directory, {
    clock,
    browserHistoryRoot: join(directory, "no-browser-profiles"),
    permissionReply: {
      accessibility: true,
      inputMonitoring: true,
      screenRecording: true,
      automation: { "com.apple.Safari": false },
    },
  })
  const db = openLedger(join(directory, "context-awareness", "ledger.db"))
  const socketPath = join(directory, "run", "daemon.sock")
  const call = async (method: string, params?: unknown) => {
    const response = await fetch("http://localhost/rpc", {
      unix: socketPath,
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        ...(params === undefined ? {} : { params }),
      }),
    })
    return response.json()
  }
  try {
    expect(existsSync(socketPath)).toBe(true)
    const settingsMethods = [
      "status",
      "permissions",
      "requestPermissions",
      "settings.get",
      "settings.patch",
      "summaryModelDefault",
      "historyStatus",
      "historyList",
      "listApplications",
      "appIcons",
      "mcp.usage",
      "pause",
      "resume",
      "clear",
      "providers.setKey",
      "providers.test",
    ]
    for (const method of settingsMethods) {
      expect(await call(method, { invalid: "synthetic" })).toMatchObject({
        error: { code: -32602 },
      })
    }
    expect(await call("status")).toMatchObject({
      result: { enabled: true, state: "running", today: { events: 0 } },
    })
    expect(await call("permissions")).toMatchObject({
      result: { automation: { "com.apple.Safari": false } },
    })
    expect(await call("status")).toMatchObject({ result: { banner: "some_unavailable" } })
    helper.send({
      kind: "content.snapshot",
      source: "mac_ax",
      occurredAt: clock.now(),
      appName: "Synthetic Browser",
      bundleId: "fixture.invalid.browser",
      windowId: 1,
      windowTitle: "Synthetic SQLite guide",
      url: "https://fixture.invalid/sqlite",
      content: "Synthetic SQLite content",
    })
    await waitFor(
      () =>
        (db
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
          .get()?.count ?? 0) === 1,
    )
    const id = db.query<{ id: string }, []>("SELECT id FROM context_awareness_events").get()?.id
    if (!id) throw new Error("Missing synthetic event")
    expect(await call("read", { id: `e:${id}` })).toMatchObject({
      result: { id: `e:${id}`, text: expect.stringContaining("Synthetic SQLite content") },
    })
    expect(await call("settings.patch", { retentionDays: 7 })).toMatchObject({
      result: { retention_days: 7 },
    })
    expect((await loadSettings(directory)).contextAwareness.retentionDays).toBe(7)
    const syntheticSecret = "synthetic-provider-key-for-integration"
    const expectedRef = `provider/synthetic/${createHash("sha256")
      .update(JSON.stringify(["synthetic", "https://fixture.invalid/v1"]))
      .digest("hex")}`
    expect(
      await call("providers.setKey", { providerId: "synthetic", apiKey: syntheticSecret }),
    ).toMatchObject({ result: { apiKeyRef: expectedRef } })
    expect(await call("settings.get")).toMatchObject({
      result: { providers: [{ id: "synthetic", has_key: true }] },
    })
    expect(readFileSync(join(directory, "settings.json"), "utf8")).not.toContain(syntheticSecret)
    await Promise.all([
      call("settings.patch", { captureTypedText: false }),
      call("pause", { durationMs: 900_000 }),
    ])
    const afterParallel = await loadSettings(directory)
    expect(afterParallel.contextAwareness.captureTypedText).toBe(false)
    expect(afterParallel.contextAwareness.pausedUntil).toBe(clock.now() + 900_000)
    const summaryId = ulid(clock.now() - 60_000)
    db.query(`
      INSERT INTO context_awareness_summaries
        (id, kind, window_from, window_to, created_at, updated_at, title, description,
         citations, status)
      VALUES (?, '10min', ?, ?, ?, ?, 'Synthetic summary', '[]', '[]', 'done')
    `).run(summaryId, clock.now() - 60_000, clock.now(), clock.now(), clock.now())
    expect(
      await call("historyList", { from: clock.now() - 60_000, to: clock.now() }),
    ).toMatchObject({
      result: [{ id: summaryId, title: "Synthetic summary" }],
    })
    expect(await call("historyStatus")).toMatchObject({
      result: { days_with_summaries: ["2026-09-24"], today_summary_states: { done: 1 } },
    })
    expect(await call("digest", { day: "2026-09-24" })).toMatchObject({
      result: { days: 1, summaries: 1, failed: 0 },
    })
    expect(await call("day.get", { date: "2026-09-24" })).toMatchObject({
      result: { markdown: expect.stringContaining("Synthetic summary") },
    })
    expect(await call("clear", { target: "today" })).toMatchObject({
      result: { deleted_events: 1, deleted_summaries: 1, deletion_epoch: 1 },
    })
    expect(await call("day.get", { date: "2026-09-24" })).toMatchObject({ result: null })
  } finally {
    db.close()
    await helper.close()
    expect(existsSync(socketPath)).toBe(false)
    rmSync(directory, { recursive: true, force: true })
  }
})
