import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "../constants"

export class DaemonAlreadyRunningError extends Error {
  readonly name = "DaemonAlreadyRunningError"
  readonly code = "DAEMON_ALREADY_RUNNING"

  constructor(readonly pid: number) {
    super(`Side daemon is already running with PID ${pid}`)
  }
}

export type DaemonLock = {
  readonly path: string
  readonly release: () => void
}

type LockOwner = {
  readonly dev: number
  readonly ino: number
  readonly pid: number
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
  }
}

function readOwner(path: string): LockOwner {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 4_096) throw new Error("Invalid daemon lock file")
    const raw: unknown = JSON.parse(readFileSync(fd, "utf8"))
    if (
      raw === null ||
      typeof raw !== "object" ||
      !("pid" in raw) ||
      typeof raw.pid !== "number" ||
      !Number.isSafeInteger(raw.pid) ||
      raw.pid <= 0
    )
      throw new Error("Invalid daemon lock owner")
    return { dev: stat.dev, ino: stat.ino, pid: raw.pid }
  } finally {
    closeSync(fd)
  }
}

function removeIfOwner(path: string, owner: LockOwner): boolean {
  const current = lstatSync(path)
  if (!current.isFile() || current.dev !== owner.dev || current.ino !== owner.ino) return false
  unlinkSync(path)
  return true
}

export function acquireDaemonLock(directory: string): DaemonLock {
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  chmodSync(directory, PRIVATE_DIRECTORY_MODE)
  const path = join(directory, "daemon.lock")
  for (let attempt = 0; attempt < 4; attempt++) {
    let fd: number
    try {
      fd = openSync(
        path,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      )
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
      const owner = readOwner(path)
      if (processExists(owner.pid)) throw new DaemonAlreadyRunningError(owner.pid)
      removeIfOwner(path, owner)
      continue
    }
    try {
      chmodSync(path, PRIVATE_FILE_MODE)
      writeFileSync(fd, JSON.stringify({ pid: process.pid }))
      fsyncSync(fd)
      const stat = fstatSync(fd)
      const owner = { dev: stat.dev, ino: stat.ino, pid: process.pid }
      let released = false
      return {
        path,
        release() {
          if (released) return
          released = true
          closeSync(fd)
          try {
            removeIfOwner(path, owner)
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
          }
        },
      }
    } catch (error) {
      closeSync(fd)
      try {
        unlinkSync(path)
      } catch {}
      throw error
    }
  }
  throw new Error("Daemon lock ownership changed repeatedly")
}
