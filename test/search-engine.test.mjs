import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DIMS } from '../src/embeddings.js'
import { searchDocuments } from '../src/search-engine.js'

const INTENTS = { terminal: ['terminal', 'cli'], browser: ['browser'] }

function repoRecord(repo) {
  return { id: `repo:${repo.toLowerCase()}`, repo, kind: 'repo' }
}
function readmeRecord(repo, heading, text) {
  return {
    id: `readme:${repo.toLowerCase()}:fixture`,
    repo,
    kind: 'readme_chunk',
    heading,
    text,
  }
}

function search(query, options = {}, documents = {}) {
  return searchDocuments({
    catalog: { repos: {} },
    rankings: {},
    assetIndex: { repos: {}, intent_inverted: {} },
    harvested: [],
    vectors: { values: null, records: null },
    queryVector: null,
    intents: INTENTS,
    ...documents,
  }, query, options)
}

const INGESTED = {
  repo: 'acme/noveltool',
  description: 'an unusual project',
  reason: 'chosen for zephyr integration',
  categories: ['research'],
  stars: 7,
}

test('an ingest is searchable by its user reason before any asset-index rebuild', () => {
  const [result] = search('zephyr', { source: 'curated', category: 'research' }, { harvested: [INGESTED] })
  assert.equal(result.repo, 'acme/noveltool')
  assert.equal(result.source, 'curated')
  assert.equal(result.reason, 'chosen for zephyr integration')
  assert.deepEqual(result.categories, ['research'])
  assert.equal(result.relevance_score, 0.857)
})

test('an ingest matching an intent is offered without vectors and does not bypass the subject gate', () => {
  const harvested = [{ ...INGESTED, description: 'a terminal cli' }]
  assert.equal(search('terminal', {}, { harvested }).length, 1)
  assert.deepEqual(search('unrelated terminal', {}, { harvested }), [])
})

test('journal entries are included in rankings scope but never masquerade as existing stars', () => {
  const documents = { harvested: [INGESTED] }
  assert.equal(search('zephyr', { scope: 'rankings' }, documents).length, 1)
  assert.deepEqual(search('zephyr', { scope: 'starred' }, documents), [])
  assert.deepEqual(search('zephyr', { source: 'starred' }, documents), [])
})

test('an overlapping board cannot erase the ingested category or reason', () => {
  const documents = {
    harvested: [INGESTED],
    rankings: { trending: { overall_daily: [{ repo: INGESTED.repo, description: 'zephyr terminal', stars: 100 }] } },
  }
  const results = search('zephyr', {}, documents)
  assert.equal(results.length, 1)
  assert.equal(results[0].source, 'curated')
  assert.equal(results[0].reason, INGESTED.reason)
  assert.deepEqual(results[0].categories, ['research'])
})

test('a repository already starred is returned once under the starred source', () => {
  const results = search('zephyr', {}, {
    catalog: { repos: { [INGESTED.repo]: INGESTED } },
    harvested: [INGESTED],
  })
  assert.equal(results.length, 1)
  assert.equal(results[0].source, 'starred')
})

test('a new reason for an existing star is immediately searchable before the catalogue rebuild', () => {
  const results = search('quantum', {}, {
    catalog: { repos: { 'acme/tool': { repo: 'acme/tool', description: 'generic utility', reason: 'old note' } } },
    harvested: [{ repo: 'acme/tool', reason: 'quantum research' }],
  })
  assert.equal(results.length, 1)
  assert.equal(results[0].source, 'starred')
  assert.equal(results[0].reason, 'quantum research')
})

test('a vector for an unstarred repository cannot leak into starred-only search', () => {
  const values = new Float32Array(DIMS * 2)
  values[0] = 1
  values[DIMS] = 1
  const queryVector = new Float32Array(DIMS)
  queryVector[0] = 1
  const results = search('terminal', { scope: 'starred' }, {
    catalog: { repos: { 'me/saved': { description: 'a terminal' } } },
    vectors: { values, records: [repoRecord('me/saved'), repoRecord('other/public')] },
    queryVector,
  })
  assert.deepEqual(results.map(result => result.repo), ['me/saved'])
  assert.equal(results[0].vector_similarity, 1)
})

