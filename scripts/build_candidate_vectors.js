import fs from 'node:fs'
import process from 'node:process'
import { ASSET_INDEX_KEY, CATALOG_KEY } from '../src/object-keys.js'
import { buildRepositoryVectors } from './vector_pipeline.js'

const HOT_VECTOR_TIERS = new Set(['starred', 'curated', 'community'])

function readJson(path) {
  if (!fs.existsSync(path))
    throw new Error(`Required candidate corpus file is missing: ${path}`)
  return JSON.parse(fs.readFileSync(path, 'utf8'))
}

export function candidateVectorRepositories(catalog, assetIndex) {
  if (!catalog?.repos || typeof catalog.repos !== 'object' || Array.isArray(catalog.repos))
    throw new Error(`${CATALOG_KEY} must contain a repos object.`)
  if (!assetIndex?.repos || typeof assetIndex.repos !== 'object' || Array.isArray(assetIndex.repos))
    throw new Error(`${ASSET_INDEX_KEY} must contain a repos object.`)

  const assetByName = new Map(Object.values(assetIndex.repos)
    .filter(asset => asset && typeof asset.repo === 'string' && asset.repo)
    .map(asset => [asset.repo.toLowerCase(), asset]))

  const missingStarred = Object.keys(catalog.repos)
    .filter(repo => !assetByName.has(repo.toLowerCase()))
  if (missingStarred.length > 0) {
    throw new Error(
      `${ASSET_INDEX_KEY} is missing ${missingStarred.length} starred repository/repositories: ${missingStarred.slice(0, 5).join(', ')}`,
    )
  }

  const repositories = [...assetByName.values()]
    .filter(asset => HOT_VECTOR_TIERS.has(asset.tier))
    .map(asset => ({
      repo: asset.repo,
      name: asset.name || '',
      description: asset.description || asset.description_zh || '',
      language: asset.language || '',
      topics: Array.isArray(asset.topics) ? asset.topics : [],
      categories: Array.isArray(asset.categories) ? asset.categories : [],
      reason: asset.reason || '',
      summary: asset.summary || '',
    }))

  return {
    repositories,
    starredRepositories: repositories.filter(repo => assetByName.get(repo.repo.toLowerCase())?.tier === 'starred').length,
    curatedRepositories: repositories.filter(repo => assetByName.get(repo.repo.toLowerCase())?.tier === 'curated').length,
    communityRepositories: repositories.filter(repo => assetByName.get(repo.repo.toLowerCase())?.tier === 'community').length,
  }
}

export async function buildCandidateVectors() {
  const catalog = readJson(CATALOG_KEY)
  const assetIndex = readJson(ASSET_INDEX_KEY)
  const corpus = candidateVectorRepositories(catalog, assetIndex)

  // An empty hot set is a valid first-run state. The vector pipeline emits a structured zero-count
  // pair/manifest so generation integrity remains explicit instead of inventing a repository just
  // to make semantic search non-empty.
  const report = await buildRepositoryVectors(corpus.repositories)
  return {
    ...report,
    candidateRepositories: corpus.repositories.length,
    starredRepositories: corpus.starredRepositories,
    curatedRepositories: corpus.curatedRepositories,
    communityRepositories: corpus.communityRepositories,
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
