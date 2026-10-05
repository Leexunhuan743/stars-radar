import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { verifyVectorPair } from '../scripts/verify_vector_pair.js'
import {
  BYTES_PER_VECTOR,
  describePairMismatch,
  DIMS,
  EMBEDDING_INPUT_PROFILE,
  EMBEDDING_MODEL,
  expectedPairBytes,
  isEmbedding,
  validateVectorIndex,
  vectorCountFromBytes,
  vectorManifest,
  verifyVectorManifest,
} from '../src/embeddings.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function repoRecord(repo) {
  return { id: `repo:${repo.toLowerCase()}`, repo, kind: 'repo' }
}

function chunkRecord(repo, id = 'fixture') {
  return {
    id: `readme:${repo.toLowerCase()}:${id}`,
    repo,
    kind: 'readme_chunk',
    heading: 'Features',
    text: 'README feature evidence',
  }
}

function scratch(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `stars-radar-${name}-`))
}

function writePair(root, { records, bytes, catalogueRepos = 3 }) {
  if (records !== undefined)
    fs.writeFileSync(path.join(root, 'embeddings-index.json'), JSON.stringify(records), 'utf-8')
  if (bytes !== undefined)
    fs.writeFileSync(path.join(root, 'embeddings.bin'), Buffer.alloc(bytes))
  fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify({ totalRepos: catalogueRepos, repos: {} }), 'utf-8')

  if (records !== undefined && bytes !== undefined) {
    const index = fs.readFileSync(path.join(root, 'embeddings-index.json'))
    const binary = fs.readFileSync(path.join(root, 'embeddings.bin'))
    fs.writeFileSync(path.join(root, 'embeddings-manifest.json'), JSON.stringify({
      model: 'BAAI/bge-m3',
      input_profile: 'repo-metadata-readme-chunks-v3',
      dimensions: 1024,
      count: records.length,
      repo_count: records.filter(record => record.kind === 'repo').length,
      index_sha256: createHash('sha256').update(index).digest('hex'),
      binary_sha256: createHash('sha256').update(binary).digest('hex'),
    }))
  }
}

test('the declared dimension, profile and vector byte width are one contract', () => {
  assert.equal(DIMS, 1024)
  assert.equal(BYTES_PER_VECTOR, DIMS * 4)
  assert.equal(EMBEDDING_MODEL, 'BAAI/bge-m3')
  assert.equal(EMBEDDING_INPUT_PROFILE, 'repo-metadata-readme-chunks-v3')
  assert.equal(expectedPairBytes(3), 3 * BYTES_PER_VECTOR)
  assert.equal(expectedPairBytes(0), 0)
})

test('a byte count that is not a whole number of vectors still reports whole slots', () => {
  assert.equal(vectorCountFromBytes(BYTES_PER_VECTOR * 2 + 7), 2)
})

test('a vector count is required rather than guessed', () => {
  assert.throws(() => expectedPairBytes(undefined), /needs a vector count/)
  assert.throws(() => expectedPairBytes(-1), /needs a vector count/)
})

test('structured vector indexes reject strings, duplicate repo records and malformed chunks', () => {
  assert.throws(() => validateVectorIndex(['a/b']), /must be an object/)
  assert.throws(
    () => validateVectorIndex([repoRecord('a/b'), repoRecord('a/b')]),
    /duplicate id/,
  )
  assert.throws(
    () => validateVectorIndex([{ id: 'readme:a/b:x', repo: 'a/b', kind: 'readme_chunk', heading: 'Features' }]),
    /missing text/,
  )
  assert.throws(
    () => validateVectorIndex([{ ...repoRecord('a/b'), id: 'repo:wrong' }]),
    /canonical id/,
  )
  assert.throws(
    () => validateVectorIndex([chunkRecord('a/b')]),
    /no matching repo metadata record/,
  )
  assert.deepEqual(
    validateVectorIndex([repoRecord('a/b'), chunkRecord('a/b')]),
    { recordCount: 2, repoCount: 1 },
  )
})

test('a matching pair has nothing to report and a mismatch names record counts', () => {
  const records = [repoRecord('a/b'), chunkRecord('a/b')]
  assert.equal(describePairMismatch({ records, bytes: expectedPairBytes(2) }), null)
  assert.equal(describePairMismatch({ records: [], bytes: 0 }), null)

  const short = describePairMismatch({ records, bytes: BYTES_PER_VECTOR })
  assert.match(short, /holds 1 vectors/)
  assert.match(short, /lists 2 records/)
  assert.match(short, new RegExp(`expected ${expectedPairBytes(2)}B`))

  const long = describePairMismatch({ records: [repoRecord('a/b')], bytes: expectedPairBytes(3) })
  assert.match(long, /holds 3 vectors but the index lists 1 records/)
})

