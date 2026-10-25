import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { PassThrough } from "node:stream"
import { enqueueSummaryJobs, markNonGlanceEvent } from "../../src/comprehension/queue"
import { saveSettings } from "../../src/config/index"
import { COMPREHENSION_INTERVAL_MS, SYNC_DEBOUNCE_MS, TEN_MINUTES_MS } from "../../src/constants"
import { SettingsSchema } from "../../src/contracts/settings"
import { runDaemon } from "../../src/daemon/index"
import { openLedger } from "../../src/ledger/schema"
import { writeLedgerEvent } from "../../src/ledger/write"
import { health, hello } from "../helper/fixture"
import { FakeClock } from "../mocks/fake-clock"

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error("Synthetic summary did not reach the expected state")
}

test("Given an in-flight summary, when Clear all starts, then deletion and rotation wait for its completion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "side-clear-summary-"))
  mkdirSync(join(directory, "context-awareness"))
  const now = Math.floor(Date.now() / TEN_MINUTES_MS) * TEN_MINUTES_MS
  const clock = new FakeClock(now)
  const db = openLedger(join(directory, "context-awareness", "ledger.db"))
  const occurredAt = now - TEN_MINUTES_MS + 1_000
  const event = writeLedgerEvent(db, Buffer.alloc(32, 7), {
    occurredAt,
    source: "mac_ax",
    kind: "content.snapshot",
    appName: "Synthetic Editor",
    bundleId: "com.example.Editor",
    windowTitle: "Synthetic summary source",
    content: "Synthetic summary source",
  })
  markNonGlanceEvent(db, event.id, occurredAt)
  enqueueSummaryJobs(db, now)
  db.close()
  let releaseProvider: (() => void) | undefined
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve
  })
  let providerStarted = false
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      providerStarted = true
      await providerGate
      return Response.json({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: "record_summary",
                    arguments: JSON.stringify({
                      title: "Synthetic summary",
                      description: ["Synthetic source reviewed"],
                      memorySummary: "Synthetic source reviewed",
                      apps: ["Synthetic Editor"],
                      domains: [],
                      citations: [{ ref: `e:${event.id}` }],
                      sourceIds: [`e:${event.id}`],
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
  const input = new PassThrough()
  const output = new PassThrough()
  const lines = createInterface({ input: output })
  const commands: string[] = []
  lines.on("line", (line) => {
    const command = JSON.parse(line)
    if (command.type !== "command") return
    commands.push(`${command.name}${command.args?.paused === true ? ":paused" : ""}`)
    input.write(
      `${JSON.stringify({
        type: "result",
        id: command.id,
        ok: true,
        data:
          command.name === "keychain.rotate"
            ? { key: Buffer.alloc(32, 9).toString("base64") }
            : null,
      })}\n`,
    )
  })
  let running: Promise<void> | null = null
  try {
    await saveSettings(
      directory,
      SettingsSchema.parse({
        version: 2,
        contextAwareness: { enabled: true, summaryModel: { provider: "fake", modelId: "fake" } },
        providers: [
          { id: "fake", baseUrl: `${provider.url}v1`, models: ["fake"], allowEvidence: true },
        ],
      }),
    )
    running = runDaemon({
      directory,
      input,
      output,
      clock,
      embeddingManager: {
        async embed() {
          return new Float32Array(384)
        },
        async close() {},
      },
    })
    input.write(`${JSON.stringify(hello)}\n`)
    input.write(`${JSON.stringify({ type: "health", health })}\n`)
    await waitFor(() => commands.includes("observer.configure"))
    clock.advanceBy(COMPREHENSION_INTERVAL_MS)
    await waitFor(() => providerStarted)
    const clearResponse = fetch("http://localhost/rpc", {
      unix: join(directory, "run", "daemon.sock"),
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "clear", params: { target: "all" } }),
    }).then((response) => response.json())
    await waitFor(() => commands.includes("observer.configure:paused"))
    const during = openLedger(join(directory, "context-awareness", "ledger.db"))
    try {
      expect(
        during
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_awareness_events")
          .get()?.count,
      ).toBe(1)
      expect(commands).not.toContain("keychain.rotate")
    } finally {
      during.close()
    }
    releaseProvider?.()
    const day = new Intl.DateTimeFormat("sv-SE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(occurredAt)
    await waitFor(() =>
      existsSync(join(directory, "memory", "episodic", `context-awareness-${day}.md`)),
    )
    clock.advanceBy(SYNC_DEBOUNCE_MS)
    const result = await clearResponse
    expect(result.result).toMatchObject({ deleted_events: 1, deletion_epoch: 1 })
    expect(commands).toContain("keychain.rotate")
  } finally {
    releaseProvider?.()
    input.end()
    await running?.catch(() => {})
    lines.close()
    output.destroy()
    provider.stop(true)
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)
