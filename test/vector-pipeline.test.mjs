import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

const DIMS = 1024
const BYTES_PER_VECTOR = DIMS * 4
const PROFILE = 'repo-metadata-readme-chunks-v3'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-pipeline-test-'))
const R2_VARS = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'CLOUDFLARE_API_TOKEN', 'VECTOR_STORE_ROOT']
const ENV_VARS = [...R2_VARS, 'SILICONFLOW_URL', 'SILICONFLOW_KEY']
const savedEnv = Object.fromEntries(ENV_VARS.map(key => [key, process.env[key]]))
const realFetch = globalThis.fetch

let downloadVectorsFromR2
let buildRepositoryVectors
let embeddingText
let repositoryVectorRows

function repoRecord(repo) {
  return { id: `repo:${repo.toLowerCase()}`, repo, kind: 'repo' }
}

before(async () => {
  process.env.VECTOR_STORE_ROOT = TMP
  process.env.R2_ACCOUNT_ID = 'account'
  process.env.R2_BUCKET = 'bucket'
  process.env.CLOUDFLARE_API_TOKEN = 'token'
  process.env.SILICONFLOW_URL = 'https://embeddings.test/v1/embeddings'
  process.env.SILICONFLOW_KEY = 'test-key'
  ;({
    downloadVectorsFromR2,
    buildRepositoryVectors,
    embeddingText,
    repositoryVectorRows,
  } = await import('../scripts/vector_pipeline.js'))
})

after(() => {
  for (const key of ENV_VARS) {
    if (savedEnv[key] === undefined)
      delete process.env[key]
    else
      process.env[key] = savedEnv[key]
  }
  globalThis.fetch = realFetch
  fs.rmSync(TMP, { recursive: true, force: true })
})

function stubR2(objects) {
  const bucket = { objects: { ...objects }, requests: [], embeddings: [] }
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    if (target.endsWith('/v1/embeddings')) {
      const body = JSON.parse(init.body)
      bucket.embeddings.push(body.input)
      const data = body.input.map((_, i) => ({
        index: i,
        embedding: Array.from({ length: DIMS }, (_, d) => (i + d + 1) / 1000),
      }))
      return Response.json({ data })
    }

    const name = target.split('/objects/')[1]
    const method = init.method || 'GET'
    bucket.requests.push(`${method} ${name}`)
    assert.equal(method, 'GET', 'the vector builder cannot mutate R2')
    const payload = bucket.objects[name]
    if (payload === undefined)
      return new Response('not found', { status: 404 })
    return new Response(payload, { status: 200 })
  }
  return bucket
}

function vectorBuffer(count) {
  return Buffer.alloc(count * BYTES_PER_VECTOR, 0x7F)
}

function manifestBytes(records, index, binary) {
  return Buffer.from(JSON.stringify({
    model: 'BAAI/bge-m3',
    input_profile: PROFILE,
    dimensions: DIMS,
    count: records.length,
    repo_count: records.filter(record => record.kind === 'repo').length,
    index_sha256: createHash('sha256').update(index).digest('hex'),
    binary_sha256: createHash('sha256').update(binary).digest('hex'),
  }))
}

function generationObjects(records, vectorCount = records.length) {
  const index = Buffer.from(JSON.stringify(records))
  const binary = vectorBuffer(vectorCount)
  return {
    'embeddings.bin': binary,
    'embeddings-index.json': index,
    'embeddings-manifest.json': manifestBytes(records, index, binary),
  }
}

function localFiles() {
  return {
    bin: path.join(TMP, 'embeddings.bin'),
    index: path.join(TMP, 'embeddings-index.json'),
    fingerprints: path.join(TMP, 'embeddings-fingerprints.json'),
    manifest: path.join(TMP, 'embeddings-manifest.json'),
  }
}

function clearLocalGeneration() {
  for (const file of Object.values(localFiles()))
    fs.rmSync(file, { force: true })
  fs.rmSync(path.join(TMP, 'stars'), { recursive: true, force: true })
}

