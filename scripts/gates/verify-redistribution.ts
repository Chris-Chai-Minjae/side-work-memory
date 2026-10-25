import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import packageJson from "../../package.json"
import { assertRedistributionLicenses } from "./license-policy"
import { verifyModelAssets } from "./model-lock"
import { inspectSqlite } from "./verify-sqlite"

const app = resolve(process.argv[2] ?? "apps/side-mac/.build/release/Side.app")
const resources = join(app, "Contents", "Resources")
const metadata = join(resources, "metadata")
const required = [
  "THIRD_PARTY_NOTICES.txt",
  "sbom.json",
  "model-provenance.json",
  "build-manifest.json",
  "version.json",
]
for (const name of required) {
  if (!readFileSync(join(metadata, name), "utf8").trim())
    throw new Error(`Empty redistribution metadata: ${name}`)
}
const sbom = JSON.parse(readFileSync(join(metadata, "sbom.json"), "utf8"))
assertRedistributionLicenses(sbom.components ?? [])
const provenance = JSON.parse(readFileSync(join(metadata, "model-provenance.json"), "utf8"))
verifyModelAssets(join(resources, "models"))
if (!provenance.revision || !provenance.sourceUrl || !provenance.license)
  throw new Error("Model provenance is incomplete")
const sqlite = inspectSqlite(
  join(resources, "lib", "libsqlite3.dylib"),
  join(resources, "lib", "vec0.dylib"),
)
const sourceVerdict = JSON.parse(readFileSync(join(metadata, "sqlite-lock-verdict.json"), "utf8"))
if (!sourceVerdict.inspected.locked || sourceVerdict.inspected.version !== sqlite.lockedVersion)
  throw new Error("REDISTRIBUTION FAIL: the selected build-time SQLite binary was not locked")
const manifest = JSON.parse(readFileSync(join(metadata, "build-manifest.json"), "utf8"))
if (manifest.libraries.sqlite.sha256 !== sqlite.sha256)
  throw new Error("Bundled SQLite differs from the signed build manifest")
if (manifest.application.version !== packageJson.version)
  throw new Error("Build manifest version differs from package.json")
const version = JSON.parse(readFileSync(join(metadata, "version.json"), "utf8"))
const plistVersion = spawnSync(
  "plutil",
  ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(app, "Contents", "Info.plist")],
  { encoding: "utf8" },
)
if (plistVersion.status !== 0 || plistVersion.stdout.trim() !== packageJson.version)
  throw new Error("Info.plist version differs from package.json")
if (version.version !== packageJson.version)
  throw new Error("version.json differs from package.json")
for (const binary of [
  join(app, "Contents", "MacOS", "Side"),
  join(resources, "side"),
  join(resources, "lib", "libsqlite3.dylib"),
  join(resources, "lib", "vec0.dylib"),
  join(resources, "lib", "libonnxruntime.1.dylib"),
]) {
  const result = spawnSync("otool", ["-L", binary], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`otool failed: ${binary}`)
  const dependencies = result.stdout.split("\n").slice(1).join("\n")
  if (/\/(?:opt\/homebrew|usr\/local|Users)\//.test(dependencies))
    throw new Error(`Redistribution contains a build-host dylib path: ${binary}`)
  if (/LGPL|libav|libvips/i.test(dependencies))
    throw new Error(`Redistribution contains a library requiring license review: ${binary}`)
}
console.log(`REDISTRIBUTION: PASS ${app}`)
