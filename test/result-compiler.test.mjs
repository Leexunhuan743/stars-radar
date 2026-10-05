import assert from 'node:assert/strict'
// Result-compiler tests: source/badge derivation, info fallback order, category and
// min_score filtering, the relevance-then-RRF ordering, and the community cap.
//
// These behaviours previously lived inline in src/index.js, which imports `agents/mcp`
// and cannot be loaded by plain Node — so nothing in the suite could fail when the sort
// key was inverted, relevance_score was zeroed, or the cap shifted by one. Every
// expected value below is a LITERAL for the same reason the ranking tests use literals:
// deriving them from the implementation would make the assertions unable to fail.
import { test } from 'node:test'
import { resolveArchiveCandidates } from '../src/archive-candidates.js'
import { COMMUNITY_LAYERS } from '../src/community-layers.js'
import { compileResults, RESULT_SOURCES } from '../src/result-compiler.js'

function compile({
  rrfMap = new Map(),
  repos = {},
  communityMap = new Map(),
  targetCategory,
  targetSource,
  minScore = 0,
  limit = 20,
  applyCommunityDiversityCap = false,
} = {}) {
  return compileResults({ rrfMap, repos, communityMap, targetCategory, targetSource, minScore, limit, applyCommunityDiversityCap })
}

// A vector-channel entry: source 'starred' is the default fuseRankings stamps on every
// repository found by the vector channel, whether or not the user actually starred it.
function vectorEntry({ rrf = 1, vScore = 0, kwWeight = 0, source = 'starred', badge, extraItem } = {}) {
  return { rrf, vScore, kwWeight, source, badge, extraItem }
}

test('a repository the user starred is sourced and badged as starred', () => {
  const results = compile({
    rrfMap: new Map([['me/mine', vectorEntry({ badge: '🌐 Public Ranking' })]]),
    repos: { 'me/mine': { url: 'https://github.com/me/mine', stars: 12, description: 'mine' } },
    communityMap: new Map([['me/mine', { url: 'https://example.test/community' }]]),
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].source, 'starred')
  assert.equal(results[0].source_badge, '⭐ Starred')
})

test('a community-ingested repository is sourced and badged as community', () => {
  const results = compile({
    rrfMap: new Map([['org/tool', vectorEntry()]]),
    communityMap: new Map([['org/tool', { url: 'https://github.com/org/tool', stars: 42 }]]),
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].source, 'community')
  assert.equal(results[0].source_badge, '⚡ Community Ingested')
})

test('a repository known only from the public rankings keeps the ranking defaults', () => {
  const results = compile({
    rrfMap: new Map([['org/ranked', vectorEntry()]]),
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].source, 'ranking')
  assert.equal(results[0].source_badge, '🌐 Public Ranking')
})

test('a non-starred channel keeps its own source and badge', () => {
  const results = compile({
    rrfMap: new Map([['org/archived', vectorEntry({ source: 'archive', badge: '📦 Archived' })]]),
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].source, 'archive')
  assert.equal(results[0].source_badge, '📦 Archived')
})

test('the catalog record wins over the community item and the keyword item', () => {
  const results = compile({
    rrfMap: new Map([['a/b', vectorEntry({
      extraItem: { description: 'from extraItem', stars: 1, categories: ['extra'] },
    })]]),
    repos: { 'a/b': { description: 'from catalog', stars: 3, categories: ['catalog'] } },
    communityMap: new Map([['a/b', { description: 'from community', stars: 2, categories: ['community'] }]]),
  })

  assert.equal(results[0].description, 'from catalog')
  assert.equal(results[0].stars, 3)
  assert.deepEqual(results[0].categories, ['catalog'])
})

test('the community item wins over the keyword item when the catalog has no record', () => {
  const results = compile({
    rrfMap: new Map([['a/b', vectorEntry({
      extraItem: { description: 'from extraItem', stars: 1 },
    })]]),
    communityMap: new Map([['a/b', { description: 'from community', stars: 2 }]]),
  })

  assert.equal(results[0].description, 'from community')
  assert.equal(results[0].stars, 2)
})

