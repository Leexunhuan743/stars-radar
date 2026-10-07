import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLOSURE_QUERY_CLASSES, validateClosureBenchmark } from '../scripts/validate_private_benchmark.js'

function fixture() {
  const cases = CLOSURE_QUERY_CLASSES.map((name, index) => ({
    id: `case-${index}`,
    query: `query ${name}`,
    relevant: name === 'negative' ? [] : ['owner/repo'],
    class: name,
  }))
  return {
    cases,
    thresholds: {
      hybrid_bge_m3: {
        min_mrr: 0.5,
        classes: {
          readme_only: { min_mean_recall_at_k: 0.5 },
          multi_facet: { min_mean_recall_at_k: 0.5 },
          multilingual: { min_mean_recall_at_k: 0.5 },
          negative: { min_negative_empty_success_rate: 0.8 },
          community: { min_mean_recall_at_k: 0.5 },
        },
      },
    },
  }
}

test('private closure benchmark requires critical query classes and class thresholds', () => {
  const valid = fixture()
  const report = validateClosureBenchmark(valid)
  assert.equal(report.cases, CLOSURE_QUERY_CLASSES.length)

  const missingClass = fixture()
  missingClass.cases = missingClass.cases.filter(item => item.class !== 'readme_only')
  assert.throws(() => validateClosureBenchmark(missingClass), /readme_only/)

  const missingGate = fixture()
  delete missingGate.thresholds.hybrid_bge_m3.classes.multi_facet
  assert.throws(() => validateClosureBenchmark(missingGate), /multi_facet/)
})
