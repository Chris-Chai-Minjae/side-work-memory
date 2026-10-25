import { z } from "zod"
import type { HelperHealth } from "../../contracts/protocol"
import { PermissionKindSchema } from "../../contracts/protocol"
import { RpcMethods } from "../../contracts/rpc"
import type { DaemonDiagnosticsSnapshot } from "../../contracts/rpc-resources"
import type { Settings } from "../../contracts/settings"
import type { ReconcileState } from "../../daemon/reconcile"
import type { HelperCommandRequest } from "../../helper/client"
import type { HelperHealthMachine } from "../../helper/health"
import type { DayCounters } from "../../ledger/stats"
import { isDeniedHost } from "../../policy/index"
import type { RpcHandlers } from "../rpc"
import { createSettingsMutation, type SettingsMutation } from "./settings"

const HelperPermissionsSchema = z.strictObject({
  accessibility: z.boolean(),
  inputMonitoring: z.boolean(),
  screenRecording: z.boolean(),
  automation: z.record(z.string(), z.boolean()),
})

const UNAVAILABLE_HEALTH = {
  platform: "darwin",
  protocolVersion: 1,
  nativeCaptureAvailable: false,
  inputCaptureAvailable: false,
  screenOcrAvailable: false,
  screenOcrLanguages: [],
  accessibilityTrusted: false,
  inputMonitoringTrusted: false,
  screenRecordingTrusted: false,
  eventTapHealthy: false,
  inputTapRunning: false,
  observerRegistrationFailures: 0,
  secureInput: false,
  permissionSheetVisible: false,
  systemSessionActive: false,
  idle: false,
  pid: 0,
  observerPid: 0,
  responsibleSelf: true,
  state: "stopped",
  asideAdapter: "off",
  perApp: {},
} satisfies HelperHealth

export type StatusResourceDependencies = {
  readonly reconciler: {
    readonly currentSettings: Settings
    readonly state: ReconcileState
    readonly settingsPatched: (next: Settings) => Promise<void>
  }
  readonly health: HelperHealthMachine
  readonly helper: { readonly sendCommand: (command: HelperCommandRequest) => Promise<unknown> }
  readonly saveSettings: (next: Settings) => Promise<void>
  readonly getToday: () => DayCounters
  readonly getStopReason: () => string | null
  readonly automationUnavailable: () => boolean
  readonly getAsideAdapterHealth?: () => HelperHealth["asideAdapter"]
  readonly onAutomationPermissions?: (automation: Readonly<Record<string, boolean>>) => void
  readonly now: () => number
  readonly getDiagnostics?: () => DaemonDiagnosticsSnapshot
  readonly mutateSettings?: SettingsMutation
}

type StatusHandlers = Pick<
  RpcHandlers,
  "status" | "pause" | "resume" | "permissions" | "requestPermissions"
>

class PauseTimeRangeError extends RangeError {
  readonly name = "PauseTimeRangeError"
}

function banner(
  health: HelperHealth | null,
  machineState: HelperHealth["state"],
  options: { readonly screenOcrEnabled: boolean; readonly automationUnavailable: boolean },
): "none" | "starting" | "not_running" | "permissions_needed" | "some_unavailable" {
  if (health === null) return machineState === "starting" ? "starting" : "not_running"
  if (health.state === "starting") return "starting"
  if (!health.nativeCaptureAvailable) return "not_running"
  if (!health.accessibilityTrusted || !health.inputMonitoringTrusted) return "permissions_needed"
  if (health.state === "stopped") return "not_running"
  if (
    (options.screenOcrEnabled && (!health.screenOcrAvailable || !health.screenRecordingTrusted)) ||
    options.automationUnavailable ||
    !health.eventTapHealthy ||
    health.observerRegistrationFailures > 0
  )
    return "some_unavailable"
  return "none"
}

function permissionsResult(value: unknown) {
  const status = HelperPermissionsSchema.parse(value)
  return {
    accessibility: status.accessibility,
    input_monitoring: status.inputMonitoring,
    screen_recording: status.screenRecording,
    automation: status.automation,
  }
}

export function createStatusHandlers(dependencies: StatusResourceDependencies): StatusHandlers {
  const mutateSettings =
    dependencies.mutateSettings ??
    createSettingsMutation(dependencies.reconciler, dependencies.saveSettings)

  async function updatePause(pausedUntil: number | null): Promise<void> {
    await mutateSettings((current) => ({
      ...current,
      contextAwareness: { ...current.contextAwareness, pausedUntil },
    }))
  }

  return {
    status(params) {
      const input = RpcMethods.status.input.parse(params)
      const capture = dependencies.reconciler.currentSettings.contextAwareness
      const observed = dependencies.health.current
      const machineState = dependencies.health.state
      const health: HelperHealth = {
        ...(observed ?? { ...UNAVAILABLE_HEALTH, state: machineState }),
        asideAdapter: !capture.asideAdapter
          ? "off"
          : observed === null
            ? "unavailable"
            : (dependencies.getAsideAdapterHealth?.() ?? "off"),
      }
      const state =
        observed === null || observed.state === "starting" || observed.state === "stopped"
          ? machineState
          : dependencies.reconciler.state
      return {
        enabled: capture.enabled,
        state,
        paused_until: capture.pausedUntil,
        banner: banner(observed, machineState, {
          screenOcrEnabled: capture.screenOcr,
          automationUnavailable: dependencies.automationUnavailable(),
        }),
        stop_reason: observed === null ? "helper-unavailable" : dependencies.getStopReason(),
        health,
        today: dependencies.getToday(),
        url_denied: input?.url ? isDeniedHost(new URL(input.url).hostname, capture.rules) : false,
        diagnostics: dependencies.getDiagnostics?.() ?? {
          last_error: null,
          last_successful_capture_at: null,
        },
      }
    },
    async permissions() {
      const result = permissionsResult(
        await dependencies.helper.sendCommand({ type: "command", name: "permissions" }),
      )
      dependencies.onAutomationPermissions?.(result.automation)
      return result
    },
    async requestPermissions(params) {
      const input = RpcMethods.requestPermissions.input.parse(params)
      const kinds = input?.kinds ?? [...PermissionKindSchema.options]
      const result = permissionsResult(
        await dependencies.helper.sendCommand({
          type: "command",
          name: "requestPermissions",
          args: { kinds },
        }),
      )
      dependencies.onAutomationPermissions?.(result.automation)
      return result
    },
    async pause(params) {
      const input = RpcMethods.pause.input.parse(params)
      const pausedUntil = "until" in input ? input.until : dependencies.now() + input.durationMs
      if (!Number.isSafeInteger(pausedUntil))
        throw new PauseTimeRangeError("Pause end is outside the supported epoch range")
      await updatePause(pausedUntil)
      return { paused_until: pausedUntil }
    },
    async resume() {
      await updatePause(null)
      return null
    },
  }
}
