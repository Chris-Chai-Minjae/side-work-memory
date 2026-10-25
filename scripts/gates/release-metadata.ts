import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import packageJson from "../../package.json"
import { modelLock, verifyModelAssets } from "./model-lock"
import { inspectSqlite, sqliteLock } from "./verify-sqlite"

const app = resolve(process.argv[2] ?? "apps/side-mac/.build/release/Side.app")
const resources = join(app, "Contents", "Resources")
const metadata = join(resources, "metadata")
const packageNames = new Set<string>()
const roots = new Set([...Object.keys(packageJson.dependencies), "onnxruntime-node"])
const pending = [...roots]
while (pending.length) {
  const name = pending.pop()
  if (!name || packageNames.has(name) || name === "sharp" || name === "onnxruntime-web") continue
  if (name.startsWith("@img/")) continue
  const manifestPath = resolve("node_modules", name, "package.json")
  if (!existsSync(manifestPath)) {
    if (roots.has(name)) throw new Error(`Missing dependency manifest: ${name}`)
    continue
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  const supported = (values: unknown, current: string) =>
    !Array.isArray(values) || values.includes(current)
  if (!supported(manifest.os, process.platform) || !supported(manifest.cpu, process.arch)) continue
  packageNames.add(name)
  pending.push(
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  )
}

type Component = {
  type: "library"
  name: string
  version: string
  licenses: { license: { id?: string; name?: string } }[]
  purl: string
}

const components: Component[] = []
const MIT_NOTICE = `MIT License

Copyright (c) the respective package authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`
const notices = [
  "Side third-party notices",
  "This file contains notices for dependencies distributed in Side.app.",
  "",
  readFileSync(resolve("LICENSE"), "utf8"),
]

for (const name of [...packageNames].sort()) {
  const directory = resolve("node_modules", name)
  const manifestPath = join(directory, "package.json")
  if (!existsSync(manifestPath)) throw new Error(`Missing dependency manifest: ${name}`)
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  const license = typeof manifest.license === "string" ? manifest.license : "UNLICENSED"
  if (/LGPL/i.test(license))
    throw new Error(`LGPL dependency requires a separate compliance review: ${name}`)
  const version = String(manifest.version)
  components.push({
    type: "library",
    name,
    version,
    licenses: [{ license: license === "MIT OR Apache" ? { name: license } : { id: license } }],
    purl: `pkg:npm/${name.replace("/", "%2f")}@${version}`,
  })
  notices.push("", `--- ${name}@${version} (${license}) ---`, "")
  const licenseFile = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE"]
    .map((candidate) => join(directory, candidate))
    .find(existsSync)
  notices.push(
    licenseFile
      ? readFileSync(licenseFile, "utf8")
      : /MIT/.test(license)
        ? MIT_NOTICE
        : `License declared by package.json: ${license}. No separate license file was shipped by the package.`,
  )
}

const sqlite = inspectSqlite(
  process.env["SIDE_SQLITE_SOURCE"] ?? join(resources, "lib", "libsqlite3.dylib"),
  join(resources, "lib", "vec0.dylib"),
)
components.push({
  type: "library",
  name: "sqlite",
  version: sqlite.version,
  licenses: [{ license: { name: "SQLite Blessing (public domain)" } }],
  purl: `pkg:generic/sqlite@${sqlite.version}`,
})
notices.push(
  "",
  `--- sqlite@${sqlite.version} (public-domain blessing) ---`,
  "",
  "The author disclaims copyright to this source code. In place of a legal notice, here is a blessing: May you do good and not evil. May you find forgiveness for yourself and forgive others. May you share freely, never taking more than you give.",
)
writeFileSync(join(metadata, "THIRD_PARTY_NOTICES.txt"), notices.join("\n"))
writeFileSync(
  join(metadata, "sbom.json"),
  `${JSON.stringify(
    {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      metadata: {
        component: { type: "application", name: packageJson.name, version: packageJson.version },
      },
      components,
    },
    null,
    2,
  )}\n`,
)
const modelHashes = verifyModelAssets(join(resources, "models"))
writeFileSync(
  join(metadata, "model-provenance.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      modelId: modelLock.modelId,
      revision: modelLock.revision,
      sourceUrl: `https://huggingface.co/${modelLock.modelId}/tree/${modelLock.revision}`,
      baseModel: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
      license: "Apache-2.0",
      dtype: modelLock.dtype,
      sha256: modelHashes,
    },
    null,
    2,
  )}\n`,
)
writeFileSync(
  join(metadata, "version.json"),
  `${JSON.stringify({ version: packageJson.version, buildNumber: process.env["SIDE_BUILD_NUMBER"] ?? "1" })}\n`,
)
writeFileSync(
  join(metadata, "sqlite-lock-verdict.json"),
  `${JSON.stringify({ lock: sqliteLock, inspected: sqlite }, null, 2)}\n`,
)
console.log(`PASS notices, SBOM, and model provenance: ${metadata}`)
