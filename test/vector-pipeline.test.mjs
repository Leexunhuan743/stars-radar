import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// Tests for the vector-pair restore path and the R2 configuration contract.
//
// Two bugs are guarded here:
//   * a partially configured R2 used to abort the run. CI performs all of its R2 I/O
//     through `aws s3` and deliberately does not require CLOUDFLARE_API_TOKEN, so
//     "account set, token absent" is a supported configuration — throwing on it broke
//     every build that added a star. The other failure mode was guessing a bucket name:
//     the old `R2_BUCKET || 'github-stars'` default could read an unrelated bucket.
//   * restoring only the binary left the committed index in place, so the pair disagreed
//     by however many vectors had been appended since — a state the Worker rejects,
//     silently disabling vector search.
//
// A third bug is guarded by the append tests at the bottom: the invariant `bin bytes ==
// names * 1024 * 4` was only warned about on both sides of the append, so a run could
// publish a mismatched pair and still report success.
//
// The data root is redirected with VECTOR_STORE_ROOT before the module is imported, so
// these tests never touch the repository's own embeddings pair. `globalThis.fetch` is
// stubbed to model both the R2 REST endpoint and the embedding provider.
import { after, before, test } from 'node:test'

const DIMS = 1024
const BYTES_PER_VECTOR = DIMS * 4

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-pipeline-test-'))
const R2_VARS = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'CLOUDFLARE_API_TOKEN', 'VECTOR_STORE_ROOT']
const ENV_VARS = [...R2_VARS, 'SILICONFLOW_URL', 'SILICONFLOW_KEY']
const savedEnv = Object.fromEntries(ENV_VARS.map(k => [k, process.env[k]]))
const realFetch = globalThis.fetch

let downloadVectorsFromR2
let buildRepositoryVectors