test('a keyword-only repository is filled from its extraItem, not left as a bare badge', () => {
  const results = compile({
    rrfMap: new Map([['a/keyword-only', vectorEntry({
      source: 'ranking',
      kwWeight: 10,
      extraItem: {
        url: 'https://github.com/a/keyword-only',
        stars: 77,
        categories: ['cli'],
        reason: 'matched keyword cli',
        summary: 'a summary',
        description: 'a description',
      },
    })]]),
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].url, 'https://github.com/a/keyword-only')
  assert.equal(results[0].stars, 77)
  assert.deepEqual(results[0].categories, ['cli'])
  assert.equal(results[0].reason, 'matched keyword cli')
  assert.equal(results[0].summary, 'a summary')
  assert.equal(results[0].description, 'a description')
})

test('a repository with no record anywhere falls back to the github url and empty fields', () => {
  const results = compile({
    rrfMap: new Map([['a/unknown', vectorEntry()]]),
  })

  assert.deepEqual(results[0], {
    repo: 'a/unknown',
    url: 'https://github.com/a/unknown',
    source: 'ranking',
    source_badge: '🌐 Public Ranking',
    stars: undefined,
    categories: [],
    reason: undefined,
    summary: undefined,
    description: undefined,
    relevance_score: 0,
    vector_similarity: undefined,
  })
})

test('the results carry exactly the eleven documented fields', () => {
  const results = compile({
    rrfMap: new Map([['a/b', vectorEntry({ vScore: 0.87654 })]]),
  })

  assert.deepEqual(Object.keys(results[0]).sort(), [
    'categories',
    'description',
    'reason',
    'relevance_score',
    'repo',
    'source',
    'source_badge',
    'stars',
    'summary',
    'url',
    'vector_similarity',
  ])
  assert.equal(results[0].vector_similarity, 0.8765)
})

test('targetCategory matches the record categories case-insensitively', () => {
  const results = compile({
    rrfMap: new Map([
      ['a/player', vectorEntry()],
      ['a/other', vectorEntry()],
      ['a/uncategorised', vectorEntry()],
    ]),
    repos: {
      'a/player': { categories: ['Media-Players'] },
      'a/other': { categories: ['Terminal-CLI'] },
      'a/uncategorised': {},
    },
    targetCategory: 'media-players',
  })

  assert.deepEqual(results.map(r => r.repo), ['a/player'])
})

test('no targetCategory means no category filtering', () => {
  const results = compile({
    rrfMap: new Map([['a/other', vectorEntry()], ['a/uncategorised', vectorEntry()]]),
    repos: { 'a/other': { categories: ['Terminal-CLI'] } },
  })

  assert.equal(results.length, 2)
})

test('a community-layer hit carries no category, so a personal filter cannot match it', () => {
  // `categories` on a result means "a category the deployer assigned"; a community layer's
  // provenance is not one. The layers used to publish `categories: ['trending']` and friends, which
  // put a source label into the deployer's namespace — where it could collide with one of their real
  // lists and answered `?category=` with a categorisation they never made.
  const trending = {
    repo: 'acme/trending-tool',
    url: 'https://github.com/acme/trending-tool',
    stars: 900,
    description: 'came from a trending board',
  }
  const results = compile({
    rrfMap: new Map([[
      'acme/trending-tool',
      vectorEntry({ source: 'trending', badge: '🔥 Trending (overall_daily)', extraItem: trending }),
    ]]),
  })

  assert.deepEqual(results[0].categories, [], 'a source label must not appear as a category')
  assert.equal(results[0].source, 'trending', 'the provenance travels in `source`')
  assert.equal(results[0].source_badge, '🔥 Trending (overall_daily)', 'and in the badge')

  const filtered = compile({
    rrfMap: new Map([[
      'acme/trending-tool',
      vectorEntry({ source: 'trending', extraItem: trending }),
    ]]),
    targetCategory: 'trending',
  })
  assert.deepEqual(filtered, [], 'a personal category filter must not select a community-layer hit')
})

