import assert from 'node:assert/strict'
import { test } from 'node:test'
import { candidateVectorRepositories } from '../scripts/build_candidate_vectors.js'

test('candidate vector corpus is exactly the published hot asset set', () => {
  const catalog = {
    repos: {
      'owner/star': {
        repo: 'Owner/Star',
        description: 'personal starred repository',
      },
    },
  }
  const assetIndex = {
    repos: {
      'owner/star': {
        repo: 'Owner/Star',
        tier: 'starred',
        description: 'personal starred repository',
        categories: ['research'],
      },
      'curated/tool': {
        repo: 'Curated/Tool',
        tier: 'curated',
        description: 'user-curated repository',
        reason: 'useful for local research',
      },
      'community/tool': {
        repo: 'Community/Tool',
        tier: 'community',
        description: 'high performance community web framework',
        language: 'Rust',
        topics: ['web', 'framework'],
      },
      'legacy/demoted': {
        repo: 'Legacy/Demoted',
        tier: 'community',
        description_zh: '已经取消 star 但仍保留的社区资产',
      },
      'probe/unconfirmed': {
        repo: 'Probe/Unconfirmed',
        tier: 'discovered',
        description: 'not part of the published hot set',
      },
    },
  }

  const corpus = candidateVectorRepositories(catalog, assetIndex)

  assert.deepEqual(
    corpus.repositories.map(repo => repo.repo),
    ['Owner/Star', 'Curated/Tool', 'Community/Tool', 'Legacy/Demoted'],
  )
  assert.equal(corpus.starredRepositories, 1)
  assert.equal(corpus.curatedRepositories, 1)
  assert.equal(corpus.communityRepositories, 2)
  assert.equal(
    corpus.repositories.find(repo => repo.repo === 'Legacy/Demoted').description,
    '已经取消 star 但仍保留的社区资产',
  )
  assert.equal(corpus.repositories.some(repo => repo.repo === 'Probe/Unconfirmed'), false)
})

test('candidate vector corpus fails closed when a starred repository is absent from the hot asset index', () => {
  assert.throws(
    () => candidateVectorRepositories(
      { repos: { 'owner/star': { repo: 'Owner/Star' } } },
      { repos: {} },
    ),
    /missing 1 starred repository/,
  )
})
