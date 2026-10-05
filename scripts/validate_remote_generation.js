import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  })
}

function readObject(target, key) {
  return awsBuffer([
    's3', 'cp', `s3://${target.bucket}/${key}`, '-',
    '--endpoint-url', target.endpoint,
    '--only-show-errors',
  ])
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

  const vectorPresent = VECTOR_FILES.filter(name => files[name])
  if (vectorPresent.length !== 0 && vectorPresent.length !== VECTOR_FILES.length)
    throw new Error(`Generation ${id} has a partial vector set: ${vectorPresent.join(', ')}.`)
  if (vectorPresent.length === VECTOR_FILES.length) {
    const records = parseJson(files[EMBEDDINGS_INDEX_KEY], EMBEDDINGS_INDEX_KEY)
    validateVectorIndex(records)
    await verifyVectorManifest(
      parseJson(files[EMBEDDINGS_MANIFEST_KEY], EMBEDDINGS_MANIFEST_KEY),
      records,
      files[EMBEDDINGS_INDEX_KEY],
      files[EMBEDDINGS_BIN_KEY],
    )
  }

  const readmes = parseJson(files[READMES_MANIFEST_KEY], READMES_MANIFEST_KEY)
  if (readmes.schema !== 2)
    throw new Error(`Generation ${id} has unsupported README manifest schema ${JSON.stringify(readmes.schema)}.`)
  const readmePointer = parseGenerationPointer(readmes.generation)
  if (readmePointer.id !== id || readmePointer.commit !== pointer.commit)
    throw new Error(`Generation ${id} README manifest identity does not match generation metadata.`)

  let readmeBlobs = 0
  for (const [repoKey, ref] of Object.entries(readmes.repos || {})) {
    if (!ref || typeof ref.repo !== 'string' || ref.repo.toLowerCase() !== repoKey)
      throw new Error(`Generation ${id} has invalid README repo mapping for ${repoKey}.`)
    if (!ref.sha256) {
      if (ref.object_key)
        throw new Error(`Generation ${id} README ${ref.repo} has object_key without SHA-256.`)
      continue
    }

    if (!/^[0-9a-f]{64}$/.test(ref.sha256))
      throw new Error(`Generation ${id} README ${ref.repo} has invalid SHA-256.`)
    const expectedKey = readmeBlobKey(ref.sha256)
    if (ref.object_key !== expectedKey)
      throw new Error(`Generation ${id} README ${ref.repo} points to ${ref.object_key}, expected ${expectedKey}.`)
    const blob = readObject(target, ref.object_key)
    if (digest(blob) !== ref.sha256)
      throw new Error(`Generation ${id} README blob ${ref.object_key} failed SHA-256 validation.`)
    readmeBlobs++
  }

  return {
    pointer,
    files: Object.keys(files).length,
    vectors: vectorPresent.length === VECTOR_FILES.length,
    readme_blobs: readmeBlobs,
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
