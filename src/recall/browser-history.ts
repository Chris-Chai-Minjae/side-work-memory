import { Database, SQLiteError } from "bun:sqlite"
import type { Dirent } from "node:fs"
import { chmodSync, copyFileSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { neutralizePromptInjectionText } from "../comprehension/neutralize"
import {
  MS_PER_DAY,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  RECALL_CANDIDATE_LIMIT,
  WEBKIT_EPOCH_OFFSET_MS,
} from "../constants"
import { type DenyRule, isDeniedApp, isDeniedHost } from "../policy/index"
import { normalizePageUrl } from "../policy/url"
import { redact } from "../redact/index"
import type { BrowserHistoryEntry } from "./search"

const browserRoots = [
  {
    browser: "chrome",
    app: "Chrome",
    bundleId: "com.google.Chrome",
    parts: ["Google", "Chrome"],
  },
  {
    browser: "arc",
    app: "Arc",
    bundleId: "company.thebrowser.Browser",
    parts: ["Arc", "User Data"],
  },
  {
    browser: "brave",
    app: "Brave",
    bundleId: "com.brave.Browser",
    parts: ["BraveSoftware", "Brave-Browser"],
  },
  {
    browser: "edge",
    app: "Microsoft Edge",
    bundleId: "com.microsoft.edgemac",
    parts: ["Microsoft Edge"],
  },
  {
    browser: "aside",
    app: "Aside",
    bundleId: "at.studio.AsideBrowser",
    parts: ["Aside"],
  },
  {
    browser: "aside",
    app: "Aside",
    bundleId: "at.studio.AsideBrowser",
    parts: ["Aside", "User Data"],
  },
] as const

const visitSchema = z.strictObject({
  id: z.number().int().nonnegative(),
  occurredAt: z.number().int(),
  url: z.string(),
  title: z.string(),
})

export const BROWSER_HISTORY_UNAVAILABLE_MESSAGE =
  "Browsing history is unavailable because no supported browser profile was found."

export type BrowserHistoryOptions = {
  readonly applicationSupportPath: string
  readonly temporaryRoot?: string
  readonly settings: {
    readonly rules: readonly DenyRule[]
    readonly retentionDays: number
    readonly browserHistoryEnabled: boolean
  }
  readonly now?: () => number
}

export type BrowserHistoryRequest = {
  readonly terms: readonly string[]
  readonly from?: number
  readonly to?: number
}

type Profile = {
  readonly browser: string
  readonly app: string
  readonly key: string
  readonly historyPath: string
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true
  } catch (error) {
    if (isUnavailableFile(error)) return false
    throw error
  }
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false })?.isFile() === true
  } catch (error) {
    if (isUnavailableFile(error)) return false
    throw error
  }
}

function profiles(options: BrowserHistoryOptions): readonly Profile[] {
  if (!isDirectory(options.applicationSupportPath)) return []
  const found: Profile[] = []
  for (const root of browserRoots) {
    if (isDeniedApp(root.bundleId, options.settings.rules)) continue
    let parent = options.applicationSupportPath
    for (const part of root.parts) {
      parent = join(parent, part)
      if (!isDirectory(parent)) break
    }
    if (!isDirectory(parent)) continue
    let entries: readonly Dirent[]
    try {
      entries = readdirSync(parent, { withFileTypes: true })
    } catch (error) {
      if (isUnavailableFile(error)) continue
      throw error
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^(Default|Profile [1-9]\d*)$/.test(entry.name)) continue
      const profilePath = join(parent, entry.name)
      const historyPath = join(profilePath, "History")
      if (isDirectory(profilePath) && isFile(historyPath))
        found.push({
          browser: root.browser,
          app: root.app,
          key: encodeURIComponent([...root.parts, entry.name].join("/")),
          historyPath,
        })
    }
  }
  return found
}

