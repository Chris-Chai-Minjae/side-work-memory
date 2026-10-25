import { expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const script = resolve("apps/side-mac/scripts/sign-notarize.sh")
const sourceInfo = resolve("apps/side-mac/Info.plist")

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "side-signing-test-"))
  const app = join(root, "Side.app")
  const contents = join(app, "Contents")
  const macOS = join(contents, "MacOS")
  const resources = join(contents, "Resources")
  mkdirSync(macOS, { recursive: true })
  mkdirSync(join(resources, "lib"), { recursive: true })
  mkdirSync(join(resources, "metadata"), { recursive: true })
  writeFileSync(join(contents, "Info.plist"), readFileSync(sourceInfo))
  for (const name of [
    "THIRD_PARTY_NOTICES.txt",
    "sbom.json",
    "model-provenance.json",
    "build-manifest.json",
  ]) {
    writeFileSync(join(resources, "metadata", name), "synthetic metadata")
  }
  for (const file of [
    join(macOS, "Side"),
    join(resources, "side"),
    join(resources, "lib", "libsqlite3.dylib"),
    join(resources, "lib", "vec0.dylib"),
    join(resources, "lib", "libonnxruntime.1.dylib"),
  ]) {
    writeFileSync(file, "synthetic code")
  }
  return { root, app }
}

function run(args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync({
    cmd: ["sh", script, ...args],
    env: { ...process.env, ...env },
    stdin: "ignore",
  })
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }
}

test("preflight checks the exact bundle layout and permission strings", () => {
  const { root, app } = fixture()
  try {
    expect(run(["preflight", app]).code).toBe(0)
    rmSync(join(app, "Contents", "Resources", "lib", "vec0.dylib"))
    const missing = run(["preflight", app])
    expect(missing.code).not.toBe(0)
    expect(missing.output).toContain("vec0.dylib")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("preflight rejects an app without its Screen Recording purpose string", () => {
  const { root, app } = fixture()
  try {
    const info = join(app, "Contents", "Info.plist")
    const edit = Bun.spawnSync({
      cmd: ["plutil", "-remove", "NSScreenCaptureUsageDescription", info],
    })
    expect(edit.exitCode).toBe(0)
    const result = run(["preflight", app])
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("NSScreenCaptureUsageDescription")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("release refuses a missing Developer ID before changing the app or creating a ZIP", () => {
  const { root, app } = fixture()
  try {
    const output = join(root, "Side.zip")
    const result = run([
      "release",
      app,
      "Developer ID Application: Synthetic Team (SYNTHETIC)",
      "synthetic-profile",
      output,
    ])
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("Developer ID")
    expect(existsSync(output)).toBe(false)
    expect(readFileSync(join(app, "Contents", "MacOS", "Side"), "utf8")).toBe("synthetic code")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("synthetic Accepted notarization signs nested code first and staples before packaging", () => {
  const { root, app } = fixture()
  try {
    const bin = join(root, "bin")
    mkdirSync(bin)
    const log = join(root, "calls.log")
    const identity = "Developer ID Application: Synthetic Team (SYNTHETIC)"
    const fakeCommands: Record<string, string> = {
      bun: '#!/bin/sh\nprintf "REDISTRIBUTION: PASS synthetic\\n"',
      security: `#!/bin/sh\nprintf '  1) ABCDEF "${identity}"\\n     1 valid identities found\\n'`,
      codesign: '#!/bin/sh\nprintf "codesign %s\\n" "$*" >> "$SIDE_TEST_LOG"',
      xcrun:
        '#!/bin/sh\nprintf "xcrun %s\\n" "$*" >> "$SIDE_TEST_LOG"\nif [ "$1" = notarytool ]; then printf \'{"id":"synthetic-id","status":"Accepted"}\\n\'; fi',
      spctl:
        '#!/bin/sh\nprintf "spctl %s\\n" "$*" >> "$SIDE_TEST_LOG"\nprintf "Side.app: accepted\\nsource=Notarized Developer ID\\n"',
    }
    for (const [name, source] of Object.entries(fakeCommands)) {
      const path = join(bin, name)
      writeFileSync(path, source)
      chmodSync(path, 0o755)
    }
    const output = join(root, "Side.zip")
    const result = run(["release", app, identity, "synthetic-profile", output], {
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      SIDE_TEST_LOG: log,
    })
    expect(result.code).toBe(0)
    expect(existsSync(output)).toBe(true)
    expect(readFileSync(join(app, "Contents", "MacOS", "Side"), "utf8")).toBe("synthetic code")
    const calls = readFileSync(log, "utf8")
    expect(calls).toContain("--options runtime --timestamp")
    expect(calls).toContain("--entitlements")
    for (const name of ["libsqlite3.dylib", "vec0.dylib", "libonnxruntime.1.dylib", "/side"]) {
      expect(calls.indexOf(name)).toBeLessThan(calls.indexOf("--entitlements"))
    }
    expect(calls.indexOf("notarytool submit")).toBeLessThan(calls.indexOf("stapler staple"))
    expect(calls.indexOf("stapler staple")).toBeLessThan(calls.indexOf("stapler validate"))
    expect(calls).toContain("spctl -a -vv")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("synthetic Invalid notarization never staples or publishes a ZIP", () => {
  const { root, app } = fixture()
  try {
    const bin = join(root, "bin")
    mkdirSync(bin)
    const log = join(root, "calls.log")
    const identity = "Developer ID Application: Synthetic Team (SYNTHETIC)"
    for (const [name, source] of Object.entries({
      bun: '#!/bin/sh\nprintf "REDISTRIBUTION: PASS synthetic\\n"',
      security: `#!/bin/sh\nprintf '  1) ABCDEF "${identity}"\\n'`,
      codesign: "#!/bin/sh\nexit 0",
      xcrun:
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SIDE_TEST_LOG"\nif [ "$1" = notarytool ] && [ "$2" = submit ]; then printf \'{"id":"synthetic-id","status":"Invalid"}\\n\'; fi\nif [ "$1" = notarytool ] && [ "$2" = log ]; then printf \'{"issues":[{"message":"synthetic invalid diagnostic"}]}\n\'; fi',
    })) {
      const path = join(bin, name)
      writeFileSync(path, source)
      chmodSync(path, 0o755)
    }
    const output = join(root, "Side.zip")
    const result = run(["release", app, identity, "synthetic-profile", output], {
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      SIDE_TEST_LOG: log,
    })
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("Invalid")
    expect(result.output).toContain("synthetic invalid diagnostic")
    expect(result.output).toContain("redistribution artifact was not published")
    expect(existsSync(output)).toBe(false)
    expect(readFileSync(log, "utf8")).toContain("notarytool log synthetic-id")
    expect(readFileSync(log, "utf8")).not.toContain("stapler")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
