import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { DIMS, EMBEDDING_MODEL, isEmbedding, validateVectorIndex, vectorNorms } from '../src/embeddings.js'
import { foldJournalFiles } from '../src/ingest-journal.js'
import {
  ASSET_INDEX_KEY,
  CATALOG_KEY,
  EMBEDDINGS_BIN_KEY,
  EMBEDDINGS_INDEX_KEY,
  INGEST_JOURNAL_PREFIX,
  LOCAL_RANKINGS_DIR,
  RANKINGS_KEY,
} from '../src/object-keys.js'
import { searchDocuments } from '../src/search-engine.js'

const defaultIntents = JSON.parse(fs.readFileSync(new URL('../data/intents.json', import.meta.url), 'utf-8'))

const DEFAULT_FIXTURE = 'data/retrieval-benchmark.private.json'
const DEFAULT_K = 10
const SILICONFLOW_URL = process.env.SILICONFLOW_URL || 'https://api.siliconflow.cn/v1/embeddings'

function argValue(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function hasFlag(name) {
  return process.argv.includes(name)
}

function readJson(file, fallback) {
  if (!fs.existsSync(file))
    return fallback
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

function loadHarvested(root) {
  const dir = path.resolve(root, INGEST_JOURNAL_PREFIX)
  if (!fs.existsSync(dir))
    return []
  const files = fs.readdirSync(dir)
    .filter(name => name.endsWith('.jsonl'))
    .map(name => ({
      key: `${INGEST_JOURNAL_PREFIX}${name}`,
      text: fs.readFileSync(path.join(dir, name), 'utf-8'),
    }))
  const { harvested, problems } = foldJournalFiles(files)
  if (problems.length > 0)
    throw new Error(`Could not fold ingest journal: ${problems.join('; ')}`)
  return harvested
}

function loadVectors(root) {
  const indexPath = path.resolve(root, EMBEDDINGS_INDEX_KEY)
  const binPath = path.resolve(root, EMBEDDINGS_BIN_KEY)
  if (!fs.existsSync(indexPath) || !fs.existsSync(binPath))
    throw new Error(`Real benchmark needs ${EMBEDDINGS_INDEX_KEY} and ${EMBEDDINGS_BIN_KEY} from the target data plane.`)
  const records = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
  validateVectorIndex(records)
  const bytes = fs.readFileSync(binPath)
  if (bytes.byteLength !== records.length * DIMS * 4)
    throw new Error(`Vector pair mismatch: ${records.length} records but ${bytes.byteLength} bytes.`)
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const values = new Float32Array(copy)
  return { records, values, norms: vectorNorms(values, records.length) }
}

async function embedQuery(query) {
  if (!process.env.SILICONFLOW_KEY)
    throw new Error('SILICONFLOW_KEY is required for hybrid benchmark mode. Use --lexical-only to skip embeddings.')
  const response = await fetch(SILICONFLOW_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SILICONFLOW_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: query }),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok)
    throw new Error(`Embedding query failed with HTTP ${response.status}`)
  const payload = await response.json()
  const vector = payload?.data?.[0]?.embedding
  if (!isEmbedding(vector))
    throw new Error('Embedding provider returned an invalid query vector.')
  return new Float32Array(vector)
}

function reciprocalRank(returned, relevant) {
  const rank = returned.findIndex(repo => relevant.has(repo))
  return rank < 0 ? 0 : 1 / (rank + 1)
}

function ndcgAtK(returned, relevant, k) {
  if (relevant.size === 0)
    return null
  let dcg = 0
  for (let i = 0; i < Math.min(k, returned.length); i++) {
    if (relevant.has(returned[i]))
      dcg += 1 / Math.log2(i + 2)
  }
  const ideal = Math.min(k, relevant.size)
  let idcg = 0
  for (let i = 0; i < ideal; i++)
    idcg += 1 / Math.log2(i + 2)
  return dcg / idcg
}

