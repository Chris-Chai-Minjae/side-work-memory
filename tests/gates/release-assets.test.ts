import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import packageJson from "../../package.json"
import { assertRedistributionLicenses } from "../../scripts/gates/license-policy"
import { modelLock, verifyModelAssets } from "../../scripts/gates/model-lock"
import { EMBEDDING_MODEL_ID } from "../../src/memory/embed"

test("model lock matches the runtime and rejects modified assets", () => {
  expect(modelLock.modelId).toBe(EMBEDDING_MODEL_ID)
  expect(modelLock.revision).toMatch(/^[0-9a-f]{40}$/)
  const root = mkdtempSync(join(tmpdir(), "side-model-lock-test-"))
  try {
    for (const asset of Object.keys(modelLock.assets)) {
      const path = join(root, modelLock.modelId, asset)
      mkdirSync(join(path, ".."), { recursive: true })
      writeFileSync(path, "modified synthetic asset")
    }
    expect(() => verifyModelAssets(root)).toThrow("Model asset hash mismatch")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("plist, generated constant, and package use one version", () => {
  const checked = spawnSync("bun", ["run", "scripts/gates/sync-version.ts", "--check"], {
    encoding: "utf8",
  })
  expect(checked.status).toBe(0)
  const plist = spawnSync(
    "plutil",
    ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", "apps/side-mac/Info.plist"],
    { encoding: "utf8" },
  )
  expect(plist.stdout.trim()).toBe(packageJson.version)
  expect(readFileSync("src/version.generated.ts", "utf8")).toContain(
    `APP_VERSION = ${JSON.stringify(packageJson.version)}`,
  )
})

test("redistribution license gate rejects LGPL and accepts reviewed permissive licenses", () => {
  expect(() =>
    assertRedistributionLicenses([
      { name: "synthetic-lgpl", licenses: [{ license: { id: "LGPL-3.0-only" } }] },
    ]),
  ).toThrow("LGPL component needs compliance review")
  expect(() =>
    assertRedistributionLicenses([
      { name: "synthetic-mit", licenses: [{ license: { id: "MIT" } }] },
    ]),
  ).not.toThrow()
})
