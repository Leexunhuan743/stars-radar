import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateOne, percentile, summarize, summarizeByClass } from '../scripts/evaluate_retrieval_real.js'

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

test('negative cases are measured as empty-result success, not mixed into ranking metrics', () => {
  const empty = evaluateOne([], [], [], 5)
  assert.equal(empty.has_relevant, false)
  assert.equal(empty.recall_at_k, null)
  assert.equal(empty.precision_at_k, null)
  assert.equal(empty.reciprocal_rank, null)
  assert.equal(empty.ndcg_at_k, null)
  assert.equal(empty.empty_success, true)

  const noisy = evaluateOne(['noise/repo'], [], [], 5)
  assert.equal(noisy.empty_success, false)
})

test('forbidden hits and latency percentiles remain visible in the summary', () => {
  const rows = [
    {
      latency_ms: 10,
      metrics: {
        has_relevant: true,
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
        has_relevant: true,
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
        has_relevant: true,
        recall_at_k: 0,
        precision_at_k: 0,
        reciprocal_rank: 0,
        ndcg_at_k: 0,
        forbidden_hits: ['bad/two'],
      },
    },
  ]

  assert.equal(percentile([30, 10, 20], 0.5), 20)
  assert.equal(percentile([30, 10, 20], 0.95), 30)

  const summary = summarize(rows)
  assert.equal(summary.cases, 3)
  assert.equal(summary.positive_cases, 3)
  assert.equal(summary.negative_cases, 0)
  assert.equal(summary.negative_empty_success_rate, null)
  assert.equal(summary.forbidden_hits, 2)
  assert.equal(summary.p50_latency_ms, 20)
  assert.equal(summary.p95_latency_ms, 30)
  assert.equal(summary.mean_recall_at_k, 0.5)
  assert.equal(summary.mrr, 0.5)
})

test('Precision@K uses K as the denominator and negative success has its own aggregate', () => {
  const positive = evaluateOne(['a/relevant'], ['a/relevant'], [], 10)
  assert.equal(positive.precision_at_k, 0.1)

  const report = summarize([
    { latency_ms: 1, metrics: positive },
    { latency_ms: 1, metrics: evaluateOne([], [], [], 10) },
    { latency_ms: 1, metrics: evaluateOne(['noise/repo'], [], [], 10) },
  ])
  assert.equal(report.positive_cases, 1)
  assert.equal(report.negative_cases, 2)
  assert.equal(report.mean_precision_at_k, 0.1)
  assert.equal(report.negative_empty_success_rate, 0.5)
})


test('benchmark summaries stay visible per labeled query class', () => {
  const rows = [
    { classes: ['readme_only', 'multilingual'], latency_ms: 5, metrics: evaluateOne(['a/relevant'], ['a/relevant'], [], 5) },
    { classes: ['readme_only'], latency_ms: 7, metrics: evaluateOne([], ['b/relevant'], [], 5) },
    { classes: ['negative'], latency_ms: 3, metrics: evaluateOne([], [], [], 5) },
  ]
  const classes = summarizeByClass(rows)
  assert.equal(classes.readme_only.cases, 2)
  assert.equal(classes.readme_only.mean_recall_at_k, 0.5)
  assert.equal(classes.multilingual.mean_recall_at_k, 1)
  assert.equal(classes.negative.negative_empty_success_rate, 1)
})
