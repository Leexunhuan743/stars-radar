import assert from 'node:assert/strict'
// The document loaders, against a fake bucket.
//
// These are the functions that decide what a request is answered with when R2 misbehaves, and until
// this module existed they lived in the Worker entry, which no test can import. The behaviours
// below are the ones that have actually gone wrong: an unreadable document answered as an empty
// one, a stale document pinned for the whole TTL, and a vector pair whose halves disagree being
// reported as "no vectors yet".
import { test } from 'node:test'
import { DOCUMENT_TTL_MS } from '../src/document-cache.js'
import {
  dataPlaneStatus,
  getAssetIndex,
  getCatalog,
  getHarvested,
  getRankings,
  getVectors,
  JOURNAL_TTL_MS,
  resetDocumentCaches,
  seedRankings,
} from '../src/documents.js'
import { vectorManifest } from '../src/embeddings.js'
import { INGEST_JOURNAL_PREFIX } from '../src/object-keys.js'

/** Minimal R2 stand-in: objects are `{ key: value }`; a value of `Error` means "read fails". */
function bucket(objects = {}, { listFails = false } = {}) {
  const reads = []
  const object = key => ({
    json: async () => JSON.parse(objects[key]),
    text: async () => objects[key],
    arrayBuffer: async () => objects[key],
  })
  return {
    reads,
    async get(key) {
      reads.push(key)
      if (!(key in objects))
        return null
      if (objects[key] instanceof Error)
        throw objects[key]
      return object(key)
    },
    async list({ prefix } = {}) {
      if (listFails)
        throw new Error('R2 list unavailable')
      const keys = Object.keys(objects).filter(key => !prefix || key.startsWith(prefix))
      return { objects: keys.map(key => ({ key })), truncated: false }
    },
    async put() {
      throw new Error('the loaders never write')
    },
  }
}

const CATALOG = JSON.stringify({ repos: { 'a/b': { repo: 'a/b' } }, categories: [], totalRepos: 1 })

function repoRecord(repo) {
  return { id: `repo:${repo.toLowerCase()}`, repo, kind: 'repo' }
}
const JOURNAL_ENTRY = JSON.stringify({ repo: 'acme/tool', by: 'worker', ingested_at: '2026-02-26T00:00:00.000Z' })

test.beforeEach(() => {
  resetDocumentCaches()
})

test('an absent document is served as the documented placeholder', async () => {
  const env = { R2: bucket({}) }

  assert.deepEqual(await getCatalog(env), { repos: {}, categories: [] })
  const rankings = await getRankings(env)
  assert.deepEqual(Object.keys(rankings).sort(), ['agentSkillRepos', 'agentSkills', 'breakoutWeekly', 'helloGitHub', 'topStarred', 'trending'])
  assert.deepEqual(await getHarvested(env), [])
  assert.deepEqual(await getVectors(env), { vectors: null, records: null })
  const { statuses, degraded } = dataPlaneStatus()
  assert.equal(statuses.catalog, 'missing', 'an absent document is a first run, not a fault')
  assert.equal(degraded, false, 'nothing is published yet, so nothing is degraded')
})

test('an unreadable document is reported as unavailable instead of empty', async () => {
  const env = { R2: bucket({ 'catalog.json': new Error('R2 unreachable') }) }

  await assert.rejects(getCatalog(env), /Could not read catalog\.json/, 'a failed read must not look like an empty catalogue')
  const { statuses, degraded } = dataPlaneStatus()
  assert.equal(statuses.catalog, 'unavailable')
  assert.equal(degraded, true, '/health must say so rather than answering "ok"')
})

test('a warm cache answers without touching the bucket again', async () => {
  // The whole reason these loaders exist: a request must not pay an R2 round trip per document.
  const env = { R2: bucket({ 'catalog.json': CATALOG }) }
  await getCatalog(env)
  await getCatalog(env)
  assert.deepEqual(env.R2.reads, ['catalog.json'], 'the second read must come from the cache')
  assert.equal(dataPlaneStatus().statuses.catalog, 'fresh')

  // How long a cached document survives, and what happens when it expires, is
  // test/document-cache.test.mjs's subject; this module only has to wire the loaders up.
  resetDocumentCaches()
  assert.deepEqual(dataPlaneStatus().statuses, {
    catalog: 'unknown',
    rankings: 'unknown',
    assetIndex: 'unknown',
    vectors: 'unknown',
    ingestJournal: 'unknown',
  })
})

