import assert from 'node:assert/strict'
// G2 regression test: hybrid retrieval relevance calibration + community cap.
// Imports the REAL pure functions from src/relevance.js (single source of truth shared with
// the Worker via src/index.js), so a source regression in the mapping/cap fails here —
// no replica drift. Guards:
//   (a) keyword-only relevance must not collapse (distinct, monotonic, low weights > min_score)
//   (b) low-weight community/archive passes default min_score 0.25 (F6 fix)
//   (c) the community cap is actually applied to a ranked result list (F6 follow-up)
import { test } from 'node:test'
import { applyCommunityCap, communityCap, keywordRelevanceScore as relevance, relevanceScore } from '../src/relevance.js'

test('relevance mapping is distinct, monotonic, and low weights pass min_score 0.25', () => {
  // Low-weight community/archive (weight 5-12) must pass default min_score 0.25 (F6)
  assert.ok(relevance(5) > 0.25, `relevance(5)=${relevance(5)} must exceed 0.25`)
  assert.ok(relevance(8) > 0.25)
  assert.ok(relevance(12) > 0.25)
  // Distinct across realistic range -> no ranking collapse
  assert.deepEqual(
    [5, 8, 12, 19, 40, 80, 130].map(relevance),
    [0.385, 0.5, 0.6, 0.704, 0.833, 0.909, 0.942],
    'the weight -> relevance calibration is pinned, not merely self-consistent',
  )
  // Saturation cap at 0.95
  assert.ok(relevance(1000) <= 0.95)
  assert.equal(relevance(1000), 0.95, 'the mapping must saturate AT the cap, not merely below it')
})

test('community cap = ceil(limit*0.4)', () => {
  assert.equal(communityCap(5), 2)
  assert.equal(communityCap(10), 4)
  assert.equal(communityCap(20), 8)
  assert.equal(communityCap(1), 1)
})

test('applyCommunityCap drops non-starred overflow but never a starred hit', () => {
  const s = n => ({ repo: `me/s${n}`, source: 'starred' })
  const c = n => ({ repo: `them/c${n}`, source: 'community' })

  // limit 5 -> cap 2. Traced by hand so the expected survivors are unambiguous:
  // c0 admitted (1), s0 kept, c1 admitted (2), s1 kept, c2+c3+c4 rejected, s2 kept.
  const ranked = [c(0), s(0), c(1), s(1), c(2), s(2), c(3), c(4)]
  const capped = applyCommunityCap(ranked, 5)

  assert.deepEqual(capped.map(r => r.repo), ['them/c0', 'me/s0', 'them/c1', 'me/s1', 'me/s2'])
  assert.equal(capped.filter(r => r.source === 'starred').length, 3, 'every starred hit must survive')
  assert.equal(capped.filter(r => r.source !== 'starred').length, 2, 'non-starred results must be capped')
})

test('applyCommunityCap still truncates to limit when everything is starred', () => {
  const allStarred = Array.from({ length: 12 }, (_, i) => ({ repo: `me/s${i}`, source: 'starred' }))
  const capped = applyCommunityCap(allStarred, 5)
  assert.equal(capped.length, 5)
  assert.deepEqual(capped.map(r => r.repo), ['me/s0', 'me/s1', 'me/s2', 'me/s3', 'me/s4'])
})

test('a query with no starred hits returns only the capped community set', () => {
  const onlyCommunity = Array.from({ length: 9 }, (_, i) => ({ repo: `them/c${i}`, source: 'archive' }))
  const capped = applyCommunityCap(onlyCommunity, 5)
  assert.equal(capped.length, 2, 'the cap applies even when nothing is starred')
  assert.deepEqual(capped.map(r => r.repo), ['them/c0', 'them/c1'])
})

test('combined relevance adds a capped keyword bonus on top of the vector score', () => {
  // The bonus tops out at +0.35, so a strong keyword match can lift a weak vector hit
  // but can never turn an unrelated one into a confident result.
  assert.equal(relevanceScore({ vScore: 0.5, kwWeight: 0 }), 0.5, 'a weight of 0 leaves the vector score alone')
  assert.equal(relevanceScore({ vScore: 0.5, kwWeight: 100 }), 0.85, ' 0.5 + (100/100)*0.35')
  assert.equal(relevanceScore({ vScore: 0.5, kwWeight: 200 }), 0.85, 'the bonus is capped at +0.35')
  assert.equal(relevanceScore({ vScore: 0.5, kwWeight: 50 }), 0.675, 'the bonus scales linearly below the cap')
})

test('combined relevance uses a lower ceiling than the keyword-only mapping', () => {
  assert.equal(relevanceScore({ vScore: 0.97, kwWeight: 0 }), 0.95, 'vector-only saturates at 0.95')
  assert.equal(relevanceScore({ vScore: 0.9, kwWeight: 100 }), 0.98, 'both channels saturate at 0.98')
  assert.equal(relevanceScore({ vScore: 1, kwWeight: 100 }), 0.98, 'and never exceed it')
})

test('relevance falls back to each channel alone and never goes negative', () => {
  assert.equal(relevanceScore({ vScore: 0.42, kwWeight: 0 }), 0.42)
  assert.equal(relevanceScore({ vScore: 0, kwWeight: 12 }), 0.6, 'keyword-only uses the non-linear mapping')
  assert.equal(relevanceScore({}), 0, 'no signal at all scores zero rather than NaN')
})
