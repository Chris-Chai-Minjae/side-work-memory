import { z } from "zod"
import {
  HELPER_COMMAND_TIMEOUT_MS,
  HELPER_CONSECUTIVE_TIMEOUT_LIMIT,
  HELPER_MAX_LINE_BYTES,
} from "../constants"
import {
  type AppToDaemonMessage,
  AppToDaemonMessageSchema,
  type DaemonToAppMessage,
  type HelperHealth,
} from "../contracts/protocol"
import { HelperHealthMachine } from "./health"

type Command = Extract<DaemonToAppMessage, { type: "command" }>
type WithoutId<T> = T extends Command ? Omit<T, "id"> : never
export type HelperCommandRequest = WithoutId<Command>
type Observation = Extract<AppToDaemonMessage, { type: "event" }>["event"]
const RotationResultSchema = z.strictObject({ key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/) })
const KEYCHAIN_AUTHORIZATION_TIMEOUT_MS = 120_000

type Pending = {
  readonly resolve: (data: unknown) => void
  readonly reject: (error: Error) => void
  readonly cancelTimeout: () => void
}

type HelloWaiter = {
  readonly resolve: () => void
  readonly reject: (error: Error) => void
}

type HelperClientOptions = {
  readonly input: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>
  readonly output: { write(line: string): number | boolean | undefined | Promise<number> }
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => () => void
  readonly onEvent?: (event: Observation) => void | Promise<void>
  readonly onHealth?: (health: HelperHealth) => void | Promise<void>
  readonly onProtocolError?: (error: HelperProtocolError) => void
}

function realTimeout(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs)
  return () => clearTimeout(timer)
}

async function* readChunks(input: HelperClientOptions["input"]): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in input) {
    yield* input
    return
  }
  const reader = input.getReader()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      yield chunk.value
    }
  } finally {
    reader.releaseLock()
  }
}

export class HelperCommandTimeoutError extends Error {
  readonly name = "HelperCommandTimeoutError"
  constructor(readonly commandId: string) {
    super(`Helper command ${commandId} timed out`)
  }
}

export class HelperCommandFailureError extends Error {
  readonly name = "HelperCommandFailureError"
  constructor(
    readonly commandId: string,
    readonly reason: string,
  ) {
    super(`Helper command ${commandId} failed`)
  }
}

export class HelperProtocolError extends Error {
  readonly name = "HelperProtocolError"
}

export class HelperUnavailableError extends Error {
  readonly name = "HelperUnavailableError"
  constructor() {
    super("Helper is unavailable")
  }
}

export class HelperClient {
  readonly health = new HelperHealthMachine()
  private readonly options: HelperClientOptions
  private readonly pending = new Map<string, Pending>()
  private readonly helloWaiters: HelloWaiter[] = []
  private readonly lineParts: Uint8Array[] = []
  private lineBytes = 0
  private masterKey: Buffer | null = null
  private nextId = 0
  private consecutiveTimeouts = 0
  private started = false
  private stopped = false

  constructor(options: HelperClientOptions) {
    this.options = options
  }

  getMasterKey(): Buffer | null {
    return this.masterKey === null ? null : Buffer.from(this.masterKey)
  }

  replaceMasterKey(result: unknown): void {
    const parsed = RotationResultSchema.safeParse(result)
    if (!parsed.success) throw new HelperProtocolError("Invalid key rotation result")
    const replacement = Buffer.from(parsed.data.key, "base64")
    if (
      replacement.length !== 32 ||
      replacement.toString("base64") !== parsed.data.key ||
      this.masterKey === null ||
      replacement.equals(this.masterKey)
    ) {
      replacement.fill(0)
      throw new HelperProtocolError("Invalid key rotation result")
    }
    this.masterKey.fill(0)
    this.masterKey = replacement
  }

  discardMasterKey(): void {
    this.masterKey?.fill(0)
    this.masterKey = null
  }

  waitForHello(): Promise<void> {
    if (this.masterKey !== null) return Promise.resolve()
    if (this.stopped) return Promise.reject(new HelperUnavailableError())
    return new Promise((resolve, reject) => this.helloWaiters.push({ resolve, reject }))
  }

  sendCommand(request: HelperCommandRequest): Promise<unknown> {
    if (this.masterKey === null || this.stopped) return Promise.reject(new HelperUnavailableError())
    const id = String(++this.nextId)
    const line = JSON.stringify({ ...request, id })
    if (Buffer.byteLength(`${line}\n`, "utf8") > HELPER_MAX_LINE_BYTES) {
      return Promise.reject(new HelperProtocolError("Helper command exceeds the JSON-lines limit"))
    }
    return new Promise((resolve, reject) => {
      const schedule = this.options.scheduleTimeout ?? realTimeout
      const cancelTimeout = schedule(
        () => this.timeout(id),
        request.name === "keychain.authorize"
          ? KEYCHAIN_AUTHORIZATION_TIMEOUT_MS
          : HELPER_COMMAND_TIMEOUT_MS,
      )
      this.pending.set(id, { resolve, reject, cancelTimeout })
      try {
        const written = this.options.output.write(`${line}\n`)
        void Promise.resolve(written).catch((error: unknown) => {
          const pending = this.pending.get(id)
          if (!pending) return
          pending.cancelTimeout()
          this.pending.delete(id)
          pending.reject(error instanceof Error ? error : new HelperUnavailableError())
        })
      } catch (error) {
        cancelTimeout()
        this.pending.delete(id)
        throw error
      }
    })
  }

