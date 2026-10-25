import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { z } from "zod"
import { saveSettings } from "../../src/config/index"
import { DaemonToAppMessageSchema } from "../../src/contracts/protocol"
import { SettingsSchema } from "../../src/contracts/settings"

const InspectorReplySchema = z.object({
  id: z.number(),
  result: z.object({
    wasThrown: z.boolean(),
    result: z.object({ value: z.unknown().optional() }).optional(),
    exceptionDetails: z.unknown().optional(),
  }),
})

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (existsSync(path)) return
    await Bun.sleep(25)
  }
  throw new Error(`Synthetic daemon path did not appear: ${path}`)
}

async function evaluate(inspector: WebSocket, expression: string): Promise<unknown> {
  const reply = await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Inspector evaluation timed out")), 10_000)
    inspector.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout)
        resolve(JSON.parse(String(event.data)))
      },
      { once: true },
    )
    inspector.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    )
  })
  const result = InspectorReplySchema.parse(reply).result
  if (result.wasThrown || result.exceptionDetails) {
    throw new Error("Daemon Inspector evaluation failed")
  }
  return result.result?.value
}

test("Given a synthetic provider key sent over daemon UDS, when GC and heap snapshot run, then daemon outputs and live heap contain no key", async () => {
  // Given: an isolated daemon process and a protocol-level fake of the Swift helper.
  const directory = mkdtempSync(join(tmpdir(), "side-provider-heap-"))
  const socketPath = join(directory, "run", "daemon.sock")
  const snapshotPath = join(directory, "provider.heapsnapshot")
  const secret = `synthetic-provider-${randomUUID()}`
  const marker = `heap-canary-${randomUUID()}`
  await saveSettings(
    directory,
    SettingsSchema.parse({
      version: 2,
      contextAwareness: { enabled: false },
      providers: [{ id: "synthetic", baseUrl: "https://fixture.invalid/v1", models: ["probe"] }],
    }),
  )
  const child = spawn(process.execPath, ["--inspect=127.0.0.1:0", "src/cli.ts", "daemon"], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, HOME: directory, SIDE_DATA_DIR: directory, LCA_DATA_DIR: directory },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  let stderr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk
  })
  let helperSawKey = false
  const keychain = new Map<string, string>()
  const helper = (async () => {
    for await (const line of createInterface({ input: child.stdout })) {
      const command = DaemonToAppMessageSchema.parse(JSON.parse(line))
      if (command.type !== "command") throw new Error("Unexpected daemon output")
      let data: unknown = null
      if (command.name === "keychain.set") {
        helperSawKey = true
        keychain.set(command.args.ref, command.args.secret)
        data = { ref: command.args.ref }
      }
      if (command.name === "keychain.get") data = keychain.get(command.args.ref) ?? null
      child.stdin.write(
        `${JSON.stringify({
          type: "result",
          id: command.id,
          ok: true,
          data,
        })}\n`,
      )
    }
  })()
  let inspector: WebSocket | undefined
  try {
    child.stdin.write(
      `${JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        key: randomBytes(32).toString("base64"),
        appVersion: "synthetic-canary",
      })}\n`,
    )
    await waitForPath(socketPath)
    const inspectorUrl = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9]+/u)?.[0]
    if (!inspectorUrl) throw new Error("Synthetic daemon Inspector did not start")
    inspector = new WebSocket(inspectorUrl)
    await new Promise<void>((resolve, reject) => {
      inspector?.addEventListener("open", () => resolve(), { once: true })
      inspector?.addEventListener("error", () => reject(new Error("Inspector connection failed")), {
        once: true,
      })
    })
    const call = async (method: string, params?: unknown): Promise<unknown> => {
      const response = await fetch("http://localhost/rpc", {
        unix: socketPath,
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
      return response.json()
    }

    // When: the actual daemon handles providers.setKey, then its own Inspector forces GC.
    const setKey = await call("providers.setKey", { providerId: "synthetic", apiKey: secret })
    const expectedRef = `provider/synthetic/${createHash("sha256")
      .update(JSON.stringify(["synthetic", "https://fixture.invalid/v1"]))
      .digest("hex")}`
    expect(setKey).toMatchObject({ result: { apiKeyRef: expectedRef } })
    expect(helperSawKey).toBe(true)
    expect(keychain.get(expectedRef) === secret).toBe(true)
    const settings = await call("settings.get")
    expect(settings).toMatchObject({ result: { providers: [{ has_key: true }] } })
    expect(JSON.stringify(settings).includes(secret)).toBe(false)
    expect(JSON.stringify(settings).includes("apiKeyRef")).toBe(false)
    expect(JSON.stringify(settings).includes("apiKey")).toBe(false)
    expect(readFileSync(join(directory, "settings.json")).includes(secret)).toBe(false)
    expect(stderr.includes(secret)).toBe(false)

    await evaluate(inspector, `globalThis.__sideHeapCanary = ${JSON.stringify(marker)}`)
    await evaluate(
      inspector,
      `(async () => {
      Bun.gc(true);
      Bun.gc(true);
      return await Bun.write(${JSON.stringify(snapshotPath)}, Bun.generateHeapSnapshot("v8", "arraybuffer"));
    })()`,
    )
    await waitForPath(snapshotPath)
    const snapshot = readFileSync(snapshotPath)
    // Then: the positive marker proves that this is the daemon's live JS heap.
    expect(snapshot.includes(marker)).toBe(true)
    expect(snapshot.includes(secret)).toBe(false)
    expect(stderr.includes(secret)).toBe(false)
  } finally {
    inspector?.close()
    child.kill("SIGTERM")
    await exited
    await helper
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)
