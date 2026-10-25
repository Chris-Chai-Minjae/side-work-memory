import { expect, test } from "bun:test"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { HELPER_COMMAND_TIMEOUT_MS, HELPER_MAX_LINE_BYTES } from "../../src/constants"
import {
  HelperClient,
  HelperCommandFailureError,
  HelperCommandTimeoutError,
  HelperProtocolError,
} from "../../src/helper/client"
import { HelperHealthMachine } from "../../src/helper/health"
import { type Command, harness, health, hello, type ProtocolErrorFrame } from "./fixture"

test("Given a successful rotation result, when the helper key is replaced, then its previous buffer is zeroed", async () => {
  const { client, input, sent, running } = harness()
  await client.waitForHello()
  const oldKey = client["masterKey"]
  const reply = client.sendCommand({ type: "command", name: "keychain.rotate" })
  await Bun.sleep(0)
  const command = sent.find((frame): frame is Command => frame.type === "command")
  if (!command) throw new TypeError("Expected rotate command")
  input.write(
    `${JSON.stringify({ type: "result", id: command.id, ok: true, data: { key: Buffer.alloc(32, 9).toString("base64") } })}\n`,
  )
  client.replaceMasterKey(await reply)
  expect(client.getMasterKey()?.equals(Buffer.alloc(32, 9))).toBe(true)
  expect(oldKey?.equals(Buffer.alloc(32))).toBe(true)
  input.end()
  await running
})

test("Given malformed or reused rotation keys, when replacement is parsed, then the old key remains unavailable after fail closed discard", async () => {
  const { client, input, running } = harness()
  await client.waitForHello()
  for (const result of [
    null,
    { key: "invalid" },
    { key: hello.key },
    { key: Buffer.alloc(32, 9).toString("base64"), extra: true },
  ]) {
    expect(() => client.replaceMasterKey(result)).toThrow(HelperProtocolError)
  }
  const original = client["masterKey"]
  client.discardMasterKey()
  expect(original?.equals(Buffer.alloc(32))).toBe(true)
  expect(client.getMasterKey()).toBeNull()
  input.end()
  await running
})

test("Given health reports, when state changes or connection ends, then status and banner follow the capture rules", () => {
  const machine = new HelperHealthMachine()
  expect(machine.state).toBe("starting")
  expect(machine.banner({ screenOcrEnabled: false, automationUnavailable: false })).toBe("starting")

  machine.update(health)
  expect(machine.state).toBe("running")
  expect(machine.banner({ screenOcrEnabled: false, automationUnavailable: false })).toBeNull()
  expect(machine.banner({ screenOcrEnabled: true, automationUnavailable: true })).toBe(
    "some-unavailable",
  )
  machine.update({ ...health, accessibilityTrusted: false })
  expect(machine.banner({ screenOcrEnabled: false, automationUnavailable: false })).toBe(
    "permissions-needed",
  )
  machine.update({ ...health, state: "paused" })
  expect(machine.state).toBe("paused")
  machine.update({ ...health, nativeCaptureAvailable: false })
  expect(machine.banner({ screenOcrEnabled: false, automationUnavailable: false })).toBe(
    "not-running",
  )
  machine.disconnect()
  expect(machine.state).toBe("stopped")
  expect(machine.banner({ screenOcrEnabled: false, automationUnavailable: false })).toBe(
    "not-running",
  )
})

test("Given chunked helper frames, when hello, health and event arrive, then the key stays in memory and frames dispatch", async () => {
  const events: unknown[] = []
  const input = new PassThrough()
  const output = new PassThrough()
  const client = new HelperClient({
    input,
    output,
    onEvent: (event) => {
      events.push(event)
    },
  })
  const running = client.run()
  const lines = `${JSON.stringify(hello)}\n${JSON.stringify({ type: "health", health })}\n${JSON.stringify({ type: "event", event: { kind: "window.changed" } })}\n`
  input.write(Buffer.from(lines).subarray(0, 17))
  input.write(Buffer.from(lines).subarray(17))
  await client.waitForHello()
  input.end()
  await running
  expect(events).toEqual([{ kind: "window.changed" }])
  expect(client.health.state).toBe("stopped")
  expect(client.getMasterKey()).toBeNull()
  expect(process.argv.join(" ")).not.toContain(hello.key)
  expect(Object.values(process.env)).not.toContain(hello.key)
})

test("Given a post-hello ping, when it arrives, then only its matching pong is written immediately", async () => {
  const { client, input, sent, running } = harness()
  await client.waitForHello()
  const pending = client.sendCommand({ type: "command", name: "health" })
  input.write(`${JSON.stringify({ type: "ping", id: "native-42" })}\n`)
  await Bun.sleep(0)
  expect(sent).toContainEqual({ type: "pong", id: "native-42" })
  expect(client.health.state).toBe("starting")
  expect(client["pending"].size).toBe(1)
  input.end()
  await running
  await expect(pending).rejects.toThrow("Helper is unavailable")
})