test('a vector and a journal keyword hit keep curated provenance and full metadata', () => {
  const values = new Float32Array(DIMS)
  values[0] = 1
  const queryVector = new Float32Array(DIMS)
  queryVector[0] = 1
  const [result] = search('zephyr', {}, {
    harvested: [INGESTED],
    vectors: { values, records: [repoRecord(INGESTED.repo)] },
    queryVector,
  })
  assert.equal(result.source, 'curated')
  assert.equal(result.source_badge, '💎 Curated Asset')
  assert.equal(result.reason, INGESTED.reason)
  assert.equal(result.vector_similarity, 1)
})

test('explanations show actual literal evidence and are omitted by default', () => {
  const documents = { harvested: [INGESTED] }
  assert.equal('explanation' in search('zephyr', {}, documents)[0], false)
  const [result] = search('zephyr', { explain: true }, documents)
  assert.deepEqual(result.explanation, {
    channels: ['keyword'],
    keyword_weight: 48,
    vector_similarity: null,
    matched_tokens: ['zephyr'],
    matched_subjects: ['zephyr'],
    matched_intents: [],
  })
})

test('Chinese intent evidence includes only the matching terms of the activated domain', () => {
  const [result] = search('终端', { explain: true }, {
    intents: { terminal: ['终端', 'terminal', 'cli'] },
    harvested: [{ ...INGESTED, description: 'terminal application' }],
  })
  assert.deepEqual(result.explanation.matched_intents, [{ domain: 'terminal', terms: ['terminal'] }])
  assert.deepEqual(result.explanation.matched_tokens, [])
})

test('semantic-only matches carry vector evidence without fabricated keyword matches', () => {
  const values = new Float32Array(DIMS)
  values[0] = 1
  const queryVector = new Float32Array(DIMS)
  queryVector[0] = 1
  const [result] = search('browser', { explain: true }, {
    catalog: { repos: { 'me/tool': { description: 'a utility' } } },
    vectors: { values, records: [repoRecord('me/tool')] },
    queryVector,
  })
  assert.deepEqual(result.explanation.channels, ['vector'])
  assert.deepEqual(result.explanation.matched_tokens, [])
  assert.deepEqual(result.explanation.matched_intents, [])
  assert.equal(result.explanation.vector_similarity, 1)
})

test('GitHub name casing cannot duplicate a starred repo or change its source', () => {
  const values = new Float32Array(DIMS)
  values[0] = 1
  const queryVector = new Float32Array(DIMS)
  queryVector[0] = 1
  const results = search('zephyr', { explain: true }, {
    catalog: { repos: { 'Acme/NovelTool': { ...INGESTED, repo: 'Acme/NovelTool' } } },
    harvested: [{ ...INGESTED, repo: 'ACME/NOVELTOOL' }],
    rankings: { trending: { overall_daily: [{ repo: 'acme/noveltool', description: 'zephyr' }] } },
    vectors: { values, records: [repoRecord('ACME/NovelTool')] },
    queryVector,
  })
  assert.equal(results.length, 1)
  assert.equal(results[0].repo, 'Acme/NovelTool')
  assert.equal(results[0].source, 'starred')
  assert.deepEqual(results[0].explanation.channels, ['vector', 'keyword'])
})

test('archive recall is explained as archive recall even for a curated source', () => {
  const [result] = search('terminal', { explain: true }, {
    assetIndex: {
      repos: { 'acme/archive': { repo: 'acme/archive', description: 'a cli tool', tier: 'curated' } },
      intent_inverted: { cli: ['acme/archive'] },
    },
  })
  assert.equal(result.source, 'curated')
  assert.deepEqual(result.explanation.channels, ['archive'])
  assert.equal(result.explanation.keyword_weight, 5)
  assert.deepEqual(result.explanation.matched_intents, [{ domain: 'terminal', terms: ['cli'] }])
})

