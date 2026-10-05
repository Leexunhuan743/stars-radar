import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import fs from 'fs-extra'
import { $fetch } from 'ofetch'
import { ACTIVE_GENERATION_KEY, generationKey, parseGenerationPointer } from '../src/data-generation.js'
import {
  describePairMismatch,
  DIMS,
  EMBEDDING_INPUT_PROFILE,
  EMBEDDING_MODEL,
  isEmbedding,
  validateVectorIndex,
  vectorManifest,
  verifyVectorManifest,
} from '../src/embeddings.js'
import {
  EMBEDDINGS_BIN_KEY,
  EMBEDDINGS_FINGERPRINTS_KEY,
  EMBEDDINGS_INDEX_KEY,
  EMBEDDINGS_MANIFEST_KEY,
  localReadmePath,
} from '../src/object-keys.js'
import { selectReadmeVectorChunks } from '../src/readme-evidence.js'
import { retryAsync } from '../src/retry.js'
import { r2Target, readObject } from './r2-rest.js'

const PROJECT_ROOT = process.env.VECTOR_STORE_ROOT
  ? path.resolve(process.env.VECTOR_STORE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SILICONFLOW_URL = process.env.SILICONFLOW_URL || 'https://api.siliconflow.cn/v1/embeddings'
const SILICONFLOW_KEY = process.env.SILICONFLOW_KEY
const EMBED_ATTEMPTS = 3
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

const METADATA_TEXT_LIMIT = 2400

function readLocalReadme(repo) {
  const file = path.resolve(PROJECT_ROOT, localReadmePath(repo))
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
}

export function embeddingText(repo) {
  const categories = (repo.categories || []).join(', ')
  const topics = (repo.topics || []).join(', ')
  return [repo.repo, categories, repo.language, repo.reason, repo.summary, repo.description, topics]
    .filter(Boolean)
    .join(' ')
    .slice(0, METADATA_TEXT_LIMIT)
}

export function repositoryVectorRows(repo) {
  const key = repo.repo.toLowerCase()
  const rows = [{
    record: {
      id: `repo:${key}`,
      repo: repo.repo,
      kind: 'repo',
    },
    text: embeddingText(repo),
  }]

  const readme = readLocalReadme(repo.repo)
  const readmeSha256 = readme ? digest(readme) : null
  for (const [ordinal, chunk] of selectReadmeVectorChunks(readme).entries()) {
    const contentSha256 = digest(chunk.text)
    const chunkHash = digest(`${chunk.heading}\0${chunk.text}`).slice(0, 20)
    rows.push({
      record: {
        id: `readme:${key}:${chunkHash}`,
        repo: repo.repo,
        kind: 'readme_chunk',
        readme_sha256: readmeSha256,
        content_sha256: contentSha256,
        ordinal,
        heading: chunk.heading,
        text: chunk.text,
      },
      text: [repo.repo, chunk.heading, chunk.text].filter(Boolean).join(' '),
    })
  }

  return rows
}

function desiredRows(repositories) {
  const byRepo = new Map(repositories.map(repo => [repo.repo.toLowerCase(), repo]))
  const rows = [...byRepo.values()].flatMap(repositoryVectorRows)
  const ids = new Set()
  return rows.filter((row) => {
    if (ids.has(row.record.id))
      return false
    ids.add(row.record.id)
    return true
  })
}

async function readCurrentBaseline({ binPath, indexPath, manifestPath }) {
  if (!fs.existsSync(binPath) || !fs.existsSync(indexPath) || !fs.existsSync(manifestPath))
    return null

  try {
    const records = fs.readJsonSync(indexPath)
    validateVectorIndex(records)
    const binary = fs.readFileSync(binPath)
    const problem = describePairMismatch({ records, bytes: binary.length })
    if (problem)
      throw new Error(problem)
    const indexBytes = fs.readFileSync(indexPath)
    const manifest = fs.readJsonSync(manifestPath)
    await verifyVectorManifest(manifest, records, indexBytes, binary)
    return { records, binary }
  }
  catch (error) {
    console.warn(`[Vector Pipeline] Local vector generation is not reusable: ${error.message || String(error)}`)
    return null
  }
}

export async function buildRepositoryVectors(repositories) {
  const started = performance.now()
  const binPath = path.resolve(PROJECT_ROOT, EMBEDDINGS_BIN_KEY)
  const indexPath = path.resolve(PROJECT_ROOT, EMBEDDINGS_INDEX_KEY)
  const manifestPath = path.resolve(PROJECT_ROOT, EMBEDDINGS_MANIFEST_KEY)
  const fingerprintsPath = path.resolve(PROJECT_ROOT, EMBEDDINGS_FINGERPRINTS_KEY)

  let baseline = await readCurrentBaseline({ binPath, indexPath, manifestPath })
  if (!baseline) {
    const restored = await downloadVectorsFromR2()
    baseline = restored ? await readCurrentBaseline({ binPath, indexPath, manifestPath }) : null
  }

  const oldRecords = baseline?.records || []
  const oldBinary = baseline?.binary || Buffer.alloc(0)
  const oldFingerprints = fs.existsSync(fingerprintsPath) ? fs.readJsonSync(fingerprintsPath) : {}
  const oldSlots = new Map(oldRecords.map((record, index) => [record.id, index]))

  const rows = desiredRows(repositories).map(({ record, text }) => {
    const textHash = digest(`${EMBEDDING_MODEL}\0${EMBEDDING_INPUT_PROFILE}\0${text}`)
    const slot = oldSlots.get(record.id)
    const binary = slot === undefined
      ? null
      : oldBinary.subarray(slot * DIMS * 4, (slot + 1) * DIMS * 4)
    const fingerprint = oldFingerprints[record.id]
    const reusable = binary !== null
      && fingerprint?.text_hash === textHash
      && fingerprint.vector_hash === digest(binary)

    return {
      record,
      text,
      textHash,
      binary: reusable ? binary : null,
      existed: slot !== undefined,
    }
  })

  const pending = rows.filter(row => row.binary === null)
  if (pending.length > 0 && !SILICONFLOW_KEY)
    throw new Error('SILICONFLOW_KEY is required to build new or changed vector records')

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
        throw new Error(`Embedding batch returned ${payload?.data?.length} vectors for ${batch.length} records`)
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

  const outputRecords = rows.map(row => row.record)
  validateVectorIndex(outputRecords)
  const binary = Buffer.concat(rows.map(row => row.binary))
  const indexBytes = Buffer.from(JSON.stringify(outputRecords, null, 2))
  const fingerprints = Object.fromEntries(rows.map(row => [
    row.record.id,
    { text_hash: row.textHash, vector_hash: digest(row.binary) },
  ]))
  const manifest = await vectorManifest(outputRecords, indexBytes, binary)

  // Nothing is written until every requested embedding has succeeded. CI alone publishes these files.
  fs.writeFileSync(binPath, binary)
  fs.writeFileSync(indexPath, indexBytes)
  fs.writeJsonSync(fingerprintsPath, fingerprints, { spaces: 2 })
  fs.writeJsonSync(manifestPath, manifest, { spaces: 2 })

  const desiredIds = new Set(outputRecords.map(record => record.id))
  return {
    addedCount: pending.filter(row => !row.existed).length,
    updatedCount: pending.filter(row => row.existed).length,
    removedCount: oldRecords.filter(record => !desiredIds.has(record.id)).length,
    totalVectors: outputRecords.length,
    repoVectors: outputRecords.filter(record => record.kind === 'repo').length,
    readmeChunkVectors: outputRecords.filter(record => record.kind === 'readme_chunk').length,
    elapsedMs: Number((performance.now() - started).toFixed(1)),
  }
}

export async function downloadVectorsFromR2() {
  const target = r2Target('downloadVectorsFromR2')
  if (!target)
    return false

  let active
  try {
    active = parseGenerationPointer(JSON.parse((await readObject(target, ACTIVE_GENERATION_KEY)).toString('utf-8')))
  }
  catch (err) {
    console.warn(`[Vector Pipeline] Could not resolve ${ACTIVE_GENERATION_KEY} (${err.message || String(err)}); rebuilding without a baseline.`)
    return false
  }

  const objects = [
    { name: EMBEDDINGS_BIN_KEY, field: 'bin' },
    { name: EMBEDDINGS_INDEX_KEY, field: 'index' },
    { name: EMBEDDINGS_FINGERPRINTS_KEY, field: 'fingerprints' },
    { name: EMBEDDINGS_MANIFEST_KEY, field: 'manifest' },
  ]

  const payloads = {}
  for (const object of objects) {
    const key = generationKey(active.id, object.name)
    try {
      payloads[object.field] = await readObject(target, key)
    }
    catch (err) {
      console.warn(`[Vector Pipeline] Could not restore ${key} from R2 (${err.message || String(err)}); rebuilding without a baseline.`)
      return false
    }
  }

  try {
    const records = JSON.parse(payloads.index.toString('utf-8'))
    validateVectorIndex(records)
    const problem = describePairMismatch({ records, bytes: payloads.bin.length })
    if (problem)
      throw new Error(problem)
    await verifyVectorManifest(
      JSON.parse(payloads.manifest.toString('utf-8')),
      records,
      payloads.index,
      payloads.bin,
    )

    fs.writeFileSync(path.resolve(PROJECT_ROOT, EMBEDDINGS_BIN_KEY), payloads.bin)
    fs.writeFileSync(path.resolve(PROJECT_ROOT, EMBEDDINGS_INDEX_KEY), payloads.index)
    fs.writeFileSync(path.resolve(PROJECT_ROOT, EMBEDDINGS_FINGERPRINTS_KEY), payloads.fingerprints)
    fs.writeFileSync(path.resolve(PROJECT_ROOT, EMBEDDINGS_MANIFEST_KEY), payloads.manifest)

    console.log(`[Vector Pipeline] Restored current vector generation from R2 (${records.length} records, ${payloads.bin.length} bytes).`)
    return true
  }
  catch (error) {
    console.warn(`[Vector Pipeline] R2 vector generation is not reusable: ${error.message || String(error)}`)
    return false
  }
}
