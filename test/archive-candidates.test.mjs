import assert from 'node:assert/strict'
// Regression test for the Level-2 archive channel key-space contract.
//
// Bug being guarded: scripts/asset_store.js keys `assetIndex.repos` by the
// LOWERCASED repo full name, while `intent_inverted` values keep the original
// GitHub casing. The Worker used to resolve `assetRepos[repoName]` with the
// inverted value verbatim, so every repository whose name contains an uppercase
// letter was dropped from archive results with no error and no log line.
import { test } from 'node:test'
import { listReadmePage, resolveArchiveCandidates } from '../src/archive-candidates.js'

/**
 * A bucket whose objects are the given keys, served in the order R2 returns them.
 *
 * R2's cursor is opaque, so this stub encodes the next start index in it rather than
 * pretending it is the last key: asserting on a token that happens to look like a key would
 * pin behaviour the real service does not promise.
 */
function bucketOf(keys) {
  const calls = []
  return {
    calls,
    async list({ limit = 20, cursor } = {}) {
      const start = cursor === undefined ? 0 : Number(cursor)
      const slice = keys.slice(start, start + limit)
      const truncated = start + limit < keys.length
      calls.push({ limit, cursor, returned: slice.length })
      return {
        objects: slice.map(key => ({ key })),
        truncated,
        cursor: truncated ? String(start + limit) : undefined,
      }
    },
  }
}

test('listing skips the JSON state objects instead of returning an empty page', async () => {
  // The real bucket starts with these three, and `R2.list` limits *every* object, so a
  // filtered single page reported count 0 with has_more true against a 772-repo archive.
  const bucket = bucketOf([
    'asset-index.json',
    'catalog.json',
    'embeddings-index.json',
    'a/one.md',
    'b/two.md',
  ])

  const page = await listReadmePage(bucket, { limit: 2 })

  assert.deepEqual(page.repos, ['a/one', 'b/two'], 'the READMEs behind the JSON must be reached')
  assert.equal(page.count, 2)
  assert.equal(page.has_more, false, 'nothing is left once the READMEs are exhausted')
  assert.equal(page.next_cursor, null)
})

test('listing keeps paging until it has as many repositories as asked for', async () => {
  const keys = [...Array.from({ length: 5 }, (_, i) => `state-${i}.json`), 'a/one.md']
  const bucket = bucketOf(keys)

  const page = await listReadmePage(bucket, { limit: 1 })

  assert.deepEqual(page.repos, ['a/one'])
  assert.ok(bucket.calls.length > 1, 'one page of JSON is not enough to answer')
})

test('listing stops at the page budget rather than paging forever', async () => {
  // A bucket of pure JSON that is always truncated would otherwise loop indefinitely.
  const bucket = bucketOf(Array.from({ length: 500 }, (_, i) => `state-${i}.json`))

  const page = await listReadmePage(bucket, { limit: 5 }, 3)

  assert.equal(bucket.calls.length, 3, 'the budget bounds the work')
  assert.deepEqual(page.repos, [])
  assert.equal(page.has_more, true, 'it must not claim the archive is empty')
  // A null cursor would force a client to start over and hit the same wall; the cursor that
  // resumes past the objects already read is the only useful answer here.
  assert.equal(page.next_cursor, '15', 'the client can resume where the budget ran out')
})

test('listing reports more to come while READMEs remain', async () => {
  const bucket = bucketOf(Array.from({ length: 10 }, (_, i) => `a/r${i}.md`))

  const page = await listReadmePage(bucket, { limit: 3 })

  assert.deepEqual(page.repos, ['a/r0', 'a/r1', 'a/r2'])
  assert.equal(page.has_more, true)
  assert.equal(page.next_cursor, '3', 'the cursor is passed through for the next call')
})

test('listing resumes from a cursor', async () => {
  const bucket = bucketOf(['a/r0.md', 'a/r1.md', 'a/r2.md', 'a/r3.md'])

  const page = await listReadmePage(bucket, { limit: 2, cursor: '2' })

  assert.deepEqual(page.repos, ['a/r2', 'a/r3'])
  assert.equal(page.has_more, false)
})

test('listing an empty bucket is empty rather than an error', async () => {
  const page = await listReadmePage(bucketOf([]), { limit: 5 })
  assert.deepEqual(page.repos, [])
  assert.equal(page.has_more, false)
})

const INTENTS = {
  player: ['player', 'music'],
  notes: ['notes', 'markdown'],
}

