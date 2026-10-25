import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { PassThrough } from "node:stream"
import { z } from "zod"
import { saveSettings } from "../../src/config/index"
import { DaemonToAppMessageSchema } from "../../src/contracts/protocol"
import { SettingsSchema } from "../../src/contracts/settings"
import { runDaemon } from "../../src/daemon/index"
import { health, hello } from "../helper/fixture"

const WebPublicationSchema = z.strictObject({
  port: z.number().int().positive(),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
})
const RpcResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("result"), result: z.unknown() }),
  z.object({ kind: z.literal("error"), code: z.number() }),
])

async function daemonRpc(socketPath: string, method: string, params?: unknown): Promise<unknown> {
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
  if (!response.ok) throw new Error(`Daemon RPC HTTP ${response.status}`)
  const wire = z
    .union([
      z
        .object({ result: z.unknown() })
        .transform((value) => ({ kind: "result" as const, result: value.result })),
      z
        .object({ error: z.object({ code: z.number() }) })
        .transform((value) => ({ kind: "error" as const, code: value.error.code })),
    ])
    .parse(await response.json())
  const parsed = RpcResponseSchema.parse(wire)
  if (parsed.kind === "error") throw new Error(`Daemon RPC ${method} failed (${parsed.code})`)
  return parsed.result
}

export async function startSettingsFixture(webDirectory: string, inputMonitoring = true) {
  const directory = mkdtempSync(join(tmpdir(), "side-settings-daemon-e2e-"))
  const initial = SettingsSchema.parse({
    version: 2,
    contextAwareness: {
      enabled: true,
      captureTypedText: true,
      screenOcr: false,
      retentionDays: 14,
      rules: [{ scope: "app", behavior: "do_not_observe", bundleId: "com.example.Secret" }],
    },
    providers: [
      {
        id: "local",
        baseUrl: "https://fixture.invalid/v1",
        models: ["small"],
        supportsToolChoice: true,
        allowEvidence: false,
      },
    ],
  })
  const input = new PassThrough()
  const output = new PassThrough()
  const calls: { method: string; params?: unknown }[] = []
  const helperCalls: { name: string; ref?: string; keyMatched?: boolean }[] = []
  const sessions: { readonly port: number; readonly token: string }[] = []
  let monitoringTrusted = inputMonitoring
  let grantOnRequest = false
  const permissions = () => ({
    accessibility: true,
    inputMonitoring: monitoringTrusted,
    screenRecording: false,
    automation: {},
  })
  const helperHealth = () => ({ ...health, inputMonitoringTrusted: monitoringTrusted })
  const lines = createInterface({ input: output })
  lines.on("line", (line) => {
    const frame = DaemonToAppMessageSchema.parse(JSON.parse(line))
    if (frame.type !== "command") return
    let data: unknown = null
    if (frame.name === "health") data = helperHealth()
    if (frame.name === "permissions") data = permissions()
    if (frame.name === "requestPermissions") {
      helperCalls.push({ name: frame.name })
      if (grantOnRequest) monitoringTrusted = true
      data = permissions()
      if (grantOnRequest)
        input.write(`${JSON.stringify({ type: "health", health: helperHealth() })}\n`)
    }
    if (frame.name === "applications.list") data = []
    if (frame.name === "web.session") sessions.push(frame.args)
    if (frame.name === "keychain.set") {
      helperCalls.push({
        name: frame.name,
        ref: frame.args.ref,
        keyMatched: frame.args.secret === "synthetic-only-key",
      })
      data = { ref: frame.args.ref }
    }
    input.write(`${JSON.stringify({ type: "result", id: frame.id, ok: true, data })}\n`)
  })
  let running: Promise<void> | null = null
  try {
    await saveSettings(directory, initial)
    running = runDaemon({
      directory,
      input,
      output,
      webDirectory,
      browserHistoryRoot: join(directory, "no-browser-profiles"),
      embeddingManager: {
        async embed() {
          return new Float32Array(384)
        },
        async close() {},
      },
    })
    let daemonError: unknown
    void running.catch((error: unknown) => {
      daemonError = error
    })
    input.write(`${JSON.stringify(hello)}\n`)
    input.write(`${JSON.stringify({ type: "health", health: helperHealth() })}\n`)
    const publication = join(directory, "run", "web.json")
    for (
      let attempt = 0;
      (!existsSync(publication) || sessions.length === 0) && attempt < 100;
      attempt++
    ) {
      if (daemonError) throw daemonError
      await Bun.sleep(10)
    }
    if (!existsSync(publication) || sessions.length !== 1)
      throw new Error("Synthetic daemon did not provide one web session")
    const session = sessions[0]
    if (!session) throw new Error("Synthetic daemon did not provide a web session")
    const published = WebPublicationSchema.parse(JSON.parse(readFileSync(publication, "utf8")))
    if (
      published.port !== session.port ||
      published.tokenHash !== createHash("sha256").update(session.token).digest("hex")
    )
      throw new Error("Published web session does not match fake helper command")
    const socketPath = join(directory, "run", "daemon.sock")
    return {
      daemonPort: session.port,
      port: session.port,
      token: session.token,
      tokenHash: published.tokenHash,
      webPublicationPath: publication,
      relayPath: join(directory, "relay"),
      calls,
      helperCalls,
      settingsPath: join(directory, "settings.json"),
      grantInputMonitoring() {
        grantOnRequest = true
      },
      callDaemon: (method: string, params?: unknown) => daemonRpc(socketPath, method, params),
      async close() {
        input.end()
        try {
          await running
        } finally {
          lines.close()
          output.destroy()
          input.destroy()
          rmSync(directory, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    input.end()
    try {
      await running?.catch(() => {})
    } finally {
      lines.close()
      output.destroy()
      input.destroy()
      rmSync(directory, { recursive: true, force: true })
    }
    throw error
  }
}
