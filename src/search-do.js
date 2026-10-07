import { DurableObject } from 'cloudflare:workers'
import defaultIntents from '../data/intents.json'
import { getAssetIndex, getCatalog, getHarvested, getRankings, getVectors } from './documents.js'
import { searchDocuments } from './search-engine.js'

/**
 * Runs the hybrid search off the request Worker.
 *
 * The search itself is synchronous CPU work: a 9,999-record vector scan plus a lexical pass over
 * every README chunk. Measured on the real corpus that is ~105 ms, while an HTTP-triggered Worker
 * on the Workers Free plan is capped at 10 ms of CPU per request, so roughly half of all searches
 * were answered with `Worker exceeded CPU limit`.
 *
 * A Durable Object is a different execution context: its per-invocation CPU ceiling is 30 seconds
 * by default (verified on the deployed Free-plan account: ~200M loop iterations completed inside
 * the object, ~500M was rejected). That is three orders of magnitude more headroom than this
 * search needs, so the existing engine runs here unmodified and keeps its exact ranking behaviour.
 *
 * The object is addressed by a single well-known name, so every query lands on the same instance
 * and reuses one in-memory copy of the documents. That is what makes this cheaper than sharding
 * across several Workers: a cold instance reads `embeddings.bin` (39 MB) once and then serves from
 * memory, instead of paying that read on every shard for every query.
 */
export class StarsRadarSearch extends DurableObject {
  /**
   * Documents are loaded through the same accessors the Worker used, so the generation-bound
   * caching, TTL and stale-copy behaviour are identical to the previous single-process design.
   */
  async #load(env) {
    const [catalog, rankings, assetIndex, harvested, vectors] = await Promise.all([
      getCatalog(env),
      getRankings(env),
      getAssetIndex(env),
      getHarvested(env),
      getVectors(env),
    ])
    return {
      catalog,
      rankings,
      assetIndex,
      harvested,
      vectors: { values: vectors.vectors, norms: vectors.norms, records: vectors.records },
    }
  }

  /**
   * Reports whether a semantic pass is possible, without making the caller load the index.
   * The Worker needs this answer before it spends a SiliconFlow round trip on an embedding.
   */
  async hasVectors() {
    const vectors = await getVectors(this.env)
    return Boolean(vectors.vectors && vectors.records?.length > 0)
  }

  /**
   * @param {string} query
   * @param {object} options        Search options, forwarded to `searchDocuments` unchanged.
   * @param {Float32Array|null} queryVector
   *        Encoded query embedding, or null when the caller could not obtain one. It travels as a
   *        plain array because structured cloning through an RPC boundary does not preserve
   *        Float32Array identity across every runtime version; the engine only needs something
   *        indexable with a `length`.
   */
  async search(query, options, queryVector) {
    const documents = await this.#load(this.env)
    const vector = queryVector ? Float32Array.from(queryVector) : null
    return searchDocuments(
      { ...documents, queryVector: vector, intents: defaultIntents },
      query,
      options,
    )
  }
}
