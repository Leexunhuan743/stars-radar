import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// The vector pair: the dimension, the byte-length invariant, and the CI gate in front of the upload.
//
// This replaced a test that read three source files and compared the literal `1024` it found in
// each — the dimension was declared in the Worker, in the offline pipeline and inside a `node -e`
// snippet in build.yaml, plus the invariant `count * DIMS * 4` written out four times. Comparing
// copies kept them equal; it did not make them one thing. The dimension now lives in
// src/embeddings.js, the gate is a script (scripts/verify_vector_pair.js) that imports it, and the
// remaining assertions are behavioural plus a check that no file declares it again.
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { verifyVectorPair } from '../scripts/verify_vector_pair.js'
import { BYTES_PER_VECTOR, describePairMismatch, DIMS, EMBEDDING_INPUT_PROFILE, EMBEDDING_MODEL, expectedPairBytes, isEmbedding, vectorCountFromBytes, vectorManifest, verifyVectorManifest } from '../src/embeddings.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function scratch(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `stars-radar-${name}-`))
}

function writePair(root, { names, bytes, catalogueRepos = 3 }) {
  if (names !== undefined)
    fs.writeFileSync(path.join(root, 'embeddings-index.json'), JSON.stringify(names), 'utf-8')
  if (bytes !== undefined)
    fs.writeFileSync(path.join(root, 'embeddings.bin'), Buffer.alloc(bytes))
  fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify({ totalRepos: catalogueRepos, repos: {} }), 'utf-8')
  if (names !== undefined && bytes !== undefined) {
    const index = fs.readFileSync(path.join(root, 'embeddings-index.json'))
    const binary = fs.readFileSync(path.join(root, 'embeddings.bin'))
    fs.writeFileSync(path.join(root, 'embeddings-manifest.json'), JSON.stringify({
      model: 'BAAI/bge-m3',
      input_profile: 'repo-metadata-readme-v2',
      dimensions: 1024,
      count: names.length,
      index_sha256: createHash('sha256').update(index).digest('hex'),
      binary_sha256: createHash('sha256').update(binary).digest('hex'),
    }))
  }
}

test('the declared dimension and the byte size of a vector agree', () => {
  assert.equal(DIMS, 1024, 'the model is bge-m3; a different dimension must be a deliberate change')
  assert.equal(BYTES_PER_VECTOR, DIMS * 4, 'Float32')
  assert.equal(EMBEDDING_MODEL, 'BAAI/bge-m3', 'the model name is published by /health')
  assert.equal(EMBEDDING_INPUT_PROFILE, 'repo-metadata-readme-v2')
  assert.equal(expectedPairBytes(3), 3 * BYTES_PER_VECTOR)
  assert.equal(expectedPairBytes(0), 0, 'an empty index is consistent with an empty binary')
})

test('a byte count that is not a whole number of vectors still reports a count', () => {
  // A remainder means the halves came from different runs. The count is floored so the message can
  // name it; deciding whether the pair is usable is describePairMismatch's job.
  assert.equal(vectorCountFromBytes(BYTES_PER_VECTOR * 2 + 7), 2)
})

test('a vector count is required rather than guessed', () => {
  assert.throws(() => expectedPairBytes(undefined), /needs a vector count/)
  assert.throws(() => expectedPairBytes(-1), /needs a vector count/)
})

test('a matching pair has nothing to report, a mismatched one names both sides', () => {
  assert.equal(describePairMismatch({ names: ['a/b', 'c/d'], bytes: expectedPairBytes(2) }), null)
  assert.equal(describePairMismatch({ names: [], bytes: 0 }), null, 'no vectors is a consistent pair')

  const short = describePairMismatch({ names: ['a/b', 'c/d'], bytes: BYTES_PER_VECTOR })
  assert.match(short, /holds 1 vectors/, 'the message must say what the binary actually holds')
  assert.match(short, /lists 2 names/, 'and what the index claims')
  assert.match(short, new RegExp(`expected ${expectedPairBytes(2)}B`), 'and what it should have been')

  const long = describePairMismatch({ names: ['a/b'], bytes: expectedPairBytes(3) })
  assert.match(long, /holds 3 vectors but the index lists 1 names/)
})

