import assert from 'node:assert/strict'
// Provenance for live search results.
//
// The badge is the only thing telling a caller whether a result is theirs, the community's, or an
// unvetted discovery — and it used to be computed inside the Worker entry, where no test could
// reach it. The precedence rule (starred over community) and the catalogue fallback for renamed
// repositories are the two behaviours worth pinning down.
import { test } from 'node:test'
import { buildCommunityIndex } from '../src/community-index.js'
import { enrichLiveResults } from '../src/live-results.js'

function item(fullName, extra = {}) {
  return {
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    stargazers_count: 100,
    description: 'a tool',
    language: 'Rust',
    created_at: '2026-01-01T00:00:00Z',
    pushed_at: '2026-09-01T00:00:00Z',
    topics: ['cli'],
    ...extra,
  }
}

const catalogue = {
  'acme/starred': { repo: 'acme/starred', name: 'starred', categories: ['media-players'], reason: 'my music player' },
}

test('a repository in the catalogue is presented as the user own', () => {
  const [result] = enrichLiveResults([item('acme/starred')], { reposCatalog: catalogue })
  assert.equal(result.badge, '⭐ Starred')
  assert.equal(result.source, 'starred')
  assert.equal(result.is_starred, true)
  assert.deepEqual(result.user_categories, ['media-players'])
  assert.equal(result.user_reason, 'my music player')
})

test('starred wins when a repository is also part of the community layer', () => {
  const communityIndex = buildCommunityIndex({ harvested: [{ repo: 'acme/starred', stars: 1 }] })
  const [result] = enrichLiveResults([item('acme/starred')], { reposCatalog: catalogue, communityIndex })
  assert.equal(result.source, 'starred', 'the user own choice is the stronger statement')
})

test('a community repository is badged as ingested, not as a discovery', () => {
  const communityIndex = buildCommunityIndex({ rankings: { breakoutWeekly: [{ repo: 'Other/Tool', stars: 5 }] } })
  const [result] = enrichLiveResults([item('Other/Tool')], { communityIndex })
  assert.equal(result.badge, '⚡ Community Ingested')
  assert.equal(result.source, 'community')
  assert.equal(result.is_starred, false)
})

test('an unknown repository is an unvetted discovery', () => {
  const [result] = enrichLiveResults([item('nobody/knows')])
  assert.equal(result.badge, '🌐 Global Discovery')
  assert.equal(result.source, 'global')
  assert.equal(result.user_categories, undefined, 'no categories may be invented for a discovery')
})

test('a repository the catalogue does not know is a discovery, even if the name matches', () => {
  // The catalogue is keyed by `owner/name`. A name-only fallback existed and never fired (it
  // compared a bare repository name against a full one), and making it fire would badge another
  // owner's identically named repository as one of yours — so it is gone rather than repaired.
  const [result] = enrichLiveResults([item('newowner/starred')], { reposCatalog: catalogue })
  assert.equal(result.source, 'global')
  assert.equal(result.is_starred, false)
})

test('results keep GitHub ordering and are ranked from one', () => {
  const results = enrichLiveResults([item('a/one'), item('b/two'), item('c/three')])
  assert.deepEqual(results.map(r => r.rank), [1, 2, 3])
  assert.deepEqual(results.map(r => r.repo), ['a/one', 'b/two', 'c/three'])
})

test('missing optional fields become empty values rather than undefined keys in the payload', () => {
  const [result] = enrichLiveResults([{ full_name: 'bare/repo', html_url: 'https://github.com/bare/repo', stargazers_count: 3 }])
  assert.equal(result.description, '')
  assert.equal(result.language, '')
  assert.deepEqual(result.topics, [])
  assert.equal(result.pushed_at, undefined, 'a field GitHub did not send stays absent')
})

test('an empty result set is an empty list', () => {
  assert.deepEqual(enrichLiveResults([]), [])
  assert.deepEqual(enrichLiveResults(undefined), [])
})


test('live results expose every community source that observed the repository', () => {
  const communityIndex = buildCommunityIndex({
    rankings: {
      breakoutWeekly: [{ repo: 'acme/tool', stars: 50 }],
      helloGitHub: [{ repo: 'acme/tool', description_zh: 'pick' }],
      trending: { overall_daily: [{ repo: 'acme/tool', stars: 100 }] },
    },
  })
  const [result] = enrichLiveResults([item('acme/tool')], { communityIndex })
  assert.deepEqual(result.community_sources, ['breakout', 'hellogithub', 'trending'])
})
