import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// G1 regression test: asset_store accumulateAssets idempotency, trending week-guard,
// probe-hit de-duplication, and the intent-inverted key-space contract.
//
// Self-contained by design: the fixture is built from literals so the test does not
// depend on the repository's own catalog/rankings payload (which is real user data and
// differs per deployment). Isolated via ASSET_STORE_ROOT pointing at a throwaway dir;
// dynamic import ensures PROJECT_ROOT is read AFTER the env is set (ESM static imports
// are hoisted, so a normal `import asset_store` would freeze PROJECT_ROOT to the real
// project root and pollute it).
import { after, before, test } from 'node:test'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-store-test-'))
const PROBE_FILE = '2026-02-20'
const PROMOTION_PROBE_FILE = '2026-02-21'

// Recency-relative timestamps: the promotion rule compares against the wall clock, so a
// hard-coded date would make this suite start failing three months from now.
const daysAgo = days => new Date(Date.now() - days * 86400000).toISOString()

// Two repos that are starred AND trending (week-guard), one community-only repo whose
// name carries uppercase letters (key-space contract), and one probe-discovered repo.
// `pushedAt` is deliberately the name catalog.json actually uses: the previous fixture
// spelled it `pushed_at`, which matched the reader's bug and hid it from this suite.
const CATALOG = {
  version: '1.0',
  totalRepos: 2,
  repos: {
    'Acme/PlayMaster': {
      repo: 'Acme/PlayMaster',
      name: 'PlayMaster',
      owner: 'Acme',
      url: 'https://github.com/Acme/PlayMaster',
      stars: 5000,
      description: 'a music player',
      categories: ['media-players'],
      topics: ['music'],
      pushedAt: daysAgo(5),
    },
    'small/notes': {
      repo: 'small/notes',
      name: 'notes',
      owner: 'small',
      url: 'https://github.com/small/notes',
      stars: 10,
      description: 'markdown notes',
      categories: ['reading-notes'],
      topics: [],
      pushedAt: daysAgo(5),
    },
  },
}

const RANKINGS = {
  updatedAt: '2026-02-20T00:00:00Z',
  harvested: [],
  trending: {
    overall_daily: [
      { repo: 'Acme/PlayMaster', url: 'https://github.com/Acme/PlayMaster', stars: 5000, description: 'a music player', language: 'Kotlin' },
    ],
  },
  topStarred: {},
  helloGitHub: [
    { repo: 'Legacy/ToolBox', url: 'https://github.com/Legacy/ToolBox', description_zh: '老牌工具箱', category: '工具' },
  ],
  agentSkillRepos: [],
  // The ingested repository below is deliberately ALSO on a board. The accumulator reads the boards
  // before the journal, and while a tier was kept by whichever source named it first, that ordering
  // published the user's own ingest as a board listing — the fixture used to have no such overlap,
  // which is why nothing failed.
  breakoutWeekly: [
    { repo: 'Ingested/Tool', url: 'https://github.com/Ingested/Tool', stars: 42, description: 'ingested by the worker', language: 'Go' },
  ],
}

const INTENTS = { player: ['player', 'music'], notes: ['notes', 'markdown'] }

let store

