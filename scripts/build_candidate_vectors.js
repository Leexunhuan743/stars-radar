import fs from 'node:fs'
import process from 'node:process'
import { embeddingRepositories, foldIngestEntries } from '../src/ingest-journal.js'
import { ASSET_INDEX_KEY, CATALOG_KEY } from '../src/object-keys.js'
import { buildRepositoryVectors } from './vector_pipeline.js'

function readJson(path) {
  if (!fs.existsSync(path))
    throw new Error(`Required candidate corpus file is missing: ${path}`)
  return JSON.parse(fs.readFileSync(path, 'utf8'))
}

export async function buildCandidateVectors() {
  const catalog = readJson(CATALOG_KEY)
  const assetIndex = readJson(ASSET_INDEX_KEY)
  if (!catalog?.repos || typeof catalog.repos !== 'object' || Array.isArray(catalog.repos))
    throw new Error(`${CATALOG_KEY} must contain a repos object.`)

  const snapshot = assetIndex?.ingest_snapshot || { entries: [] }
  if (!Array.isArray(snapshot.entries))
    throw new Error(`${ASSET_INDEX_KEY} ingest_snapshot.entries must be an array.`)

  const harvested = foldIngestEntries(snapshot.entries)
  const repositories = embeddingRepositories(catalog.repos, harvested)
  if (repositories.length === 0)
    throw new Error('Candidate vector gate needs at least one starred or curated repository.')

  const starred = new Set(Object.keys(catalog.repos).map(repo => repo.toLowerCase()))
  const report = await buildRepositoryVectors(repositories)
  return {
    ...report,
    candidateRepositories: repositories.length,
    starredRepositories: starred.size,
    curatedRepositories: harvested.filter(repo => !starred.has(repo.repo.toLowerCase())).length,
  }
}

if (process.argv[1]?.endsWith('build_candidate_vectors.js')) {
  buildCandidateVectors()
    .then(report => console.log(`[Candidate Vectors] ${JSON.stringify(report)}`))
    .catch((error) => {
      console.error(error.message || String(error))
      process.exitCode = 1
    })
}