test('the CI gate accepts a matching structured generation and reports its composition', async () => {
  const root = scratch('pair-ok')
  try {
    const records = [repoRecord('a/b'), chunkRecord('a/b')]
    writePair(root, { records, bytes: expectedPairBytes(records.length) })
    const report = await verifyVectorPair(root)
    assert.match(report, /2 records/)
    assert.match(report, /1 repo \+ 1 README/)
    assert.match(report, new RegExp(`${expectedPairBytes(2)}B`))
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the CI gate refuses half a pair', async () => {
  const root = scratch('pair-half')
  try {
    writePair(root, { records: [repoRecord('a/b')], bytes: undefined })
    await assert.rejects(verifyVectorPair(root), /Vector pair is incomplete/)

    fs.rmSync(path.join(root, 'embeddings-index.json'))
    fs.writeFileSync(path.join(root, 'embeddings.bin'), Buffer.alloc(BYTES_PER_VECTOR))
    await assert.rejects(verifyVectorPair(root), /Vector pair is incomplete/)
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the CI gate refuses a missing pair while the catalogue has starred repos', async () => {
  const root = scratch('pair-missing')
  try {
    writePair(root, { records: undefined, bytes: undefined, catalogueRepos: 931 })
    await assert.rejects(verifyVectorPair(root), /semantic search would be silently disabled/)
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a fresh install has nothing to verify', async () => {
  const root = scratch('pair-fresh')
  try {
    writePair(root, { records: undefined, bytes: undefined, catalogueRepos: 0 })
    assert.match(await verifyVectorPair(root), /fresh install/)
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the CI gate refuses a pair whose binary and record index disagree', async () => {
  const root = scratch('pair-drift')
  try {
    writePair(root, {
      records: [repoRecord('a/b'), chunkRecord('a/b')],
      bytes: BYTES_PER_VECTOR,
    })
    await assert.rejects(verifyVectorPair(root), /holds 1 vectors but the index lists 2 records/)
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('nothing declares the embedding dimension again', () => {
  const sources = []
  for (const dir of ['src', 'scripts']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (name.endsWith('.js') && name !== 'embeddings.js')
        sources.push({ path: `${dir}/${name}`, text: fs.readFileSync(path.join(ROOT, dir, name), 'utf-8') })
    }
  }
  assert.ok(sources.length > 10)

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

  const build = workflows.find(workflow => workflow.name === 'build.yaml').text
  assert.match(build, /node scripts\/verify_vector_pair\.js/)
  assert.ok(build.indexOf('verify_vector_pair.js') < build.indexOf('Upload to Cloudflare R2'))
})

test('embedding validation rejects zero, invalid dimensions and non-Float32 values', () => {
  assert.equal(isEmbedding(Array.from({ length: 1024 }).fill(0.5)), true)
  for (const value of [
    null,
    [0.5],
    Array.from({ length: 1024 }).fill(0),
    Array.from({ length: 1024 }).fill(1e100),
    Array.from({ length: 1024 }).fill(1e-100),
    Array.from({ length: 1024 }).fill(Number.NaN),
  ]) {
    assert.equal(isEmbedding(value), false)
  }
})

test('the CI gate rejects same-length reordered records and a missing manifest', async () => {
  const root = scratch('manifest')
  try {
    const records = [repoRecord('a/b'), repoRecord('c/d')]
    writePair(root, { records, bytes: expectedPairBytes(2) })
    fs.writeFileSync(path.join(root, 'embeddings-index.json'), JSON.stringify([...records].reverse()))
    await assert.rejects(verifyVectorPair(root), /manifest does not match/)
    fs.rmSync(path.join(root, 'embeddings-manifest.json'))
    await assert.rejects(verifyVectorPair(root), /manifest is missing/)
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the CI gate requires a repo vector record for journal ingests', async () => {
  const root = scratch('journal-corpus')
  try {
    writePair(root, { records: [], bytes: 0, catalogueRepos: 0 })
    const directory = path.join(root, 'state', 'ingest-journal')
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'fixture.jsonl'), '{"repo":"confirmed/tool","ingested_at":"2026-10-03T00:00:00Z"}\n')
    await assert.rejects(verifyVectorPair(root), /missing confirmed repositories: confirmed\/tool/)
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('vector manifests require the exact structured-chunk profile', async () => {
  const records = [repoRecord('a/b'), chunkRecord('a/b')]
  const index = Buffer.from(JSON.stringify(records))
  const binary = Buffer.alloc(expectedPairBytes(records.length))
  const current = await vectorManifest(records, index, binary)

  assert.equal(current.input_profile, EMBEDDING_INPUT_PROFILE)
  assert.equal(current.repo_count, 1)
  assert.equal(await verifyVectorManifest(current, records, index, binary), EMBEDDING_INPUT_PROFILE)

  const missingProfile = { ...current }
  delete missingProfile.input_profile
  await assert.rejects(
    verifyVectorManifest(missingProfile, records, index, binary),
    /required repo-metadata-readme-chunks-v3 generation/,
  )

  await assert.rejects(
    verifyVectorManifest({ ...current, input_profile: 'repo-metadata-readme-v2' }, records, index, binary),
    /required repo-metadata-readme-chunks-v3 generation/,
  )
})
