import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import process from 'node:process'
import { ACTIVE_GENERATION_KEY, generationKey, parseGenerationPointer, validateGenerationId } from '../src/data-generation.js'
import { validateVectorIndex, verifyVectorManifest } from '../src/embeddings.js'
import {
  ASSET_INDEX_KEY,
  ASSET_STATE_KEY,
  CATALOG_KEY,
  EMBEDDINGS_BIN_KEY,
  EMBEDDINGS_FINGERPRINTS_KEY,
  EMBEDDINGS_INDEX_KEY,
  EMBEDDINGS_MANIFEST_KEY,
  RANKINGS_KEY,
  readmeBlobKey,
  READMES_MANIFEST_KEY,
} from '../src/object-keys.js'

const GENERATION_MANIFEST_KEY = 'generation-manifest.json'
const AWS_OBJECT_MAX_BUFFER = 128 * 1024 * 1024
const REQUIRED_FILES = [
  CATALOG_KEY,
  RANKINGS_KEY,
  ASSET_INDEX_KEY,
  ASSET_STATE_KEY,
  READMES_MANIFEST_KEY,
]
const VECTOR_FILES = [
  EMBEDDINGS_BIN_KEY,
  EMBEDDINGS_INDEX_KEY,
  EMBEDDINGS_FINGERPRINTS_KEY,
  EMBEDDINGS_MANIFEST_KEY,
]

function required(name) {
  const value = process.env[name]
  if (!value)
    throw new Error(`${name} is required.`)
  return value
}

export function remoteTarget() {
  const account = required('R2_ACCOUNT_ID')
  const bucket = required('R2_BUCKET')
  required('AWS_ACCESS_KEY_ID')
  required('AWS_SECRET_ACCESS_KEY')
  return { bucket, endpoint: `https://${account}.r2.cloudflarestorage.com` }
}

function awsBuffer(args) {
  return execFileSync('aws', [...args, '--region', 'auto'], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // embeddings.bin is intentionally tens of MiB (10k * 1024 Float32 values is ~39 MiB).
    // execFileSync defaults to a ~1 MiB child-process buffer, which made a valid generation fail
    // integrity validation with ENOBUFS after upload. Validation already needs the complete bytes
    // for SHA-256 and vector-manifest verification, so give this bounded corpus explicit headroom.
    maxBuffer: AWS_OBJECT_MAX_BUFFER,
  })
}

function readObject(target, key) {
  return awsBuffer([
    's3',
    'cp',
    `s3://${target.bucket}/${key}`,
    '-',
    '--endpoint-url',
    target.endpoint,
    '--only-show-errors',
  ])
}

