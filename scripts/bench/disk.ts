import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { saveSettings } from "../../src/config/index"
import { SettingsSchema } from "../../src/contracts/settings"
import { sealColdBlobs } from "../../src/ledger/frames"
import { openLedger } from "../../src/ledger/schema"
import { writeLedgerEvent } from "../../src/ledger/write"
import { openIndexDb } from "../../src/memory/index-db"
import { renderContextAwarenessDayPage } from "../../src/memory/render"
import { truncateWal } from "../../src/sqlite/checkpoint"

export function footprintBytes(sizes: readonly number[]): number {
  if (sizes.length === 0 || sizes.some((size) => size < 0)) {
    throw new RangeError("Invalid footprint sizes")
  }
  return sizes.reduce((sum, size) => sum + size, 0)
}

function size(path: string): number {
  return existsSync(path) ? statSync(path).size : 0
}

export function dataRootFootprintBytes(root: string): number {
  const sizes: number[] = []
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) sizes.push(statSync(join(entry.parentPath, entry.name)).size)
  }
  return sizes.length === 0 ? 0 : footprintBytes(sizes)
}

export async function measureEightHourDisk(): Promise<{
  readonly ledgerBytes: number
  readonly dayPageBytes: number
  readonly indexBytes: number
  readonly operationalBytes: number
  readonly totalBytes: number
  readonly events: number
  readonly summaries: number
  readonly sealedBlobs: number
}> {
  const root = mkdtempSync(join(tmpdir(), "side-nfr-disk-"))
  const key = Buffer.alloc(32, 0x42)
  const day = "2026-09-20"
  const dayStart = new Date(2026, 8, 20, 9).getTime()
  try {
    const ledgerDirectory = join(root, "context-awareness")
    mkdirSync(ledgerDirectory, { recursive: true })
    const ledger = join(ledgerDirectory, "ledger.db")
    const db = openLedger(ledger)
    try {
      for (let window = 0; window < 48; window++) {
        const windowFrom = dayStart + window * 600_000
        for (let capture = 0; capture < 2; capture++) {
          writeLedgerEvent(db, key, {
            occurredAt: windowFrom + capture * 60_000,
            source: "mac_ax",
            kind: "content.snapshot",
            appName: "Synthetic Browser",
            windowTitle: `Synthetic document ${window}`,
            content: `Fabricated reference ${window}-${capture}: ${"fictional research note ".repeat(40)}`,
          })
        }
        db.query(`
          INSERT INTO context_awareness_summaries
            (id, kind, window_from, window_to, created_at, updated_at,
             title, description, body, status)
          VALUES (?, '10min', ?, ?, ?, ?, ?, '[]', ?, 'done')
        `).run(
          `synthetic-${window}`,
          windowFrom,
          windowFrom + 600_000,
          windowFrom,
          windowFrom + 600_000,
          `Synthetic summary ${window}`,
          `Fabricated summary for fictional document ${window}.`,
        )
      }
      let sealedBlobs = 0
      for (let attempt = 0; attempt < 20; attempt++) {
        const sealed = sealColdBlobs(db, key, dayStart + 86_400_000)
        sealedBlobs += sealed
        if (sealed === 0) break
      }
      const rendered = await renderContextAwarenessDayPage(db, root, day, dayStart + 86_400_000)
      if (rendered.status !== "committed") throw new Error("Day page was not committed")
      await saveSettings(root, SettingsSchema.parse({ version: 2, contextAwareness: {} }))
      const index = join(root, "index.db")
      const indexDb = openIndexDb(index)
      try {
        truncateWal(indexDb)
      } finally {
        indexDb.close()
      }
      const run = join(root, "run")
      mkdirSync(run, { recursive: true })
      const usage = {
        timestamp: dayStart,
        clientName: "synthetic",
        tool: "history_search",
        resultCount: 1,
        latencyMs: 5,
      }
      writeFileSync(join(run, "mcp-usage.jsonl"), `${JSON.stringify(usage)}\n`, { mode: 0o600 })
      writeFileSync(join(run, "mcp-usage.jsonl.1"), `${JSON.stringify(usage)}\n`, { mode: 0o600 })
      writeFileSync(
        join(run, "diagnostics.jsonl"),
        `${JSON.stringify({ type: "capture-success", timestamp: dayStart })}\n`,
        { mode: 0o600 },
      )
      truncateWal(db)
      const ledgerBytes = footprintBytes([
        size(ledger),
        size(`${ledger}-wal`),
        size(`${ledger}-shm`),
      ])
      const dayPageBytes = size(join(root, "memory", "episodic", `context-awareness-${day}.md`))
      const indexBytes = footprintBytes([size(index), size(`${index}-wal`), size(`${index}-shm`)])
      const totalBytes = dataRootFootprintBytes(root)
      return {
        ledgerBytes,
        dayPageBytes,
        indexBytes,
        operationalBytes: totalBytes - ledgerBytes - dayPageBytes - indexBytes,
        totalBytes,
        events: 96,
        summaries: 48,
        sealedBlobs,
      }
    } finally {
      db.close()
    }
  } finally {
    key.fill(0)
    rmSync(root, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  console.log(
    JSON.stringify({
      scope:
        "synthetic 8-hour day; all regular data-root files including ledger, day page, index, settings, MCP and diagnostic logs",
      ...(await measureEightHourDisk()),
    }),
  )
}