before(async () => {
  // Env must be set before the import: the module resolves its data root and its endpoints
  // at load time.
  process.env.VECTOR_STORE_ROOT = TMP
  process.env.R2_ACCOUNT_ID = 'account'
  process.env.R2_BUCKET = 'bucket'
  process.env.CLOUDFLARE_API_TOKEN = 'token'
  process.env.SILICONFLOW_URL = 'https://embeddings.test/v1/embeddings'
  process.env.SILICONFLOW_KEY = 'test-key'
  ;({ downloadVectorsFromR2, buildRepositoryVectors } = await import('../scripts/vector_pipeline.js'))
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

/**
 * Model the R2 REST endpoint plus the embedding endpoint.
 *
 * `objects` (`{ 'embeddings.bin': Buffer }`) is what the bucket holds; unknown names 404.
 * `denyPut` lists object names whose PUT is refused with 403, which is how a publish can
 * succeed on one object and fail on the other.
 */
function stubR2(objects) {
  const bucket = { objects: { ...objects }, requests: [], embeddings: [] }
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    if (target.endsWith('/v1/embeddings')) {
      const body = JSON.parse(init.body)
      bucket.embeddings.push(body.input)
      const data = body.input.map((_, i) => ({ embedding: Array.from({ length: DIMS }, (_, d) => (i + d) / 1000) }))
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } })
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

function localFiles() {
  return {
    bin: path.join(TMP, 'embeddings.bin'),
    index: path.join(TMP, 'embeddings-index.json'),
  }
}

/** Lay down a local pair that may deliberately disagree: `vectors` worth of binary beside `names`. */
function writeLocalPair(names, vectors) {
  const { bin, index } = localFiles()
  fs.writeFileSync(bin, vectorBuffer(vectors))
  fs.writeFileSync(index, JSON.stringify(names))
}

function readLocalPair() {
  const { bin, index } = localFiles()
  return {
    binBytes: fs.existsSync(bin) ? fs.statSync(bin).size : null,
    names: fs.existsSync(index) ? JSON.parse(fs.readFileSync(index, 'utf-8')) : null,
  }
}

function clearLocalPair() {
  const { bin, index } = localFiles()
  fs.rmSync(bin, { force: true })
  fs.rmSync(index, { force: true })
  fs.rmSync(path.join(TMP, 'embeddings-fingerprints.json'), { force: true })
  fs.rmSync(path.join(TMP, 'embeddings-manifest.json'), { force: true })
  fs.rmSync(path.join(TMP, 'stars'), { recursive: true, force: true })
}

test('a consistent pair in R2 is restored, and satisfies the byte-length invariant', async () => {
  clearLocalPair()
  const names = ['owner/one', 'Owner/Two']
  stubR2({
    'embeddings.bin': vectorBuffer(names.length),
    'embeddings-index.json': Buffer.from(JSON.stringify(names)),
  })

  assert.equal(await downloadVectorsFromR2(), true)

  const { bin, index } = localFiles()
  const writtenNames = JSON.parse(fs.readFileSync(index, 'utf-8'))
  assert.deepEqual(writtenNames, names, 'display casing must survive the round trip')
  assert.equal(
    fs.statSync(bin).size,
    writtenNames.length * BYTES_PER_VECTOR,
    'the restored pair must satisfy the invariant the Worker checks',
  )
})

test('an inconsistent pair in R2 is rejected without writing anything', async () => {
  clearLocalPair()
  // The index claims three vectors while the binary holds two.
  stubR2({
    'embeddings.bin': vectorBuffer(2),
    'embeddings-index.json': Buffer.from(JSON.stringify(['a/b', 'c/d', 'e/f'])),
  })

  assert.equal(await downloadVectorsFromR2(), false, 'a mismatched pair must never be adopted')

  const { bin, index } = localFiles()
  assert.equal(fs.existsSync(bin), false, 'validation happens before any write')
  assert.equal(fs.existsSync(index), false, 'validation happens before any write')
})

test('a missing object leaves no partial pair behind', async () => {
  clearLocalPair()
  stubR2({ 'embeddings.bin': vectorBuffer(2) }) // index absent => 404

  assert.equal(await downloadVectorsFromR2(), false)

  const { bin, index } = localFiles()
  assert.equal(fs.existsSync(bin), false, 'the binary must not be written when its index is missing')
  assert.equal(fs.existsSync(index), false)
})

test('an empty object is treated as absent rather than as an empty pair', async () => {
  clearLocalPair()
  stubR2({
    'embeddings.bin': Buffer.alloc(0),
    'embeddings-index.json': Buffer.from(JSON.stringify([])),
  })

  assert.equal(await downloadVectorsFromR2(), false)

  const { bin } = localFiles()
  assert.equal(fs.existsSync(bin), false, 'a zero-byte binary must not be adopted as a baseline')
})

test('an unconfigured R2 is skipped rather than fatal', async () => {
  const saved = Object.fromEntries(R2_VARS.map(k => [k, process.env[k]]))
  try {
    for (const key of R2_VARS)
      delete process.env[key]
    globalThis.fetch = () => assert.fail('an unconfigured R2 must not issue a request')
    assert.equal(await downloadVectorsFromR2(), false)
  }
  finally {
    for (const key of R2_VARS) {
      if (saved[key] !== undefined)
        process.env[key] = saved[key]
    }
  }
})

test('a partially configured R2 is skipped rather than fatal', async () => {
  const partialShapes = [
    { R2_ACCOUNT_ID: 'account-id' },
    { R2_ACCOUNT_ID: 'account-id', R2_BUCKET: 'bucket' },
    { R2_BUCKET: 'bucket', CLOUDFLARE_API_TOKEN: 'token' },
    { CLOUDFLARE_API_TOKEN: 'token' },
  ]
  for (const shape of partialShapes) {
    const saved = Object.fromEntries(R2_VARS.map(k => [k, process.env[k]]))
    try {
      for (const key of R2_VARS)
        delete process.env[key]
      Object.assign(process.env, shape)
      globalThis.fetch = () => assert.fail('an incomplete R2 configuration must not issue a request')
      assert.equal(
        await downloadVectorsFromR2(),
        false,
        `configuration ${JSON.stringify(Object.keys(shape))} must be skipped, not fatal`,
      )
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

// ---------------------------------------------------------------------------- append path
// The pair is only valid when `bin bytes == names * 1024 * 4`. Everything below pins that
// invariant on both sides of an append: the baseline the run starts from, and what it leaves
// in the bucket.

test('a local pair that disagrees is rebuilt, and the append builds a matched local pair', async () => {
  clearLocalPair()
  writeLocalPair(['owner/one', 'owner/two', 'owner/three'], 2) // three names, two vectors
  const bucket = stubR2({}) // no usable baseline in R2 either => rebuild

  const result = await buildRepositoryVectors([{ repo: 'brand/new', description: 'a brand new repository' }])

  const local = readLocalPair()
  assert.deepEqual(local.names, ['brand/new'], 'names without a vector behind them must be dropped, not carried over')
  assert.equal(local.binBytes, local.names.length * BYTES_PER_VECTOR, 'the appended binary must hold exactly one vector per name')
  assert.equal(result.addedCount, 1)
  assert.equal('uploaded' in result, false)
  assert.ok(bucket.requests.every(request => request.startsWith('GET ')))
})

test('an authoritative build removes vectors outside its confirmed input corpus', async () => {
  clearLocalPair()
  writeLocalPair(['owner/one', 'owner/two', 'owner/three'], 2)
  const bucket = stubR2({
    'embeddings.bin': Buffer.concat([vectorBuffer(1), vectorBuffer(1)]),
    'embeddings-index.json': Buffer.from(JSON.stringify(['owner/one', 'owner/two'])),
  })

  const result = await buildRepositoryVectors([{ repo: 'brand/new', description: 'a brand new repository' }])

  const local = readLocalPair()
  assert.deepEqual(local.names, ['brand/new'])
  assert.equal(local.binBytes, local.names.length * BYTES_PER_VECTOR)
  assert.equal(result.totalVectors, 1)
  assert.equal(result.removedCount, 2)
  assert.ok(bucket.requests.every(request => request.startsWith('GET ')))
})

test('the vector builder never publishes or deletes R2 objects, even with REST credentials', async () => {
  clearLocalPair()
  writeLocalPair(['owner/one'], 1)
  const bucket = stubR2({})
  const result = await buildRepositoryVectors([{ repo: 'brand/new', description: 'a new project' }])
  assert.equal(result.addedCount, 1)
  assert.equal('uploaded' in result, false)
  assert.deepEqual(bucket.requests, [])
  assert.deepEqual(Object.keys(bucket.objects), [])
})

test('unchanged inputs reuse vectors, while changed descriptions refresh only the affected repository', async () => {
  clearLocalPair()
  const bucket = stubR2({})
  const inputs = [{ repo: 'acme/one', description: 'terminal' }, { repo: 'acme/two', description: 'notes' }]
  const first = await buildRepositoryVectors(inputs)
  assert.equal(first.addedCount, 2)
  assert.equal(bucket.embeddings.length, 1)
  const repeated = await buildRepositoryVectors(inputs)
  assert.equal(repeated.updatedCount, 0)
  assert.equal(repeated.addedCount, 0)
  assert.equal(bucket.embeddings.length, 1)
  const changed = await buildRepositoryVectors([{ ...inputs[0], description: 'offline terminal music player' }, inputs[1]])
  assert.equal(changed.updatedCount, 1)
  assert.equal(changed.totalVectors, 2)
  assert.equal(bucket.embeddings[1].length, 1)
  assert.ok(bucket.embeddings[1][0].includes('offline terminal music player'))
})

test('reordering the corpus reorders vector slots without recomputing unchanged embeddings', async () => {
  clearLocalPair()
  const bucket = stubR2({})
  const inputs = [{ repo: 'acme/one', description: 'one' }, { repo: 'acme/two', description: 'two' }]
  await buildRepositoryVectors(inputs)
  const original = fs.readFileSync(localFiles().bin)
  const result = await buildRepositoryVectors([...inputs].reverse())
  const reordered = fs.readFileSync(localFiles().bin)
  assert.equal(result.updatedCount, 0)
  assert.equal(bucket.embeddings.length, 1)
  assert.deepEqual(reordered.subarray(0, BYTES_PER_VECTOR), original.subarray(BYTES_PER_VECTOR))
  assert.deepEqual(readLocalPair().names, ['acme/two', 'acme/one'])
})

test('a same-length damaged vector is refreshed instead of trusting an old text fingerprint', async () => {
  clearLocalPair()
  const bucket = stubR2({})
  const inputs = [{ repo: 'acme/one', description: 'one' }]
  await buildRepositoryVectors(inputs)
  const damaged = fs.readFileSync(localFiles().bin)
  damaged[0] ^= 255
  fs.writeFileSync(localFiles().bin, damaged)
  assert.equal((await buildRepositoryVectors(inputs)).updatedCount, 1)
  assert.equal(bucket.embeddings.length, 2)
})

test('a short embedding response fails without replacing any of the four existing artifacts', async () => {
  clearLocalPair()
  stubR2({})
  await buildRepositoryVectors([{ repo: 'acme/one', description: 'one' }])
  const files = ['embeddings.bin', 'embeddings-index.json', 'embeddings-fingerprints.json', 'embeddings-manifest.json']
  const before = files.map(file => fs.readFileSync(path.join(TMP, file)))
  globalThis.fetch = async () => Response.json({ data: [] })
  await assert.rejects(buildRepositoryVectors([{ repo: 'acme/one', description: 'changed' }]), /returned 0 vectors for 1/)
  files.forEach((file, index) => assert.deepEqual(fs.readFileSync(path.join(TMP, file)), before[index]))
})

test('README evidence participates in embeddings and invalidates only the repository whose README changed', async () => {
  clearLocalPair()
  const bucket = stubR2({})
  const inputs = [
    { repo: 'acme/one', description: 'generic self-hosted app' },
    { repo: 'acme/two', description: 'another utility' },
  ]

  await buildRepositoryVectors(inputs)
  assert.equal(bucket.embeddings.length, 1)

  const readmeDir = path.join(TMP, 'stars', 'acme')
  fs.mkdirSync(readmeDir, { recursive: true })
  fs.writeFileSync(
    path.join(readmeDir, 'one.md'),
    '---\nrepo: acme/one\n---\n# Features\nSupports WebDAV synchronization and S3-compatible storage.',
  )

  const rebuilt = await buildRepositoryVectors(inputs)
  assert.equal(rebuilt.updatedCount, 1)
  assert.equal(rebuilt.addedCount, 0)
  assert.equal(bucket.embeddings.length, 2)
  assert.equal(bucket.embeddings[1].length, 1)
  assert.match(bucket.embeddings[1][0], /WebDAV synchronization/)
  assert.match(bucket.embeddings[1][0], /S3-compatible storage/)

  const stable = await buildRepositoryVectors(inputs)
  assert.equal(stable.updatedCount, 0)
  assert.equal(bucket.embeddings.length, 2, 'unchanged README evidence reuses the vector fingerprint')
})
