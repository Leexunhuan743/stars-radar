import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fuseRankings, RRF_K } from '../src/ranking.js'

function fuse({
  repoVectorScores = new Map(),
  readmeVectorScores = new Map(),
  keywordScores = new Map(),
  repos = {},
  assets = {},
  hardSubjects = [],
  vectorEvidence = new Map(),
} = {}) {
  return fuseRankings({
    repoVectorScores,
    readmeVectorScores,
    keywordScores,
    repos,
    assets,
    hardSubjects,
    vectorEvidence,
  })
}

test('RRF uses the standard k=60 rank contribution independently per semantic plane', () => {
  assert.equal(RRF_K, 60)
  const map = fuse({ repoVectorScores: new Map([['a/first', 0.61], ['a/second', 0.99]]) })
  assert.equal(map.get('a/second').rrf, 1 / 61)
  assert.equal(map.get('a/first').rrf, 1 / 62)
})

test('repository, README and keyword rankings contribute as independent evidence planes', () => {
  const map = fuse({
    repoVectorScores: new Map([['both/repo', 0.7]]),
    readmeVectorScores: new Map([['both/repo', 0.8]]),
    keywordScores: new Map([['both/repo', { weight: 20, source: 'starred', tier: 'starred' }]]),
  })
  const entry = map.get('both/repo')
  assert.equal(entry.rrf, (1 / 61) * 3)
  assert.equal(entry.repoVScore, 0.7)
  assert.equal(entry.readmeVScore, 0.8)
  assert.equal(entry.vScore, 0.8)
  assert.equal(entry.kwWeight, 20)
})

test('keyword rank follows keyword weight without source-specific boosts', () => {
  const map = fuse({
    keywordScores: new Map([
      ['me/starred', { weight: 10, source: 'starred', tier: 'starred' }],
      ['them/community', { weight: 10, source: 'archive' }],
      ['heavy/repo', { weight: 40, source: 'archive' }],
    ]),
  })
  assert.equal(map.get('heavy/repo').rrf, 1 / 61)
  assert.equal(map.get('me/starred').rrf, 1 / 62)
  assert.equal(map.get('them/community').rrf, 1 / 63)
})

test('a semantic match does not rewrite a public repository source', () => {
  const map = fuse({
    repoVectorScores: new Map([['public/repo', 0.5]]),
    keywordScores: new Map([['public/repo', { weight: 8, source: 'archive' }]]),
  })
  assert.equal(map.get('public/repo').source, 'archive')
})

test('a semantic-only historical community repository keeps asset provenance and metadata', () => {
  const map = fuse({
    repoVectorScores: new Map([['public/history', 0.8]]),
    assets: {
      'public/history': {
        repo: 'Public/History',
        tier: 'community',
        description: 'historical community tool',
      },
    },
  })
  const entry = map.get('public/history')
  assert.equal(entry.source, 'archive')
  assert.equal(entry.badge, '🏛️ Historical Archive')
  assert.equal(entry.tier, 'community')
  assert.equal(entry.extraItem.repo, 'Public/History')
})

test('keyword metadata reaches the fused entry', () => {
  const item = { repo: 'them/tool', url: 'https://github.com/them/tool' }
  const [repo, entry] = [...fuse({
    keywordScores: new Map([['them/tool', {
      weight: 12,
      source: 'archive',
      badge: '🏛️ Historical Archive',
      tier: 'community',
      item,
    }]]),
  })][0]
  assert.equal(repo, 'them/tool')
  assert.equal(entry.source, 'archive')
  assert.equal(entry.badge, '🏛️ Historical Archive')
  assert.equal(entry.tier, 'community')
  assert.equal(entry.extraItem, item)
})

test('hard identities require literal evidence even at high vector similarity', () => {
  const repos = { 'generic/tool': { name: 'tool', description: 'unrelated utility' } }
  const map = fuse({
    repoVectorScores: new Map([['generic/tool', 0.99]]),
    repos,
    hardSubjects: ['acme/tool'],
  })
  assert.equal(map.has('generic/tool'), false)
})

test('an exact repository identity satisfies the hard gate', () => {
  const repos = { 'acme/tool': { name: 'Tool' } }
  const map = fuse({
    repoVectorScores: new Map([['acme/tool', 0.25]]),
    repos,
    hardSubjects: ['acme/tool'],
  })
  assert.equal(map.has('acme/tool'), true)
})

test('ordinary feature queries are not gated by an arbitrary semantic threshold', () => {
  const repos = { 'me/storage': { name: 'storage', description: 'self-hosted data service' } }
  const weak = fuse({
    repoVectorScores: new Map([['me/storage', 0.4]]),
    repos,
  })
  assert.equal(weak.has('me/storage'), true)
})
