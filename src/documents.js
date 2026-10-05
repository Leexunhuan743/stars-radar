// Generation-consistent R2 document loaders.
//
// A published data plane is immutable under generations/<id>/. The only mutable publication
// object is active-generation.json. Every derived document cache is bound to the generation id
// returned by that pointer, so an isolate may be briefly stale but can never combine documents
// from two different builds.

import { parseGenerationPointer, ACTIVE_GENERATION_KEY, generationKey } from './data-generation.js'
import { createDocumentCache, DOCUMENT_STATUS } from './document-cache.js'
import { describePairMismatch, validateVectorIndex, verifyVectorManifest } from './embeddings.js'
import { foldIngestEntries, foldJournalFiles } from './ingest-journal.js'
import {
  ASSET_INDEX_KEY,
  CATALOG_KEY,
  EMBEDDINGS_BIN_KEY,
  EMBEDDINGS_INDEX_KEY,
  EMBEDDINGS_MANIFEST_KEY,
  INGEST_JOURNAL_PREFIX,
  RANKINGS_KEY,
} from './object-keys.js'
import { emptyRankings } from './rankings-document.js'

export const JOURNAL_TTL_MS = 60 * 1000
export const GENERATION_TTL_MS = 60 * 1000

const NO_GENERATION = Object.freeze({
  schema: 1,
  id: null,
  published_at: null,
  commit: null,
})

async function readJsonObject(env, key) {
  const object = await env.R2.get(key)
  return object ? await object.json() : null
}

async function readActiveGeneration(env) {
  const pointer = await readJsonObject(env, ACTIVE_GENERATION_KEY)
  return pointer ? parseGenerationPointer(pointer) : null
}

async function readGenerationJson(env, generation, logicalKey) {
  if (!generation.id)
    return null
  return readJsonObject(env, generationKey(generation.id, logicalKey))
}

function generationBoundCache(generationCache, {
  name,
  empty,
  read,
  ttlMs,
}) {
  let boundGeneration = Symbol('unbound')
  const cache = createDocumentCache({
    name,
    empty,
    ttlMs,
    read: ({ env, generation }) => read(env, generation),
  })

  return {
    async load(env) {
      const generation = await generationCache.load(env)
      if (generation.id !== boundGeneration) {
        cache.reset()
        boundGeneration = generation.id
      }
      return cache.load({ env, generation })
    },
    seed(value) {
      cache.seed(value)
    },
    status: cache.status,
    reset() {
      boundGeneration = Symbol('unbound')
      cache.reset()
    },
  }
}

// CI snapshots confirmed ingests into the generation's asset-index. Runtime only reads raw objects
// that are not represented by that snapshot, so old journal objects may later be compacted safely.
async function readIngestJournal(env) {
  const index = await getAssetIndex(env)
  const snapshot = index.ingest_snapshot || { keys: [], entries: [] }
  const included = new Set(snapshot.keys || [])
  const keys = []
  let cursor
  do {
    const page = await env.R2.list({ prefix: INGEST_JOURNAL_PREFIX, cursor })
    for (const object of page.objects) {
      if (!included.has(object.key))
        keys.push(object.key)
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)

  const files = []
  for (let offset = 0; offset < keys.length; offset += 10) {
    const batch = await Promise.all(keys.slice(offset, offset + 10).map(async (key) => {
      const object = await env.R2.get(key)
      if (!object)
        throw new Error(`Journal object ${key} disappeared after listing; refusing a partial ingest view.`)
      return { key, text: await object.text() }
    }))
    files.push(...batch)
  }

  const { snapshot: tail, problems } = foldJournalFiles(files)
  if (problems.length > 0)
    throw new Error(`Could not fold ${INGEST_JOURNAL_PREFIX}: ${problems.join('; ')}`)
  const harvested = foldIngestEntries([...(snapshot.entries || []), ...tail.entries])
  return harvested.length > 0 ? harvested : null
}

function buildCaches() {
  const generation = createDocumentCache({
    name: ACTIVE_GENERATION_KEY,
    read: readActiveGeneration,
    empty: () => NO_GENERATION,
    ttlMs: GENERATION_TTL_MS,
  })

  const catalog = generationBoundCache(generation, {
    name: CATALOG_KEY,
    read: (env, active) => readGenerationJson(env, active, CATALOG_KEY),
    empty: () => ({ repos: {}, categories: [] }),
  })

  const rankings = generationBoundCache(generation, {
    name: RANKINGS_KEY,
    read: (env, active) => readGenerationJson(env, active, RANKINGS_KEY),
    empty: () => emptyRankings(),
  })

  const assetIndex = generationBoundCache(generation, {
    name: ASSET_INDEX_KEY,
    read: (env, active) => readGenerationJson(env, active, ASSET_INDEX_KEY),
    empty: () => ({ repos: {}, intent_inverted: {}, starredCount: 0, totalRepos: 0 }),
  })

  const vectors = generationBoundCache(generation, {
    name: 'embeddings',
    empty: () => ({ vectors: null, records: null, inputProfile: null }),
    read: async (env, active) => {
      if (!active.id)
        return null
      const keys = {
        index: generationKey(active.id, EMBEDDINGS_INDEX_KEY),
        binary: generationKey(active.id, EMBEDDINGS_BIN_KEY),
        manifest: generationKey(active.id, EMBEDDINGS_MANIFEST_KEY),
      }
      const [indexObject, binObject, manifestObject] = await Promise.all([
        env.R2.get(keys.index),
        env.R2.get(keys.binary),
        env.R2.get(keys.manifest),
      ])
      if (!indexObject && !binObject && !manifestObject)
        return null
      if (!indexObject || !binObject || !manifestObject)
        throw new Error(`Vector generation ${active.id} is incomplete.`)

      const indexText = await indexObject.text()
      const records = JSON.parse(indexText)
      validateVectorIndex(records)
      const buffer = await binObject.arrayBuffer()
      const problem = describePairMismatch({ records, bytes: buffer.byteLength })
      if (problem)
        throw new Error(`${keys.binary} / ${keys.index} invariant violated: ${problem}`)
      const inputProfile = await verifyVectorManifest(
        await manifestObject.json(),
        records,
        new TextEncoder().encode(indexText),
        buffer,
      )
      return { vectors: new Float32Array(buffer), records, inputProfile }
    },
  })

  const ingestJournal = generationBoundCache(generation, {
    name: INGEST_JOURNAL_PREFIX,
    read: env => readIngestJournal(env),
    empty: () => [],
    ttlMs: JOURNAL_TTL_MS,
  })

  return { generation, catalog, rankings, assetIndex, vectors, ingestJournal }
}

let caches = buildCaches()

export function getDataGeneration(env) {
  return caches.generation.load(env)
}

export function getCatalog(env) {
  return caches.catalog.load(env)
}

export function getRankings(env) {
  return caches.rankings.load(env)
}

export function getAssetIndex(env) {
  return caches.assetIndex.load(env)
}

export function getVectors(env) {
  return caches.vectors.load(env)
}

export function getHarvested(env) {
  return caches.ingestJournal.load(env)
}

export function seedRankings(document) {
  caches.rankings.seed(document)
}

export function seedHarvested(entries) {
  caches.ingestJournal.seed(entries)
}

export function dataPlaneStatus() {
  const statuses = {}
  for (const [key, cache] of Object.entries(caches))
    statuses[key] = cache.status()
  const degraded = Object.values(statuses).some(
    status => status === DOCUMENT_STATUS.STALE || status === DOCUMENT_STATUS.UNAVAILABLE,
  )
  return { statuses, degraded }
}

export function resetDocumentCaches() {
  caches = buildCaches()
}
