// Every R2-backed document the Worker serves from, in one place.
//
// Why this is its own module: `src/index.js` imports `agents/mcp`, which resolves a `cloudflare:`
// scheme that plain Node cannot load, so nothing defined there can be tested. The loaders below —
// which decide whether a request is answered from a document, from an empty placeholder, or with a
// "we could not read this" error — were therefore unreachable by any test, even though getting
// them wrong is exactly how an R2 hiccup turned into "no repositories matched" for half an hour.
//
// Only `env.R2` is touched here, so this module is importable and testable under plain Node.

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

/**
 * How long the folded ingest journal stays cached inside one isolate.
 *
 * Every other document here is replaced wholesale by a six-hourly build, so half an hour of staleness
 * is invisible to a reader. The journal is the one document a *user action* changes: an ingest appends
 * to it and the caller is told the entry is there. Under the shared 30-minute TTL the isolate that
 * handled the write saw it at once — the writer seeds its own cache — while every other isolate kept
 * serving the fold from before it, so the same query answered `🌐 Global Discovery` and
 * `⚡ Community Ingested` for one repository in the same minute, and `/health` reported two different
 * ingest counts a second apart (both observed on a live deployment).
 *
 * One minute is short enough that somebody checking the result of their own write sees it, and long
 * enough that a fold — one list plus one read per entry — does not run on every request. The write
 * itself was never at risk: the journal object is in R2 either way.
 */
export const JOURNAL_TTL_MS = 60 * 1000

// Read one JSON object out of R2. `null` means "this bucket does not hold it yet" and is the only
// outcome that may be answered with an empty document; every other failure throws, which
// document-cache.js turns into either a stale answer or a loud error.
async function readJsonObject(env, key) {
  const object = await env.R2.get(key)
  return object ? await object.json() : null
}

// CI snapshots the folded entries without deleting the append-only journal. A cold isolate
// reads only objects absent from that snapshot, including writes racing with the build.
async function readIngestJournal(env) {
  const index = await getAssetIndex(env)
  const snapshot = index.ingest_snapshot || { keys: [], entries: [] }
  const included = new Set(snapshot.keys)
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
  const harvested = foldIngestEntries([...snapshot.entries, ...tail.entries])
  return harvested.length > 0 ? harvested : null
}

// Built once per isolate: the caches are module state, which is what makes a warm isolate cheap and
// a cold one correct.
function buildCaches() {
  return {
    catalog: createDocumentCache({
      name: CATALOG_KEY,
      read: env => readJsonObject(env, CATALOG_KEY),
      empty: () => ({ repos: {}, categories: [] }),
    }),
    rankings: createDocumentCache({
      name: RANKINGS_KEY,
      read: env => readJsonObject(env, RANKINGS_KEY),
      // Mirrors the shape the pipeline publishes, so every consumer sees the same keys whether or
      // not the document exists yet.
      empty: () => emptyRankings(),
    }),
    assetIndex: createDocumentCache({
      name: ASSET_INDEX_KEY,
      read: env => readJsonObject(env, ASSET_INDEX_KEY),
      empty: () => ({ repos: {}, intent_inverted: {}, starredCount: 0, totalRepos: 0 }),
    }),
    vectors: createDocumentCache({
      name: 'embeddings',
      empty: () => ({ vectors: null, records: null }),
      // The pair is one logical document: an index that disagrees with the binary cannot be
      // loaded, and reporting that as "no vectors yet" is what used to disable semantic search
      // without a trace in /health.
      read: async (env) => {
        const [indexObject, binObject, manifestObject] = await Promise.all([
          env.R2.get(EMBEDDINGS_INDEX_KEY),
          env.R2.get(EMBEDDINGS_BIN_KEY),
          env.R2.get(EMBEDDINGS_MANIFEST_KEY),
        ])
        if (!indexObject && !binObject && !manifestObject)
          return null
        if (!indexObject || !binObject)
          throw new Error('Vector generation is incomplete: the index or binary object is missing.')
        const indexText = await indexObject.text()
        const records = JSON.parse(indexText)
        validateVectorIndex(records)
        const buffer = await binObject.arrayBuffer()
        const problem = describePairMismatch({ records, bytes: buffer.byteLength })
        if (problem) {
          throw new Error(
            `${EMBEDDINGS_BIN_KEY} / ${EMBEDDINGS_INDEX_KEY} invariant violated: ${problem} `
            + `Re-sync the pair from R2, or rebuild it with scripts/vector_pipeline.js.`,
          )
        }
        if (!manifestObject)
          throw new Error('Vector manifest is missing. Run the CI data build before serving this vector generation.')
        const inputProfile = await verifyVectorManifest(await manifestObject.json(), records, new TextEncoder().encode(indexText), buffer)
        return { vectors: new Float32Array(buffer), records, inputProfile }
      },
    }),
    ingestJournal: createDocumentCache({
      name: INGEST_JOURNAL_PREFIX,
      read: env => readIngestJournal(env),
      empty: () => [],
      ttlMs: JOURNAL_TTL_MS,
    }),
  }
}

let caches = buildCaches()

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

/** Installs a document this isolate just wrote, so the writer sees its own update immediately. */
export function seedRankings(document) {
  caches.rankings.seed(document)
}

/** Installs the ingest view after an append, so the writer sees its own entry immediately. */
export function seedHarvested(entries) {
  caches.ingestJournal.seed(entries)
}

/** Per-document status plus an overall verdict, reported by `/health`. */
export function dataPlaneStatus() {
  const statuses = {}
  for (const [key, cache] of Object.entries(caches))
    statuses[key] = cache.status()
  const degraded = Object.values(statuses).some(
    status => status === DOCUMENT_STATUS.STALE || status === DOCUMENT_STATUS.UNAVAILABLE,
  )
  return { statuses, degraded }
}

/** Test seam: drops every cached document so the next read hits the bucket again. */
export function resetDocumentCaches() {
  caches = buildCaches()
}
