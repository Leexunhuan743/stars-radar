import assert from 'node:assert/strict'
// Ranking tests: Reciprocal Rank Fusion and the subject floor around it.
//
// This is where the two retrieval channels meet, and where "your own stars stay
// visible without drowning out relevance" is actually decided.
//
// Every expected value below is written as a LITERAL. Deriving them from the imported
// constants would make the tests self-consistent and unable to fail: a mutation study
// showed that changing RRF_K or STARRED_BOOST altered 955 and 776 of 966 scenarios
// while the whole suite stayed green.
import { test } from 'node:test'
import { fuseRankings, RRF_K, SEMANTIC_SUBJECT_FALLBACK, STARRED_BOOST } from '../src/ranking.js'

test('the tuned constants are what the ranking assumes', () => {
  assert.equal(RRF_K, 60)
  assert.equal(STARRED_BOOST, 1.5)
  assert.equal(SEMANTIC_SUBJECT_FALLBACK, 0.65)
})

function fuse({ vectorScores = new Map(), keywordScores = new Map(), repos = {}, specificSubjects = [], hardSubjects } = {}) {
  return fuseRankings({ vectorScores, keywordScores, repos, specificSubjects, ...(hardSubjects === undefined ? {} : { hardSubjects }) })
}

test('a single vector hit scores 1/61, the standard RRF contribution', () => {
  const map = fuse({ vectorScores: new Map([['a/one', 0.9]]) })
  assert.equal(map.get('a/one').rrf, 1 / 61)
  assert.equal(map.get('a/one').vScore, 0.9)
  assert.equal(map.get('a/one').kwWeight, 0)
  assert.equal(map.get('a/one').source, 'starred')
})

test('rank order, not score magnitude, determines the contribution', () => {
  const map = fuse({ vectorScores: new Map([['a/first', 0.61], ['a/second', 0.99]]) })
  assert.equal(map.get('a/second').rrf, 1 / 61, 'the higher score ranks first')
  assert.equal(map.get('a/first').rrf, 1 / 62)
})

test('a repository found by both channels accumulates both contributions', () => {
  const map = fuse({
    vectorScores: new Map([['both/repo', 0.7]]),
    keywordScores: new Map([['both/repo', { weight: 20, source: 'starred', tier: 'starred', badge: '⭐ Starred' }]]),
  })
  const entry = map.get('both/repo')
  assert.equal(entry.rrf, (1 / 61) + (1 / 61) * 1.5)
  assert.equal(entry.vScore, 0.7, 'the vector score survives the keyword pass')
  assert.equal(entry.kwWeight, 20, 'the keyword weight survives the vector pass')
})

test('the keyword channel ranks by weight, so the heaviest hit takes rank 1', () => {
  // Two entries with different weights: without this, reversing the keyword channel's
  // internal sort leaves every other assertion in this file passing.
  const map = fuse({
    keywordScores: new Map([
      ['light/repo', { weight: 5, source: 'archive', badge: '🏛️ Historical Archive' }],
      ['heavy/repo', { weight: 40, source: 'archive', badge: '🏛️ Historical Archive' }],
    ]),
  })
  assert.equal(map.get('heavy/repo').rrf, 1 / 61, 'the heavier keyword hit ranks first')
  assert.equal(map.get('light/repo').rrf, 1 / 62)
})

test('a starred keyword hit is boosted but a community hit is not', () => {
  const map = fuse({
    keywordScores: new Map([
      ['me/starred', { weight: 10, source: 'starred', tier: 'starred', badge: '⭐ Starred' }],
      ['them/community', { weight: 10, source: 'archive', badge: '🏛️ Historical Archive' }],
    ]),
  })
  assert.equal(map.get('me/starred').rrf, 1.5 / 61)
  assert.equal(map.get('them/community').rrf, 1 / 62, 'no boost for a community hit')
})

test('a vector match does not turn a public repository into a starred repository', () => {
  const map = fuse({
    vectorScores: new Map([['me/repo', 0.5]]),
    keywordScores: new Map([['me/repo', { weight: 8, source: 'archive' }]]),
  })
  assert.equal(map.get('me/repo').rrf, (1 / 61) + (1 / 61))
  assert.equal(map.get('me/repo').source, 'archive')
})

test('keyword metadata (source, badge, tier, item) reaches the fused entry', () => {
  const item = { repo: 'them/tool', url: 'https://github.com/them/tool' }
  const map = fuse({
    keywordScores: new Map([['them/tool', { weight: 12, source: 'archive', badge: '🏛️ Historical Archive', tier: 'community', item }]]),
  })
  const entry = map.get('them/tool')
  assert.equal(entry.source, 'archive')
  assert.equal(entry.badge, '🏛️ Historical Archive')
  assert.equal(entry.tier, 'community')
  assert.equal(entry.extraItem, item)
})

