import fs from 'node:fs'
import process from 'node:process'
import { DIMS } from '../src/embeddings.js'
import { searchDocuments } from '../src/search-engine.js'

const normalize = value => value.toLowerCase()

export function evaluateRetrieval(fixture, intents) {
  const cases = fixture.cases.map((scenario) => {
    const names = scenario.vectors || []
    const values = new Float32Array(names.length * DIMS)
    for (let index = 0; index < names.length; index++)
      values[index * DIMS] = 1
    const queryVector = names.length > 0 ? new Float32Array(DIMS) : null
    if (queryVector)
      queryVector[0] = 1
    const results = searchDocuments({
      catalog: fixture.catalog,
      rankings: fixture.rankings,
      harvested: fixture.harvested,
      assetIndex: fixture.assetIndex || { repos: {}, intent_inverted: {} },
      vectors: { values, names },
      queryVector,
      intents,
    }, scenario.query, { limit: 10, explain: true, ...scenario.options })
    const returned = results.map(result => normalize(result.repo))
    const relevant = new Set(scenario.relevant.map(normalize))
    const hits = returned.filter(repo => relevant.has(repo)).length
    const rank = returned.findIndex(repo => relevant.has(repo))
    const forbidden = returned.filter(repo => (scenario.forbidden || []).map(normalize).includes(repo))
    const recall = relevant.size === 0 ? (returned.length === 0 ? 1 : 0) : hits / relevant.size
    const precision = returned.length === 0 ? (relevant.size === 0 ? 1 : 0) : hits / returned.length
    const passed = recall >= (scenario.min_recall ?? 0)
      && precision >= (scenario.min_precision ?? 1)
      && forbidden.length === 0
      && (scenario.first === undefined || returned[0] === normalize(scenario.first))
      && (scenario.max_results === undefined || returned.length <= scenario.max_results)
    return { id: scenario.id, query: scenario.query, returned, precision, recall, reciprocal_rank: rank < 0 ? 0 : 1 / (rank + 1), forbidden, passed }
  })
  const positiveCases = cases.filter(item => fixture.cases.find(scenario => scenario.id === item.id).relevant.length > 0)
  return {
    dataset: 'synthetic labeled metadata corpus; vectors are deterministic channel fixtures, not real BGE-M3 embeddings',
    cases,
    passed: cases.filter(item => item.passed).length,
    total: cases.length,
    mean_precision: cases.reduce((sum, item) => sum + item.precision, 0) / cases.length,
    mean_recall: cases.reduce((sum, item) => sum + item.recall, 0) / cases.length,
    mrr: positiveCases.length > 0 ? positiveCases.reduce((sum, item) => sum + item.reciprocal_rank, 0) / positiveCases.length : 0,
  }
}

export function repositoryEvaluation() {
  return evaluateRetrieval(
    JSON.parse(fs.readFileSync(new URL('../test/fixtures/retrieval-evaluation.json', import.meta.url), 'utf-8')),
    JSON.parse(fs.readFileSync(new URL('../data/intents.json', import.meta.url), 'utf-8')),
  )
}

if (process.argv[1]?.endsWith('evaluate_retrieval.js')) {
  const report = repositoryEvaluation()
  console.log(JSON.stringify(report, null, 2))
  if (report.passed !== report.total)
    process.exitCode = 1
}