test('a vector pair whose halves disagree is unavailable, not an empty index', async () => {
  const records = [repoRecord('a/b'), repoRecord('c/d')]
  const index = JSON.stringify(records)
  const bytes = new Uint8Array(2 * 1024 * 4)
  const shortBytes = new Uint8Array(1024 * 4)
  const manifest = await vectorManifest(records, new TextEncoder().encode(index), bytes)
  const env = { R2: bucket({ 'embeddings-index.json': index, 'embeddings.bin': bytes.buffer, 'embeddings-manifest.json': JSON.stringify(manifest) }) }

  const pair = await getVectors(env)
  assert.equal(pair.records.length, 2, 'a consistent pair loads')

  resetDocumentCaches()
  const broken = { R2: bucket({ 'embeddings-index.json': index, 'embeddings.bin': shortBytes.buffer }) }
  await assert.rejects(getVectors(broken), /invariant violated/, 'the mismatch must surface as a fault')
  assert.equal(dataPlaneStatus().statuses.vectors, 'unavailable')
})

test('same-length mixed vector generations are rejected by their content manifest', async () => {
  const records = [repoRecord('a/b')]
  const index = JSON.stringify(records)
  const original = new Uint8Array(1024 * 4)
  const manifest = await vectorManifest(records, new TextEncoder().encode(index), original)
  const changed = new Uint8Array(1024 * 4)
  changed[0] = 1
  const env = { R2: bucket({
    'embeddings-index.json': index,
    'embeddings.bin': changed.buffer,
    'embeddings-manifest.json': JSON.stringify(manifest),
  }) }
  await assert.rejects(getVectors(env), /manifest does not match/)
  assert.equal(dataPlaneStatus().statuses.vectors, 'unavailable')
})

test('an incomplete vector generation is a fault rather than an empty successful index', async () => {
  await assert.rejects(getVectors({ R2: bucket({ 'embeddings-index.json': '["a/b"]' }) }), /generation is incomplete/)
})

test('unreadable journal lines fail visibly instead of silently shrinking the user view', async () => {
  const env = { R2: bucket({ [`${INGEST_JOURNAL_PREFIX}bad.jsonl`]: `${JOURNAL_ENTRY}\nnot json\n` }) }
  await assert.rejects(getHarvested(env), /bad.jsonl: 1 unreadable line/)
  assert.equal(dataPlaneStatus().statuses.ingestJournal, 'unavailable')
})

test('the journal can grow beyond 200 ingests without disabling search', async () => {
  const entries = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [
    `${INGEST_JOURNAL_PREFIX}${index}.jsonl`,
    JSON.stringify({ repo: `fixture/tool${index}` }),
  ]))
  assert.equal((await getHarvested({ R2: bucket(entries) })).length, 200)
  resetDocumentCaches()
  assert.equal((await getHarvested({ R2: bucket({ ...entries, [`${INGEST_JOURNAL_PREFIX}extra.jsonl`]: JOURNAL_ENTRY }) })).length, 201)
})

test('a journal object disappearing after listing is not silently ignored', async () => {
  const env = { R2: {
    list: async () => ({ objects: [{ key: `${INGEST_JOURNAL_PREFIX}missing.jsonl` }], truncated: false }),
    get: async () => null,
  } }
  await assert.rejects(getHarvested(env), /disappeared after listing.*partial ingest view/)
})