function readObjectAsync(target, key) {
  return new Promise((resolve, reject) => {
    execFile('aws', [
      's3',
      'cp',
      `s3://${target.bucket}/${key}`,
      '-',
      '--endpoint-url',
      target.endpoint,
      '--only-show-errors',
      '--region',
      'auto',
    ], {
      env: process.env,
      encoding: null,
      maxBuffer: AWS_OBJECT_MAX_BUFFER,
    }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}${stderr?.length ? `: ${stderr.toString('utf8').trim()}` : ''}`
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}

// README blobs are immutable and content-addressed: the object key IS the SHA-256 of the bytes,
// so a blob that exists under its own hash cannot have been written with different content.
//
// Verification still means downloading and hashing, and doing that for a 1k+ corpus twice per run
// was the bulk of this workflow's wall time. The two passes are avoidable without weakening the
// guarantee, because the blobs fall into two disjoint groups:
//
//   - Blobs this run fetched and published. Their bytes are on disk right now (`.readme-content-stage`),
//     and they were hashed before upload by `prepare_data_generation.js`. The question worth asking
//     is whether the transfer landed them intact, which the local digest answers only for the copy
//     that was sent — so these are still fetched back and re-hashed.
//   - Blobs that already existed in R2 and were merely referenced again. These were downloaded and
//     verified when the corpus was restored, and nothing in this run wrote to them.
//
// A receipt file records the digests the restore step actually observed, keyed by blob. Blobs
// covered by a receipt are not re-fetched; everything else is fetched and hashed exactly as before.
// A missing or unreadable receipt simply means "verify everything", so the receipt can only ever
// remove work that another step already proved.
function readVerificationReceipt(file) {
  if (!file || !fs.existsSync(file))
    return new Map()
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  catch {
    return new Map()
  }
  const entries = parsed?.verified
  if (!entries || typeof entries !== 'object')
    return new Map()
  return new Map(Object.entries(entries).filter(([, v]) => /^[0-9a-f]{64}$/.test(v)))
}

const README_VERIFY_CONCURRENCY = Number.parseInt(process.env.README_VERIFY_CONCURRENCY || '', 10)
const README_VERIFY_MAX_IN_FLIGHT = Number.isInteger(README_VERIFY_CONCURRENCY) && README_VERIFY_CONCURRENCY > 0
  ? README_VERIFY_CONCURRENCY
  : 64

async function validateReadmeBlobs(target, refs, { receipt = new Map() } = {}) {
  const all = refs
    .filter(ref => ref?.sha256)
    .map(ref => ({ repo: ref.repo, sha256: ref.sha256, key: readmeBlobKey(ref.sha256) }))

  if (all.length === 0)
    return { verified: 0, reused: 0 }

  // A receipt only discharges a blob when it names the same digest the manifest asks for.
  const jobs = []
  let reused = 0
  for (const job of all) {
    if (receipt.get(job.key) === job.sha256)
      reused += 1
    else
      jobs.push(job)
  }

  let cursor = 0
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++]
      const blob = await readObjectAsync(target, job.key)
      if (digest(blob) !== job.sha256)
        throw new Error(`README blob ${job.key} for ${job.repo} failed SHA-256 validation.`)
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(README_VERIFY_MAX_IN_FLIGHT, jobs.length) },
    () => worker(),
  ))

  return { verified: jobs.length, reused }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  }
  catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`)
  }
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function validateRemoteGeneration(generationId, { expectedPointer = null } = {}) {
  const id = validateGenerationId(generationId)
  const target = remoteTarget()
  const manifestBytes = readObject(target, generationKey(id, GENERATION_MANIFEST_KEY))
  const manifest = parseJson(manifestBytes, GENERATION_MANIFEST_KEY)
  const pointer = parseGenerationPointer(manifest.generation)

  if (pointer.id !== id)
    throw new Error(`${GENERATION_MANIFEST_KEY} belongs to ${pointer.id}, not ${id}.`)
  if (expectedPointer && (
    expectedPointer.id !== pointer.id
    || expectedPointer.commit !== pointer.commit
    || expectedPointer.published_at !== pointer.published_at
  )) {
    throw new Error('Active generation pointer does not match the generation manifest identity.')
  }

  for (const name of REQUIRED_FILES) {
    if (!manifest.files?.[name])
      throw new Error(`Generation ${id} is missing required manifest entry ${name}.`)
  }

  const files = {}
  for (const [name, descriptor] of Object.entries(manifest.files || {})) {
    if (!descriptor || descriptor.object_key !== generationKey(id, name))
      throw new Error(`Generation ${id} has invalid object_key for ${name}.`)
    if (!Number.isInteger(descriptor.bytes) || descriptor.bytes < 0)
      throw new Error(`Generation ${id} has invalid byte count for ${name}.`)
    if (!/^[0-9a-f]{64}$/.test(descriptor.sha256 || ''))
      throw new Error(`Generation ${id} has invalid SHA-256 for ${name}.`)

    const bytes = readObject(target, descriptor.object_key)
    if (bytes.length !== descriptor.bytes)
      throw new Error(`Generation ${id} ${name} is ${bytes.length} bytes; manifest says ${descriptor.bytes}.`)
    if (digest(bytes) !== descriptor.sha256)
      throw new Error(`Generation ${id} ${name} SHA-256 does not match its manifest.`)
    files[name] = bytes
  }

  const catalog = parseJson(files[CATALOG_KEY], CATALOG_KEY)
  const assetIndex = parseJson(files[ASSET_INDEX_KEY], ASSET_INDEX_KEY)
  const requiredSemanticRepos = new Set([
    ...Object.keys(catalog.repos || {}).map(repo => repo.toLowerCase()),
    ...(assetIndex.ingest_snapshot?.entries || [])
      .map(entry => entry?.repo?.toLowerCase())
      .filter(Boolean),
  ])

  const vectorPresent = VECTOR_FILES.filter(name => files[name])
  if (vectorPresent.length !== 0 && vectorPresent.length !== VECTOR_FILES.length)
    throw new Error(`Generation ${id} has a partial vector set: ${vectorPresent.join(', ')}.`)
  if (requiredSemanticRepos.size > 0 && vectorPresent.length === 0)
    throw new Error(`Generation ${id} has ${requiredSemanticRepos.size} semantic repositories but no vector generation.`)
  if (vectorPresent.length === VECTOR_FILES.length) {
    const records = parseJson(files[EMBEDDINGS_INDEX_KEY], EMBEDDINGS_INDEX_KEY)
    validateVectorIndex(records)
    await verifyVectorManifest(
      parseJson(files[EMBEDDINGS_MANIFEST_KEY], EMBEDDINGS_MANIFEST_KEY),
      records,
      files[EMBEDDINGS_INDEX_KEY],
      files[EMBEDDINGS_BIN_KEY],
    )
    const indexedRepos = new Set(
      records
        .filter(record => record.kind === 'repo')
        .map(record => record.repo.toLowerCase()),
    )
    const missing = [...requiredSemanticRepos].filter(repo => !indexedRepos.has(repo))
    if (missing.length > 0)
      throw new Error(`Generation ${id} vector corpus is missing semantic repositories: ${missing.join(', ')}.`)
  }

  const readmes = parseJson(files[READMES_MANIFEST_KEY], READMES_MANIFEST_KEY)
  if (readmes.schema !== 2)
    throw new Error(`Generation ${id} has unsupported README manifest schema ${JSON.stringify(readmes.schema)}.`)
  const readmePointer = parseGenerationPointer(readmes.generation)
  if (readmePointer.id !== id || readmePointer.commit !== pointer.commit)
    throw new Error(`Generation ${id} README manifest identity does not match generation metadata.`)

  const readmeRefs = []
  for (const [repoKey, ref] of Object.entries(readmes.repos || {})) {
    if (!ref || typeof ref.repo !== 'string' || ref.repo.toLowerCase() !== repoKey)
      throw new Error(`Generation ${id} has invalid README repo mapping for ${repoKey}.`)
    if (!ref.sha256)
      continue
    if (!/^[0-9a-f]{64}$/.test(ref.sha256))
      throw new Error(`Generation ${id} README ${ref.repo} has invalid SHA-256.`)
    readmeRefs.push(ref)
  }

  // A receipt names the blobs the corpus restore already downloaded and hashed this run. It can
  // only remove work; an absent or stale receipt falls back to verifying every blob.
  const receipt = readVerificationReceipt(process.env.README_VERIFY_RECEIPT_FILE)
  const { verified, reused } = await validateReadmeBlobs(target, readmeRefs, { receipt })
  if (reused > 0)
    console.log(`[Generation Integrity] ${reused} README blob(s) discharged by the restore receipt; ${verified} fetched and hashed.`)

  return {
    pointer,
    files: Object.keys(files).length,
    vectors: vectorPresent.length === VECTOR_FILES.length,
    readme_blobs: verified + reused,
    readme_blobs_reused: reused,
  }
}

export async function validateActiveGeneration() {
  const target = remoteTarget()
  const pointer = parseGenerationPointer(parseJson(readObject(target, ACTIVE_GENERATION_KEY), ACTIVE_GENERATION_KEY))
  return validateRemoteGeneration(pointer.id, { expectedPointer: pointer })
}

async function main() {
  const generationAt = process.argv.indexOf('--generation')
  const active = process.argv.includes('--active')
  if (active === (generationAt >= 0))
    throw new Error('Usage: node scripts/validate_remote_generation.js --active | --generation <id>')

  const report = active
    ? await validateActiveGeneration()
    : await validateRemoteGeneration(process.argv[generationAt + 1])

  console.log(`[Generation Integrity] ${report.pointer.id}: ${report.files} manifest files, vectors=${report.vectors}, README blobs=${report.readme_blobs}.`)
}

if (process.argv[1]?.endsWith('validate_remote_generation.js')) {
  main().catch((error) => {
    console.error(error.message || String(error))
    process.exitCode = 1
  })
}
