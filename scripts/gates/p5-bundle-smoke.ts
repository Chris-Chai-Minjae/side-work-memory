import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { z } from "zod"
import { EMBEDDING_DIMENSIONS } from "../../src/constants"
import { EMBEDDING_MODEL_ID } from "../../src/memory/embed"
import { openIndexDb, putIndexedChunk } from "../../src/memory/index-db"

const app = resolve(process.argv[2] ?? "apps/side-mac/.build/release/Side.app")
const resources = join(app, "Contents", "Resources")
const binary = join(resources, "side")
const required = [
  binary,
  join(resources, "lib", "libsqlite3.dylib"),
  join(resources, "lib", "vec0.dylib"),
  join(resources, "lib", "libonnxruntime.1.dylib"),
  join(resources, "web", "index.html"),
  join(resources, "skills", "side-resume", "SKILL.md"),
  join(resources, "models", EMBEDDING_MODEL_ID, "onnx", "model_quantized.onnx"),
] as const
for (const path of required) {
  if (!existsSync(path)) throw new Error(`Missing bundle asset: ${path}`)
}

const Command = z.object({
  type: z.literal("command"),
  id: z.string(),
  name: z.string(),
  args: z.unknown().optional(),
})
const WebSession = z.object({ port: z.number().int().positive(), token: z.string().length(64) })
const RpcResult = z.union([z.object({ result: z.unknown() }), z.object({ error: z.unknown() })])
const directory = mkdtempSync(join(tmpdir(), "side-p5-bundle-smoke-"))
const child = spawn(binary, ["daemon"], {
  env: { ...process.env, SIDE_DATA_DIR: directory, LCA_DATA_DIR: directory },
  stdio: ["pipe", "pipe", "pipe"],
  detached: true,
})
const exited = new Promise<number | null>((resolveExit) => {
  child.once("exit", resolveExit)
})
const sessionState: { current: z.infer<typeof WebSession> | null } = { current: null }
let stderr = ""
child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
  stderr += chunk
})
const lines = createInterface({ input: child.stdout })
lines.on("line", (line) => {
  const parsed = Command.safeParse(JSON.parse(line))
  if (!parsed.success) return
  const command = parsed.data
  if (command.name === "web.session") sessionState.current = WebSession.parse(command.args)
  const data =
    command.name === "permissions"
      ? { accessibility: true, inputMonitoring: true, screenRecording: true, automation: {} }
      : null
  child.stdin.write(`${JSON.stringify({ type: "result", id: command.id, ok: true, data })}\n`)
})

try {
  child.stdin.write(
    `${JSON.stringify({ type: "hello", protocolVersion: 1, key: Buffer.alloc(32, 7).toString("base64"), appVersion: "p5-smoke" })}\n`,
  )
  const socket = join(directory, "run", "daemon.sock")
  for (
    let index = 0;
    index < 200 && (!existsSync(socket) || sessionState.current === null);
    index++
  ) {
    if (child.exitCode !== null) throw new Error(`Daemon exited ${child.exitCode}: ${stderr}`)
    await Bun.sleep(50)
  }
  const session = sessionState.current
  if (!existsSync(socket) || session === null) throw new Error(`Daemon did not start: ${stderr}`)

  const web = await fetch(`http://127.0.0.1:${session.port}/`, {
    headers: { Authorization: `Bearer ${session.token}` },
  })
  if (web.status !== 200 || !(await web.text()).includes("side-executable"))
    throw new Error(`Bundled web response was ${web.status}`)

  const index = openIndexDb(join(directory, "index.db"))
  try {
    const vector = new Float32Array(EMBEDDING_DIMENSIONS)
    const day = new Date().toISOString().slice(0, 10)
    vector[0] = 1
    putIndexedChunk(
      index,
      {
        id: "synthetic-bundle-chunk",
        path: `episodic/context-awareness-${day}.md`,
        day,
        windowFrom: null,
        windowTo: null,
        heading: "fixture",
        text: "Synthetic bundle inference fixture",
        summaryId: null,
        indexVersion: 1,
        embeddedModel: EMBEDDING_MODEL_ID,
      },
      vector,
    )
  } finally {
    index.close()
  }
  const response = await fetch("http://localhost/rpc", {
    unix: socket,
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "memorySearch",
      params: { query: "fixture" },
    }),
  })
  const result = RpcResult.parse(await response.json())
  if ("error" in result || !Array.isArray(result.result))
    throw new Error(`Compiled memory search failed: ${JSON.stringify(result)}`)
  console.log("PASS bundled web, SQLite vec0, and compiled MiniLM inference")
} finally {
  try {
    if (child.exitCode === null) {
      const pid = child.pid
      try {
        if (pid) process.kill(-pid, "SIGTERM")
        else child.kill("SIGTERM")
      } catch {
        child.kill("SIGTERM")
      }
      await exited
    }
  } finally {
    lines.close()
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    Bun.gc(true)
    rmSync(directory, { recursive: true, force: true })
  }
}