test('community evidence is collected from its scoring pool, including board language', () => {
  const [result] = search('rust', { explain: true }, {
    rankings: { trending: { overall_daily: [{ repo: 'acme/tool', description: 'a utility', language: 'Rust' }] } },
  })
  assert.equal(result.source, 'trending')
  assert.deepEqual(result.explanation.matched_tokens, ['rust'])
  assert.deepEqual(result.explanation.matched_subjects, ['rust'])
})

test('semantic-only ingested matches keep curated source without inventing literal evidence', () => {
  const values = new Float32Array(DIMS)
  values[0] = 1
  const queryVector = new Float32Array(DIMS)
  queryVector[0] = 1
  const [result] = search('browser', { explain: true }, {
    harvested: [INGESTED],
    vectors: { values, records: [repoRecord(INGESTED.repo)] },
    queryVector,
  })
  assert.equal(result.source, 'curated')
  assert.deepEqual(result.explanation.channels, ['vector'])
  assert.deepEqual(result.explanation.matched_tokens, [])
})

test('explicit community searches are not truncated by mixed-view diversity policy', () => {
  const trending = Array.from({ length: 5 }, (_, index) => ({
    repo: `community/tool-${index + 1}`,
    description: 'terminal cli utility',
    stars: 100 - index,
  }))
  const documents = { rankings: { trending: { overall_daily: trending } } }

  const bySource = search('terminal', { source: 'trending', limit: 5 }, documents)
  const byScope = search('terminal', { scope: 'rankings', limit: 5 }, documents)
  const mixed = search('terminal', { scope: 'all', limit: 5 }, documents)

  assert.equal(bySource.length, 5, 'source=trending explicitly asks for a community result set')
  assert.equal(byScope.length, 5, 'scope=rankings explicitly asks for a community result set')
  assert.equal(mixed.length, 2, 'the default mixed view keeps its discovery diversity cap')
})

test('a strong semantic vector can recover an ordinary feature absent from short metadata', () => {
  const values = new Float32Array(DIMS)
  values[0] = 1
  const queryVector = new Float32Array(DIMS)
  queryVector[0] = 0.9

  const [result] = search('webdav', { scope: 'starred', explain: true }, {
    catalog: { repos: { 'me/storage': { repo: 'me/storage', description: 'self-hosted data service' } } },
    vectors: { values, records: [repoRecord('me/storage')] },
    queryVector,
  })

  assert.equal(result.repo, 'me/storage')
  assert.deepEqual(result.explanation.channels, ['vector'])
  assert.deepEqual(result.explanation.matched_subjects, [])
})

test('README chunk vectors can recall a feature absent from repository metadata and expose semantic evidence', () => {
  const values = new Float32Array(DIMS * 2)
  values[DIMS] = 1
  const queryVector = new Float32Array(DIMS)
  queryVector[0] = 1

  const [result] = search('webdav', { scope: 'starred', explain: true }, {
    catalog: {
      repos: {
        'me/storage': {
          repo: 'me/storage',
          description: 'self-hosted data service',
        },
      },
    },
    vectors: {
      values,
      records: [
        repoRecord('me/storage'),
        readmeRecord('me/storage', 'Integrations', 'Supports WebDAV synchronization and S3-compatible storage.'),
      ],
    },
    queryVector,
  })

  assert.equal(result.repo, 'me/storage')
  assert.equal(result.vector_similarity, 1)
  assert.equal(result.explanation.semantic_evidence.repo_similarity, null)
  assert.equal(result.explanation.semantic_evidence.readme_chunk.heading, 'Integrations')
  assert.match(result.explanation.semantic_evidence.readme_chunk.snippet, /WebDAV/)
  assert.equal(result.explanation.semantic_evidence.readme_chunk.similarity, 1)
})
