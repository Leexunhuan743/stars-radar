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

const README_MANIFEST = {
  repos: Object.fromEntries(
    ['a/r0', 'a/r1', 'a/r2', 'a/r3'].map(repo => [repo, { repo }]),
  ),
}

test('listing pages the active generation README manifest', async () => {
  const page = await listReadmePage(README_MANIFEST, { limit: 2 })
  assert.deepEqual(page.repos, ['a/r0', 'a/r1'])
  assert.equal(page.count, 2)
  assert.equal(page.has_more, true)
  assert.equal(page.next_cursor, '2')
})

test('listing resumes from a manifest cursor', async () => {
  const page = await listReadmePage(README_MANIFEST, { limit: 2, cursor: '2' })
  assert.deepEqual(page.repos, ['a/r2', 'a/r3'])
  assert.equal(page.has_more, false)
  assert.equal(page.next_cursor, null)
})

test('listing an empty README manifest is empty', async () => {
  const page = await listReadmePage({ repos: {} }, { limit: 5 })
  assert.deepEqual(page.repos, [])
  assert.equal(page.has_more, false)
})

test('listing rejects an invalid README cursor', async () => {
  await assert.rejects(listReadmePage(README_MANIFEST, { limit: 2, cursor: 'bad' }), /cursor/)
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
  assert.equal(hit.weight, 5, 'one intent domain contributes one bounded score regardless of synonym count')
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

test('archive ranking rewards distinct evidence channels rather than repeated intent synonyms', () => {
  const hits = resolveArchiveCandidates({
    assetIndex: {
      repos: {
        'a/strong': { repo: 'a/strong', tier: 'community', description: 'music player with player controls' },
        'b/weak': { repo: 'b/weak', tier: 'community', description: 'music utility' },
      },
      intent_inverted: {
        player: ['a/strong'],
        music: ['a/strong', 'b/weak'],
      },
    },
    intents: INTENTS,
    matchedGroups: ['player'],
    queryTokens: ['controls'],
    scoredRepos: new Set(),
    specificSubjects: [],
  })

  const byRepo = new Map(hits.map(hit => [hit.repo, hit.weight]))
  assert.ok(byRepo.get('a/strong') > byRepo.get('b/weak'))
  assert.equal(byRepo.get('a/strong'), 13, 'explicit query-token evidence adds to the one intent-domain score')
  assert.equal(byRepo.get('b/weak'), 5)
})
