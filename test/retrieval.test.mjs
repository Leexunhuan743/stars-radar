import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keywordRelevanceScore, relevanceScore } from '../src/relevance.js'

test('keyword relevance is monotonic and keeps low-weight matches above the default floor', () => {
  assert.deepEqual(
    [5, 8, 12, 19, 40, 80, 130].map(keywordRelevanceScore),
    [0.385, 0.5, 0.6, 0.704, 0.833, 0.909, 0.942],
  )
  assert.ok(keywordRelevanceScore(5) > 0.25)
  assert.ok(keywordRelevanceScore(1000) < 1)
})

test('final relevance preserves one-channel strength and rewards corroboration', () => {
  assert.equal(relevanceScore({ vScore: 0.5, kwWeight: 0 }), 0.375)
  assert.equal(relevanceScore({ vScore: 0, kwWeight: 8 }), 0.5)
  assert.equal(relevanceScore({ vScore: 0.5, kwWeight: 8 }), 0.688)
  assert.equal(relevanceScore({ vScore: 0.5, kwWeight: 40 }), 0.896)
  assert.equal(relevanceScore({ vScore: 0.9, kwWeight: 40 }), 0.979)
})

test('relevance is bounded and empty input is zero', () => {
  assert.equal(relevanceScore({ vScore: 2, kwWeight: 0 }), 1)
  assert.equal(relevanceScore({ vScore: -1, kwWeight: -10 }), 0)
  assert.equal(relevanceScore({}), 0)
})