export function evaluateOne(returned, relevantList, forbiddenList, k) {
  const relevant = new Set(relevantList.map(v => v.toLowerCase()))
  const forbidden = new Set((forbiddenList || []).map(v => v.toLowerCase()))
  const top = returned.slice(0, k).map(v => v.toLowerCase())
  const hits = top.filter(repo => relevant.has(repo)).length
  const forbiddenHits = top.filter(repo => forbidden.has(repo))
  const hasRelevant = relevant.size > 0
  return {
    has_relevant: hasRelevant,
    recall_at_k: hasRelevant ? hits / relevant.size : null,
    // Standard Precision@K counts unfilled positions as non-relevant. This prevents a search that
    // returns one correct result for K=10 from reporting precision=1.0.
    precision_at_k: hasRelevant ? hits / k : null,
    reciprocal_rank: hasRelevant ? reciprocalRank(top, relevant) : null,
    ndcg_at_k: hasRelevant ? ndcgAtK(top, relevant, k) : null,
    empty_success: hasRelevant ? null : top.length === 0,
    forbidden_hits: forbiddenHits,
  }
}

function evidenceQuality(results, relevantList, k) {
  const relevant = new Set((relevantList || []).map(value => value.toLowerCase()))
  if (relevant.size === 0) {
    return {
      evidence_coverage_rate: null,
      provenance_completeness_rate: null,
      facet_satisfaction_rate: null,
    }
  }

  const relevantHits = results.slice(0, k).filter(result => relevant.has(result.repo.toLowerCase()))
  if (relevantHits.length === 0) {
    return {
      evidence_coverage_rate: null,
      provenance_completeness_rate: null,
      facet_satisfaction_rate: null,
    }
  }

  const evidenceCoverage = average(relevantHits.map(result => (result.evidence || []).length > 0 ? 1 : 0))
  const provenanceCompleteness = average(relevantHits.map((result) => {
    const fields = ['description', 'stars', 'categories', 'reason', 'summary']
      .filter((field) => {
        const value = result[field]
        return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== ''
      })
    if (fields.length === 0)
      return 1
    const covered = fields.filter(field => result.provenance?.[field]).length
    return covered / fields.length
  }))
  const facetSatisfaction = average(relevantHits
    .map(result => result.ranking?.facet_coverage)
    .filter(coverage => coverage?.total >= 2)
    .map(coverage => coverage.ratio))

  return {
    evidence_coverage_rate: evidenceCoverage,
    provenance_completeness_rate: provenanceCompleteness,
    facet_satisfaction_rate: facetSatisfaction,
  }
}

function average(values) {
  const numeric = values.filter(Number.isFinite)
  return numeric.length ? numeric.reduce((sum, value) => sum + value, 0) / numeric.length : null
}

export function summarize(rows) {
  const positive = rows.filter(row => row.metrics.has_relevant)
  const negative = rows.filter(row => !row.metrics.has_relevant)
  return {
    cases: rows.length,
    positive_cases: positive.length,
    negative_cases: negative.length,
    mean_recall_at_k: average(positive.map(row => row.metrics.recall_at_k)),
    mean_precision_at_k: average(positive.map(row => row.metrics.precision_at_k)),
    mrr: average(positive.map(row => row.metrics.reciprocal_rank)),
    mean_ndcg_at_k: average(positive.map(row => row.metrics.ndcg_at_k)),
    evidence_coverage_rate: average(positive.map(row => row.metrics.evidence_coverage_rate)),
    provenance_completeness_rate: average(positive.map(row => row.metrics.provenance_completeness_rate)),
    facet_satisfaction_rate: average(positive.map(row => row.metrics.facet_satisfaction_rate)),
    negative_empty_success_rate: average(negative.map(row => row.metrics.empty_success ? 1 : 0)),
    p50_latency_ms: percentile(rows.map(row => row.latency_ms), 0.50),
    p95_latency_ms: percentile(rows.map(row => row.latency_ms), 0.95),
    forbidden_hits: rows.reduce((sum, row) => sum + row.metrics.forbidden_hits.length, 0),
  }
}

