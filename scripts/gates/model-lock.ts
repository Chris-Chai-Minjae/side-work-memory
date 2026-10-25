import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { z } from "zod"

export const ModelLockSchema = z.strictObject({
  schemaVersion: z.literal(1),
  modelId: z.string().min(1),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  dtype: z.literal("q8"),
  assets: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
})

export const modelLock = ModelLockSchema.parse(
  JSON.parse(readFileSync(resolve("apps/side-mac/model-lock.json"), "utf8")),
)

export function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

export function verifyModelAssets(cacheDirectory: string): Record<string, string> {
  if (modelLock.modelId !== "Xenova/paraphrase-multilingual-MiniLM-L12-v2")
    throw new Error("Model lock ID does not match the runtime model")
  const actual: Record<string, string> = {}
  for (const [asset, expected] of Object.entries(modelLock.assets)) {
    const path = join(cacheDirectory, modelLock.modelId, asset)
    const digest = sha256(path)
    actual[asset] = digest
    if (digest !== expected)
      throw new Error(
        `Model asset hash mismatch for ${asset}: expected ${expected}, received ${digest}`,
      )
  }
  return actual
}
