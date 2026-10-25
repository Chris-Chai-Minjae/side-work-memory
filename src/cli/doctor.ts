import { readdirSync } from "node:fs"
import { dataDirectory } from "../config/index"
import type { RpcMethodName } from "../contracts/rpc"
import { DaemonDiagnosticsSchema } from "../contracts/rpc-resources"
import { modelCacheDirectory } from "../memory/embed"
import { openIndexDb } from "../memory/index-db"
import { configureSqlite } from "../memory/sqlite"

type DoctorEnvironment = {
  readonly rpc: (method: RpcMethodName, params: unknown) => Promise<unknown>
  readonly write: (line: string) => void
  readonly checkCustomSqlite?: () => boolean
  readonly checkVec0?: () => boolean
  readonly checkModelCache?: () => boolean
}

type DoctorResult = "PASS" | "FAIL" | "SKIP" | "WARN"

function checkCustomSqlite(): boolean {
  try {
    configureSqlite()
    return true
  } catch {
    return false
  }
}

function checkVec0(): boolean {
  try {
    const db = openIndexDb(":memory:")
    try {
      return db.query("SELECT vec_version() AS version").get() !== null
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}

function checkModelCache(): boolean {
  try {
    const entries = readdirSync(modelCacheDirectory(dataDirectory()), {
      recursive: true,
      encoding: "utf8",
    })
    return (
      entries.some((entry) => entry.endsWith(".onnx")) &&
      entries.some((entry) => entry.endsWith("tokenizer.json"))
    )
  } catch {
    return false
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export async function runDoctor(environment: DoctorEnvironment): Promise<number> {
  let failed = false
  const report = (status: DoctorResult, check: string, detail: string): void => {
    if (status === "FAIL") failed = true
    environment.write(`${status} ${check}: ${detail}`)
  }

  let status: Record<string, unknown> | null = null
  let settings: Record<string, unknown> | null = null
  let permissions: Record<string, unknown> | null = null
  try {
    status = asRecord(await environment.rpc("status", undefined))
    settings = asRecord(await environment.rpc("settings.get", undefined))
    permissions = asRecord(await environment.rpc("permissions", undefined))
  } catch {
    // no-excuse-ok: catch -- doctor reports daemon absence without leaking RPC internals.
  }

  const health = asRecord(status?.["health"])
  report(
    health &&
      typeof health["pid"] === "number" &&
      health["pid"] > 0 &&
      status?.["stop_reason"] !== "keychain-locked"
      ? "PASS"
      : "FAIL",
    "Keychain",
    "Unlock this Mac and restart Side.app if the helper handshake is unavailable",
  )
  const diagnosticsResult = DaemonDiagnosticsSchema.safeParse(status?.["diagnostics"])
  if (!diagnosticsResult.success) {
    report("SKIP", "daemon diagnostics", "No diagnostic metadata is available")
  } else {
    const diagnostics = diagnosticsResult.data
    const lastCapture =
      diagnostics.last_successful_capture_at === null
        ? "never"
        : new Date(diagnostics.last_successful_capture_at).toISOString()
    const lastError = diagnostics.last_error
    report(
      lastError === null ? "PASS" : "WARN",
      "daemon diagnostics",
      lastError === null
        ? `No recorded error; last successful capture ${lastCapture}`
        : `${lastError.name}${lastError.code === null ? "" : `/${lastError.code}`} at ${lastError.stage} ${new Date(lastError.timestamp).toISOString()}; consecutive ${lastError.consecutive_count}; last successful capture ${lastCapture}`,
    )
  }
  const requiredPermissions =
    permissions?.["accessibility"] === true &&
    permissions?.["input_monitoring"] === true &&
    (settings?.["screen_ocr"] !== true || permissions?.["screen_recording"] === true)
  report(
    requiredPermissions ? "PASS" : "FAIL",
    "permissions",
    "Grant Accessibility and Input Monitoring in System Settings; Screen Recording is required when OCR is enabled",
  )

  const sqlite = (environment.checkCustomSqlite ?? checkCustomSqlite)()
  report(
    sqlite ? "PASS" : "FAIL",
    "custom SQLite",
    "Install or bundle libsqlite3.dylib with extension loading support",
  )
  const vec0 = sqlite && (environment.checkVec0 ?? checkVec0)()
  report(vec0 ? "PASS" : "FAIL", "vec0", "Bundle or install sqlite-vec for the custom SQLite")
  const modelCache = (environment.checkModelCache ?? checkModelCache)()
  report(
    modelCache ? "PASS" : "FAIL",
    "model cache",
    "Run Side memory search once to cache the multilingual MiniLM model",
  )

  const providers = settings?.["providers"]
  const selected = asRecord(settings?.["summary_model"]) ?? asRecord(settings?.["default_model"])
  const selectedId = selected?.["provider"]
  const selectedModelId = selected?.["modelId"]
  if (!Array.isArray(providers)) {
    report("FAIL", "provider connection", "Start Side.app to inspect configured providers")
  } else if (providers.length === 0 || typeof selectedId !== "string") {
    report("SKIP", "provider connection", "No summary provider is configured")
  } else {
    let selectedPassed = false
    let selectedFound = false
    let selectedKind = "openai-compatible"
    for (const item of providers) {
      const provider = asRecord(item)
      const id = provider?.["id"]
      if (typeof id !== "string") continue
      const kind = typeof provider?.["kind"] === "string" ? provider["kind"] : "openai-compatible"
      const isSelected = id === selectedId
      if (isSelected) {
        selectedFound = true
        selectedKind = kind
      }
      const modelId = isSelected
        ? selectedModelId
        : Array.isArray(provider?.["models"])
          ? provider["models"][0]
          : undefined
      if (typeof modelId !== "string") {
        if (!isSelected) report("SKIP", `provider ${id} (${kind})`, "Model ID not set")
        continue
      }
      const isCli = kind === "claude-code-cli" || kind === "codex-cli"
      if (!isCli && provider?.["has_key"] !== true) {
        report("SKIP", `provider ${id} (${kind})`, "API key not set")
        continue
      }
      try {
        const result = asRecord(
          await environment.rpc("providers.test", { providerId: id, modelId }),
        )
        if (isSelected) selectedPassed = result?.["ok"] === true
        else if (result?.["ok"] !== true)
          report("WARN", `provider ${id} (${kind})`, "Synthetic connection failed")
      } catch {
        if (!isSelected) report("WARN", `provider ${id} (${kind})`, "Synthetic connection failed")
      }
    }
    report(
      selectedFound && selectedPassed ? "PASS" : "FAIL",
      "provider connection",
      `${selectedId} (${selectedKind}); synthetic probe without user evidence`,
    )
  }
  return failed ? 1 : 0
}
