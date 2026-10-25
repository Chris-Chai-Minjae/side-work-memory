import { Database } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { getLoadablePath } from "sqlite-vec"
import { z } from "zod"
import { sha256 } from "./model-lock"

const SqliteLockSchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  requiredCompileOptions: z.array(z.string()).min(1),
  knownBinaries: z.record(
    z.string(),
    z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/), source: z.string() }),
  ),
})

export const sqliteLock = SqliteLockSchema.parse(
  JSON.parse(readFileSync(resolve("apps/side-mac/sqlite-lock.json"), "utf8")),
)

export function inspectSqlite(path: string, vec0Path = getLoadablePath()) {
  Database.setCustomSQLite(path)
  const db = new Database(":memory:")
  try {
    const version = db
      .query<{ version: string }, []>("SELECT sqlite_version() AS version")
      .get()?.version
    if (!version) throw new Error("Could not query SQLite version")
    const options = db
      .query<{ compile_options: string }, []>("PRAGMA compile_options")
      .all()
      .map((row) => row.compile_options)
    for (const option of sqliteLock.requiredCompileOptions) {
      if (!options.includes(option)) throw new Error(`SQLite is missing ${option}: ${path}`)
    }
    const fts = db
      .query<{ name: string }, []>("SELECT name FROM pragma_module_list WHERE name = 'fts5'")
      .get()
    if (!fts) throw new Error(`SQLite FTS5 module is unavailable: ${path}`)
    db.loadExtension(vec0Path)
    const vecVersion = db
      .query<{ version: string }, []>("SELECT vec_version() AS version")
      .get()?.version
    if (!vecVersion) throw new Error(`SQLite extension loading is unavailable: ${path}`)
    const linked = spawnSync("otool", ["-L", path], { encoding: "utf8" })
    if (linked.status !== 0) throw new Error(`otool failed for ${path}: ${linked.stderr}`)
    const architecture = spawnSync("lipo", ["-info", path], { encoding: "utf8" })
    if (architecture.status !== 0)
      throw new Error(`lipo failed for ${path}: ${architecture.stderr}`)
    const digest = sha256(path)
    const platform = `${process.platform}-${process.arch}`
    const locked = sqliteLock.knownBinaries[platform]?.sha256 === digest
    return {
      path,
      version,
      lockedVersion: sqliteLock.version,
      sha256: digest,
      platform,
      locked,
      compileOptions: options,
      vecVersion,
      otool: linked.stdout.trim().split("\n"),
      architecture: architecture.stdout.trim(),
    }
  } finally {
    db.close()
  }
}

if (import.meta.main) {
  const path = process.argv[2]
  if (!path) throw new TypeError("Expected SQLite dylib path")
  const result = inspectSqlite(resolve(path))
  const requireLocked =
    process.argv.includes("--require-locked") || process.env["SIDE_REQUIRE_LOCKED_SQLITE"] === "1"
  if (requireLocked && !result.locked)
    throw new Error(
      `SQLite ${result.sha256} is not locked for ${result.platform}; record a reviewed binary in sqlite-lock.json`,
    )
  if (!result.locked)
    console.warn(
      `WARNING: using compatible but unpinned SQLite ${result.version} (${result.sha256}); local build only, not redistribution reproducibility`,
    )
  console.log(JSON.stringify(result, null, 2))
}
