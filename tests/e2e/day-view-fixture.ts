import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { PassThrough } from "node:stream"
import { ulid } from "ulid"
import { z } from "zod"
import { type DaemonToAppMessage, DaemonToAppMessageSchema } from "../../src/contracts/protocol"
import { runDaemon } from "../../src/daemon/index"
import { openLedger } from "../../src/ledger/schema"
import { writeLedgerEvent } from "../../src/ledger/write"
import { renderContextAwarenessDayPage } from "../../src/memory/render"
import { health, hello } from "../helper/fixture"

function relativeDay(offset: number): string {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() + offset)
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date)
}

export const day = relativeDay(-3)
export const previousDay = relativeDay(-4)
export const nextDay = relativeDay(-1)
export const emptyDay = relativeDay(-2)
const today = relativeDay(0)

const WebPublicationSchema = z.strictObject({
  port: z.number().int().positive(),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
})
const RpcResultSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.number(), result: z.unknown() })

function localTime(date: string, hour: number, minute = 0): number {
  const [year, month, dayOfMonth] = date.split("-").map(Number)
  if (year === undefined || month === undefined || dayOfMonth === undefined)
    throw new TypeError("Invalid synthetic date")
  return new Date(year, month - 1, dayOfMonth, hour, minute).getTime()
}

function addSummary(
  db: ReturnType<typeof openLedger>,
  date: string,
  kind: "10min" | "6h",
  title: string,
  citations: readonly { readonly ref: string; readonly title: string }[] = [],
  windowFrom?: number,
): string {
  const from = windowFrom ?? localTime(date, kind === "6h" ? 8 : 9, 10)
  const to = from + (kind === "6h" ? 6 * 60 : 10) * 60_000
  const id = ulid(from)
  db.query(`
    INSERT INTO context_awareness_summaries
      (id, kind, window_from, window_to, created_at, updated_at, title,
       description, body, citations, source_ids, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done')
  `).run(
    id,
    kind,
    from,
    to,
    from,
    from,
    title,
    JSON.stringify(["Synthetic research notes"]),
    kind === "10min" ? "Reviewed notes. <script>window.__dayExecuted = true</script>" : null,
    JSON.stringify(citations),
    JSON.stringify(citations.map(({ ref }) => ref)),
  )
  return id
}

async function seed(directory: string) {
  const ledgerDirectory = join(directory, "context-awareness")
  mkdirSync(ledgerDirectory, { recursive: true })
  const db = openLedger(join(ledgerDirectory, "ledger.db"))
  const key = Buffer.alloc(32, 7)
  try {
    const id = writeLedgerEvent(db, key, {
      occurredAt: localTime(day, 9, 15),
      source: "mac_ax",
      kind: "content.snapshot",
      appName: "Synthetic Browser",
      bundleId: "fixture.invalid.browser",
      windowTitle: "Synthetic source",
      url: "https://fixture.invalid/source",
      content: "<script>window.__evidenceExecuted = true</script> synthetic evidence",
    }).id
    const sourceRef = `e:${id}`
    const expiredRef = `e:${ulid(localTime(day, 9, 16))}`
    addSummary(db, previousDay, "10min", "Previous synthetic summary")
    addSummary(db, day, "6h", "Day overview")
    const summaryRef = `s:${addSummary(db, day, "10min", "Synthetic research", [
      { ref: sourceRef, title: "Live source" },
      { ref: expiredRef, title: "Expired source" },
    ])}`
    addSummary(db, nextDay, "10min", "Next synthetic summary")
    if (today !== day && today !== previousDay && today !== nextDay)
      addSummary(db, today, "10min", "Today synthetic summary", [], localTime(today, 0))
    await renderContextAwarenessDayPage(db, directory, day, Date.now())
    await renderContextAwarenessDayPage(db, directory, today, Date.now())
    return { today, sourceRef, expiredRef, summaryRef }
  } finally {
    key.fill(0)
    db.close()
  }
}

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
  if (!response.ok) throw new Error(`Daemon RPC failed (${response.status})`)
  return RpcResultSchema.parse(await response.json()).result
}

export async function startDayFixture(webDirectory: string) {
  const directory = mkdtempSync(join(tmpdir(), "side-day-e2e-"))
  let refs: Awaited<ReturnType<typeof seed>>
  try {
    refs = await seed(directory)
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
  const input = new PassThrough()
  const output = new PassThrough()
  const sessions: { readonly port: number; readonly token: string }[] = []
  const lines = createInterface({ input: output })
  lines.on("line", (line) => {
    const message: DaemonToAppMessage = DaemonToAppMessageSchema.parse(JSON.parse(line))
    if (message.type !== "command") return
    if (message.name === "web.session") sessions.push(message.args)
    const data = message.name === "health" ? health : null
    input.write(`${JSON.stringify({ type: "result", id: message.id, ok: true, data })}\n`)
  })
  const running = runDaemon({
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
  input.write(`${JSON.stringify({ type: "health", health })}\n`)
  const webPublication = join(directory, "run", "web.json")
  try {
    for (
      let attempt = 0;
      (!existsSync(webPublication) || sessions.length === 0) && attempt < 100;
      attempt++
    ) {
      if (daemonError) throw daemonError
      await Bun.sleep(10)
    }
    if (!existsSync(webPublication) || sessions.length !== 1)
      throw new Error("Synthetic daemon did not provide one web session")
    const session = sessions[0]
    if (!session) throw new Error("Synthetic daemon did not provide a web session")
    const published = WebPublicationSchema.parse(JSON.parse(readFileSync(webPublication, "utf8")))
    if (
      published.port !== session.port ||
      published.tokenHash !== createHash("sha256").update(session.token).digest("hex")
    )
      throw new Error("Published web session does not match fake helper command")
    const socketPath = join(directory, "run", "daemon.sock")
    const rpcCalls: { method: string; params: unknown }[] = []
    return {
      ...refs,
      daemonPort: session.port,
      port: session.port,
      token: session.token,
      tokenHash: published.tokenHash,
      webPublicationPath: webPublication,
      relayPath: join(directory, "relay"),
      rpcCalls,
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
      await running.catch(() => {})
    } finally {
      lines.close()
      output.destroy()
      input.destroy()
      rmSync(directory, { recursive: true, force: true })
    }
    throw error
  }
}