function writeLocalGeneration(records, vectorCount = records.length) {
  const files = localFiles()
  const objects = generationObjects(records, vectorCount)
  fs.writeFileSync(files.bin, objects['embeddings.bin'])
  fs.writeFileSync(files.index, objects['embeddings-index.json'])
  fs.writeFileSync(files.manifest, objects['embeddings-manifest.json'])
}

function readLocalGeneration() {
  const files = localFiles()
  return {
    binBytes: fs.existsSync(files.bin) ? fs.statSync(files.bin).size : null,
    records: fs.existsSync(files.index) ? JSON.parse(fs.readFileSync(files.index, 'utf-8')) : null,
  }
}

test('a current structured generation in R2 is restored with its manifest', async () => {
  clearLocalGeneration()
  const records = [repoRecord('owner/one'), repoRecord('Owner/Two')]
  stubR2(generationObjects(records))

  assert.equal(await downloadVectorsFromR2(), true)

  const local = readLocalGeneration()
  assert.deepEqual(local.records, records)
  assert.equal(local.binBytes, records.length * BYTES_PER_VECTOR)
  assert.equal(fs.existsSync(localFiles().manifest), true)
})

test('an inconsistent R2 generation is rejected without writing a local baseline', async () => {
  clearLocalGeneration()
  const records = [repoRecord('a/b'), repoRecord('c/d')]
  stubR2(generationObjects(records, 1))

  assert.equal(await downloadVectorsFromR2(), false)
  assert.equal(fs.existsSync(localFiles().bin), false)
  assert.equal(fs.existsSync(localFiles().index), false)
  assert.equal(fs.existsSync(localFiles().manifest), false)
})

test('a missing manifest makes an R2 baseline unusable', async () => {
  clearLocalGeneration()
  const records = [repoRecord('a/b')]
  const objects = generationObjects(records)
  delete objects['embeddings-manifest.json']
  stubR2(objects)

  assert.equal(await downloadVectorsFromR2(), false)
  assert.equal(fs.existsSync(localFiles().bin), false)
})

test('an empty binary is not accepted as a reusable R2 generation', async () => {
  clearLocalGeneration()
  stubR2(generationObjects([]))
  assert.equal(await downloadVectorsFromR2(), false)
  assert.equal(fs.existsSync(localFiles().bin), false)
})

test('an unconfigured or partially configured R2 is skipped without issuing requests', async () => {
  const shapes = [
    {},
    { R2_ACCOUNT_ID: 'account-id' },
    { R2_ACCOUNT_ID: 'account-id', R2_BUCKET: 'bucket' },
    { R2_BUCKET: 'bucket', CLOUDFLARE_API_TOKEN: 'token' },
    { CLOUDFLARE_API_TOKEN: 'token' },
  ]

  for (const shape of shapes) {
    const saved = Object.fromEntries(R2_VARS.map(key => [key, process.env[key]]))
    try {
      for (const key of R2_VARS)
        delete process.env[key]
      Object.assign(process.env, shape)
      globalThis.fetch = () => assert.fail('incomplete R2 configuration must not issue a request')
      assert.equal(await downloadVectorsFromR2(), false)
    }
    finally {
      for (const key of R2_VARS) {
        if (saved[key] === undefined)
          delete process.env[key]
        else
          process.env[key] = saved[key]
      }
    }
  }
})

test('a malformed local generation is discarded and rebuilt from the authoritative input corpus', async () => {
  clearLocalGeneration()
  writeLocalGeneration([repoRecord('owner/one'), repoRecord('owner/two')], 1)
  const bucket = stubR2({})

  const result = await buildRepositoryVectors([{ repo: 'brand/new', description: 'a brand new repository' }])

  const local = readLocalGeneration()
  assert.deepEqual(local.records, [repoRecord('brand/new')])
  assert.equal(local.binBytes, BYTES_PER_VECTOR)
  assert.equal(result.addedCount, 1)
  assert.equal(result.repoVectors, 1)
  assert.equal(result.readmeChunkVectors, 0)
  assert.ok(bucket.requests.every(request => request.startsWith('GET ')))
})