test('a CI snapshot avoids old-object reads and includes writes arriving during the build', async () => {
  const oldKey = `${INGEST_JOURNAL_PREFIX}old.jsonl`
  const newKey = `${INGEST_JOURNAL_PREFIX}new.jsonl`
  const old = { repo: 'acme/tool', reason: 'old note', ingested_at: '2026-10-01T00:00:00Z', key: oldKey }
  const current = { repo: 'acme/tool', reason: 'new note', ingested_at: '2026-10-02T00:00:00Z' }
  const r2 = bucket({
    'asset-index.json': JSON.stringify({ ingest_snapshot: { keys: [oldKey], entries: [old] } }),
    [oldKey]: new Error('old objects must not be fetched again'),
    [newKey]: JSON.stringify(current),
  })
  assert.deepEqual(await getHarvested({ R2: r2 }), [current])
  assert.equal(r2.reads.includes(oldKey), false)
  assert.equal(r2.reads.includes(newKey), true)
})

test('the journal snapshot and tail fold across every listing page', async () => {
  const first = `${INGEST_JOURNAL_PREFIX}one.jsonl`
  const second = `${INGEST_JOURNAL_PREFIX}two.jsonl`
  const r2 = bucket({ [first]: JSON.stringify({ repo: 'acme/one' }), [second]: JSON.stringify({ repo: 'acme/two' }) })
  const cursors = []
  r2.list = async ({ cursor }) => {
    cursors.push(cursor)
    return cursor ? { objects: [{ key: second }], truncated: false } : { objects: [{ key: first }], truncated: true, cursor: 'next' }
  }
  assert.equal((await getHarvested({ R2: r2 })).length, 2)
  assert.deepEqual(cursors, [undefined, 'next'])
})

test('the ingest journal is folded, and a listing failure is not an empty journal', async () => {
  const env = { R2: bucket({ [`${INGEST_JOURNAL_PREFIX}one.jsonl`]: `${JOURNAL_ENTRY}\n` }) }
  const harvested = await getHarvested(env)
  assert.equal(harvested.length, 1)
  assert.equal(harvested[0].repo, 'acme/tool')
  assert.equal(dataPlaneStatus().statuses.ingestJournal, 'fresh')

  resetDocumentCaches()
  const broken = { R2: bucket({}, { listFails: true }) }
  await assert.rejects(getHarvested(broken), /Could not read/, 'an unlistable prefix must not fold to zero entries')
  assert.equal(dataPlaneStatus().statuses.ingestJournal, 'unavailable')
})

test('a freshly written rankings document can be installed without waiting out the TTL', async () => {
  const env = { R2: bucket({ 'rankings.json': JSON.stringify({ trending: { overall_daily: [{ repo: 'x/y' }] } }) }) }
  await getRankings(env)

  seedRankings({ trending: { overall_daily: [{ repo: 'fresh/one' }] } })
  const seeded = await getRankings(env)
  assert.equal(seeded.trending.overall_daily[0].repo, 'fresh/one', 'the writer must see its own update')
})

test('the archive listing skips the state objects', async () => {
  // The bucket also holds JSON documents and the state prefixes; `R2.list` counts them towards its
  // limit, so a loader that failed to page would report an empty corpus.
  const env = { R2: bucket({ 'asset-index.json': '{}', [`${INGEST_JOURNAL_PREFIX}one.jsonl`]: `${JOURNAL_ENTRY}\n` }) }
  assert.deepEqual(await getAssetIndex(env), {}, 'asset-index.json is read by key, not by listing')
})

test('the ingest journal converges far sooner than the documents a build replaces', () => {
  // The journal is the one document a *user action* changes, and the ingest response tells the caller
  // the entry is there. Under the shared half-hour TTL the isolate that handled the write answered
  // from its seeded cache while every other one served the previous fold: on a live deployment the
  // same query returned `🌐 Global Discovery` and `⚡ Community Ingested` for one repository inside the
  // same minute, and `/health` reported two different ingest counts a second apart. The value is
  // pinned as a literal because it is a policy, not a derived quantity — a deliberate change has to
  // change this line too.
  assert.equal(JOURNAL_TTL_MS, 60 * 1000)
  assert.ok(
    JOURNAL_TTL_MS < DOCUMENT_TTL_MS,
    'the folded journal must converge within a minute, not on the derived documents\u2019 schedule',
  )
})
