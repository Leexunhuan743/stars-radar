import assert from 'node:assert/strict'
// The probe capture rule.
//
// A capture is what the asset store later promotes from `discovered` to `community`, so this rule
// decides which discoveries ever become part of the collection. It also has to stay metadata-only:
// a capture that carried a vector or a tier would let an unconfirmed search result enter the index
// by the back door, which is the one thing the probe layer must never do.
import { test } from 'node:test'
import { buildProbeCaptures, PROBE_MAX_CAPTURES, PROBE_MIN_STARS } from '../src/probe-capture.js'

const repo = (name, stars, extra = {}) => ({ repo: name, url: `https://github.com/${name}`, stars, description: `${name} description`, ...extra })
const clock = () => new Date('2026-09-15T08:00:00.000Z')

test('only described repositories above the star threshold are captured', () => {
  const captures = buildProbeCaptures([
    repo('keep/one', PROBE_MIN_STARS),
    repo('drop/low', PROBE_MIN_STARS - 1),
    { repo: 'drop/undescribed', stars: 500, description: '' },
    { repo: 'drop/nodescription', stars: 500 },
  ], { query: 'q', now: clock })

  assert.deepEqual(captures.map(c => c.repo), ['keep/one'], 'the threshold documented to clients is the one applied')
})

test('a single response contributes at most the documented number of captures, strongest first', () => {
  const many = ['a/one', 'b/two', 'c/three', 'd/four', 'e/five'].map((name, index) => repo(name, 100 + index))
  const captures = buildProbeCaptures(many, { query: 'q', now: clock })

  assert.equal(captures.length, PROBE_MAX_CAPTURES)
  assert.deepEqual(captures.map(c => c.repo), ['e/five', 'd/four', 'c/three'], 'a crowded response keeps the strongest')
})

test('captures are metadata only, and carry the query that produced them', () => {
  const [capture] = buildProbeCaptures([
    repo('acme/tool', 120, { language: 'Rust', topics: ['cli'], created_at: '2026-01-01T00:00:00Z', pushed_at: '2026-09-01T00:00:00Z', tier: 'starred', is_starred: true, badge: '⭐ Starred' }),
  ], { query: 'agent memory', now: clock })

  assert.deepEqual(Object.keys(capture).sort(), [
    'captured_at',
    'created_at',
    'description',
    'language',
    'pushed_at',
    'query',
    'repo',
    'stars',
    'topics',
    'url',
  ].sort(), 'the shape is enumerated, so a search result cannot smuggle a tier or a vector into the store')
  assert.equal(capture.query, 'agent memory', 'the promotion rule counts distinct queries, so this must be the query, not a timestamp')
  assert.equal(capture.captured_at, '2026-09-15T08:00:00.000Z')
})

test('the same query never inflates the observation count', () => {
  // `probe_hits` counts distinct queries; two responses to the same query must look identical to
  // the fold, which is what keeps "seen twice" meaning "two independent signals".
  const first = buildProbeCaptures([repo('acme/tool', 120)], { query: 'agent memory', now: clock })
  const second = buildProbeCaptures([repo('acme/tool', 120)], { query: 'agent memory', now: clock })
  assert.deepEqual(first, second)
})

test('an empty or unusable result set yields nothing to write', () => {
  assert.deepEqual(buildProbeCaptures([], { query: 'q', now: clock }), [])
  assert.deepEqual(buildProbeCaptures(undefined, { query: 'q', now: clock }), [])
})