before(async () => {
  fs.mkdirSync(path.join(TMP, 'rankings'), { recursive: true })
  fs.mkdirSync(path.join(TMP, 'data'), { recursive: true })
  fs.mkdirSync(path.join(TMP, 'state', 'probe-captures'), { recursive: true })
  fs.mkdirSync(path.join(TMP, 'state', 'ingest-journal'), { recursive: true })
  fs.writeFileSync(path.join(TMP, 'catalog.json'), JSON.stringify(CATALOG))
  fs.writeFileSync(path.join(TMP, 'rankings', 'rankings.json'), JSON.stringify(RANKINGS))
  fs.writeFileSync(path.join(TMP, 'data', 'intents.json'), JSON.stringify(INTENTS))
  // An ingested repo now arrives through the append-only journal, not through rankings.json.
  // It is deliberately not named after any catalogue repo, so the curated tier it creates is
  // independent of the starred pass.
  fs.writeFileSync(
    path.join(TMP, 'state', 'ingest-journal', '2026-02-20T00-00-00-000Z-aaaa.jsonl'),
    `${JSON.stringify({ repo: 'Ingested/Tool', url: 'https://github.com/Ingested/Tool', stars: 42, description: 'ingested by the worker', categories: ['cli-tools'], reason: 'user ingested it', pushed_at: daysAgo(3), created_at: daysAgo(300), by: 'worker', ingested_at: daysAgo(1) })}\n`,
  )
  // Seeded empty state proves first_seen_at is initialised, not inherited.
  fs.writeFileSync(path.join(TMP, 'asset-state.json'), JSON.stringify({ version: 2, updatedAt: '2026-01-01T00:00:00Z', repos: {} }))
  // One probe capture, repeated verbatim, to prove probe_hits counts distinct queries only.
  const capture = { repo: 'probe/Found', url: 'https://github.com/probe/Found', stars: 150, description: 'discovered tool', pushed_at: daysAgo(15), query: 'music player' }
  fs.writeFileSync(path.join(TMP, 'state', 'probe-captures', `${PROBE_FILE}.jsonl`), `${JSON.stringify(capture)}\n${JSON.stringify(capture)}\n`)

  // Set env BEFORE importing the module (dynamic import evaluates PROJECT_ROOT at load time)
  process.env.ASSET_STORE_ROOT = TMP
  store = await import('../scripts/asset_store.js')
})

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true })
  }
  catch {
    // The temp fixture is disposable; a locked file must not fail the suite.
  }
  delete process.env.ASSET_STORE_ROOT
})

function readState() {
  return JSON.parse(fs.readFileSync(path.join(TMP, 'asset-state.json'), 'utf-8'))
}

function readIndex() {
  return JSON.parse(fs.readFileSync(path.join(TMP, 'asset-index.json'), 'utf-8'))
}

test('accumulateAssets is idempotent across runs (no repo/trending/first_seen drift)', () => {
  store.accumulateAssets()
  const s1 = readState()
  store.accumulateAssets()
  const s2 = readState()

  assert.equal(Object.keys(s2.repos).length, Object.keys(s1.repos).length, 'repo count must be stable across runs')

  const drifted = Object.entries(s2.repos)
    .filter(([k, v]) => (v.trending_count ?? 0) !== (s1.repos[k]?.trending_count ?? 0))
    .map(([k]) => k)
  assert.equal(drifted.length, 0, `trending_count drifted across runs: ${drifted.slice(0, 5)}`)

  const reset = Object.entries(s2.repos)
    .filter(([k, v]) => s1.repos[k] && v.first_seen_at !== s1.repos[k].first_seen_at)
    .map(([k]) => k)
  assert.equal(reset.length, 0, `first_seen_at reset across runs: ${reset.slice(0, 5)}`)
})

test('starred repos that also appear in trending are not over-counted (week guard)', () => {
  const s = readState()
  const starredTrending = Object.values(s.repos).filter(
    r => r.tier === 'starred' && (r.source_channels || []).some(c => c.startsWith('trending:')),
  )
  assert.ok(starredTrending.length > 0, 'fixture must exercise the starred×trending overlap')
  for (const r of starredTrending)
    assert.ok(r.last_trending_week, `starred+trending repo ${r.repo} must have last_trending_week set`)

  store.accumulateAssets()
  const s3 = readState()
  const inflated = starredTrending
    .map(r => ({ repo: r.repo, before: r.trending_count, after: s3.repos[r.repo.toLowerCase()]?.trending_count ?? 0 }))
    .filter(x => x.after !== x.before)
    .map(x => `${x.repo}:${x.before}->${x.after}`)
  assert.equal(inflated.length, 0, `starred+trending trending_count inflated: ${inflated}`)
})