test('the CI gate accepts a matching pair and reports what it checked', async () => {
  const root = scratch('pair-ok')
  try {
    const names = ['a/b', 'c/d']
    writePair(root, { names, bytes: expectedPairBytes(names.length) })
    const report = await verifyVectorPair(root)
    assert.match(report, /2 names/)
    assert.match(report, new RegExp(`${expectedPairBytes(2)}B`))
  }
  finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('the CI gate refuses half a pair', async () => {
  // Uploading one half leaves the Worker with a pair it must reject, which silently falls back to
  // lexical search — no error, no vector hits.
  const root = scratch('pair-half')
  try {
    writePair(root, { names: ['a/b'], bytes: undefined })
    await assert.rejects(verifyVectorPair(root), /Vector pair is incomplete/)

    fs.rmSync(path.join(root, 'embeddings-index.json'))
    fs.writeFileSync(path.join(root, 'embeddings.bin'), Buffer.alloc(BYTES_PER_VECTOR))
    await assert.rejects(verifyVectorPair(root), /Vector pair is incomplete/)
  }
  finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('the CI gate refuses a missing pair while the catalogue has starred repos', async () => {
  const root = scratch('pair-missing')
  try {
    writePair(root, { names: undefined, bytes: undefined, catalogueRepos: 931 })
    await assert.rejects(verifyVectorPair(root), /semantic search would be silently disabled/)
  }
  finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a fresh install has nothing to verify, and says so rather than failing', async () => {
  const root = scratch('pair-fresh')
  try {
    writePair(root, { names: undefined, bytes: undefined, catalogueRepos: 0 })
    assert.match(await verifyVectorPair(root), /fresh install/)
  }
  finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('the CI gate refuses a pair whose halves disagree, before anything is uploaded', async () => {
  const root = scratch('pair-drift')
  try {
    writePair(root, { names: ['a/b', 'c/d'], bytes: BYTES_PER_VECTOR })
    await assert.rejects(verifyVectorPair(root), /holds 1 vectors but the index lists 2 names/)
  }
  finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('nothing declares the embedding dimension again', () => {
  // The guard that keeps the unification: a new module spelling `1024` for the dimension is
  // invisible until the day one of the copies changes.
  const sources = []
  for (const dir of ['src', 'scripts']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (name.endsWith('.js') && name !== 'embeddings.js')
        sources.push({ path: `${dir}/${name}`, text: fs.readFileSync(path.join(ROOT, dir, name), 'utf-8') })
    }
  }
  assert.ok(sources.length > 10, 'the scan found no modules to check, so it would pass vacuously')

  const offenders = []
  for (const { path: file, text } of sources) {
    for (const [index, line] of text.split('\n').entries()) {
      if (line.trim().startsWith('//') || line.trim().startsWith('*'))
        continue
      if (/\bDIMS\s*[:=]\s*\d+/.test(line))
        offenders.push(`${file}:${index + 1} declares the embedding dimension again: ${line.trim()}`)
    }
  }
  assert.deepEqual(offenders, [])

  const workflows = fs.readdirSync(path.join(ROOT, '.github', 'workflows'))
    .filter(name => name.endsWith('.yaml') || name.endsWith('.yml'))
    .map(name => ({ name, text: fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf-8') }))
  for (const { name, text } of workflows)
    assert.ok(!/const DIMS = \d+/.test(text), `${name} declares the embedding dimension inline again`)

  // And the gate itself must still run, before the upload it protects.
  const build = workflows.find(w => w.name === 'build.yaml').text
  assert.match(build, /node scripts\/verify_vector_pair\.js/, 'build.yaml no longer runs the vector-pair gate')
  assert.ok(
    build.indexOf('verify_vector_pair.js') < build.indexOf('Upload to Cloudflare R2'),
    'the pair must be verified before anything is uploaded',
  )
})

test('embedding validation rejects zero, invalid dimensions and non-Float32 values', () => {
  assert.equal(isEmbedding(Array.from({ length: 1024 }).fill(0.5)), true)
  for (const value of [null, [0.5], Array.from({ length: 1024 }).fill(0), Array.from({ length: 1024 }).fill(1e100), Array.from({ length: 1024 }).fill(1e-100), Array.from({ length: 1024 }).fill(Number.NaN)])
    assert.equal(isEmbedding(value), false)
})

test('the CI gate rejects same-length reordered names and a missing content manifest', async () => {
  const root = scratch('manifest')
  try {
    writePair(root, { names: ['a/b', 'c/d'], bytes: expectedPairBytes(2) })
    fs.writeFileSync(path.join(root, 'embeddings-index.json'), JSON.stringify(['c/d', 'a/b']))
    await assert.rejects(verifyVectorPair(root), /manifest does not match/)
    fs.rmSync(path.join(root, 'embeddings-manifest.json'))
    await assert.rejects(verifyVectorPair(root), /manifest is missing/)
  }
  finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('the CI gate requires vectors for journal ingests even when the star catalogue is empty', async () => {
  const root = scratch('journal-corpus')
  try {
    writePair(root, { names: [], bytes: 0, catalogueRepos: 0 })
    const directory = path.join(root, 'state', 'ingest-journal')
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'fixture.jsonl'), '{"repo":"confirmed/tool","ingested_at":"2026-10-03T00:00:00Z"}\n')
    await assert.rejects(verifyVectorPair(root), /missing confirmed repositories: confirmed\/tool/)
  }
  finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('vector manifests require the current README-aware input profile exactly', async () => {
  const names = ['a/b']
  const index = Buffer.from(JSON.stringify(names))
  const binary = Buffer.alloc(BYTES_PER_VECTOR)
  const current = await vectorManifest(names, index, binary)

  assert.equal(current.input_profile, EMBEDDING_INPUT_PROFILE)
  assert.equal(await verifyVectorManifest(current, names, index, binary), EMBEDDING_INPUT_PROFILE)

  const missingProfile = { ...current }
  delete missingProfile.input_profile
  await assert.rejects(
    verifyVectorManifest(missingProfile, names, index, binary),
    /required repo-metadata-readme-v2 generation/,
  )

  await assert.rejects(
    verifyVectorManifest({ ...current, input_profile: 'repo-metadata-v1' }, names, index, binary),
    /required repo-metadata-readme-v2 generation/,
  )
})
