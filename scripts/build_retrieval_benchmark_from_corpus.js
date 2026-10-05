import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { CATALOG_KEY } from '../src/object-keys.js'

const DEFAULT_CATALOG = CATALOG_KEY
const DEFAULT_OUTPUT = 'data/retrieval-benchmark.derived.json'

function argValue(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function normalize(value) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

function stableSample(items, limit) {
  if (items.length <= limit)
    return items
  const selected = []
  const used = new Set()
  for (let slot = 0; slot < limit; slot++) {
    const index = Math.round(slot * (items.length - 1) / Math.max(1, limit - 1))
    if (used.has(index))
      continue
    used.add(index)
    selected.push(items[index])
  }
  return selected
}

function eligibleNote(value) {
  const text = normalize(value)
  if (text.length < 4 || text.length > 240)
    return null
  if (!/[\p{L}\p{N}]/u.test(text))
    return null
  return text
}

export function deriveBenchmark(catalog, { maxExact = 24, maxNotes = 24 } = {}) {
  const repos = Object.entries(catalog?.repos || {})
    .map(([key, record]) => ({ ...record, repo: record.repo || key }))
    .filter(record => /^[\w.-]+\/[\w.-]+$/.test(record.repo || ''))
    .sort((a, b) => a.repo.localeCompare(b.repo, 'en', { sensitivity: 'base' }))

  if (repos.length === 0)
    throw new Error('Cannot derive a retrieval benchmark from an empty catalog.')

  const cases = []
  for (const record of stableSample(repos, maxExact)) {
    cases.push({
      id: `identity-${record.repo.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      query: record.repo,
      relevant: [record.repo],
      forbidden: [],
      class: 'exact_identity',
      options: { scope: 'starred' },
    })
  }

  const noteOwners = new Map()
  for (const record of repos) {
    const note = eligibleNote(record.reason) || eligibleNote(record.summary)
    if (!note)
      continue
    const key = note.toLocaleLowerCase()
    if (!noteOwners.has(key))
      noteOwners.set(key, [])
    noteOwners.get(key).push({ record, note })
  }

  const uniqueNotes = [...noteOwners.values()]
    .filter(entries => entries.length === 1)
    .map(entries => entries[0])
  for (const { record, note } of stableSample(uniqueNotes, maxNotes)) {
    const classes = ['personal_note']
    if ([...note].some(char => char.codePointAt(0) > 127))
      classes.push('multilingual')
    cases.push({
      id: `note-${record.repo.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      query: note,
      relevant: [record.repo],
      forbidden: [],
      classes,
      options: { scope: 'starred' },
    })
  }

  cases.push(
    {
      id: 'negative-impossible-repository',
      query: 'zzzz-no-such-repository-6f9c8b2d',
      relevant: [],
      forbidden: [],
      class: 'negative',
      options: { scope: 'starred' },
    },
    {
      id: 'negative-impossible-capability',
      query: 'qxv-no-such-capability-3a71df84',
      relevant: [],
      forbidden: [],
      class: 'negative',
      options: { scope: 'starred' },
    },
  )

  const classThresholds = {
    exact_identity: {
      min_mean_recall_at_k: 1,
      min_mrr: 1,
      min_mean_ndcg_at_k: 1,
    },
    negative: {
      min_negative_empty_success_rate: 1,
    },
  }
  if (uniqueNotes.length >= 5) {
    classThresholds.personal_note = {
      min_mean_recall_at_k: 0.7,
      min_mrr: 0.55,
      min_mean_ndcg_at_k: 0.55,
    }
  }

  return {
    dataset: 'production-derived-regression-smoke',
    provenance: {
      kind: 'derived_from_active_catalog',
      generated_at: new Date().toISOString(),
      catalog_generated_at: catalog.generatedAt || null,
      catalog_repo_count: repos.length,
      note_case_count: cases.filter(item => item.classes?.includes('personal_note')).length,
    },
    cases,
    thresholds: {
      hybrid_bge_m3: {
        min_mean_recall_at_k: 0.85,
        min_mrr: 0.8,
        min_mean_ndcg_at_k: 0.8,
        min_evidence_coverage_rate: 0.95,
        min_provenance_completeness_rate: 0.95,
        min_negative_empty_success_rate: 1,
        max_forbidden_hits: 0,
        max_p95_latency_ms: 5000,
        classes: classThresholds,
      },
    },
  }
}

export function main() {
  const catalogPath = path.resolve(argValue('--catalog', DEFAULT_CATALOG))
  const outputPath = path.resolve(argValue('--output', DEFAULT_OUTPUT))
  if (!fs.existsSync(catalogPath))
    throw new Error(`Catalog not found: ${catalogPath}`)
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
  const benchmark = deriveBenchmark(catalog)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(benchmark, null, 2)}\n`)
  console.log(`[Retrieval Regression] derived ${benchmark.cases.length} smoke/regression cases from ${benchmark.provenance.catalog_repo_count} production catalog repositories; this is not a human-labeled quality benchmark.`)
}

if (process.argv[1]?.endsWith('build_retrieval_benchmark_from_corpus.js')) {
  try {
    main()
  }
  catch (error) {
    console.error(error.message || String(error))
    process.exitCode = 1
  }
}
