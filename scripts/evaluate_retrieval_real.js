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
    negative_empty_success_rate: average(negative.map(row => row.metrics.empty_success ? 1 : 0)),
    p50_latency_ms: percentile(rows.map(row => row.latency_ms), 0.50),
    p95_latency_ms: percentile(rows.map(row => row.latency_ms), 0.95),
    forbidden_hits: rows.reduce((sum, row) => sum + row.metrics.forbidden_hits.length, 0),
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
      { ...(scenario.options || {}), limit: Math.max(k, scenario.options?.limit || 0), explain: false },
    )
    const returned = results.map(result => result.repo)
    rows.push({
      id: scenario.id,
      query: scenario.query,
      returned,
      metrics: evaluateOne(returned, scenario.relevant || [], scenario.forbidden || [], k),
      latency_ms: Number((performance.now() - started).toFixed(1)),
    })
  }
  return { mode: name, summary: summarize(rows), cases: rows }
}

export async function main() {
  const root = path.resolve(argValue('--root', process.cwd()))
  const fixturePath = path.resolve(argValue('--fixture', path.join(root, DEFAULT_FIXTURE)))
  const k = Number(argValue('--k', String(DEFAULT_K)))
  const lexicalOnly = hasFlag('--lexical-only')

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
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

if (process.argv[1]?.endsWith('evaluate_retrieval_real.js')) {
  main().catch((error) => {
    console.error(error.message || String(error))
    process.exitCode = 1
  })
}