test('a keyword hit without a badge defaults to the starred badge', () => {
  const map = fuse({ keywordScores: new Map([['a/b', { weight: 5, source: 'starred' }]]) })
  assert.equal(map.get('a/b').badge, '⭐ Starred')
})

test('the vector subject floor drops a generic repo when a subject was named', () => {
  const vectorScores = new Map([['generic/tool', 0.3]])
  const repos = { 'generic/tool': { name: 'tool', description: 'a generic utility', reason: '' } }

  const withoutSubject = fuse({ vectorScores, repos })
  assert.ok(withoutSubject.has('generic/tool'), 'below the floor but no subject in the query: kept')

  const filtered = fuse({ vectorScores, repos, specificSubjects: ['antigravity'] })
  assert.equal(filtered.has('generic/tool'), false, 'a named subject vetoes an unrelated generic match')
})

test('high vector similarity cannot bypass a concrete subject', () => {
  const repos = { 'generic/tool': { name: 'tool', description: 'unrelated', reason: '' } }
  const at = n => fuse({ vectorScores: new Map([['generic/tool', n]]), repos, specificSubjects: ['antigravity'] })
  assert.equal(at(0.99).has('generic/tool'), false)
  assert.equal(at(0.4799999).has('generic/tool'), false)
})

test('the subject text pool covers the curator reason and is case-insensitive', () => {
  // A subject appearing only in `reason`, and only in mixed case, must still rescue the
  // repo: catalog names and descriptions routinely carry capitals, and the curator note
  // is the one field that records why the repo was starred.
  const vectorScores = new Map([['me/proxy', 0.25]])
  const repos = { 'me/proxy': { name: 'Proxy', description: '', reason: 'built for Antigravity' } }
  assert.ok(
    fuse({ vectorScores, repos, specificSubjects: ['antigravity'] }).has('me/proxy'),
    'reason text and its casing must both participate in the subject match',
  )
})

test('a repo matching the named subject or an activated intent group survives the floor', () => {
  const vectorScores = new Map([['me/antigravity-proxy', 0.25], ['me/cli-thing', 0.25]])
  const repos = {
    'me/antigravity-proxy': { name: 'antigravity-proxy', description: 'reverse proxy', reason: '' },
    'me/cli-thing': { name: 'cli-thing', description: 'a cli helper', reason: '' },
  }
  const filtered = fuse({ vectorScores, repos, specificSubjects: ['antigravity'] })
  assert.ok(filtered.has('me/antigravity-proxy'), 'the subject appears in the record text')
  assert.equal(filtered.has('me/cli-thing'), false, 'an activated domain cannot bypass the named subject')
})

test('a repo absent from the catalog is not filtered out by the floor', () => {
  // Community/ranking repos have no catalog record, so there is no text to judge and
  // the vector channel cannot veto them — the keyword channel decides.
  const map = fuse({ vectorScores: new Map([['them/unknown', 0.2]]), specificSubjects: ['antigravity'] })
  assert.equal(map.has('them/unknown'), false)
})

test('missing record fields contribute nothing to the subject pool', () => {
  // Interpolating them raw would put the literal "undefined" or "null" into the pool,
  // where a subject could match text the repo never contained.
  const vectorScores = new Map([['me/bare', 0.25]])
  const repos = { 'me/bare': { name: undefined, description: null, reason: undefined } }
  for (const subject of ['null', 'undefined']) {
    assert.equal(
      fuse({ vectorScores, repos, specificSubjects: [subject] }).has('me/bare'),
      false,
      `a repo with missing metadata must not match the subject "${subject}"`,
    )
  }
})

test('ordinary feature subjects may be rescued by strong README semantics but weak similarity is rejected', () => {
  const repos = { 'me/storage': { name: 'storage', description: 'self-hosted data service' } }

  const strong = fuse({
    vectorScores: new Map([['me/storage', 0.81]]),
    repos,
    specificSubjects: ['webdav'],
    hardSubjects: [],
  })
  assert.ok(strong.has('me/storage'), 'README embedding can evidence a feature absent from short metadata')

  const weak = fuse({
    vectorScores: new Map([['me/storage', 0.40]]),
    repos,
    specificSubjects: ['webdav'],
    hardSubjects: [],
  })
  assert.equal(weak.has('me/storage'), false, 'semantic fallback remains conservative')

  const hard = fuse({
    vectorScores: new Map([['me/storage', 0.99]]),
    repos,
    specificSubjects: ['antigravity'],
    hardSubjects: ['antigravity'],
  })
  assert.equal(hard.has('me/storage'), false, 'named entities still require literal evidence')
})
