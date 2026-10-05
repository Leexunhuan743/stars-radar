import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateOne, percentile, summarize } from '../scripts/evaluate_retrieval_real.js'

test('real-benchmark metrics compute recall, precision, reciprocal rank and ndcg from labeled results', () => {
  const metrics = evaluateOne(
    ['a/noise', 'a/relevant', 'b/relevant'],
    ['a/relevant', 'b/relevant'],
    ['forbidden/repo'],
    3,
  )

  assert.equal(metrics.recall_at_k, 1)
  assert.equal(metrics.precision_at_k, 2 / 3)
  assert.equal(metrics.reciprocal_rank, 1 / 2)
  assert.ok(metrics.ndcg_at_k > 0 && metrics.ndcg_at_k < 1)
  assert.deepEqual(metrics.forbidden_hits, [])
})

test('empty-relevance cases require an honestly empty result set', () => {
  assert.equal(evaluateOne([], [], [], 5).recall_at_k, 1)
  assert.equal(evaluateOne([], [], [], 5).precision_at_k, 1)
  assert.equal(evaluateOne(['noise/repo'], [], [], 5).recall_at_k, 0)
})

test('forbidden hits and latency percentiles remain visible in the summary', () => {
  const rows = [
    {
      latency_ms: 10,
      metrics: {
        recall_at_k: 1,
        precision_at_k: 0.5,
        reciprocal_rank: 1,
        ndcg_at_k: 1,
        forbidden_hits: ['bad/one'],
      },
    },
    {
      latency_ms: 30,
      metrics: {
        recall_at_k: 0.5,
        precision_at_k: 0.25,
        reciprocal_rank: 0.5,
        ndcg_at_k: 0.6,
        forbidden_hits: [],
      },
    },
    {
      latency_ms: 20,
      metrics: {
        recall_at_k: 0,
        precision_at_k: 0,
        reciprocal_rank: 0,
        ndcg_at_k: 0,
        forbidden_hits: ['bad/two'],
      },
    },
  ]

  assert.equal(percentile([30, 10, 20], 0.5), 20)
  assert.equal(percentile([30, 10, 20], 0.95), 20)

  const summary = summarize(rows)
  assert.equal(summary.cases, 3)
  assert.equal(summary.forbidden_hits, 2)
  assert.equal(summary.p50_latency_ms, 20)
  assert.equal(summary.p95_latency_ms, 20)
  assert.equal(summary.mean_recall_at_k, 0.5)
  assert.equal(summary.mrr, 0.5)
})