test('a probe capture repeated within one file counts once (probe_hits)', () => {
  const state = readState()
  const found = state.repos['probe/found']
  assert.ok(found, 'probe capture must be accumulated')
  assert.equal(found.probe_hits, 1, 'the same query id must not inflate probe_hits across runs')
})

test('catalogue fields reach the asset map under the names it reads', () => {
  // The reader used to ask for `pushed_at` while catalog.json publishes `pushedAt`, so all
  // 931 starred entries carried an empty push date and the recency rule could never fire.
  const state = readState()
  const starred = Object.values(state.repos).filter(r => r.tier === 'starred')
  assert.ok(starred.length > 0, 'fixture must contain starred repos')
  const missing = starred.filter(r => !r.pushed_at).map(r => r.repo)
  assert.deepEqual(missing, [], `these starred repos lost their push date between catalog.json and asset-state.json: ${missing.join(', ')}`)
  assert.ok(
    starred.every(r => Date.parse(r.pushed_at) > Date.parse('2020-01-01')),
    'the push date must be the catalogue value, not an empty string that Date.parse accepts as NaN',
  )
})

test('intent_inverted values resolve against assetIndex.repos keys (key-space contract)', () => {
  const index = readIndex()
  const keys = new Set(Object.keys(index.repos))
  const unresolved = []
  for (const [word, repos] of Object.entries(index.intent_inverted)) {
    for (const repo of repos) {
      if (!keys.has(repo.toLowerCase()))
        unresolved.push(`${word}:${repo}`)
    }
  }
  assert.equal(unresolved.length, 0, `every intent_inverted entry must resolve to a repos key via lowercase: ${unresolved.slice(0, 5)}`)

  // The uppercase-named community repo must be reachable through its canonical key.
  assert.ok(index.repos['legacy/toolbox'], 'uppercase-named repo must be in the hot set')
  assert.equal(index.repos['legacy/toolbox'].repo, 'Legacy/ToolBox', 'display casing must survive in the `repo` field')
})

test('a HelloGitHub pick does not inherit HelloGitHub\u2019s own section as a category', () => {
  // The section it was published under ("工具") is HelloGitHub's classification, not one the deployer
  // assigned. Writing it into `categories` made `?category=工具` return a repository that is in none of
  // their lists, and put a source's label in the field their own taxonomy lives in.
  const pick = readState().repos['legacy/toolbox']
  assert.ok(pick, 'the fixture must exercise a HelloGitHub-only repository')
  assert.deepEqual(pick.categories, [], 'a source classification is not a deployer category')
  assert.deepEqual(readIndex().repos['legacy/toolbox'].categories, [], 'and it must not reach the hot set either')
})

test('an ingest from the journal becomes a curated asset with the fields the Worker recorded', () => {
  // The curated tier used to be built from rankings.harvested, which the scheduled build
  // replaced wholesale — that is how an ingest could disappear. The journal is folded instead,
  // and the fields the Worker wrote must survive the trip.
  const curated = Object.values(readState().repos).find(r => r.repo === 'Ingested/Tool')
  assert.ok(curated, 'the journal entry must be accumulated')
  assert.equal(curated.tier, 'curated', 'the user staged this repository themselves — a board carrying it too must not downgrade the description of it')
  assert.deepEqual(
    curated.source_channels,
    ['breakout', 'user_ingest'],
    'the fixture must really exercise the board-plus-ingest overlap',
  )
  assert.equal(curated.pushed_at !== '', true, 'the push date must come through from the journal entry')
  assert.equal(curated.created_at !== '', true, 'the creation date must come through from the journal entry')
  assert.equal(
    curated.reason,
    'user ingested it',
    'the reason the user gave at ingest time is what the result list shows; the row builder used to keep only a reason it had inherited from somewhere else',
  )
  assert.ok(
    readIndex().repos['ingested/tool'],
    'a curated asset belongs in the hot set the Worker loads',
  )
})

