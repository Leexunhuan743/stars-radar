import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import fs from 'fs-extra'
import { $fetch } from 'ofetch'
import { describePairMismatch, DIMS, EMBEDDING_MODEL, expectedPairBytes, isEmbedding, vectorManifest } from '../src/embeddings.js'
import { EMBEDDINGS_BIN_KEY, EMBEDDINGS_FINGERPRINTS_KEY, EMBEDDINGS_INDEX_KEY, EMBEDDINGS_MANIFEST_KEY } from '../src/object-keys.js'
import { retryAsync } from '../src/retry.js'
import { r2Target, readObject } from './r2-rest.js'

const PROJECT_ROOT = process.env.VECTOR_STORE_ROOT
  ? path.resolve(process.env.VECTOR_STORE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SILICONFLOW_URL = process.env.SILICONFLOW_URL || 'https://api.siliconflow.cn/v1/embeddings'
const SILICONFLOW_KEY = process.env.SILICONFLOW_KEY
const EMBED_ATTEMPTS = 3
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function embeddingText(repo) {
  const categories = (repo.categories || []).join(', ')
  const topics = (repo.topics || []).join(', ')
  return [repo.repo, categories, repo.language, repo.reason, repo.summary, repo.description, topics]
    .filter(Boolean)
    .join(' ')
    .slice(0, 1500)
}

export async function buildRepositoryVectors(repositories) {
  const started = performance.now()
  const binPath = path.resolve(PROJECT_ROOT, EMBEDDINGS_BIN_KEY)
  const indexPath = path.resolve(PROJECT_ROOT, EMBEDDINGS_INDEX_KEY)
  const fingerprintsPath = path.resolve(PROJECT_ROOT, EMBEDDINGS_FINGERPRINTS_KEY)
  let names = fs.existsSync(indexPath) ? fs.readJsonSync(indexPath) : []
  const bytes = fs.existsSync(binPath) ? fs.statSync(binPath).size : null
  if (bytes !== expectedPairBytes(names.length)) {
    const restored = await downloadVectorsFromR2()
    names = restored ? fs.readJsonSync(indexPath) : []
  }
  const oldBinary = names.length > 0 ? fs.readFileSync(binPath) : Buffer.alloc(0)
  const oldFingerprints = fs.existsSync(fingerprintsPath) ? fs.readJsonSync(fingerprintsPath) : {}
  const oldSlots = new Map(names.map((name, index) => [name.toLowerCase(), index]))
  const desired = new Map(repositories.map(repo => [repo.repo.toLowerCase(), repo]))
  const rows = [...desired.values()].map((repo) => {
    const key = repo.repo.toLowerCase()
    const text = embeddingText(repo)
    const textHash = digest(`${EMBEDDING_MODEL}\0${text}`)
    const slot = oldSlots.get(key)
    const binary = slot === undefined ? null : oldBinary.subarray(slot * DIMS * 4, (slot + 1) * DIMS * 4)
    const fingerprint = oldFingerprints[key]
    const reusable = binary !== null && fingerprint?.text_hash === textHash && fingerprint.vector_hash === digest(binary)
    return { repo: repo.repo, key, text, textHash, binary: reusable ? binary : null, existed: slot !== undefined }
  })
  const pending = rows.filter(row => row.binary === null)
  if (pending.length > 0 && !SILICONFLOW_KEY)
    throw new Error('SILICONFLOW_KEY is required to build new or changed repository vectors')
  for (let offset = 0; offset < pending.length; offset += 16) {
    const batch = pending.slice(offset, offset + 16)
    const vectors = await retryAsync(async () => {
      const payload = await $fetch(SILICONFLOW_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SILICONFLOW_KEY}` },
        body: { model: EMBEDDING_MODEL, input: batch.map(row => row.text) },
        timeout: 30000,
      })
      if (!Array.isArray(payload?.data) || payload.data.length !== batch.length)
        throw new Error(`Embedding batch returned ${payload?.data?.length} vectors for ${batch.length} repositories`)
      const ordered = payload.data.every(item => Number.isInteger(item.index))
        ? [...payload.data].sort((a, b) => a.index - b.index)
        : payload.data
      if (ordered.some((item, index) => (item.index !== undefined && item.index !== index)
        || !isEmbedding(item.embedding))) {
        throw new Error('Embedding batch returned invalid vector dimensions, values or indices')
      }
      return ordered.map(item => item.embedding)
    }, { attempts: EMBED_ATTEMPTS, baseMs: 1000, onGiveUp: (error) => { throw error } })
    batch.forEach((row, index) => {
      row.binary = Buffer.alloc(DIMS * 4)
      vectors[index].forEach((value, dimension) => row.binary.writeFloatLE(value, dimension * 4))
    })
  }
  const outputNames = rows.map(row => row.repo)
  const binary = Buffer.concat(rows.map(row => row.binary))
  const indexBytes = Buffer.from(JSON.stringify(outputNames, null, 2))
  const fingerprints = Object.fromEntries(rows.map(row => [row.key, { text_hash: row.textHash, vector_hash: digest(row.binary) }]))
  const manifest = await vectorManifest(outputNames, indexBytes, binary)
  // Nothing is written until every requested embedding has succeeded. CI alone publishes these files.
  fs.writeFileSync(binPath, binary)
  fs.writeFileSync(indexPath, indexBytes)
  fs.writeJsonSync(fingerprintsPath, fingerprints, { spaces: 2 })
  fs.writeJsonSync(path.resolve(PROJECT_ROOT, EMBEDDINGS_MANIFEST_KEY), manifest, { spaces: 2 })
  return {
    addedCount: pending.filter(row => !row.existed).length,
    updatedCount: pending.filter(row => row.existed).length,
    removedCount: names.filter(name => !desired.has(name.toLowerCase())).length,
    totalVectors: outputNames.length,
    elapsedMs: Number((performance.now() - started).toFixed(1)),
  }
}

export async function downloadVectorsFromR2() {
  const target = r2Target('downloadVectorsFromR2')
  if (!target)
    return false

  const objects = [
    { name: EMBEDDINGS_BIN_KEY, field: 'bin' },
    { name: EMBEDDINGS_INDEX_KEY, field: 'index' },
  ]

  const payloads = {}
  for (const object of objects) {
    try {
      payloads[object.field] = await readObject(target, object.name)
    }
    catch (err) {
      // Absent on a first run, or not reachable with these credentials. Either way
      // there is no usable baseline pair, and the caller rebuilds from scratch — so
      // this is reported, not thrown.
      console.warn(`[Vector Pipeline] Could not restore ${object.name} from R2 (${err.message || String(err)}); continuing without a baseline pair.`)
      return false
    }
  }

  // Validate BEFORE touching the working tree: writing first and checking afterwards
  // would leave the very mismatch this function exists to prevent on disk.
  const names = JSON.parse(payloads.index.toString('utf-8'))
  const problem = describePairMismatch({ names, bytes: payloads.bin.length })
  if (problem) {
    console.warn(
      `[Vector Pipeline] R2 holds an inconsistent vector pair: ${problem} `
      + `Re-upload a matching pair; continuing without a baseline pair.`,
    )
    return false
  }

  fs.writeFileSync(path.resolve(PROJECT_ROOT, EMBEDDINGS_BIN_KEY), payloads.bin)
  fs.writeFileSync(path.resolve(PROJECT_ROOT, EMBEDDINGS_INDEX_KEY), payloads.index)

  console.log(`[Vector Pipeline] Restored a consistent vector pair from R2 (${names.length} vectors, ${payloads.bin.length} bytes).`)
  return true
}