export function summarizeByClass(rows) {
  const groups = new Map()
  for (const row of rows) {
    const classes = Array.isArray(row.classes) && row.classes.length > 0 ? row.classes : ['uncategorized']
    for (const className of classes) {
      if (!groups.has(className))
        groups.set(className, [])
      groups.get(className).push(row)
    }
  }
  return Object.fromEntries([...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([className, classRows]) => [className, summarize(classRows)]))
}

const THRESHOLD_RULES = {
  min_mean_recall_at_k: { metric: 'mean_recall_at_k', direction: 'min' },
  min_mean_precision_at_k: { metric: 'mean_precision_at_k', direction: 'min' },
  min_mrr: { metric: 'mrr', direction: 'min' },
  min_mean_ndcg_at_k: { metric: 'mean_ndcg_at_k', direction: 'min' },
  min_evidence_coverage_rate: { metric: 'evidence_coverage_rate', direction: 'min' },
  min_provenance_completeness_rate: { metric: 'provenance_completeness_rate', direction: 'min' },
  min_facet_satisfaction_rate: { metric: 'facet_satisfaction_rate', direction: 'min' },
  min_negative_empty_success_rate: { metric: 'negative_empty_success_rate', direction: 'min' },
  max_forbidden_hits: { metric: 'forbidden_hits', direction: 'max' },
  max_p95_latency_ms: { metric: 'p95_latency_ms', direction: 'max' },
}

export function evaluateThresholds(reports, thresholds) {
  if (!thresholds || typeof thresholds !== 'object' || Array.isArray(thresholds))
    return { passed: false, failures: ['thresholds must be an object keyed by evaluation mode'] }

  const failures = []
  let checked = 0

  const checkMetricSet = (label, summary, expected) => {
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
      failures.push(`${label}: thresholds must be an object`)
      return
    }
    for (const [name, limit] of Object.entries(expected)) {
      const rule = THRESHOLD_RULES[name]
      if (!rule) {
        failures.push(`${label}: unknown threshold ${name}`)
        continue
      }
      if (!Number.isFinite(limit)) {
        failures.push(`${label}: ${name} must be numeric`)
        continue
      }
      const actual = summary?.[rule.metric]
      checked++
      if (!Number.isFinite(actual)) {
        failures.push(`${label}: ${rule.metric} is unavailable but ${name}=${limit} is required`)
        continue
      }
      const passed = rule.direction === 'min' ? actual >= limit : actual <= limit
      if (!passed)
        failures.push(`${label}: ${rule.metric}=${actual} violates ${name}=${limit}`)
    }
  }

  for (const report of reports) {
    const expected = thresholds[report.mode]
    if (!expected)
      continue
    if (typeof expected !== 'object' || Array.isArray(expected)) {
      failures.push(`${report.mode}: thresholds must be an object`)
      continue
    }

    const { classes, ...modeThresholds } = expected
    checkMetricSet(report.mode, report.summary, modeThresholds)

    if (classes !== undefined) {
      if (!classes || typeof classes !== 'object' || Array.isArray(classes)) {
        failures.push(`${report.mode}.classes: thresholds must be an object`)
      }
      else {
        for (const [className, classThresholds] of Object.entries(classes)) {
          const classSummary = report.classes?.[className]
          if (!classSummary) {
            failures.push(`${report.mode}.classes.${className}: benchmark contains no cases for this required class`)
            continue
          }
          checkMetricSet(`${report.mode}.classes.${className}`, classSummary, classThresholds)
        }
      }
    }
  }

  return {
    passed: failures.length === 0 && checked > 0,
    checked,
    failures: checked === 0 && failures.length === 0
      ? ['no thresholds matched the evaluation modes that ran']
      : failures,
  }
}

export function percentile(values, q) {
  if (!values.length)
    return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil(q * sorted.length))
  return sorted[Math.min(sorted.length - 1, rank - 1)]
}