test('a second ingest of the same repository replaces the first without leaving a duplicate', () => {
  const journalDir = path.join(TMP, 'state', 'ingest-journal')
  const second = { ...JSON.parse(fs.readFileSync(path.join(journalDir, '2026-02-20T00-00-00-000Z-aaaa.jsonl'), 'utf-8')), stars: 99, ingested_at: new Date().toISOString() }
  const secondPath = path.join(journalDir, '2026-02-21T00-00-00-000Z-bbbb.jsonl')
  fs.writeFileSync(secondPath, `${JSON.stringify(second)}\n`)

  try {
    store.accumulateAssets()
    const matching = Object.values(readState().repos).filter(r => r.repo.toLowerCase() === 'ingested/tool')
    assert.equal(matching.length, 1, 'the same repo ingested twice must fold into one asset')
    assert.equal(matching[0].stars, 99, 'the newest ingest wins')
  }
  finally {
    fs.rmSync(secondPath, { force: true })
    store.accumulateAssets()
  }
})

// Runs last: it writes synthetic state/files, so keep it after the ordering-sensitive tests.
test('a repo that is no longer in catalog.json loses the starred tier', () => {
  const seeded = readState()
  seeded.repos['ghost/old-star'] = {
    repo: 'Ghost/Old-Star',
    name: 'Old-Star',
    owner: 'Ghost',
    url: 'https://github.com/Ghost/Old-Star',
    description: 'unstarred long ago',
    stars: 900,
    categories: [],
    topics: [],
    tier: 'starred',
    is_starred: 1,
    first_seen_at: '2026-01-01T00:00:00Z',
    last_seen_at: '2026-01-01T00:00:00Z',
    source_channels: ['github_star'],
    trending_count: 0,
    probe_hits: 0,
    probe_queries: [],
    untrusted: 0,
  }
  fs.writeFileSync(path.join(TMP, 'asset-state.json'), JSON.stringify(seeded))

  store.accumulateAssets()
  const after = readState().repos['ghost/old-star']

  assert.ok(after, 'the repo must be kept as a community asset, not deleted')
  assert.equal(after.tier, 'community', 'tier must follow the CURRENT star state')
  assert.equal(after.is_starred, 0, 'a repo absent from catalog.json is not starred by the user')
  assert.equal(
    readIndex().starredCount,
    Object.keys(CATALOG.repos).length,
    'starredCount must equal the catalog size, not the historical maximum',
  )
})

// Also runs last: it temporarily replaces catalog.json.
test('an authoritative empty catalogue removes stale starred status', () => {
  const catalogPath = path.join(TMP, 'catalog.json')
  const original = fs.readFileSync(catalogPath, 'utf-8')
  fs.writeFileSync(catalogPath, JSON.stringify({ version: '1.0', totalRepos: 0, categories: [], repos: {} }))

  try {
    const before = readState()
    const starredBefore = Object.values(before.repos).filter(r => r.tier === 'starred').length
    assert.ok(starredBefore > 0, 'fixture must contain starred assets for this test to mean anything')

    store.accumulateAssets()

    const after = readState()
    const starredAfter = Object.values(after.repos).filter(r => r.tier === 'starred').length
    assert.equal(
      starredAfter,
      0,
      'a successful empty star listing must clear the old starred status',
    )
    assert.equal(after.repos['acme/playmaster'].is_starred, 0)
  }
  finally {
    fs.writeFileSync(catalogPath, original)
  }
})

