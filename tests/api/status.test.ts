import { expect, test } from "bun:test"
import {
  createStatusHandlers,
  type StatusResourceDependencies,
} from "../../src/api/resources/status"
import { handleRpcBody } from "../../src/api/rpc"
import { PAUSE_INDEFINITE } from "../../src/constants"
import type { Settings } from "../../src/contracts/settings"
import { SettingsSchema } from "../../src/contracts/settings"
import type { ReconcileState } from "../../src/daemon/reconcile"
import type { HelperCommandRequest } from "../../src/helper/client"
import { HelperHealthMachine } from "../../src/helper/health"
import { health } from "../helper/fixture"

const TODAY = {
  events: 3,
  blobs: 2,
  rawBytes: 64,
  suppressions: 1,
  masks: 0,
  sessions: 1,
  lastEventAt: 900_000,
} as const

function fixture(
  reportHealth = true,
  getAsideAdapterHealth?: () => "off" | "available" | "unavailable" | "error",
  asideEnabled = false,
) {
  const now = 1_000_000
  let settings = SettingsSchema.parse({
    version: 2,
    contextAwareness: {
      enabled: true,
      asideAdapter: asideEnabled,
      rules: [{ scope: "url", behavior: "do_not_observe", urlDomain: "example.com" }],
    },
  })
  let state: ReconcileState = "running"
  let stopReason: string | null = null
  let automationUnavailable = false
  let permissionReply: unknown = {
    accessibility: true,
    inputMonitoring: false,
    screenRecording: true,
    automation: { "com.apple.Safari": false },
  }
  const healthMachine = new HelperHealthMachine()
  if (reportHealth) healthMachine.update(health)
  const saved: Settings[] = []
  const reconciled: Settings[] = []
  const commands: HelperCommandRequest[] = []
  const reconciler: StatusResourceDependencies["reconciler"] = {
    get currentSettings() {
      return settings
    },
    get state() {
      return state
    },
    async settingsPatched(next) {
      reconciled.push(next)
      settings = next
      state = next.contextAwareness.pausedUntil === null ? "running" : "paused"
    },
  }
  const handlers = createStatusHandlers({
    reconciler,
    health: healthMachine,
    helper: {
      async sendCommand(command) {
        commands.push(command)
        return permissionReply
      },
    },
    saveSettings: async (next) => {
      saved.push(next)
    },
    getToday: () => TODAY,
    getStopReason: () => stopReason,
    automationUnavailable: () => automationUnavailable,
    ...(getAsideAdapterHealth ? { getAsideAdapterHealth } : {}),
    now: () => now,
  })
  return {
    handlers,
    healthMachine,
    commands,
    saved,
    reconciled,
    setStopReason(next: string | null) {
      stopReason = next
    },
    setAutomationUnavailable(next: boolean) {
      automationUnavailable = next
    },
    setPermissionReply(next: unknown) {
      permissionReply = next
    },
  }
}

test("Aside adapter status comes from the daemon when enabled and reads off when disabled", async () => {
  let adapterHealth: "off" | "available" | "unavailable" | "error" = "available"
  const enabled = fixture(true, () => adapterHealth, true)
  expect(await rpc(enabled.handlers, "status")).toMatchObject({
    result: { health: { asideAdapter: "available" } },
  })
  adapterHealth = "unavailable"
  expect(await rpc(enabled.handlers, "status")).toMatchObject({
    result: { health: { asideAdapter: "unavailable" } },
  })
  const disabled = fixture(true, () => adapterHealth)
  expect(await rpc(disabled.handlers, "status")).toMatchObject({
    result: { health: { asideAdapter: "off" } },
  })
  const disconnected = fixture(false, () => adapterHealth, true)
  expect(await rpc(disconnected.handlers, "status")).toMatchObject({
    result: { health: { asideAdapter: "unavailable" } },
  })
})

function rpc(handlers: ReturnType<typeof createStatusHandlers>, method: string, params?: unknown) {
  return handleRpcBody(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
    handlers,
  )
}

test("P4-R1-T1: status has the exact capture_status shape and evaluates the URL denylist", async () => {
  const f = fixture()
  f.setStopReason("no-summary-model")
  expect(await rpc(f.handlers, "status", { url: "https://Mail.Example.com/inbox" })).toEqual({
    jsonrpc: "2.0",
    id: 1,
    result: {
      enabled: true,
      state: "running",
      paused_until: null,
      banner: "none",
      stop_reason: "no-summary-model",
      health,
      today: TODAY,
      url_denied: true,
      diagnostics: { last_error: null, last_successful_capture_at: null },
    },
  })
  expect(await rpc(f.handlers, "status", { url: "https://notexample.com" })).toMatchObject({
    result: { url_denied: false },
  })
  expect(await rpc(f.handlers, "status")).toMatchObject({ result: { url_denied: false } })
})