export function browserHistoryStatus(
  options: BrowserHistoryOptions,
): { readonly available: true } | { readonly available: false; readonly message: string } {
  return profiles(options).length > 0
    ? { available: true }
    : { available: false, message: BROWSER_HISTORY_UNAVAILABLE_MESSAGE }
}

function copyHistory(profile: Profile, destination: string): void {
  for (const suffix of ["", "-wal", "-shm"] as const) {
    const source = `${profile.historyPath}${suffix}`
    if (!isFile(source)) continue
    const target = join(destination, `History${suffix}`)
    copyFileSync(source, target)
    chmodSync(target, PRIVATE_FILE_MODE)
  }
}

function isUnavailableFile(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false
  return error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM"
}

function readProfile(
  profile: Profile,
  options: BrowserHistoryOptions,
  request: BrowserHistoryRequest,
): readonly BrowserHistoryEntry[] {
  const destination = mkdtempSync(join(options.temporaryRoot ?? tmpdir(), "side-browser-history-"))
  try {
    chmodSync(destination, PRIVATE_DIRECTORY_MODE)
    copyHistory(profile, destination)
    const db = new Database(join(destination, "History"), { readonly: true })
    try {
      const cutoff = (options.now?.() ?? Date.now()) - options.settings.retentionDays * MS_PER_DAY
      const from = Math.max(cutoff, request.from ?? cutoff)
      const conditions = request.terms.map(
        () => "(lower(u.title) LIKE ? ESCAPE '\\' OR lower(u.url) LIKE ? ESCAPE '\\')",
      )
      const sql = `
        SELECT v.id, CAST(v.visit_time / 1000 AS INTEGER) - ${WEBKIT_EPOCH_OFFSET_MS} AS occurredAt,
          u.url, u.title
        FROM visits AS v JOIN urls AS u ON u.id = v.url
        WHERE CAST(v.visit_time / 1000 AS INTEGER) - ${WEBKIT_EPOCH_OFFSET_MS} >= ?
          ${request.to === undefined ? "" : `AND CAST(v.visit_time / 1000 AS INTEGER) - ${WEBKIT_EPOCH_OFFSET_MS} <= ?`}
          AND (${conditions.join(" OR ")})
        ORDER BY v.visit_time DESC LIMIT ${RECALL_CANDIDATE_LIMIT}
      `
      const patterns = request.terms.flatMap((term) => {
        const pattern = `%${term.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`
        return [pattern, pattern]
      })
      const values =
        request.to === undefined ? [from, ...patterns] : [from, request.to, ...patterns]
      const rows = db.query<z.infer<typeof visitSchema>, (number | string)[]>(sql).all(...values)
      return rows.flatMap((raw) => {
        const parsed = visitSchema.safeParse(raw)
        if (!parsed.success) return []
        const row = parsed.data
        const normalizedUrl = normalizePageUrl(row.url)
        if (normalizedUrl === null) return []
        const domain = new URL(normalizedUrl).hostname.toLowerCase()
        if (isDeniedHost(domain, options.settings.rules)) return []
        const url = redact(normalizedUrl).text
        return [
          {
            browser: profile.browser,
            id: `${profile.key}-${row.id}`,
            occurredAt: row.occurredAt,
            app: profile.app,
            title: neutralizePromptInjectionText(redact(row.title).text),
            url,
            domain,
          },
        ]
      })
    } finally {
      db.close()
    }
  } finally {
    rmSync(destination, { recursive: true, force: true })
  }
}

export function createBrowserHistoryProvider(
  options: BrowserHistoryOptions,
): (request: BrowserHistoryRequest) => Promise<readonly BrowserHistoryEntry[]> {
  return async (request) => {
    if (!options.settings.browserHistoryEnabled || request.terms.length === 0) return []
    const rows: BrowserHistoryEntry[] = []
    for (const profile of profiles(options)) {
      try {
        rows.push(...readProfile(profile, options, request))
      } catch (error) {
        if (!(error instanceof SQLiteError) && !isUnavailableFile(error)) throw error
      }
    }
    return rows
  }
}
