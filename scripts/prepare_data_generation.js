import { Buffer } from 'node:buffer'
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
  LOCAL_STARS_DIR,
  RANKINGS_KEY,
  README_SUFFIX,
  readmeBlobKey,
  READMES_MANIFEST_KEY,
} from '../src/object-keys.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const GENERATION_STAGE_DIR = '.generation-stage'
export const README_CONTENT_STAGE_DIR = '.readme-content-stage'
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
  const readmeStage = path.resolve(root, README_CONTENT_STAGE_DIR)
  fs.rmSync(stage, { recursive: true, force: true })
  fs.rmSync(readmeStage, { recursive: true, force: true })
  fs.mkdirSync(stage, { recursive: true })
  fs.mkdirSync(readmeStage, { recursive: true })

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

  const readmes = { schema: 1, generation: pointer, repos: {} }
  const starsRoot = path.resolve(root, LOCAL_STARS_DIR)
  if (fs.existsSync(starsRoot)) {
    for (const owner of fs.readdirSync(starsRoot, { withFileTypes: true })) {
      if (!owner.isDirectory())
        continue
      for (const file of fs.readdirSync(path.join(starsRoot, owner.name), { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith(README_SUFFIX))
          continue
        const source = path.join(starsRoot, owner.name, file.name)
        const bytes = fs.readFileSync(source)
        const sha256 = digest(bytes)
        const repo = `${owner.name}/${file.name.slice(0, -README_SUFFIX.length)}`
        const blobKey = readmeBlobKey(sha256)
        const blobTarget = path.resolve(readmeStage, path.basename(blobKey))
        if (!fs.existsSync(blobTarget))
          fs.writeFileSync(blobTarget, bytes)
        readmes.repos[repo.toLowerCase()] = { repo, sha256, object_key: blobKey }
      }
    }
  }

  const readmesBytes = Buffer.from(`${JSON.stringify(readmes, null, 2)}\n`)
  fs.writeFileSync(path.resolve(stage, READMES_MANIFEST_KEY), readmesBytes)
  files[READMES_MANIFEST_KEY] = {
    bytes: readmesBytes.byteLength,
    sha256: digest(readmesBytes),
    object_key: generationKey(pointer.id, READMES_MANIFEST_KEY),
  }

  const manifest = {
    schema: 1,
    generation: pointer,
    files,
    readme_blobs: Object.keys(readmes.repos).length,
  }
  fs.writeJsonSync(path.resolve(stage, GENERATION_MANIFEST_KEY), manifest, { spaces: 2 })
  fs.writeJsonSync(path.resolve(root, 'active-generation.json'), pointer, { spaces: 2 })
  return { pointer, manifest, stage, readmeStage }
}

if (process.argv[1]?.endsWith('prepare_data_generation.js')) {
  const { pointer, manifest } = prepareDataGeneration()
  console.log(`[Generation] prepared ${pointer.id} with ${Object.keys(manifest.files).length} data object(s).`)
}