// Mirrors buildAssetIndex(): keys are lowercase, `repo` keeps the display casing.
const ASSET_INDEX = {
  repos: {
    'moriafly/saltui': { repo: 'Moriafly/SaltUI', tier: 'community', stars: 3000, description: 'music player', url: 'https://github.com/Moriafly/SaltUI' },
    'wm94i/work-review': { repo: 'wm94i/Work-Review', tier: 'starred', stars: 120, description: 'work notes', url: 'https://github.com/wm94i/Work-Review' },
    'plain/notes-app': { repo: 'plain/notes-app', tier: 'curated', stars: 42, description: 'markdown notes' },
  },
  intent_inverted: {
    // Values carry the ORIGINAL casing, exactly as buildIntentInverted emits them.
    player: ['Moriafly/SaltUI'],
    notes: ['wm94i/Work-Review', 'plain/notes-app'],
  },
}

function resolve(overrides) {
  return resolveArchiveCandidates({
    assetIndex: ASSET_INDEX,
    intents: INTENTS,
    matchedGroups: ['player'],
    scoredRepos: new Set(),
    specificSubjects: [],
    targetCategory: undefined,
    ...overrides,
  })
}

test('repos whose display name has uppercase letters still resolve', () => {
  const [hit] = resolve({ matchedGroups: ['player'] })
  assert.ok(hit, 'uppercase-named repo must not be dropped from the archive channel')
  assert.equal(hit.repo, 'Moriafly/SaltUI', 'the display casing must be preserved in the result')
  assert.equal(hit.item.url, 'https://github.com/Moriafly/SaltUI')
  assert.equal(hit.weight, 12)
})

test('an intent word with capitals still reaches the lowercase inverted index', () => {
  // `intent_inverted` is keyed by the lowercased word (buildIntentInverted lowercases the
  // key) while the intent lists keep whatever the caller wrote, so a word like 'LLM' must
  // be folded before the lookup; an exact lookup misses the index and drops the whole group.
  const [hit] = resolve({
    matchedGroups: ['llm'],
    intents: { llm: ['LLM'] },
    assetIndex: {
      repos: { 'owner/llm-tools': { repo: 'Owner/LLM-Tools', tier: 'starred', description: 'llm tooling' } },
      intent_inverted: { llm: ['Owner/LLM-Tools'] },
    },
  })

  assert.ok(hit, 'a capitalised intent word must not resolve to nothing')
  assert.equal(hit.repo, 'Owner/LLM-Tools')
})

test('a record category is matched without regard to case', () => {
  // Stored categories keep their display casing ('Media-Players') while the classifier
  // hands the filter down already lowercased, so comparing the two verbatim filtered out
  // every repository filed under a capitalised category.
  const [hit] = resolve({
    targetCategory: 'media-players',
    assetIndex: {
      repos: { 'moriafly/saltui': { repo: 'Moriafly/SaltUI', tier: 'community', categories: ['Media-Players'] } },
      intent_inverted: { player: ['Moriafly/SaltUI'] },
    },
  })

  assert.ok(hit, 'a capitalised record category must not be filtered out')
  assert.equal(hit.repo, 'Moriafly/SaltUI')
})

test('tier drives the reported source and badge', () => {
  const byRepo = new Map(resolve({ matchedGroups: ['notes'] }).map(r => [r.repo, r]))
  assert.equal(byRepo.size, 2)
  assert.deepEqual(
    { source: byRepo.get('wm94i/Work-Review').source, badge: byRepo.get('wm94i/Work-Review').badge },
    { source: 'starred', badge: '⭐ Starred' },
  )
  assert.deepEqual(
    { source: byRepo.get('plain/notes-app').source, badge: byRepo.get('plain/notes-app').badge },
    { source: 'curated', badge: '💎 Curated Asset' },
  )
})

test('a community-tier repo reports the historical-archive presentation', () => {
  const [hit] = resolve({ matchedGroups: ['player'] })
  assert.deepEqual(
    { source: hit.source, badge: hit.badge, tier: hit.tier },
    { source: 'archive', badge: '🏛️ Historical Archive', tier: 'community' },
  )
})

test('repos already scored by the vector or keyword channel are skipped', () => {
  // scoredRepos holds LOWERCASE names, matching the canonical key space.
  const results = resolve({ matchedGroups: ['player'], scoredRepos: new Set(['moriafly/saltui']) })
  assert.equal(results.length, 0, 'a repo already scored elsewhere must not be re-added')
})

test('category and subject filters still apply to archive candidates', () => {
  assert.equal(
    resolve({ matchedGroups: ['notes'], targetCategory: 'nonexistent' }).length,
    0,
  )
  assert.equal(
    resolve({ matchedGroups: ['notes'], specificSubjects: ['salt'] }).length,
    0,
  )
  assert.equal(
    resolve({ matchedGroups: ['notes'], specificSubjects: ['work'] }).length,
    1,
  )
})

test('an intent word absent from the inverted index yields nothing', () => {
  assert.deepEqual(resolve({ matchedGroups: ['notes'], assetIndex: { repos: {}, intent_inverted: {} } }), [])
  assert.deepEqual(resolve({ matchedGroups: ['unknown-group'] }), [])
})
