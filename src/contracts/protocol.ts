import { z } from "zod"

export const PermissionKindSchema = z.enum([
  "accessibility",
  "inputMonitoring",
  "screenRecording",
  "automation",
])

export const HelperHealthSchema = z.strictObject({
  platform: z.literal("darwin"),
  protocolVersion: z.literal(1),
  nativeCaptureAvailable: z.boolean(),
  inputCaptureAvailable: z.boolean(),
  screenOcrAvailable: z.boolean(),
  screenOcrLanguages: z.array(z.string()),
  accessibilityTrusted: z.boolean(),
  inputMonitoringTrusted: z.boolean(),
  screenRecordingTrusted: z.boolean(),
  eventTapHealthy: z.boolean(),
  inputTapRunning: z.boolean(),
  observerRegistrationFailures: z.number().int(),
  secureInput: z.boolean(),
  permissionSheetVisible: z.boolean(),
  systemSessionActive: z.boolean(),
  idle: z.boolean(),
  pid: z.number().int(),
  observerPid: z.number().int(),
  responsibleSelf: z.literal(true),
  state: z.enum(["starting", "running", "paused", "stopped"]),
  asideAdapter: z.enum(["off", "available", "unavailable", "error"]),
  perApp: z.record(
    z.string(),
    z.strictObject({ chromeOnly: z.boolean(), maxTreeBytes: z.number().int() }),
  ),
})

// The approved capture spec names RawObservation but does not define its wire fields.
export const RawObservationSchema = z.record(z.string(), z.unknown())

const HelloSchema = z.strictObject({
  type: z.literal("hello"),
  protocolVersion: z.literal(1),
  key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  appVersion: z.string(),
})
const PingMessageSchema = z.strictObject({ type: z.literal("ping"), id: z.string() })
const HealthMessageSchema = z.strictObject({
  type: z.literal("health"),
  health: HelperHealthSchema,
})
const EventMessageSchema = z.strictObject({ type: z.literal("event"), event: RawObservationSchema })
const ResultSuccessSchema = z.strictObject({
  type: z.literal("result"),
  id: z.string(),
  ok: z.literal(true),
  data: z.unknown(),
})
const ResultFailureSchema = z.strictObject({
  type: z.literal("result"),
  id: z.string(),
  ok: z.literal(false),
  error: z.string(),
})
const ProtocolErrorSchema = z.strictObject({
  type: z.literal("protocol-error"),
  message: z.string(),
})

export const AppToDaemonMessageSchema = z.union([
  HelloSchema,
  PingMessageSchema,
  HealthMessageSchema,
  EventMessageSchema,
  ResultSuccessSchema,
  ResultFailureSchema,
  ProtocolErrorSchema,
])

const WithoutArgs = z.undefined().optional()
const CommandBase = { type: z.literal("command"), id: z.string() }
export const DaemonToAppMessageSchema = z.union([
  ProtocolErrorSchema,
  z.strictObject({ type: z.literal("pong"), id: z.string() }),
  z.discriminatedUnion("name", [
    z.strictObject({ ...CommandBase, name: z.literal("health"), args: WithoutArgs }),
    z.strictObject({ ...CommandBase, name: z.literal("permissions"), args: WithoutArgs }),
    z.strictObject({
      ...CommandBase,
      name: z.literal("requestPermissions"),
      args: z.strictObject({ kinds: z.array(PermissionKindSchema) }),
    }),
    z.strictObject({ ...CommandBase, name: z.literal("applications.list"), args: WithoutArgs }),
    z.strictObject({
      ...CommandBase,
      name: z.literal("applications.icons"),
      args: z.strictObject({ bundleIds: z.array(z.string()) }),
    }),
    z.strictObject({
      ...CommandBase,
      name: z.literal("capture.request"),
      args: z.strictObject({
        targetKey: z.string(),
        shape: z.string(),
        trigger: z.enum(["interaction", "activation", "navigation", "sweep", "discovery"]),
      }),
    }),
    z.strictObject({
      ...CommandBase,
      name: z.literal("ocr.window"),
      args: z.strictObject({ windowId: z.number().int() }),
    }),
    z.strictObject({
      ...CommandBase,
      name: z.literal("browser.url"),
      args: z.strictObject({ bundleId: z.string() }),
    }),
    z.strictObject({
      ...CommandBase,
      name: z.literal("observer.configure"),
      args: z.strictObject({
        deniedBundleIds: z.array(z.string()),
        captureTypedText: z.boolean(),
        screenOcr: z.boolean(),
        paused: z.boolean(),
      }),
    }),
    z.strictObject({ ...CommandBase, name: z.literal("settings.open"), args: WithoutArgs }),
    z.strictObject({ ...CommandBase, name: z.literal("keychain.rotate"), args: WithoutArgs }),
    z.strictObject({
      ...CommandBase,
      name: z.literal("web.session"),
      args: z.strictObject({
        port: z.number().int().min(1).max(65_535),
        token: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    }),
    z.strictObject({
      ...CommandBase,
      name: z.literal("keychain.set"),
      args: z.strictObject({ ref: z.string(), secret: z.string() }),
    }),
    z.strictObject({
      ...CommandBase,
      name: z.literal("keychain.get"),
      args: z.strictObject({ ref: z.string() }),
    }),
    z.strictObject({
      ...CommandBase,
      name: z.literal("keychain.status"),
      args: z.strictObject({ ref: z.string() }),
    }),
    z.strictObject({
      ...CommandBase,
      name: z.literal("keychain.authorize"),
      args: z.strictObject({ ref: z.string() }),
    }),
  ]),
])

export type HelperHealth = z.infer<typeof HelperHealthSchema>
export type AppToDaemonMessage = z.infer<typeof AppToDaemonMessageSchema>
export type DaemonToAppMessage = z.infer<typeof DaemonToAppMessageSchema>
