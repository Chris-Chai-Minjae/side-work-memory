import { copyFileSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { pipeline } from "@huggingface/transformers"
import { EMBEDDING_DIMENSIONS } from "../src/constants"
import { EMBEDDING_MODEL_ID } from "../src/memory/embed"
import { modelLock, verifyModelAssets } from "./gates/model-lock"

const cacheDir = process.argv[2]
if (!cacheDir) throw new TypeError("Expected model cache destination")
if (EMBEDDING_MODEL_ID !== modelLock.modelId)
  throw new Error("Runtime model ID and model lock differ")
mkdirSync(cacheDir, { recursive: true })
const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL_ID, {
  cache_dir: cacheDir,
  revision: modelLock.revision,
  device: "cpu",
  dtype: modelLock.dtype,
})
try {
  const vector = await extractor("Side bundle model check", { pooling: "mean", normalize: true })
  if (vector.data.length !== EMBEDDING_DIMENSIONS)
    throw new RangeError("Bundled model has wrong dimensions")
} finally {
  await extractor.dispose()
}
for (const asset of Object.keys(modelLock.assets)) {
  const destination = join(cacheDir, modelLock.modelId, asset)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(join(cacheDir, modelLock.modelId, modelLock.revision, asset), destination)
}
verifyModelAssets(cacheDir)
rmSync(join(cacheDir, modelLock.modelId, modelLock.revision), { recursive: true, force: true })
console.log(`Cached ${EMBEDDING_MODEL_ID}@${modelLock.revision} q8 in ${cacheDir}`)