// Runs last: it writes a new probe file, so earlier assertions keep their fixture intact.
test('a discovery is promoted only after a second, different query confirms it', () => {
  // The promotion rule is the whole point of the probe layer: one probe hit is a guess,
  // two independent queries are a signal. This was unobservable before — the rule read a
  // push date that never arrived, so no entry could ever be promoted.
  const probePath = path.join(TMP, 'state', 'probe-captures', `${PROMOTION_PROBE_FILE}.jsonl`)
  const discovered = {
    repo: 'probe/Promoted',
    url: 'https://github.com/probe/Promoted',
    stars: 150,
    description: 'a tool that showed up twice',
    pushed_at: daysAgo(5),
    query: 'first query',
  }

  fs.writeFileSync(probePath, `${JSON.stringify(discovered)}\n`)
  store.accumulateAssets()
  assert.equal(
    readState().repos['probe/promoted']?.tier,
    'discovered',
    'a single query must not promote a discovery',
  )

  fs.writeFileSync(probePath, `${JSON.stringify(discovered)}\n${JSON.stringify({ ...discovered, query: 'a different query' })}\n`)
  store.accumulateAssets()
  assert.equal(
    readState().repos['probe/promoted']?.tier,
    'community',
    'two distinct queries plus a recent push must promote the discovery into the community tier',
  )
  assert.ok(
    readIndex().repos['probe/promoted'],
    'a promoted entry belongs in the hot set the Worker loads',
  )
})

test('corrupt state or probe journals cannot overwrite published local assets', () => {
  const statePath = path.join(TMP, 'asset-state.json')
  const indexPath = path.join(TMP, 'asset-index.json')
  const originalState = fs.readFileSync(statePath)
  const originalIndex = fs.readFileSync(indexPath)
  const probePath = path.join(TMP, 'state', 'probe-captures', 'broken.jsonl')
  try {
    fs.writeFileSync(statePath, '{broken')
    assert.throws(() => store.accumulateAssets(), /Refusing to overwrite persisted asset history/)
    assert.deepEqual(fs.readFileSync(indexPath), originalIndex)
    fs.writeFileSync(statePath, originalState)
    fs.writeFileSync(probePath, '{broken')
    assert.throws(() => store.accumulateAssets(), /Could not read probe capture broken.jsonl/)
    assert.deepEqual(fs.readFileSync(statePath), originalState)
    assert.deepEqual(fs.readFileSync(indexPath), originalIndex)
  }
  finally {
    fs.writeFileSync(statePath, originalState)
    fs.unlinkSync(probePath)
  }
})

test('the hot index includes a snapshot of exactly the ingests folded by CI', () => {
  const snapshot = readIndex().ingest_snapshot
  assert.ok(snapshot.keys.every(key => key.startsWith('state/ingest-journal/')))
  assert.equal(snapshot.entries.find(entry => entry.repo.toLowerCase() === 'ingested/tool').reason, 'user ingested it')
  assert.ok(snapshot.entries.every(entry => snapshot.keys.includes(entry.key)))
})

test('a previous generation snapshot preserves compacted ingests after raw objects are deleted', () => {
  const previousPath = path.join(TMP, 'previous-asset-index.json')
  const compactedKey = 'state/ingest-journal/compacted-old.jsonl'
  const entry = {
    repo: 'Compacted/Tool',
    description: 'survives raw journal compaction',
    reason: 'durable curator memory',
    ingested_at: '2026-02-19T00:00:00Z',
    key: compactedKey,
  }

  fs.writeFileSync(previousPath, JSON.stringify({
    ingest_snapshot: { keys: [compactedKey], entries: [entry] },
  }))

  try {
    store.accumulateAssets()
    const state = readState()
    const snapshot = readIndex().ingest_snapshot

    assert.equal(state.repos['compacted/tool']?.tier, 'curated')
    assert.equal(state.repos['compacted/tool']?.reason, 'durable curator memory')
    assert.equal(snapshot.entries.some(item => item.repo === 'Compacted/Tool'), true)
    assert.equal(
      snapshot.keys.includes(compactedKey),
      false,
      'a raw key already absent from R2 must fall out of the next snapshot key set',
    )
  }
  finally {
    fs.rmSync(previousPath, { force: true })
    store.accumulateAssets()
  }
})


test('the hot index snapshots the raw probe keys folded by this generation', () => {
  const snapshot = readIndex().probe_snapshot
  assert.ok(Array.isArray(snapshot.keys))
  assert.ok(snapshot.keys.every(key => key.startsWith('state/probe-captures/')))
})