test('an authoritative build removes records outside its confirmed input corpus', async () => {
  clearLocalGeneration()
  stubR2({})
  await buildRepositoryVectors([
    { repo: 'owner/one', description: 'one' },
    { repo: 'owner/two', description: 'two' },
  ])

  const result = await buildRepositoryVectors([{ repo: 'brand/new', description: 'new' }])
  const local = readLocalGeneration()

  assert.deepEqual(local.records, [repoRecord('brand/new')])
  assert.equal(result.removedCount, 2)
  assert.equal(result.totalVectors, 1)
})

test('the vector builder never publishes or deletes R2 objects', async () => {
  clearLocalGeneration()
  const bucket = stubR2({})
  const result = await buildRepositoryVectors([{ repo: 'brand/new', description: 'a new project' }])

  assert.equal(result.addedCount, 1)
  assert.deepEqual(Object.keys(bucket.objects), [])
  assert.ok(bucket.requests.every(request => request.startsWith('GET ')))
})

test('unchanged metadata reuses vectors while changed metadata refreshes only that repo record', async () => {
  clearLocalGeneration()
  const bucket = stubR2({})
  const inputs = [
    { repo: 'acme/one', description: 'terminal' },
    { repo: 'acme/two', description: 'notes' },
  ]

  const first = await buildRepositoryVectors(inputs)
  assert.equal(first.addedCount, 2)
  assert.equal(bucket.embeddings.length, 1)

  const repeated = await buildRepositoryVectors(inputs)
  assert.equal(repeated.addedCount, 0)
  assert.equal(repeated.updatedCount, 0)
  assert.equal(bucket.embeddings.length, 1)

  const changed = await buildRepositoryVectors([
    { ...inputs[0], description: 'offline terminal music player' },
    inputs[1],
  ])
  assert.equal(changed.updatedCount, 1)
  assert.equal(changed.totalVectors, 2)
  assert.equal(bucket.embeddings.length, 2)
  assert.equal(bucket.embeddings[1].length, 1)
  assert.match(bucket.embeddings[1][0], /offline terminal music player/)
})

test('reordering repositories reorders record slots without recomputing unchanged vectors', async () => {
  clearLocalGeneration()
  const bucket = stubR2({})
  const inputs = [
    { repo: 'acme/one', description: 'one' },
    { repo: 'acme/two', description: 'two' },
  ]
  await buildRepositoryVectors(inputs)
  const original = fs.readFileSync(localFiles().bin)

  const result = await buildRepositoryVectors([...inputs].reverse())
  const reordered = fs.readFileSync(localFiles().bin)

  assert.equal(result.updatedCount, 0)
  assert.equal(result.addedCount, 0)
  assert.equal(bucket.embeddings.length, 1)
  assert.deepEqual(reordered.subarray(0, BYTES_PER_VECTOR), original.subarray(BYTES_PER_VECTOR))
  assert.deepEqual(readLocalGeneration().records.map(record => record.repo), ['acme/two', 'acme/one'])
})

test('a damaged binary invalidates the entire generation and rebuilds from source', async () => {
  clearLocalGeneration()
  const bucket = stubR2({})
  const inputs = [{ repo: 'acme/one', description: 'one' }]
  await buildRepositoryVectors(inputs)

  const damaged = fs.readFileSync(localFiles().bin)
  damaged[0] ^= 255
  fs.writeFileSync(localFiles().bin, damaged)

  const rebuilt = await buildRepositoryVectors(inputs)
  assert.equal(rebuilt.addedCount, 1)
  assert.equal(rebuilt.updatedCount, 0)
  assert.equal(bucket.embeddings.length, 2)
})

test('a short embedding response fails atomically without replacing existing artifacts', async () => {
  clearLocalGeneration()
  stubR2({})
  await buildRepositoryVectors([{ repo: 'acme/one', description: 'one' }])
  const files = Object.values(localFiles())
  const before = files.map(file => fs.readFileSync(file))

  globalThis.fetch = async () => Response.json({ data: [] })
  await assert.rejects(
    buildRepositoryVectors([{ repo: 'acme/one', description: 'changed' }]),
    /returned 0 vectors for 1 records/,
  )

  files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]))
})