test("P4-R1-T1: missing Accessibility or Input Monitoring produces permissions_needed", async () => {
  const f = fixture()
  for (const missing of ["accessibilityTrusted", "inputMonitoringTrusted"] as const) {
    f.healthMachine.update({ ...health, [missing]: false })
    expect(await rpc(f.handlers, "status")).toMatchObject({
      result: { banner: "permissions_needed" },
    })
  }
  f.healthMachine.update({ ...health, state: "stopped", accessibilityTrusted: false })
  expect(await rpc(f.handlers, "status")).toMatchObject({
    result: { banner: "permissions_needed" },
  })
})

test("P4-R1-T1: health banners follow starting, stopped, optional feature and degraded capture states", async () => {
  const f = fixture()
  const cases = [
    { value: { ...health, state: "starting" as const }, banner: "starting" },
    { value: { ...health, nativeCaptureAvailable: false }, banner: "not_running" },
    { value: { ...health, screenRecordingTrusted: false }, banner: "some_unavailable" },
    { value: { ...health, eventTapHealthy: false }, banner: "some_unavailable" },
    { value: { ...health, observerRegistrationFailures: 1 }, banner: "some_unavailable" },
  ]
  for (const scenario of cases) {
    f.healthMachine.update(scenario.value)
    expect(await rpc(f.handlers, "status")).toMatchObject({
      result: { banner: scenario.banner },
    })
  }
  f.healthMachine.update(health)
  f.setAutomationUnavailable(true)
  expect(await rpc(f.handlers, "status")).toMatchObject({
    result: { banner: "some_unavailable" },
  })
})

test("P4-R1-T1: before hello and after disconnect, status uses a conservative synthetic health", async () => {
  const f = fixture(false)
  const starting = await rpc(f.handlers, "status")
  expect(starting).toMatchObject({
    result: {
      state: "starting",
      banner: "starting",
      stop_reason: "helper-unavailable",
      health: {
        state: "starting",
        pid: 0,
        observerPid: 0,
        nativeCaptureAvailable: false,
        accessibilityTrusted: false,
        inputMonitoringTrusted: false,
        screenRecordingTrusted: false,
      },
    },
  })
  f.healthMachine.disconnect()
  const disconnected = await rpc(f.handlers, "status")
  expect(disconnected).toMatchObject({
    result: {
      state: "stopped",
      banner: "not_running",
      stop_reason: "helper-unavailable",
      health: { state: "stopped", nativeCaptureAvailable: false },
    },
  })
})

test("P4-R1-T1: pause accepts duration, absolute until and indefinite; resume persists and reconciles", async () => {
  const f = fixture()
  expect(await rpc(f.handlers, "pause", { durationMs: 900_000 })).toEqual({
    jsonrpc: "2.0",
    id: 1,
    result: { paused_until: 1_900_000 },
  })
  expect(await rpc(f.handlers, "status")).toMatchObject({
    result: { state: "paused", paused_until: 1_900_000 },
  })
  expect(await rpc(f.handlers, "pause", { until: 2_000_000 })).toMatchObject({
    result: { paused_until: 2_000_000 },
  })
  expect(await rpc(f.handlers, "pause", { until: PAUSE_INDEFINITE })).toMatchObject({
    result: { paused_until: PAUSE_INDEFINITE },
  })
  expect(await rpc(f.handlers, "resume")).toEqual({ jsonrpc: "2.0", id: 1, result: null })
  expect(f.saved.map((saved) => saved.contextAwareness.pausedUntil)).toEqual([
    1_900_000,
    2_000_000,
    PAUSE_INDEFINITE,
    null,
  ])
  expect(f.reconciled).toEqual(f.saved)
  expect(await rpc(f.handlers, "status")).toMatchObject({
    result: { state: "running", paused_until: null },
  })
})

test("P4-R1-T1: permissions and requestPermissions delegate to helper and map the exact resource shape", async () => {
  const f = fixture()
  const expected = {
    accessibility: true,
    input_monitoring: false,
    screen_recording: true,
    automation: { "com.apple.Safari": false },
  }
  expect(await rpc(f.handlers, "permissions")).toEqual({ jsonrpc: "2.0", id: 1, result: expected })
  expect(await rpc(f.handlers, "requestPermissions", { kinds: ["inputMonitoring"] })).toEqual({
    jsonrpc: "2.0",
    id: 1,
    result: expected,
  })
  expect(f.commands).toEqual([
    { type: "command", name: "permissions" },
    { type: "command", name: "requestPermissions", args: { kinds: ["inputMonitoring"] } },
  ])
  expect(await rpc(f.handlers, "requestPermissions")).toEqual({
    jsonrpc: "2.0",
    id: 1,
    result: expected,
  })
  expect(f.commands.at(-1)).toEqual({
    type: "command",
    name: "requestPermissions",
    args: { kinds: ["accessibility", "inputMonitoring", "screenRecording", "automation"] },
  })
  f.setPermissionReply({ accessibility: true })
  expect(await rpc(f.handlers, "permissions")).toEqual({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32603, message: "Internal error" },
  })
})
