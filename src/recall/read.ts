import type { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import { decodeTime } from "ulid"
import { z } from "zod"
import { neutralizePromptInjectionText } from "../comprehension/neutralize"
import {
  READ_CALL_BYTES,
  READ_DEFAULT_CONTEXT_LINES,
  READ_MAX_CONTEXT_LINES,
  RECALL_EPOCH_RETRY_LIMIT,
  UNTRUSTED_BOUNDARY_NONCE_BYTES,
} from "../constants"
import { deriveSubkey, open } from "../crypto/index"
import { readBlobContent } from "../ledger/frames"
import type { EventCandidate, SummaryCandidate } from "./terms"

const ReadRequestSchema = z.strictObject({
  id: z.string().regex(/^[es]:[0-9A-HJKMNP-TV-Z]{26}$/u),
  match: z.string().optional(),
  contextLines: z.number().int().min(0).max(READ_MAX_CONTEXT_LINES).optional(),
})

export type HistoryReadContext = {
  readonly db: Database
  readonly masterKey: Buffer
}
export type HistoryReadRequest = z.infer<typeof ReadRequestSchema>
export type HistoryReadResult = {
  readonly id: string
  readonly occurred_at: number
  readonly app: string
  readonly title: string
  readonly url: string | null
  readonly text: string
  readonly expired: boolean
}
type ReadDraft = Omit<HistoryReadResult, "text"> & { readonly content: string }
type EventRow = EventCandidate & {
  readonly source: string
  readonly kind: string
  readonly target: string
  readonly session_id: string | null
}
type SummaryRow = Pick<
  SummaryCandidate,
  "window_from" | "title" | "description" | "body" | "apps"
> & {
  readonly citations: string
}

export class HistoryReadInputError extends Error {
  readonly name = "HistoryReadInputError"
  constructor() {
    super("History read requires an e: or s: ULID and 0–100 context lines")
  }
}
export class HistoryReadEpochChangedError extends Error {
  readonly name = "HistoryReadEpochChangedError"
  constructor() {
    super("History changed during read")
  }
}

function readEpoch(db: Database): string {
  const row = db
    .query<{ value: string }, []>("SELECT value FROM side_meta WHERE key = 'deletion_epoch'")
    .get()
  return row?.value ?? "0"
}

function citingSummaries(db: Database, eventRef: string): readonly string[] {
  return db
    .query<{ id: string }, [string, string]>(`
      SELECT id FROM context_awareness_summaries AS summary
      WHERE status = 'done' AND (
        EXISTS (SELECT 1 FROM json_each(summary.source_ids) WHERE value = ?)
        OR EXISTS (SELECT 1 FROM json_each(summary.citations)
                   WHERE json_extract(value, '$.ref') = ?)
      )
      ORDER BY window_from DESC, id DESC
    `)
    .all(eventRef, eventRef)
    .map((row) => `s:${row.id}`)
}

function expiredDraft(db: Database, eventRef: string): ReadDraft {
  let occurredAt: number
  try {
    occurredAt = decodeTime(eventRef.slice(2))
  } catch {
    throw new HistoryReadInputError()
  }
  return {
    id: eventRef,
    occurred_at: occurredAt,
    app: "",
    title: "",
    url: null,
    expired: true,
    content: `Original event expired.\nCiting summaries: ${citingSummaries(db, eventRef).join(", ")}`,
  }
}

function contentWindow(body: string, match: string | undefined, contextLines: number): string {
  const lines = body.split("\n")
  const needle = match?.toLowerCase() ?? ""
  const center = Math.max(
    0,
    lines.findIndex((line) => line.toLowerCase().includes(needle)),
  )
  const start = Math.max(0, center - contextLines)
  const end = Math.min(lines.length, center + contextLines + 1)
  return `Content (lines ${start + 1}–${end}):\n${lines.slice(start, end).join("\n")}`
}

function eventDraft(context: HistoryReadContext, request: HistoryReadRequest): ReadDraft | null {
  const id = request.id.slice(2)
  const row = context.db
    .query<EventRow, [string]>(`
      SELECT id, occurred_at, source, kind, app_name, bundle_id, window_title,
        url, domain, target, payload, blob_id, session_id
      FROM context_awareness_events WHERE id = ?
    `)
    .get(id)
  if (!row) {
    const summaries = citingSummaries(context.db, request.id)
    return summaries.length === 0 ? null : expiredDraft(context.db, request.id)
  }
  const key = deriveSubkey(context.masterKey, "evidence")
  const aad = (column: string): string => `context_awareness_events:${column}:${id}`
  const title =
    row.window_title === "" ? "" : open<string>(row.window_title, key, aad("window_title"))
  const url = row.url === null ? null : open<string>(row.url, key, aad("url"))
  const target =
    row.target === "{}" ? "{}" : JSON.stringify(open<unknown>(row.target, key, aad("target")))
  const payload = JSON.stringify(open<unknown>(row.payload, key, aad("payload")))
  const body =
    row.blob_id === null ? "" : readBlobContent(context.db, context.masterKey, row.blob_id)
  if (body === null) return expiredDraft(context.db, request.id)
  return {
    id: request.id,
    occurred_at: row.occurred_at,
    app: row.app_name,
    title,
    url,
    expired: false,
    content: [
      `Reference: ${request.id}`,
      `Occurred at: ${row.occurred_at}`,
      `Source: ${row.source}`,
      `Kind: ${row.kind}`,
      `App: ${row.app_name}`,
      `Bundle ID: ${row.bundle_id}`,
      `Title: ${title}`,
      `URL: ${url ?? ""}`,
      `Domain: ${row.domain ?? ""}`,
      `Session ID: ${row.session_id ?? ""}`,
      contentWindow(body, request.match, request.contextLines ?? READ_DEFAULT_CONTEXT_LINES),
      `Target: ${target}`,
      `Payload: ${payload}`,
    ].join("\n"),
  }
}

function summaryDraft(context: HistoryReadContext, request: HistoryReadRequest): ReadDraft | null {
  const row = context.db
    .query<SummaryRow, [string]>(`
      SELECT window_from, title, description, body, apps, citations
      FROM context_awareness_summaries WHERE id = ?
    `)
    .get(request.id.slice(2))
  if (!row) return null
  const apps: unknown = JSON.parse(row.apps)
  const citations = z.array(z.object({ ref: z.string() })).parse(JSON.parse(row.citations))
  return {
    id: request.id,
    occurred_at: row.window_from,
    app: z.array(z.string()).parse(apps)[0] ?? "",
    title: row.title,
    url: null,
    expired: false,
    content: [
      `Title: ${row.title}`,
      `Description: ${row.description}`,
      `Citations: ${JSON.stringify(citations)}`,
      `Body: ${row.body ?? ""}`,
    ].join("\n"),
  }
}

const responseBytes = (result: HistoryReadResult): number =>
  Buffer.byteLength(JSON.stringify(result), "utf8")

function fitOuterField(result: HistoryReadResult, field: "app" | "title"): HistoryReadResult {
  const characters = Array.from(result[field])
  let low = 0
  let high = characters.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = { ...result, [field]: characters.slice(0, middle).join("") }
    if (responseBytes(candidate) <= READ_CALL_BYTES) low = middle
    else high = middle - 1
  }
  return { ...result, [field]: characters.slice(0, low).join("") }
}

