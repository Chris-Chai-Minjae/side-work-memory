import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { z } from "zod"

const packageVersion = z
  .object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/) })
  .parse(JSON.parse(readFileSync(resolve("package.json"), "utf8"))).version
const buildNumberText = process.env["SIDE_BUILD_NUMBER"] ?? "1"
if (!/^[1-9]\d*$/.test(buildNumberText))
  throw new Error("SIDE_BUILD_NUMBER must be a positive integer")
const buildNumber = Number(buildNumberText)
if (!Number.isSafeInteger(buildNumber)) throw new Error("SIDE_BUILD_NUMBER is too large")
const infoPath = resolve("apps/side-mac/Info.plist")
const constantPath = resolve("src/version.generated.ts")
const constant = `export const APP_VERSION = ${JSON.stringify(packageVersion)}\nexport const APP_BUILD_NUMBER = ${JSON.stringify(buildNumberText)}\n`

function plistValue(key: string): string {
  const result = spawnSync("plutil", ["-extract", key, "raw", "-o", "-", infoPath], {
    encoding: "utf8",
  })
  if (result.status !== 0) throw new Error(`Missing ${key}: ${result.stderr}`)
  return result.stdout.trim()
}

if (process.argv.includes("--check")) {
  const mismatches = [
    plistValue("CFBundleShortVersionString") !== packageVersion
      ? "Info.plist CFBundleShortVersionString"
      : null,
    plistValue("CFBundleVersion") !== buildNumberText ? "Info.plist CFBundleVersion" : null,
    readFileSync(constantPath, "utf8") !== constant ? "src/version.generated.ts" : null,
  ].filter(Boolean)
  if (mismatches.length) throw new Error(`Version is out of sync: ${mismatches.join(", ")}`)
} else {
  for (const [key, value] of [
    ["CFBundleShortVersionString", packageVersion],
    ["CFBundleVersion", buildNumberText],
  ] as const) {
    const updated = spawnSync("plutil", ["-replace", key, "-string", value, infoPath], {
      encoding: "utf8",
    })
    if (updated.status !== 0) throw new Error(updated.stderr)
  }
  writeFileSync(constantPath, constant)
  console.log(`Version ${packageVersion} (${buildNumberText})`)
}