test('the source filter selects one channel, and is a different axis from the taxonomy', () => {
  // "Filter by where a hit came from" is a real need — it used to be served by abusing `categories` —
  // and it is now its own filter over the same published `source` field.
  const fromTrending = { repo: 'acme/trending-tool', url: 'https://github.com/acme/trending-tool', stars: 900 }
  const fromArchive = { repo: 'acme/old-tool', url: 'https://github.com/acme/old-tool', stars: 100, categories: ['dev-tools'] }

  const base = () => new Map([
    ['acme/trending-tool', vectorEntry({ source: 'trending', badge: '🔥 Trending (overall_daily)', extraItem: fromTrending })],
    ['acme/old-tool', vectorEntry({ source: 'archive', badge: '🏛️ Historical Archive', extraItem: fromArchive })],
  ])

  assert.deepEqual(compile({ rrfMap: base(), targetSource: 'trending' }).map(r => r.repo), ['acme/trending-tool'])
  assert.deepEqual(compile({ rrfMap: base(), targetSource: 'archive' }).map(r => r.repo), ['acme/old-tool'])
  assert.equal(compile({ rrfMap: base() }).length, 2, 'no filter means no filtering')

  // Both axes at once: the source picks the channel, the category picks the deployer's list.
  assert.deepEqual(
    compile({ rrfMap: base(), targetSource: 'archive', targetCategory: 'dev-tools' }).map(r => r.repo),
    ['acme/old-tool'],
  )
  assert.deepEqual(
    compile({ rrfMap: base(), targetSource: 'archive', targetCategory: 'media-players' }),
    [],
    'a category the archived repository is not in must exclude it',
  )
  assert.deepEqual(
    compile({ rrfMap: base(), targetSource: 'trending', targetCategory: 'dev-tools' }),
    [],
    'a trending hit is in none of the deployer\u2019s lists, so a category filter excludes it',
  )
})

test('the user\u2019s own star wins over the channel it was found through', () => {
  // A repository the deployer starred is sourced `starred` even when a board also offers it, so
  // filtering by a board finds the discoveries, not the things they already had.
  const results = compile({
    rrfMap: new Map([[
      'me/mine',
      vectorEntry({ source: 'trending', badge: '🔥 Trending (overall_daily)', extraItem: { repo: 'me/mine' } }),
    ]]),
    repos: { 'me/mine': { url: 'https://github.com/me/mine', stars: 12 } },
    targetSource: 'starred',
  })

  assert.deepEqual(results.map(r => r.repo), ['me/mine'])
})

test('every source a result can carry is registered, so a caller can ask for it', () => {
  // A source missing from RESULT_SOURCES is one `?source=` rejects as invalid — the request fails
  // instead of being answered, which is the wrong way round for a value the API itself publishes.
  assert.deepEqual(compile({ rrfMap: new Map([['a/b', vectorEntry({ source: 'archive' })]]), targetSource: 'archive' }).map(r => r.repo), ['a/b'])

  // The archive channel names its tiers, and the community layers name their boards.
  const archived = resolveArchiveCandidates({
    assetIndex: {
      repos: {
        'a/one': { repo: 'a/one', tier: 'starred', stars: 1 },
        'b/two': { repo: 'b/two', tier: 'curated', stars: 1 },
        'c/three': { repo: 'c/three', tier: 'community', stars: 1 },
        'd/four': { repo: 'd/four', tier: 'discovered', stars: 1 },
      },
      intent_inverted: { tool: ['a/one', 'b/two', 'c/three', 'd/four'] },
    },
    intents: { tools: ['tool'] },
    matchedGroups: ['tools'],
    scoredRepos: new Set(),
    specificSubjects: [],
    targetCategory: undefined,
  })

  const produced = new Set([
    ...archived.map(entry => entry.source),
    ...COMMUNITY_LAYERS.map(layer => layer.source),
    // And the three the compiler derives itself.
    'community',
    'ranking',
    'starred',
  ])
  const unregistered = [...produced].filter(source => !RESULT_SOURCES.includes(source))
  assert.deepEqual(unregistered, [], `these sources are published but cannot be filtered on: ${unregistered.join(', ')}`)
})

test('a relevance exactly at min_score is kept, anything below is dropped', () => {
  // kwWeight 8 -> keywordRelevanceScore = min(1 - 1/(1+1), 0.95) = 0.5.
  const rrfMap = new Map([
    ['a/edge', vectorEntry({ source: 'ranking', kwWeight: 8 })],
    ['a/low', vectorEntry({ source: 'ranking', kwWeight: 1 })],
  ])

  const kept = compile({ rrfMap, minScore: 0.5 })
  assert.deepEqual(kept.map(r => r.repo), ['a/edge'])
  assert.equal(kept[0].relevance_score, 0.5)

  assert.deepEqual(compile({ rrfMap, minScore: 0.5001 }), [])
})

