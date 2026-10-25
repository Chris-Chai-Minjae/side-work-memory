import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ZodError } from "zod"
import { loadSettings, saveSettings, dataDirectory as sideDataDirectory } from "../src/config/index"

async function writeLegacyConfig(
  directory: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({
      version: 1,
      enabled: false,
      pausedUntil: null,
      deniedApps: [],
      deniedWebsites: [],
      screenOcr: false,
      captureTypedText: false,
      summaryModel: null,
      embeddingModel: null,
      retentionDays: 14,
      intervalSeconds: 15,
      ...overrides,
    }),
  )
}

test("Given legacy and Side directory overrides, when resolving the write path, then Side wins", () => {
  const previousSide = process.env["SIDE_DATA_DIR"]
  const previousLegacy = process.env["LCA_DATA_DIR"]
  try {
    process.env["SIDE_DATA_DIR"] = "/tmp/side-settings-test"
    process.env["LCA_DATA_DIR"] = "/tmp/legacy-settings-test"
    expect(sideDataDirectory()).toBe("/tmp/side-settings-test")
    delete process.env["SIDE_DATA_DIR"]
    expect(sideDataDirectory()).toMatch(/Library\/Application Support\/Side$/)
    expect(sideDataDirectory()).not.toBe(process.env["LCA_DATA_DIR"])
  } finally {
    if (previousSide === undefined) delete process.env["SIDE_DATA_DIR"]
    else process.env["SIDE_DATA_DIR"] = previousSide
    if (previousLegacy === undefined) delete process.env["LCA_DATA_DIR"]
    else process.env["LCA_DATA_DIR"] = previousLegacy
  }
})

test("Given no settings or legacy config, when loaded, then private Side defaults are saved", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-settings-"))
  const directory = join(root, "Side")
  try {
    const settings = await loadSettings(directory, join(root, "missing-legacy"))
    expect(settings.contextAwareness).toMatchObject({
      enabled: false,
      pausedUntil: null,
      rules: [],
      retentionDays: 14,
      captureTypedText: true,
      screenOcr: true,
      asideAdapter: false,
    })
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(join(directory, "settings.json"))).mode & 0o777).toBe(0o600)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Given a v1 config, when loaded, then rules and indefinite pause migrate to v2 on disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-settings-"))
  const legacyDirectory = join(root, "legacy")
  const directory = join(root, "Side")
  try {
    await writeLegacyConfig(legacyDirectory, {
      enabled: true,
      pausedUntil: "indefinite",
      deniedApps: ["com.example.Private"],
      deniedWebsites: ["PRIVATE.EXAMPLE."],
      retentionDays: 7,
      intervalSeconds: 15,
    })
    const oldBytes = await readFile(join(legacyDirectory, "config.json"), "utf8")
    const migrated = await loadSettings(directory, legacyDirectory)
    expect(migrated.contextAwareness).toMatchObject({
      enabled: true,
      pausedUntil: Number.MAX_SAFE_INTEGER,
      retentionDays: 7,
      captureTypedText: false,
      screenOcr: false,
      rules: [
        { scope: "app", behavior: "do_not_observe", bundleId: "com.example.Private" },
        { scope: "url", behavior: "do_not_observe", urlDomain: "private.example" },
      ],
    })
    const saved = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"))
    expect(saved.version).toBe(2)
    expect(saved.intervalSeconds).toBeUndefined()
    expect(saved.contextAwareness.intervalSeconds).toBeUndefined()
    expect(await readFile(join(legacyDirectory, "config.json"), "utf8")).toBe(oldBytes)
    expect((await stat(join(directory, "settings.json"))).mode & 0o777).toBe(0o600)
    expect(await loadSettings(directory, legacyDirectory)).toEqual(migrated)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Given LCA_DATA_DIR, when Side first loads, then it reads legacy without writing there", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-settings-"))
  const legacyDirectory = join(root, "legacy")
  const directory = join(root, "Side")
  const previousLegacy = process.env["LCA_DATA_DIR"]
  try {
    await writeLegacyConfig(legacyDirectory, { deniedApps: ["com.example.Hidden"] })
    const oldBytes = await readFile(join(legacyDirectory, "config.json"), "utf8")
    process.env["LCA_DATA_DIR"] = legacyDirectory
    expect((await loadSettings(directory)).contextAwareness.rules).toEqual([
      { scope: "app", behavior: "do_not_observe", bundleId: "com.example.Hidden" },
    ])
    expect(await readFile(join(legacyDirectory, "config.json"), "utf8")).toBe(oldBytes)
  } finally {
    if (previousLegacy === undefined) delete process.env["LCA_DATA_DIR"]
    else process.env["LCA_DATA_DIR"] = previousLegacy
    await rm(root, { recursive: true, force: true })
  }
})

test("Given a v1 summary model name, when migrated, then no provider is invented and v1 is preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-settings-"))
  const legacyDirectory = join(root, "legacy")
  const directory = join(root, "Side")
  try {
    await writeLegacyConfig(legacyDirectory, { summaryModel: "local-summary-model" })
    const oldBytes = await readFile(join(legacyDirectory, "config.json"), "utf8")
    const migrated = await loadSettings(directory, legacyDirectory)
    expect(migrated.contextAwareness.summaryModel).toBeUndefined()
    expect(migrated.providers).toEqual([])
    expect(await readFile(join(legacyDirectory, "config.json"), "utf8")).toBe(oldBytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Given an existing v2 file and a v1 config, when loaded, then v2 remains authoritative", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-settings-"))
  const directory = join(root, "Side")
  const legacyDirectory = join(root, "legacy")
  try {
    const settings = await loadSettings(directory, legacyDirectory)
    await saveSettings(directory, {
      ...settings,
      contextAwareness: { ...settings.contextAwareness, enabled: true },
    })
    await writeLegacyConfig(legacyDirectory)
    expect((await loadSettings(directory, legacyDirectory)).contextAwareness.enabled).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Given a v2 update, when saved, then the replacement is private and temporary files are gone", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-settings-"))
  const directory = join(root, "Side")
  try {
    const settings = await loadSettings(directory, join(root, "missing-legacy"))
    await saveSettings(directory, {
      ...settings,
      contextAwareness: { ...settings.contextAwareness, enabled: true },
    })
    expect(
      (await loadSettings(directory, join(root, "missing-legacy"))).contextAwareness.enabled,
    ).toBe(true)
    expect((await stat(join(directory, "settings.json"))).mode & 0o777).toBe(0o600)
    expect(await readdir(directory)).toEqual(["settings.json"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Given an unknown v2 key, when saved, then zod rejects it without changing the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-settings-"))
  const directory = join(root, "Side")
  try {
    const settings = await loadSettings(directory, join(root, "missing-legacy"))
    const filename = join(directory, "settings.json")
    const before = await readFile(filename, "utf8")
    const invalidSettings = {
      ...settings,
      contextAwareness: { ...settings.contextAwareness, unexpected: true },
    }
    await expect(saveSettings(directory, invalidSettings)).rejects.toBeInstanceOf(ZodError)
    expect(await readFile(filename, "utf8")).toBe(before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Given an unknown key in settings.json, when loaded, then zod rejects it", async () => {
  const root = await mkdtemp(join(tmpdir(), "side-settings-"))
  const directory = join(root, "Side")
  try {
    const settings = await loadSettings(directory, join(root, "missing-legacy"))
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({ ...settings, unexpected: true }),
    )
    await expect(loadSettings(directory, join(root, "missing-legacy"))).rejects.toBeInstanceOf(
      ZodError,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
