import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import packageJson from "../../package.json"
import { modelLock, sha256, verifyModelAssets } from "./model-lock"
import { inspectSqlite } from "./verify-sqlite"

const app = resolve(process.argv[2] ?? "apps/side-mac/.build/release/Side.app")
const resources = join(app, "Contents", "Resources")
const metadata = join(resources, "metadata")

function command(argv: readonly string[]): string {
  const executable = argv[0]
  if (!executable) throw new TypeError("Expected a command")
  const result = spawnSync(executable, [...argv.slice(1)], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`${argv.join(" ")} failed: ${result.stderr}`)
  return result.stdout.trim()
}

const commit = command(["git", "rev-parse", "HEAD"])
const dirty = spawnSync("git", ["diff", "--quiet", "HEAD"], { stdio: "ignore" }).status !== 0
const libraries = Object.fromEntries(
  ["libsqlite3.dylib", "vec0.dylib", "libonnxruntime.1.dylib"].map((name) => {
    const path = join(resources, "lib", name)
    return [
      name,
      {
        sha256: sha256(path),
        otool: command(["otool", "-L", path]).split("\n"),
        architecture: command(["lipo", "-info", path]),
      },
    ]
  }),
)
const sqlite = inspectSqlite(
  join(resources, "lib", "libsqlite3.dylib"),
  join(resources, "lib", "vec0.dylib"),
)
const modelHashes = verifyModelAssets(join(resources, "models"))
const manifest = {
  schemaVersion: 1,
  application: {
    name: packageJson.name,
    version: packageJson.version,
    buildNumber: process.env["SIDE_BUILD_NUMBER"] ?? "1",
  },
  source: { commit, dirty },
  toolchain: {
    bun: command(["bun", "--version"]),
    swift: command(["swift", "--version"]),
    macos: command(["sw_vers", "-productVersion"]),
    architecture: process.arch,
  },
  binaries: {
    daemon: sha256(join(resources, "side")),
  },
  libraries: { ...libraries, sqlite },
  model: { id: modelLock.modelId, revision: modelLock.revision, sha256: modelHashes },
  metadata: Object.fromEntries(
    ["THIRD_PARTY_NOTICES.txt", "sbom.json", "model-provenance.json", "version.json"].map(
      (name) => [name, sha256(join(metadata, name))],
    ),
  ),
}
writeFileSync(join(metadata, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`PASS build manifest ${commit}${dirty ? " (dirty source)" : ""}: ${metadata}`)
