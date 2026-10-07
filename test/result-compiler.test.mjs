import assert from 'node:assert/strict'
// Result-compiler tests: source/badge derivation, info fallback order, category and
// min_score filtering and the corroborated-relevance-then-RRF ordering.
//
// These behaviours previously lived inline in src/index.js, which imports `agents/mcp`
// and cannot be loaded by plain Node — so nothing in the suite could fail when the sort
// key was inverted or relevance_score was zeroed. Every
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
  explain = false,
  catalogSnapshotAt = null,
  rankingSnapshotAt = null,
} = {}) {
  return compileResults({
    rrfMap,
    repos,
    communityMap,
    targetCategory,
    targetSource,
    minScore,
    limit,
    explain,
    catalogSnapshotAt,
    rankingSnapshotAt,
  })
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
    ranking: { score: 0 },
  })
})

test('results expose ranking separately from factual fields and explain adds provenance', () => {
  const results = compile({
    rrfMap: new Map([['a/b', vectorEntry({ vScore: 0.87654 })]]),
    repos: {
      'a/b': {
        repo: 'a/b',
        stars: 7,
        description: 'external description',
        reason: 'my research note',
        categories: ['research'],
        fieldOrigins: {
          reason: { source: 'catalog', snapshotAt: '2026-10-05T00:00:00Z', trust: 'user_trusted' },
          categories: { source: 'github_lists', snapshotAt: '2026-10-05T00:00:00Z', trust: 'user_trusted' },
        },
      },
    },
    explain: true,
    catalogSnapshotAt: '2026-10-05T00:00:00Z',
  })

  const result = results[0]
  assert.equal(result.ranking.score, 0.846)
  assert.equal(result.ranking.vector_similarity, 0.8765)
  assert.ok(result.provenance.description)
  assert.ok(result.provenance.reason)
  assert.ok(result.provenance.categories)
  assert.deepEqual(
    result.evidence.map(item => item.kind).sort(),
    ['personal_note', 'repository_description', 'repository_metadata', 'user_taxonomy'],
  )
  assert.equal(result.evidence.find(item => item.kind === 'personal_note').trust, 'user_trusted')
  assert.equal(result.evidence.find(item => item.kind === 'repository_metadata').trust, 'external_structured')
  assert.equal(result.evidence.find(item => item.kind === 'repository_description').trust, 'external_untrusted')
})

test('field origins drive personal-note source and unknown prose is never promoted to user_trusted', () => {
  const results = compile({
    rrfMap: new Map([['a/b', vectorEntry({ kwWeight: 10 })]]),
    repos: {
      'a/b': {
        repo: 'a/b',
        reason: 'ingest reason',
        summary: 'catalog summary',
        fieldOrigins: {
          reason: { source: 'ingest_journal', snapshotAt: '2026-10-05T01:00:00Z', trust: 'user_trusted' },
          summary: { source: 'catalog', snapshotAt: '2026-10-05T00:00:00Z', trust: 'user_trusted' },
        },
      },
    },
    explain: true,
    catalogSnapshotAt: '2026-10-05T00:00:00Z',
  })

  const result = results[0]
  const reason = result.evidence.find(item => item.id === result.provenance.reason)
  const summary = result.evidence.find(item => item.id === result.provenance.summary)
  assert.equal(reason.source.kind, 'ingest_journal')
  assert.equal(reason.source.snapshot_at, '2026-10-05T01:00:00Z')
  assert.equal(summary.source.kind, 'catalog')
  assert.equal(result.trust.reason, 'user_trusted')
  assert.equal(result.trust.summary, 'user_trusted')

  const [community] = compile({
    rrfMap: new Map([['x/y', vectorEntry({ source: 'ranking', kwWeight: 10, extraItem: { summary: 'public feed summary' } })]]),
    explain: true,
    rankingSnapshotAt: '2026-10-05T02:00:00Z',
  })
  const externalSummary = community.evidence.find(item => item.id === community.provenance.summary)
  assert.equal(externalSummary.kind, 'community_text')
  assert.equal(externalSummary.trust, 'external_untrusted')
  assert.equal(community.trust.summary, 'external_untrusted')
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
  // kwWeight 8 -> keywordRelevanceScore = 8 / (8 + 8) = 0.5.
  const rrfMap = new Map([
    ['a/edge', vectorEntry({ source: 'ranking', kwWeight: 8 })],
    ['a/low', vectorEntry({ source: 'ranking', kwWeight: 1 })],
  ])

  const kept = compile({ rrfMap, minScore: 0.5 })
  assert.deepEqual(kept.map(r => r.repo), ['a/edge'])
  assert.equal(kept[0].ranking.score, 0.5)

  assert.deepEqual(compile({ rrfMap, minScore: 0.5001 }), [])
})

test('corroborated relevance is the primary sort key ahead of RRF', () => {
  const results = compile({
    rrfMap: new Map([
      ['a/faint', vectorEntry({ rrf: 0.2, kwWeight: 4 })],
      ['a/strong', vectorEntry({ rrf: 0.1, kwWeight: 40, source: 'ranking' })],
    ]),
  })

  assert.deepEqual(results.map(r => r.repo), ['a/strong', 'a/faint'])
  assert.ok(results[0].ranking.score > results[1].ranking.score)
})

test('equal corroborated relevance is broken by larger RRF', () => {
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

test('result limit truncates only after corroborated relevance ordering', () => {
  const rrfMap = new Map([
    ['n/one', vectorEntry({ rrf: 0.1, source: 'ranking', kwWeight: 40 })],
    ['n/two', vectorEntry({ rrf: 0.2, source: 'ranking', kwWeight: 30 })],
    ['n/three', vectorEntry({ rrf: 0.3, source: 'ranking', kwWeight: 20 })],
  ])

  const results = compile({ rrfMap, limit: 2 })
  assert.deepEqual(results.map(result => result.repo), ['n/one', 'n/two'])
})

test('corroborating source channels are exposed without changing the primary source', () => {
  const stats = vectorEntry({ source: 'trending', kwWeight: 20 })
  stats.sourceChannels = ['trending', 'hellogithub', 'breakout']
  const [result] = compile({
    rrfMap: new Map([['acme/tool', stats]]),
  })

  assert.equal(result.source, 'trending')
  assert.deepEqual(result.source_channels, ['trending', 'hellogithub', 'breakout'])
})

test('source filtering matches corroborating channels without rewriting the primary source', () => {
  const stats = vectorEntry({ source: 'trending', kwWeight: 20 })
  stats.sourceChannels = ['trending', 'hellogithub']
  const rrfMap = new Map([['acme/tool', stats]])

  const [result] = compile({ rrfMap, targetSource: 'hellogithub' })
  assert.equal(result.repo, 'acme/tool')
  assert.equal(result.source, 'trending')
  assert.deepEqual(result.source_channels, ['trending', 'hellogithub'])
})
