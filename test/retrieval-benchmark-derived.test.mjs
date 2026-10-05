import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveBenchmark } from '../scripts/build_retrieval_benchmark_from_corpus.js'

test('production-derived benchmark uses real identities, unique personal notes and honest negatives', () => {
  const benchmark = deriveBenchmark({
    generatedAt: '2026-10-05T00:00:00Z',
    repos: {
      'Acme/One': { repo: 'Acme/One', reason: 'offline rust research console' },
      'Acme/Two': { repo: 'Acme/Two', reason: '离线 Markdown 研究资料' },
      'Acme/Three': { repo: 'Acme/Three', reason: 'shared duplicate note' },
      'Acme/Four': { repo: 'Acme/Four', reason: 'shared duplicate note' },
      'Acme/Five': { repo: 'Acme/Five', summary: 'local terminal notebook workflow' },
      'Acme/Six': { repo: 'Acme/Six', summary: 'self hosted media workflow' },
      'Acme/Seven': { repo: 'Acme/Seven', summary: 'personal knowledge search' },
    },
  }, { maxExact: 3, maxNotes: 10 })

  assert.equal(benchmark.provenance.catalog_repo_count, 7)
  assert.equal(benchmark.cases.filter(item => item.class === 'exact_identity').length, 3)
  assert.equal(benchmark.cases.filter(item => item.classes?.includes('personal_note')).length, 5)
  assert.equal(benchmark.cases.filter(item => item.class === 'negative').length, 2)
  assert.equal(
    benchmark.cases.some(item => item.query === 'shared duplicate note'),
    false,
    'ambiguous personal notes cannot create a false single-repo relevance label',
  )
  assert.equal(
    benchmark.cases.some(item => item.classes?.includes('multilingual')),
    true,
    'real non-ASCII curator notes stay represented',
  )
  assert.equal(benchmark.thresholds.hybrid_bge_m3.classes.exact_identity.min_mrr, 1)
  assert.ok(benchmark.thresholds.hybrid_bge_m3.classes.personal_note)
})