test('relevance_score is the primary sort key, ahead of the RRF fusion score', () => {
  const results = compile({
    rrfMap: new Map([
      ['a/faint', vectorEntry({ rrf: 9, kwWeight: 4 })],
      ['a/strong', vectorEntry({ rrf: 0.01, kwWeight: 40, source: 'ranking' })],
    ]),
  })

  assert.deepEqual(results.map(r => r.repo), ['a/strong', 'a/faint'])
  assert.ok(results[0].relevance_score > results[1].relevance_score)
})

test('equal relevance is broken by the larger RRF score', () => {
  const results = compile({
    rrfMap: new Map([
      ['a/first', vectorEntry({ rrf: 0.1, source: 'ranking', kwWeight: 8 })],
      ['a/second', vectorEntry({ rrf: 0.2, source: 'ranking', kwWeight: 8 })],
      ['a/top', vectorEntry({ rrf: 0.05, source: 'ranking', kwWeight: 40 })],
    ]),
  })

  assert.deepEqual(results.map(r => r.repo), ['a/top', 'a/second', 'a/first'])
  assert.ok(results.every(r => !('_rrf' in r)), 'the internal fusion score must not leak into the output')
})

test('starred results are never dropped by the community cap', () => {
  const rrfMap = new Map()
  for (let i = 1; i <= 6; i++)
    rrfMap.set(`n/community-${i}`, vectorEntry({ rrf: i / 100, source: 'ranking', kwWeight: 40 - i }))
  rrfMap.set('me/late-starred-a', vectorEntry({ rrf: 0.001, kwWeight: 4 }))
  rrfMap.set('me/late-starred-b', vectorEntry({ rrf: 0.002, kwWeight: 4 }))

  const repos = { 'me/late-starred-a': {}, 'me/late-starred-b': {} }
  const results = compile({ rrfMap, repos, limit: 10, applyCommunityDiversityCap: true })

  // ceil(10 * 0.4) = 4 non-starred admitted, in ranked order, then both starred hits —
  // which rank last here and would otherwise be truncated away.
  assert.deepEqual(results.map(r => r.repo), [
    'n/community-1',
    'n/community-2',
    'n/community-3',
    'n/community-4',
    'me/late-starred-b',
    'me/late-starred-a',
  ])
})

test('non-starred results are truncated to ceil(limit * 0.4) without reordering', () => {
  const rrfMap = new Map([
    ['s/starred', vectorEntry({ rrf: 0.001, kwWeight: 40 })],
    ['n/one', vectorEntry({ rrf: 0.5, source: 'ranking', kwWeight: 30 })],
    ['n/two', vectorEntry({ rrf: 0.4, source: 'ranking', kwWeight: 20 })],
    ['n/three', vectorEntry({ rrf: 0.3, source: 'ranking', kwWeight: 10 })],
  ])

  const results = compile({ rrfMap, repos: { 's/starred': {} }, limit: 5, applyCommunityDiversityCap: true })

  // ceil(5 * 0.4) = 2 non-starred kept, and the starred hit is prepended in its own
  // ranked position rather than moved.
  assert.deepEqual(results.map(r => r.repo), ['s/starred', 'n/one', 'n/two'])
  assert.equal(results.filter(r => r.source !== 'starred').length, 2)
})


test('community diversity cap is opt-in so explicit result sets can fill the requested limit', () => {
  const rrfMap = new Map()
  for (let i = 1; i <= 5; i++)
    rrfMap.set(`n/community-${i}`, vectorEntry({ rrf: i / 100, source: 'trending', kwWeight: 20 }))

  const uncapped = compile({ rrfMap, limit: 5 })
  const capped = compile({ rrfMap, limit: 5, applyCommunityDiversityCap: true })

  assert.equal(uncapped.length, 5, 'an explicit community view may fill the requested limit')
  assert.equal(capped.length, 2, 'the default mixed view still applies ceil(limit*0.4)')
})
