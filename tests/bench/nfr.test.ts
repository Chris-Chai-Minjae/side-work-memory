import { describe, expect, test } from "bun:test"
import { mean, parsePsCpu } from "../../scripts/bench/cpu"
import { footprintBytes } from "../../scripts/bench/disk"
import { percentile, summaryLagMs } from "../../scripts/bench/latency"
import { parsePsRss } from "../../scripts/bench/rss"

describe("NFR sample math", () => {
  test("CPU parsing and mean reject missing samples", () => {
    expect(parsePsCpu("  1.5\n")).toBe(1.5)
    expect(() => parsePsCpu("-")).toThrow()
    expect(mean([1, 2, 3])).toBe(2)
    expect(() => mean([])).toThrow()
  })
  test("RSS converts ps KiB to MiB", () => {
    expect(parsePsRss(" 153600\n")).toBe(150)
    expect(() => parsePsRss("0")).toThrow()
  })
  test("nearest rank p95 and summary lag", () => {
    expect(
      percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 0.95),
    ).toBe(19)
    expect(summaryLagMs(1_000, 181_000)).toBe(180_000)
    expect(() => summaryLagMs(2_000, 1_000)).toThrow()
  })
  test("footprint includes SQLite sidecars and page bytes", () => {
    expect(footprintBytes([12, 3, 5])).toBe(20)
    expect(() => footprintBytes([])).toThrow()
  })
})

test("synthetic storage benchmark includes every long-lived data-root file", async () => {
  const { measureEightHourDisk } = await import("../../scripts/bench/disk")
  const result = await measureEightHourDisk()
  expect(result.events).toBe(96)
  expect(result.summaries).toBe(48)
  expect(result.sealedBlobs).toBe(96)
  expect(result.totalBytes).toBe(
    result.ledgerBytes + result.dayPageBytes + result.indexBytes + result.operationalBytes,
  )
  expect(result.dayPageBytes).toBeGreaterThan(0)
  expect(result.indexBytes).toBeGreaterThan(0)
  expect(result.operationalBytes).toBeGreaterThan(0)
})

test("capture proxy waits for committed ledger rows", async () => {
  const { measureLedgerCommit } = await import("../../scripts/bench/latency")
  const result = measureLedgerCommit(3)
  expect(result.samples).toBe(3)
  expect(result.p95Ms).toBeGreaterThan(0)
})
