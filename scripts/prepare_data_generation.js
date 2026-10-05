import { createHash } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import fs from 'fs-extra'
import { createGenerationPointer, generationKey } from '../src/data-generation.js'
import {
  ASSET_INDEX_KEY,
  ASSET_STATE_KEY,
  CATALOG_KEY,
  EMBEDDINGS_BIN_KEY,
  EMBEDDINGS_FINGERPRINTS_KEY,
  EMBEDDINGS_INDEX_KEY,
  EMBEDDINGS_MANIFEST_KEY,
  LOCAL_RANKINGS_DIR,
  RANKINGS_KEY,
} from '../src/object-keys.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const GENERATION_STAGE_DIR = '.generation-stage'
export const GENERATION_MANIFEST_KEY = 'generation-manifest.json'

const FILES = [
  [CATALOG_KEY, CATALOG_KEY],
  [RANKINGS_KEY, path.join(LOCAL_RANKINGS_DIR, RANKINGS_KEY)],
  [ASSET_INDEX_KEY, ASSET_INDEX_KEY],
  [ASSET_STATE_KEY, ASSET_STATE_KEY],
  [EMBEDDINGS_BIN_KEY, EMBEDDINGS_BIN_KEY],
  [EMBEDDINGS_INDEX_KEY, EMBEDDINGS_INDEX_KEY],
  [EMBEDDINGS_FINGERPRINTS_KEY, EMBEDDINGS_FINGERPRINTS_KEY],
  [EMBEDDINGS_MANIFEST_KEY, EMBEDDINGS_MANIFEST_KEY],
]

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

export function prepareDataGeneration({
  root = ROOT,
  generationId = process.env.GENERATION_ID,
  commit = process.env.GITHUB_SHA,
  publishedAt = new Date().toISOString(),
} = {}) {
  const pointer = createGenerationPointer(generationId, commit, publishedAt)
  const stage = path.resolve(root, GENERATION_STAGE_DIR)
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(stage, { recursive: true })

  const missing = FILES.filter(([, local]) => !fs.existsSync(path.resolve(root, local)))
  const vectorMissing = missing.filter(([key]) => key.startsWith('embeddings'))
  const requiredMissing = missing.filter(([key]) => !key.startsWith('embeddings'))
  if (requiredMissing.length > 0)
    throw new Error(`Generation is missing required documents: ${requiredMissing.map(([key]) => key).join(', ')}`)
  if (vectorMissing.length > 0 && vectorMissing.length !== 4)
    throw new Error(`Generation has a partial vector set: ${vectorMissing.map(([key]) => key).join(', ')}`)

  const files = {}
  for (const [logicalKey, local] of FILES) {
    const source = path.resolve(root, local)
    if (!fs.existsSync(source))
      continue
    const target = path.resolve(stage, logicalKey)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
    const bytes = fs.readFileSync(source)
    files[logicalKey] = {
      bytes: bytes.byteLength,
      sha256: digest(bytes),
      object_key: generationKey(pointer.id, logicalKey),
    }
  }

  const manifest = {
    schema: 1,
    generation: pointer,
    files,
  }
  fs.writeJsonSync(path.resolve(stage, GENERATION_MANIFEST_KEY), manifest, { spaces: 2 })
  fs.writeJsonSync(path.resolve(root, 'active-generation.json'), pointer, { spaces: 2 })
  return { pointer, manifest, stage }
}

if (process.argv[1]?.endsWith('prepare_data_generation.js')) {
  const { pointer, manifest } = prepareDataGeneration()
  console.log(`[Generation] prepared ${pointer.id} with ${Object.keys(manifest.files).length} data object(s).`)
}
