import { afterEach, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireDaemonLock, DaemonAlreadyRunningError } from "../../src/daemon/lock"

const roots: string[] = []

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "side-daemon-lock-"))
  roots.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test("Given one data-directory owner, duplicate execution fails until normal shutdown releases the lock", () => {
  const directory = root()
  const first = acquireDaemonLock(directory)
  expect(() => acquireDaemonLock(directory)).toThrow(DaemonAlreadyRunningError)
  expect(statSync(first.path).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(first.path, "utf8"))).toEqual({ pid: process.pid })
  first.release()
  expect(existsSync(first.path)).toBe(false)
  const restarted = acquireDaemonLock(directory)
  restarted.release()
})

test("Given a daemon killed without cleanup, its stale PID lock is reclaimed on restart", async () => {
  const directory = root()
  const module = join(process.cwd(), "src", "daemon", "lock.ts")
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      `import { acquireDaemonLock } from ${JSON.stringify(module)}; acquireDaemonLock(${JSON.stringify(directory)}); console.log("locked"); await Bun.sleep(60_000)`,
    ],
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = child.stdout.getReader()
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toBe("locked\n")
  child.kill("SIGKILL")
  await child.exited
  const restarted = acquireDaemonLock(directory)
  restarted.release()
}, 10_000)

test("Given a stale lock and a symlink, stale state is reclaimed but symlinks are never followed", () => {
  const directory = root()
  const path = join(directory, "daemon.lock")
  writeFileSync(path, JSON.stringify({ pid: 2_147_483_647 }), { mode: 0o600 })
  const stale = acquireDaemonLock(directory)
  stale.release()
  const target = join(directory, "target")
  writeFileSync(target, JSON.stringify({ pid: 2_147_483_647 }))
  symlinkSync(target, path)
  expect(() => acquireDaemonLock(directory)).toThrow()
  expect(readFileSync(target, "utf8")).toContain("2147483647")
})

test("Given a missing data directory, lock acquisition creates only private storage", () => {
  const directory = join(root(), "nested")
  mkdirSync(directory, { recursive: true })
  const lock = acquireDaemonLock(directory)
  expect(statSync(directory).mode & 0o777).toBe(0o700)
  lock.release()
})