function boundedResult(draft: ReadDraft): HistoryReadResult {
  const nonce = randomBytes(UNTRUSTED_BOUNDARY_NONCE_BYTES).toString("hex")
  const opening = `<untrusted-evidence nonce="${nonce}">`
  const closing = `</untrusted-evidence nonce="${nonce}">`
  const truncated = "…[truncated]"
  let result: HistoryReadResult = {
    id: draft.id,
    occurred_at: draft.occurred_at,
    app: neutralizePromptInjectionText(draft.app),
    title: neutralizePromptInjectionText(draft.title),
    url: draft.url,
    expired: draft.expired,
    text: `${opening}${truncated}${closing}`,
  }
  if (responseBytes(result) > READ_CALL_BYTES) result = { ...result, url: null }
  if (responseBytes(result) > READ_CALL_BYTES) result = fitOuterField(result, "title")
  if (responseBytes(result) > READ_CALL_BYTES) result = fitOuterField(result, "app")

  const characters: string[] = []
  let hasMore = false
  for (const character of neutralizePromptInjectionText(draft.content)) {
    if (characters.length === READ_CALL_BYTES) {
      hasMore = true
      break
    }
    characters.push(character)
  }
  const complete = `${opening}${characters.join("")}${closing}`
  if (!hasMore && responseBytes({ ...result, text: complete }) <= READ_CALL_BYTES) {
    return { ...result, text: complete }
  }
  let low = 0
  let high = characters.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const text = `${opening}${characters.slice(0, middle).join("")}${truncated}${closing}`
    if (responseBytes({ ...result, text }) <= READ_CALL_BYTES) low = middle
    else high = middle - 1
  }
  return { ...result, text: `${opening}${characters.slice(0, low).join("")}${truncated}${closing}` }
}

export function historyRead(
  context: HistoryReadContext,
  request: HistoryReadRequest,
): HistoryReadResult | null {
  const parsed = ReadRequestSchema.safeParse(request)
  if (!parsed.success) throw new HistoryReadInputError()
  if (parsed.data.id.startsWith("e:")) {
    try {
      decodeTime(parsed.data.id.slice(2))
    } catch {
      throw new HistoryReadInputError()
    }
  }
  for (let attempt = 0; attempt <= RECALL_EPOCH_RETRY_LIMIT; attempt++) {
    const started = readEpoch(context.db)
    const draft = parsed.data.id.startsWith("e:")
      ? eventDraft(context, parsed.data)
      : summaryDraft(context, parsed.data)
    if (started !== readEpoch(context.db)) continue
    return draft === null ? null : boundedResult(draft)
  }
  throw new HistoryReadEpochChangedError()
}
