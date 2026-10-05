import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateRetrieval, repositoryEvaluation } from '../scripts/evaluate_retrieval.js'

test('the independent labeled research corpus meets recall, precision, rank and exclusion contracts', () => {
  const report = repositoryEvaluation()
  assert.ok(report.total >= 10)
  assert.deepEqual(report.cases.filter(item => !item.passed), [])
  assert.equal(report.mean_precision, 1)
  assert.equal(report.mean_recall, 1)
  assert.equal(report.mrr, 1)
})

test('the evaluator reports a missed relevant result as a failure rather than declaring an empty search correct', () => {
  const report = evaluateRetrieval({
    catalog: { repos: {} },
    rankings: {},
    harvested: [],
    cases: [{ id: 'miss', query: 'quantum', relevant: ['expected/tool'], min_recall: 1 }],
  }, {})
  assert.equal(report.passed, 0)
  assert.equal(report.mean_precision, 0)
  assert.equal(report.mean_recall, 0)
  assert.equal(report.mrr, 0)
})

test('the evaluator rejects an irrelevant hit even when every relevant result was found', () => {
  const report = evaluateRetrieval({
    catalog: { repos: {
      'expected/tool': { description: 'quantum' },
      'unrelated/tool': { description: 'quantum' },
    } },
    rankings: {},
    harvested: [],
    cases: [{ id: 'noise', query: 'quantum', relevant: ['expected/tool'], min_recall: 1 }],
  }, {})
  assert.equal(report.mean_recall, 1)
  assert.equal(report.mean_precision, 0.5)
  assert.equal(report.passed, 0)
})
