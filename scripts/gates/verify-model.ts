import { modelLock, verifyModelAssets } from "./model-lock"

const cacheDirectory = process.argv[2]
if (!cacheDirectory) throw new TypeError("Expected model cache destination")
verifyModelAssets(cacheDirectory)
console.log(`PASS model ${modelLock.modelId}@${modelLock.revision} SHA-256`)