test("Given a pre-hello ping, when it arrives, then the existing protocol error rule applies", async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const errors: HelperProtocolError[] = []
  const client = new HelperClient({ input, output, onProtocolError: (error) => errors.push(error) })
  const running = client.run()
  input.end(`${JSON.stringify({ type: "ping", id: "too-early" })}\n`)
  await running
  expect(errors).toHaveLength(1)
  expect(errors[0]?.message).toBe("Helper message arrived before hello")
})

test("Given two pending commands, when results arrive in reverse order, then each result matches its id", async () => {
  const { client, input, sent, running } = harness()
  await client.waitForHello()
  expect(client.getMasterKey()?.equals(Buffer.alloc(32, 7))).toBe(true)
  const first = client.sendCommand({ type: "command", name: "health" })
  const second = client.sendCommand({ type: "command", name: "permissions" })
  const commands = sent.filter((frame): frame is Command => frame.type === "command")
  expect(commands).toHaveLength(2)
  expect(commands[0]?.id).not.toBe(commands[1]?.id)
  input.write(
    `${JSON.stringify({ type: "result", id: commands[1]?.id, ok: true, data: "second" })}\n`,
  )
  input.write(
    `${JSON.stringify({ type: "result", id: commands[0]?.id, ok: true, data: "first" })}\n`,
  )
  expect(await Promise.all([first, second])).toEqual(["first", "second"])
  input.end()
  await running
})

test("Given 1000 fake-helper commands with 10% silence, when fake time advances, then replies correlate and silence times out", async () => {
  let received = 0
  const { client, clock, input, sent, errors, running } = harness((command, stream) => {
    received++
    if (received % 10 !== 0) {
      stream.write(
        `${JSON.stringify({ type: "result", id: command.id, ok: true, data: received })}\n`,
      )
    }
  })
  await client.waitForHello()
  let replies = 0
  let timeouts = 0
  for (let ordinal = 1; ordinal <= 1000; ordinal++) {
    const result = client
      .sendCommand({ type: "command", name: "health" })
      .catch((error: unknown) => error)
    if (ordinal % 10 === 0) clock.advanceBy(HELPER_COMMAND_TIMEOUT_MS)
    const value: unknown = await result
    if (ordinal % 10 === 0) {
      expect(value).toBeInstanceOf(HelperCommandTimeoutError)
      timeouts++
    } else {
      expect(value).toBe(ordinal)
      replies++
    }
  }
  expect({ received, replies, timeouts }).toEqual({ received: 1000, replies: 900, timeouts: 100 })
  expect(
    new Set(
      sent.filter((frame): frame is Command => frame.type === "command").map((frame) => frame.id),
    ).size,
  ).toBe(1000)
  expect(errors).toEqual([])
  input.end()
  await running
})

test("Given three consecutive timeouts, when fake time reaches each deadline, then one protocol-error is sent", async () => {
  const { client, clock, input, sent, errors, running } = harness()
  await client.waitForHello()
  for (let count = 0; count < 3; count++) {
    const result = client
      .sendCommand({ type: "command", name: "health" })
      .catch((error: unknown) => error)
    clock.advanceBy(HELPER_COMMAND_TIMEOUT_MS)
    expect(await result).toBeInstanceOf(HelperCommandTimeoutError)
  }
  const protocolErrors = sent.filter(
    (frame): frame is ProtocolErrorFrame => frame.type === "protocol-error",
  )
  expect(protocolErrors).toHaveLength(1)
  expect(protocolErrors[0]?.message).not.toContain(hello.key)
  expect(errors).toHaveLength(1)
  expect(client.health.state).toBe("stopped")
  input.end()
  await running
})

test("Given an oversized UTF-8 line, when received, then one protocol-error is emitted without echoing input", async () => {
  const { client, input, sent, running } = harness()
  await client.waitForHello()
  const huge = `{"type":"event","event":{"text":"${"한".repeat(Math.ceil(HELPER_MAX_LINE_BYTES / 3))}"}}`
  input.write(`${huge}\n`)
  input.end()
  await running
  const protocolErrors = sent.filter(
    (frame): frame is ProtocolErrorFrame => frame.type === "protocol-error",
  )
  expect(protocolErrors).toHaveLength(1)
  expect(protocolErrors[0]?.message).not.toContain("한")
  expect(client.getMasterKey()).toBeNull()
})