test('README chunks are separate records and do not force the repo metadata vector to recompute', async () => {
  clearLocalGeneration()
  const bucket = stubR2({})
  const inputs = [{ repo: 'acme/one', description: 'generic self-hosted app' }]

  await buildRepositoryVectors(inputs)
  assert.equal(bucket.embeddings.length, 1)
  assert.equal(bucket.embeddings[0].length, 1)

  const readmeDir = path.join(TMP, 'stars', 'acme')
  fs.mkdirSync(readmeDir, { recursive: true })
  fs.writeFileSync(
    path.join(readmeDir, 'one.md'),
    [
      '---',
      'repo: acme/one',
      '---',
      '# Features',
      'Supports WebDAV synchronization and S3-compatible storage for remote backups and collaborative workflows.',
    ].join('\n'),
  )

  const rebuilt = await buildRepositoryVectors(inputs)
  assert.equal(rebuilt.addedCount, 1, 'the new README chunk is one new vector record')
  assert.equal(rebuilt.updatedCount, 0, 'repo metadata did not change')
  assert.equal(rebuilt.repoVectors, 1)
  assert.equal(rebuilt.readmeChunkVectors, 1)
  assert.equal(bucket.embeddings.length, 2)
  assert.equal(bucket.embeddings[1].length, 1)
  assert.match(bucket.embeddings[1][0], /WebDAV synchronization/)
  assert.match(bucket.embeddings[1][0], /Features/)

  const records = readLocalGeneration().records
  assert.equal(records[0].kind, 'repo')
  assert.equal(records[1].kind, 'readme_chunk')
  assert.equal(records[1].heading, 'Features')
  assert.match(records[1].text, /S3-compatible storage/)

  const stable = await buildRepositoryVectors(inputs)
  assert.equal(stable.addedCount, 0)
  assert.equal(stable.updatedCount, 0)
  assert.equal(bucket.embeddings.length, 2)
})

test('changing one README chunk replaces only that chunk vector', async () => {
  clearLocalGeneration()
  const bucket = stubR2({})
  const inputs = [{ repo: 'acme/one', description: 'generic app' }]
  const readmeDir = path.join(TMP, 'stars', 'acme')
  fs.mkdirSync(readmeDir, { recursive: true })
  const file = path.join(readmeDir, 'one.md')

  fs.writeFileSync(file, '# Features\nWebDAV synchronization is available for remote storage and collaborative workflows.')
  await buildRepositoryVectors(inputs)
  assert.equal(bucket.embeddings.length, 1)
  assert.equal(bucket.embeddings[0].length, 2)

  fs.writeFileSync(file, '# Features\nWebDAV and S3 synchronization are available for remote storage and collaborative workflows.')
  const changed = await buildRepositoryVectors(inputs)

  assert.equal(changed.addedCount, 1)
  assert.equal(changed.updatedCount, 0)
  assert.equal(changed.removedCount, 1)
  assert.equal(bucket.embeddings.length, 2)
  assert.equal(bucket.embeddings[1].length, 1, 'only the changed chunk is re-embedded')
})

test('repositoryVectorRows always emits one metadata record plus bounded README chunks', () => {
  clearLocalGeneration()
  const readmeDir = path.join(TMP, 'stars', 'acme')
  fs.mkdirSync(readmeDir, { recursive: true })
  fs.writeFileSync(
    path.join(readmeDir, 'one.md'),
    Array.from({ length: 12 }, (_, index) => (
      `## Section ${index}\n${'feature detail '.repeat(12)} section-${index}`
    )).join('\n\n'),
  )

  const rows = repositoryVectorRows({ repo: 'acme/one', description: 'metadata' })
  assert.equal(rows[0].record.kind, 'repo')
  assert.ok(rows.length <= 7, 'one repo vector plus at most six README chunks')
  assert.equal(new Set(rows.map(row => row.record.id)).size, rows.length)
})

test('embeddingText is metadata-only; README semantics live in chunk records', () => {
  clearLocalGeneration()
  const readmeDir = path.join(TMP, 'stars', 'acme')
  fs.mkdirSync(readmeDir, { recursive: true })
  fs.writeFileSync(path.join(readmeDir, 'one.md'), '# Features\nWebDAV support is documented here.')

  const text = embeddingText({ repo: 'acme/one', description: 'generic app' })
  assert.match(text, /generic app/)
  assert.doesNotMatch(text, /WebDAV/)
})
