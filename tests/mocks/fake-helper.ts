import { readFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { ZodError } from "zod"
import {
  type AppToDaemonMessage,
  DaemonToAppMessageSchema,
  type HelperHealth,
  RawObservationSchema,
} from "../../src/contracts/protocol"

const health: HelperHealth = {
  platform: "darwin",
  protocolVersion: 1,
  nativeCaptureAvailable: true,
  inputCaptureAvailable: true,
  screenOcrAvailable: true,
  screenOcrLanguages: ["en", "ko"],
  accessibilityTrusted: true,
  inputMonitoringTrusted: true,
  screenRecordingTrusted: true,
  eventTapHealthy: true,
  inputTapRunning: true,
  observerRegistrationFailures: 0,
  secureInput: false,
  permissionSheetVisible: false,
  systemSessionActive: true,
  idle: false,
  pid: process.pid,
  observerPid: process.pid,
  responsibleSelf: true,
  state: "running",
  asideAdapter: "off",
  perApp: {},
}

const permissions = {
  accessibility: true,
  inputMonitoring: true,
  screenRecording: true,
  automation: {},
}

function emit(message: AppToDaemonMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

export async function runFakeHelper(scenarioPath?: string): Promise<void> {
  const keychain = new Map<string, string>()
  const scenario = scenarioPath ? await readFile(scenarioPath, "utf8") : ""
  const events = scenario
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => RawObservationSchema.parse(JSON.parse(line)))

  emit({
    type: "hello",
    protocolVersion: 1,
    key: Buffer.alloc(32, 7).toString("base64"),
    appVersion: "test",
  })
  emit({ type: "health", health })
  for (const event of events) emit({ type: "event", event })

  for await (const line of createInterface({ input: process.stdin })) {
    let message: ReturnType<typeof DaemonToAppMessageSchema.parse>
    try {
      message = DaemonToAppMessageSchema.parse(JSON.parse(line))
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof ZodError) {
        emit({ type: "protocol-error", message: "invalid command" })
        continue
      }
      throw error
    }
    if (message.type === "protocol-error" || message.type === "pong") continue
    let data: unknown
    switch (message.name) {
      case "health":
        data = health
        break
      case "permissions":
      case "requestPermissions":
        data = permissions
        break
      case "applications.list":
      case "applications.icons":
        data = []
        break
      case "keychain.set":
        keychain.set(message.args.ref, message.args.secret)
        data = { ref: message.args.ref }
        break
      case "keychain.get":
        data = keychain.get(message.args.ref) ?? null
        break
      case "keychain.status":
        data = {
          stored: keychain.has(message.args.ref),
          accessible: keychain.has(message.args.ref),
        }
        break
      case "keychain.authorize":
        data = { authorized: keychain.has(message.args.ref) }
        break
      case "keychain.rotate":
        data = { key: Buffer.alloc(32, 9).toString("base64") }
        break
      case "capture.request":
      case "ocr.window":
      case "browser.url":
      case "observer.configure":
      case "settings.open":
      case "web.session":
        data = null
        break
      default:
        data = message satisfies never
    }
    emit({ type: "result", id: message.id, ok: true, data })
  }
}

if (import.meta.main) await runFakeHelper(process.argv[2])