test("Given a failed result and a late timed-out result, when correlated, then only the matching pending command settles", async () => {
  const { client, clock, input, sent, running } = harness()
  await client.waitForHello()
  const expired = client
    .sendCommand({ type: "command", name: "health" })
    .catch((error: unknown) => error)
  clock.advanceBy(HELPER_COMMAND_TIMEOUT_MS)
  expect(await expired).toBeInstanceOf(HelperCommandTimeoutError)
  const commands = sent.filter((frame): frame is Command => frame.type === "command")
  input.write(
    `${JSON.stringify({ type: "result", id: commands[0]?.id, ok: true, data: "late" })}\n`,
  )
  const failed = client
    .sendCommand({ type: "command", name: "permissions" })
    .catch((error: unknown) => error)
  const next = sent.filter((frame): frame is Command => frame.type === "command")[1]
  if (!next) throw new TypeError("Expected a second command")
  input.write(
    `${JSON.stringify({ type: "result", id: next.id, ok: false, error: "private detail" })}\n`,
  )
  const error: unknown = await failed
  expect(error).toBeInstanceOf(HelperCommandFailureError)
  if (error instanceof HelperCommandFailureError) {
    expect(error.commandId).toBe(next.id)
    expect(error.reason).toBe("private detail")
    expect(error.message).not.toContain("private detail")
  }
  input.end()
  await running
})

test("Given a JSON-line at the four-megabyte limit, when LF is included, then the exact limit passes and one extra byte fails", async () => {
  const overhead = Buffer.byteLength(`${JSON.stringify({ type: "event", event: { text: "" } })}\n`)
  const payload = "x".repeat(HELPER_MAX_LINE_BYTES - overhead)
  const line = `${JSON.stringify({ type: "event", event: { text: payload } })}\n`
  expect(Buffer.byteLength(line)).toBe(HELPER_MAX_LINE_BYTES)

  const accepted = harness()
  await accepted.client.waitForHello()
  accepted.input.end(line)
  await accepted.running
  expect(accepted.errors).toEqual([])

  const rejected = harness()
  await rejected.client.waitForHello()
  const oversizedLine = `${JSON.stringify({ type: "event", event: { text: `${payload}x` } })}\n`
  expect(Buffer.byteLength(oversizedLine)).toBe(HELPER_MAX_LINE_BYTES + 1)
  rejected.input.end(oversizedLine)
  await rejected.running
  expect(rejected.errors).toHaveLength(1)
  expect(rejected.sent.filter((frame) => frame.type === "protocol-error")).toHaveLength(1)
})

test("Given an outgoing command at the four-megabyte limit, when sent, then LF counts toward the cap", async () => {
  const { client, clock, input, sent, running } = harness()
  await client.waitForHello()
  const base = JSON.stringify({
    type: "command",
    name: "keychain.set",
    args: { ref: "p", secret: "" },
    id: "1",
  })
  const allowed = "x".repeat(HELPER_MAX_LINE_BYTES - Buffer.byteLength(`${base}\n`))
  const accepted = client
    .sendCommand({ type: "command", name: "keychain.set", args: { ref: "p", secret: allowed } })
    .catch((error: unknown) => error)
  expect(sent.filter((frame) => frame.type === "command")).toHaveLength(1)
  clock.advanceBy(HELPER_COMMAND_TIMEOUT_MS)
  expect(await accepted).toBeInstanceOf(HelperCommandTimeoutError)
  const rejected = client.sendCommand({
    type: "command",
    name: "keychain.set",
    args: { ref: "p", secret: `${allowed}x` },
  })
  const rejection = rejected.catch((error: unknown) => error)
  clock.advanceBy(HELPER_COMMAND_TIMEOUT_MS)
  expect(await rejection).toBeInstanceOf(HelperProtocolError)
  expect(sent.filter((frame) => frame.type === "command")).toHaveLength(1)
  input.end()
  await running
})

test("Given malformed UTF-8 or an oversized outgoing command, when checked at the boundary, then no raw secret is echoed", async () => {
  const { client, input, sent, running } = harness()
  await client.waitForHello()
  const oversized = client.sendCommand({
    type: "command",
    name: "keychain.set",
    args: { ref: "provider/test", secret: "x".repeat(HELPER_MAX_LINE_BYTES) },
  })
  expect(await oversized.catch((error: unknown) => error)).toBeInstanceOf(HelperProtocolError)
  expect(sent).toEqual([])
  input.write(Buffer.from([0xff, 0x0a]))
  input.end()
  await running
  const protocolErrors = sent.filter(
    (frame): frame is ProtocolErrorFrame => frame.type === "protocol-error",
  )
  expect(protocolErrors).toHaveLength(1)
  expect(protocolErrors[0]?.message).not.toContain(hello.key)
})

test("Given the real fake-helper subprocess, when health is requested, then stdio JSON-lines work end to end", async () => {
  const argv = [process.execPath, join(import.meta.dir, "..", "mocks", "fake-helper.ts")]
  const child = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 5_000 })
  const client = new HelperClient({ input: child.stdout, output: child.stdin })
  const running = client.run()
  await client.waitForHello()
  expect(argv.join(" ")).not.toContain(hello.key)
  const response = await client.sendCommand({ type: "command", name: "health" })
  expect(response).toMatchObject({ platform: "darwin", state: "running" })
  child.stdin.end()
  await running
  expect(await child.exited).toBe(0)
})