async function runMode(name, fixture, documents, { lexicalOnly, k }) {
  const rows = []
  for (const scenario of fixture.cases) {
    const started = performance.now()
    const queryVector = lexicalOnly ? null : await embedQuery(scenario.query)
    const results = searchDocuments(
      { ...documents, queryVector },
      scenario.query,
      { ...(scenario.options || {}), limit: Math.max(k, scenario.options?.limit || 0), explain: true },
    )
    const returned = results.map(result => result.repo)
    rows.push({
      id: scenario.id,
      query: scenario.query,
      classes: Array.isArray(scenario.classes)
        ? scenario.classes
        : (scenario.class ? [scenario.class] : ['uncategorized']),
      returned,
      metrics: {
        ...evaluateOne(returned, scenario.relevant || [], scenario.forbidden || [], k),
        ...evidenceQuality(results, scenario.relevant || [], k),
      },
      latency_ms: Number((performance.now() - started).toFixed(1)),
    })
  }
  return {
    mode: name,
    summary: summarize(rows),
    classes: summarizeByClass(rows),
    cases: rows,
  }
}

export async function main() {
  const root = path.resolve(argValue('--root', process.cwd()))
  const fixturePath = path.resolve(argValue('--fixture', path.join(root, DEFAULT_FIXTURE)))
  const k = Number(argValue('--k', String(DEFAULT_K)))
  const lexicalOnly = hasFlag('--lexical-only')
  const enforceThresholds = hasFlag('--enforce-thresholds')
  const outputPath = argValue('--output', null)

  if (!Number.isInteger(k) || k < 1 || k > 50)
    throw new Error('--k must be an integer from 1 to 50.')
  if (!fs.existsSync(fixturePath))
    throw new Error(`Benchmark fixture not found: ${fixturePath}. Copy test/fixtures/retrieval-benchmark.example.json to ${DEFAULT_FIXTURE} and label it with your own real queries/repositories.`)

  const fixture = readJson(fixturePath, null)
  if (!Array.isArray(fixture?.cases) || fixture.cases.length === 0)
    throw new Error('Benchmark fixture must contain a non-empty cases array.')

  const catalog = readJson(path.join(root, CATALOG_KEY), { repos: {} })
  const rankings = readJson(path.join(root, LOCAL_RANKINGS_DIR, RANKINGS_KEY), {})
  const assetIndex = readJson(path.join(root, ASSET_INDEX_KEY), { repos: {}, intent_inverted: {} })
  const harvested = loadHarvested(root)
  const vectors = lexicalOnly ? { values: null, norms: null, records: null } : loadVectors(root)
  const documents = { catalog, rankings, assetIndex, harvested, vectors, intents: defaultIntents }

  const reports = []
  reports.push(await runMode('lexical', fixture, { ...documents, vectors: { values: null, norms: null, records: null } }, { lexicalOnly: true, k }))
  if (!lexicalOnly)
    reports.push(await runMode('hybrid_bge_m3', fixture, documents, { lexicalOnly: false, k }))

  const qualityGate = fixture.thresholds ? evaluateThresholds(reports, fixture.thresholds) : null
  if (enforceThresholds && !qualityGate)
    throw new Error('Quality gate requested but the benchmark fixture has no thresholds object.')

  const report = {
    dataset: fixture.dataset || path.basename(fixturePath),
    generated_at: new Date().toISOString(),
    k,
    vector_model: EMBEDDING_MODEL,
    corpus: {
      catalog_repos: Object.keys(catalog.repos || {}).length,
      asset_repos: Object.keys(assetIndex.repos || {}).length,
      vector_count: vectors.records?.length || 0,
      repo_vector_count: vectors.records?.filter(record => record.kind === 'repo').length || 0,
      readme_chunk_vector_count: vectors.records?.filter(record => record.kind === 'readme_chunk').length || 0,
      harvested: harvested.length,
    },
    reports,
    quality_gate: qualityGate,
  }

  const serialized = `${JSON.stringify(report, null, 2)}\n`
  if (outputPath)
    fs.writeFileSync(path.resolve(outputPath), serialized)
  process.stdout.write(serialized)

  if (enforceThresholds && !qualityGate.passed) {
    console.error(`Retrieval quality gate failed: ${qualityGate.failures.join('; ')}`)
    process.exitCode = 2
  }
}

if (process.argv[1]?.endsWith('evaluate_retrieval_real.js')) {
  main().catch((error) => {
    console.error(error.message || String(error))
    process.exitCode = 1
  })
}