  async run(): Promise<void> {
    if (this.started) throw new HelperProtocolError("Helper client already started")
    this.started = true
    try {
      for await (const chunk of readChunks(this.options.input)) {
        await this.ingest(chunk)
        if (this.stopped) break
      }
      if (!this.stopped && this.lineBytes > 0) await this.processLine()
    } finally {
      this.close()
    }
  }

  close(): void {
    if (this.stopped) return
    this.stopped = true
    this.masterKey?.fill(0)
    this.masterKey = null
    this.health.disconnect()
    const error = new HelperUnavailableError()
    for (const waiter of this.helloWaiters.splice(0)) waiter.reject(error)
    for (const pending of this.pending.values()) {
      pending.cancelTimeout()
      pending.reject(error)
    }
    this.pending.clear()
    this.lineParts.length = 0
    this.lineBytes = 0
  }

  private timeout(id: string): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    pending.reject(new HelperCommandTimeoutError(id))
    this.consecutiveTimeouts++
    if (this.consecutiveTimeouts >= HELPER_CONSECUTIVE_TIMEOUT_LIMIT) {
      this.protocolError("Three consecutive helper command timeouts", true)
    }
  }

  private protocolError(message: string, notifyHelper: boolean): void {
    if (this.stopped) return
    const error = new HelperProtocolError(message)
    try {
      if (notifyHelper) {
        const frame = JSON.stringify({ type: "protocol-error", message })
        const written = this.options.output.write(`${frame}\n`)
        void Promise.resolve(written).catch(() => this.close())
      }
    } finally {
      this.close()
      this.options.onProtocolError?.(error)
    }
  }

  private async ingest(chunk: Uint8Array): Promise<void> {
    for (let offset = 0; offset < chunk.length; ) {
      const newline = chunk.indexOf(10, offset)
      const end = newline < 0 ? chunk.length : newline
      const part = chunk.subarray(offset, end)
      if (this.lineBytes + part.byteLength + (newline < 0 ? 0 : 1) > HELPER_MAX_LINE_BYTES) {
        this.protocolError("Helper frame exceeds the JSON-lines limit", true)
        return
      }
      this.lineParts.push(Buffer.from(part))
      this.lineBytes += part.byteLength
      if (newline < 0) return
      await this.processLine()
      if (this.stopped) return
      offset = newline + 1
    }
  }

  private async processLine(): Promise<void> {
    const line = Buffer.concat(this.lineParts, this.lineBytes)
    this.lineParts.length = 0
    this.lineBytes = 0
    let raw: unknown
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line))
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError) {
        this.protocolError("Invalid helper JSON-line", true)
        return
      }
      throw error
    }
    const parsed = AppToDaemonMessageSchema.safeParse(raw)
    if (!parsed.success) {
      this.protocolError("Invalid helper message", true)
      return
    }
    await this.handleMessage(parsed.data)
  }

  private async handleMessage(message: AppToDaemonMessage): Promise<void> {
    if (message.type !== "hello" && this.masterKey === null && message.type !== "protocol-error") {
      this.protocolError("Helper message arrived before hello", true)
      return
    }
    switch (message.type) {
      case "hello":
        if (this.masterKey !== null) {
          this.protocolError("Duplicate helper hello", true)
          return
        }
        this.masterKey = Buffer.from(message.key, "base64")
        for (const waiter of this.helloWaiters.splice(0)) waiter.resolve()
        return
      case "ping":
        await this.options.output.write(`${JSON.stringify({ type: "pong", id: message.id })}\n`)
        return
      case "health":
        this.health.update(message.health)
        await this.options.onHealth?.(message.health)
        return
      case "event":
        await this.options.onEvent?.(message.event)
        return
      case "result": {
        const pending = this.pending.get(message.id)
        if (!pending) return // A late result cannot settle a timed-out command.
        pending.cancelTimeout()
        this.pending.delete(message.id)
        this.consecutiveTimeouts = 0
        if (message.ok) pending.resolve(message.data)
        else pending.reject(new HelperCommandFailureError(message.id, message.error))
        return
      }
      case "protocol-error":
        this.protocolError("Helper reported a protocol error", false)
        return
      default:
        return message satisfies never
    }
  }
}
