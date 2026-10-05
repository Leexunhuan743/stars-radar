import assert from 'node:assert/strict'
// The asset row, shared by every source that writes the hot set.
//
// The behaviour worth testing is not "does it copy a field" but the four rules that make the
// document coherent: a source that has nothing to say must not erase an earlier source's answer,
// the user's own star is never demoted by a community sighting, the once-per-week counter advances
// once, and the published row carries exactly the declared fields.
import { test } from 'node:test'
import { ASSET_ROW_FIELDS, HOT_TIERS, hotSetRow, mergeAssetRow } from '../src/asset-row.js'

const NOW = '2026-09-15T10:00:00.000Z'
const WEEK = 38

function sighting(overrides = {}) {
  return { repo: 'Acme/Tool', source: 'trending:overall_daily', tier: 'community', now: NOW, weekKey: WEEK, ...overrides }
}

test('a row holds exactly the declared fields', () => {
  // The schema is the point: three writers used to build this object by hand, so a field could
  // exist in one document and be missing from another without anything noticing.
  const row = mergeAssetRow(undefined, sighting())
  assert.deepEqual(Object.keys(row), ASSET_ROW_FIELDS)
  assert.ok(HOT_TIERS.includes(row.tier), 'a new row must land in a tier the Worker serves from')
})

test('a source with nothing to say does not erase what an earlier source contributed', () => {
  // The real drift this replaced: the probe pass never wrote `description_zh`, so a repository
  // discovered by a probe and later promoted carried no Chinese description while the same
  // repository arriving through rankings did.
  const ranked = mergeAssetRow(undefined, sighting({ fields: { description_zh: '中文说明', description: 'english', stars: 120 } }))
  const probed = mergeAssetRow(ranked, sighting({ source: 'probe', tier: 'discovered', fields: { stars: 121 } }))

  assert.equal(probed.description_zh, '中文说明')
  assert.equal(probed.description, 'english')
  assert.equal(probed.stars, 121, 'a newer count wins')
})

test('a missing count keeps the previous one rather than resetting it', () => {
  const ranked = mergeAssetRow(undefined, sighting({ fields: { stars: 120, language: 'Rust' } }))
  const probed = mergeAssetRow(ranked, sighting({ source: 'probe', tier: 'discovered' }))
  assert.equal(probed.stars, 120)
  assert.equal(probed.language, 'Rust')
})

test('the user\u2019s star outranks every community sighting', () => {
  const community = mergeAssetRow(undefined, sighting())
  const starred = mergeAssetRow(community, sighting({ source: 'github_star', tier: 'starred' }))
  assert.equal(starred.tier, 'starred')
  assert.equal(starred.is_starred, 1)

  const again = mergeAssetRow(starred, sighting({ source: 'helloGitHub' }))
  assert.equal(again.tier, 'starred', 'a community listing must not demote a starred repository')
  assert.equal(again.is_starred, 1)
})

test('the user\u2019s own ingest outranks a board, whichever order they arrive in', () => {
  // The accumulator reads the boards first and the journal last, so a "first source keeps the tier"
  // rule published an ingested repository as an anonymous board listing (`🏛️ Historical Archive`)
  // whenever a board also carried it. Ranked tiers make the stronger statement win either way.
  const boardedFirst = mergeAssetRow(undefined, sighting())
  const curatedAfter = mergeAssetRow(boardedFirst, sighting({ source: 'user_ingest', tier: 'curated' }))
  assert.equal(curatedAfter.tier, 'curated')

  const curatedFirst = mergeAssetRow(undefined, sighting({ source: 'user_ingest', tier: 'curated' }))
  const boardedAfter = mergeAssetRow(curatedFirst, sighting())
  assert.equal(boardedAfter.tier, 'curated', 'a board sighting must not demote a repository the user staged')
  assert.equal(boardedAfter.is_starred, 0, 'and must not claim the user starred it')
})

test('a probe guess never outranks a sighting that was already confirmed', () => {
  const community = mergeAssetRow(undefined, sighting())
  const probed = mergeAssetRow(community, sighting({ source: 'probe', tier: 'discovered' }))
  assert.equal(probed.tier, 'community', 'the promotion rule owns that decision, not the merge')

  const curated = mergeAssetRow(undefined, sighting({ source: 'user_ingest', tier: 'curated' }))
  assert.equal(mergeAssetRow(curated, sighting({ source: 'probe', tier: 'discovered' })).tier, 'curated')
})

test('a brand new row takes the tier its source proposes', () => {
  for (const tier of ['starred', 'curated', 'community', 'discovered']) {
    assert.equal(mergeAssetRow(undefined, sighting({ tier })).tier, tier)
  }
})

test('a first sighting is remembered, and every sighting is stamped', () => {
  const first = mergeAssetRow(undefined, sighting())
  assert.equal(first.first_seen_at, NOW)
  const later = mergeAssetRow(first, sighting({ now: '2026-09-16T10:00:00.000Z' }))
  assert.equal(later.first_seen_at, NOW, 'first_seen_at must survive the run that found it')
  assert.equal(later.last_seen_at, '2026-09-16T10:00:00.000Z')
})

test('the trending counter advances once per ISO week, and only for trending', () => {
  const first = mergeAssetRow(undefined, sighting())
  assert.equal(first.trending_count, 1)

  const sameWeek = mergeAssetRow(first, sighting())
  assert.equal(sameWeek.trending_count, 1, 'a second run in the same week must not count again')

  const nextWeek = mergeAssetRow(sameWeek, sighting({ weekKey: WEEK + 1 }))
  assert.equal(nextWeek.trending_count, 2)

  const community = mergeAssetRow(nextWeek, sighting({ source: 'helloGitHub' }))
  assert.equal(community.trending_count, 2, 'a non-trending channel must not advance the counter')
  assert.equal(community.last_trending_week, WEEK + 1, 'and must not clear the week it records')
})

test('channels accumulate, and the list stays bounded', () => {
  let row = mergeAssetRow(undefined, sighting({ source: 'github_star', tier: 'starred' }))
  for (let i = 0; i < 15; i++)
    row = mergeAssetRow(row, sighting({ source: `trending:board-${i}` }))

  assert.equal(row.source_channels.length, 10, 'a long-lived row must not grow without bound')
  assert.equal(row.source_channels.at(-1), 'trending:board-14', 'the most recent channel is kept')
})

test('the published row drops the inputs the next run needs', () => {
  // `probe_queries` and `last_trending_week` are bookkeeping for the next merge, not facts about
  // the repository, and the hot set is the document the Worker holds in memory.
  const row = mergeAssetRow(undefined, sighting({ fields: { probe_hits: 3, probe_queries: ['q1'] } }))
  const published = hotSetRow(row)

  assert.ok(!('probe_queries' in published))
  assert.ok(!('last_trending_week' in published))
  assert.equal(published.repo, row.repo)
  assert.equal(published.trending_count, row.trending_count, 'the count itself is a fact and is published')
})
