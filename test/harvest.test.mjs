import assert from 'node:assert/strict'
import { test } from 'node:test'
import { publishHarvest } from '../scripts/harvest-publish.js'
import { harvestAndIngest } from '../scripts/harvest_and_ingest.js'
import { embeddingRepositories, foldJournalFiles } from '../src/ingest-journal.js'
import { searchDocuments } from '../src/search-engine.js'

const TARGET = { accountId: 'fixture', bucket: 'fixture', token: 'fixture' }
const RAW = {
  full_name: 'Acme/Notebook',
  name: 'Notebook',
  html_url: 'https://github.com/Acme/Notebook',
  stargazers_count: 100,
  description: 'offline research notebook',
  language: 'Rust',
  created_at: '2026-10-01T00:00:00Z',
  pushed_at: '2026-10-02T00:00:00Z',
  topics: ['research'],
  license: { spdx_id: 'MIT' },
  archived: false,
}

test('harvest metadata is appended once, immediately searchable, and queued for CI embedding', async () => {
  const writes = []
  const result = await harvestAndIngest({ source: 'breakout', since: '14d', limit: 5 }, {
    searchRepositories: async () => ({ items: [RAW] }),
    publishMetadata: repos => publishHarvest(repos, {
      target: TARGET,
      put: async (target, key, type, body) => writes.push({ key, type, body }),
    }),
  })
  assert.equal(writes.length, 1)
  assert.ok(writes[0].key.startsWith('state/ingest-journal/'))
  assert.equal(writes[0].type, 'application/x-ndjson')
  assert.equal(result.journal_key, writes[0].key)
  assert.equal(result.vector_status, 'queued_for_ci')
  const { harvested } = foldJournalFiles([{ key: writes[0].key, text: writes[0].body }])
  assert.deepEqual(harvested[0].categories, [], 'source labels must not invent personal categories')
  assert.equal(harvested[0].license, 'MIT')
  assert.equal(harvested[0].pushed_at, RAW.pushed_at)
  const hits = searchDocuments({
    catalog: { repos: {} },
    rankings: {},
    assetIndex: { repos: {}, intent_inverted: {} },
    harvested,
    vectors: { values: null, names: null },
    queryVector: null,
    intents: {},
  }, 'offline')
  assert.equal(hits[0].repo, 'Acme/Notebook')
  assert.equal(hits[0].source, 'curated')
  assert.equal(embeddingRepositories({}, harvested)[0].repo, 'Acme/Notebook')
})

test('CI includes non-starred ingests and preserves their reasons when a star overlaps', () => {
  const repositories = embeddingRepositories({
    'acme/tool': { repo: 'acme/tool', stars: 200, description: 'current GitHub metadata', reason: 'old note' },
  }, [
    { repo: 'Acme/Tool', stars: 100, reason: 'selected for offline use' },
    { repo: 'other/ingest', description: 'not starred' },
  ])
  assert.equal(repositories.length, 2)
  const overlap = repositories.find(repo => repo.repo === 'acme/tool')
  assert.equal(overlap.stars, 200)
  assert.equal(overlap.reason, 'selected for offline use')
  assert.ok(repositories.some(repo => repo.repo === 'other/ingest'))
})

test('all-source harvest deduplicates case-insensitively and selects by stars before publishing', async () => {
  let queries = 0
  let published
  await harvestAndIngest({ source: 'all', limit: 1 }, {
    searchRepositories: async () => ({ items: ++queries === 1 ? [RAW] : [{ ...RAW, full_name: 'acme/notebook' }, { ...RAW, full_name: 'other/tool', stargazers_count: 200 }] }),
    publishMetadata: async (repos) => {
      published = repos
      return 'state/ingest-journal/fixture.jsonl'
    },
  })
  assert.equal(queries, 2)
  assert.deepEqual(published.map(repo => repo.repo), ['other/tool'])
})

test('an upstream failure does not masquerade as an empty successful harvest', async () => {
  let writes = 0
  await assert.rejects(harvestAndIngest({ source: 'all' }, {
    searchRepositories: async () => {
      throw new Error('rate limit')
    },
    publishMetadata: async () => writes++,
  }), /Harvest all.*rate limit.*Nothing was published/)
  assert.equal(writes, 0)
})

test('invalid source and limits fail before querying or publishing', async () => {
  const forbidden = () => {
    throw new Error('I/O forbidden')
  }
  for (const options of [{ source: 'unknown' }, { source: 'trending' }, { limit: 0 }, { limit: 1.5 }, { limit: 101 }])
    await assert.rejects(harvestAndIngest(options, { searchRepositories: forbidden, publishMetadata: forbidden }), /Harvest (source|limit)/)
})

test('the skills harvest respects the requested language filter', async () => {
  await harvestAndIngest({ source: 'skills', language: 'rust' }, {
    searchRepositories: async (url, options) => {
      assert.ok(options.query.q.includes('language:rust'))
      return { items: [] }
    },
    publishMetadata: async () => null,
  })
})

test('a successful empty harvest does not create an empty journal object', async () => {
  const result = await harvestAndIngest({ source: 'skills' }, {
    searchRepositories: async () => ({ items: [] }),
    publishMetadata: () => {
      throw new Error('Empty journal must not be published')
    },
  })
  assert.equal(result.count, 0)
  assert.equal(result.journal_key, null)
  assert.equal(result.vector_status, 'no_repositories')
})

test('missing R2 credentials or a refused metadata write fail explicitly', async () => {
  await assert.rejects(publishHarvest([RAW], { target: null }), /requires R2_ACCOUNT_ID/)
  await assert.rejects(publishHarvest([RAW], { target: TARGET, put: async () => {
    throw new Error('permission denied')
  } }), /permission denied/)
})
