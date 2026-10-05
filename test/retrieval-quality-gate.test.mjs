import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateThresholds } from '../scripts/evaluate_retrieval_real.js'

function report(mode, summary) {
  return { mode, summary, cases: [] }
}

test('real retrieval thresholds pass only when every configured metric is inside its bound', () => {
  const reports = [report('hybrid_bge_m3', {
    mean_recall_at_k: 0.8,
    mean_precision_at_k: 0.2,
    mrr: 0.75,
    mean_ndcg_at_k: 0.72,
    negative_empty_success_rate: 0.9,
    forbidden_hits: 0,
    p95_latency_ms: 800,
  })]

  assert.deepEqual(
    evaluateThresholds(reports, {
      hybrid_bge_m3: {
        min_mean_recall_at_k: 0.8,
        min_mrr: 0.7,
        min_mean_ndcg_at_k: 0.7,
        min_negative_empty_success_rate: 0.8,
        max_forbidden_hits: 0,
        max_p95_latency_ms: 1000,
      },
    }),
    { passed: true, checked: 6, failures: [] },
  )
})

test('quality gates report regressions, unavailable metrics and unknown thresholds', () => {
  const gate = evaluateThresholds([
    report('hybrid_bge_m3', {
      mean_recall_at_k: 0.4,
      mrr: 0.5,
      mean_ndcg_at_k: null,
      negative_empty_success_rate: null,
      forbidden_hits: 2,
      p95_latency_ms: 1500,
    }),
  ], {
    hybrid_bge_m3: {
      min_mean_recall_at_k: 0.7,
      min_mean_ndcg_at_k: 0.6,
      max_forbidden_hits: 0,
      max_p95_latency_ms: 1000,
      invented_metric: 1,
    },
  })

  assert.equal(gate.passed, false)
  assert.equal(gate.checked, 4)
  assert.ok(gate.failures.some(message => message.includes('mean_recall_at_k=0.4')))
  assert.ok(gate.failures.some(message => message.includes('mean_ndcg_at_k is unavailable')))
  assert.ok(gate.failures.some(message => message.includes('forbidden_hits=2')))
  assert.ok(gate.failures.some(message => message.includes('p95_latency_ms=1500')))
  assert.ok(gate.failures.some(message => message.includes('unknown threshold invented_metric')))
})

test('quality gates never pass vacuously when no threshold applies to the executed modes', () => {
  const gate = evaluateThresholds([report('lexical', { mrr: 1 })], {
    hybrid_bge_m3: { min_mrr: 0.5 },
  })
  assert.equal(gate.passed, false)
  assert.equal(gate.checked, 0)
  assert.deepEqual(gate.failures, ['no thresholds matched the evaluation modes that ran'])
})


test('quality gates can fail a critical query class even when aggregate metrics pass', () => {
  const gate = evaluateThresholds([{
    mode: 'hybrid_bge_m3',
    summary: { mean_recall_at_k: 0.9, mrr: 0.9 },
    classes: {
      readme_only: { mean_recall_at_k: 0.4, mrr: 0.5 },
    },
    cases: [],
  }], {
    hybrid_bge_m3: {
      min_mean_recall_at_k: 0.8,
      classes: {
        readme_only: {
          min_mean_recall_at_k: 0.7,
          min_mrr: 0.6,
        },
      },
    },
  })
  assert.equal(gate.passed, false)
  assert.equal(gate.checked, 3)
  assert.ok(gate.failures.some(message => message.includes('classes.readme_only')))
})

test('required class thresholds fail loudly when the private benchmark forgot that class', () => {
  const gate = evaluateThresholds([{
    mode: 'hybrid_bge_m3',
    summary: { mrr: 0.9 },
    classes: {},
    cases: [],
  }], {
    hybrid_bge_m3: {
      min_mrr: 0.8,
      classes: { negative: { min_negative_empty_success_rate: 0.9 } },
    },
  })
  assert.equal(gate.passed, false)
  assert.ok(gate.failures.some(message => message.includes('contains no cases')))
})
