// What a vector pair is: the embedding model, its dimension, and the one invariant that ties
// `embeddings.bin` to `embeddings-index.json`.
//
// The dimension used to be declared independently in three places that had to agree — the Worker
// (which slices the Float32Array), the offline pipeline (which writes it) and the CI step that
// validates the byte length before upload — and a source-scanning test was written to compare the
// three literals. Comparing copies is not the same as having one, and the copies had already
// drifted: the invariant `count * DIMS * 4` was written out four times across the Worker, the
// pipeline and the workflow, each with its own wording for the same failure.
//
// The byte-length invariant is what keeps semantic search alive. Both halves of the pair are
// published as two independent objects, so a pair whose halves disagree is not a degraded index but
// an unusable one: the Worker refuses it and falls back to lexical search with no error anywhere.

/** The one model the vectors come from. Reported by `/health`, so it is part of the contract. */
export const EMBEDDING_MODEL = 'BAAI/bge-m3'

/** The exact semantic generation contract. Index records are repo metadata or README chunks. */
export const EMBEDDING_INPUT_PROFILE = 'repo-metadata-readme-chunks-v3'

export const VECTOR_RECORD_KINDS = new Set(['repo', 'readme_chunk'])

/** Float32 components per vector. */
export const DIMS = 1024

/** Bytes one vector occupies in `embeddings.bin`. */
export const BYTES_PER_VECTOR = DIMS * 4

export function isEmbedding(value) {
  return Array.isArray(value) && value.length === DIMS
    && value.every(component => Number.isFinite(component) && Number.isFinite(Math.fround(component)))
    && value.some(component => Math.fround(component) !== 0)
}

/** @param {number} count @returns {number} bytes the binary half must hold for `count` vectors. */
export function expectedPairBytes(count) {
  if (!Number.isInteger(count) || count < 0)
    throw new Error(`expectedPairBytes needs a vector count, got ${JSON.stringify(count)}`)
  return count * BYTES_PER_VECTOR
}

/**
 * How many vectors a binary half holds.
 *
 * A leftover remainder means the two halves were written by different runs, so the division is
 * floored only to keep the number reportable — {@link describePairMismatch} is what decides whether
 * the pair may be used at all.
 *
 * @param {number} bytes Size of the binary half.
 * @returns {number} whole vectors it can hold.
 */
export function vectorCountFromBytes(bytes) {
  return Math.floor(bytes / BYTES_PER_VECTOR)
}

export function vectorNorms(values, recordCount) {
  if (!(values instanceof Float32Array))
    throw new Error('vectorNorms needs a Float32Array matrix.')
  if (!Number.isInteger(recordCount) || recordCount < 0)
    throw new Error(`vectorNorms needs a non-negative record count, got ${JSON.stringify(recordCount)}.`)
  if (values.length !== recordCount * DIMS)
    throw new Error(`Vector matrix has ${values.length} components for ${recordCount} records.`)

  const norms = new Float32Array(recordCount)
  for (let i = 0; i < recordCount; i++) {
    let squared = 0
    const offset = i * DIMS
    for (let j = 0; j < DIMS; j++) {
      const value = values[offset + j]
      squared += value * value
    }
    norms[i] = Math.sqrt(squared)
  }
  return norms
}

/**
 * Describes why a pair cannot be used, or `null` when it can.
 *
 * Returned as a reason rather than thrown so each side can add its own context: the Worker reports
 * it as an unavailable document (which ends up in `/health`), the pipeline as a refused baseline,
 * and the CI step as a failed run. All three are reporting one fact.
 *
 * @param {{ records: object[], bytes: number }} pair
 * @returns {string|null} why the pair is unusable, or `null` when it is usable.
 */
export function describePairMismatch({ records, bytes }) {
  const expected = expectedPairBytes(records.length)
  if (bytes === expected)
    return null
  return `${bytes}B holds ${vectorCountFromBytes(bytes)} vectors but the index lists ${records.length} records `
    + `(expected ${expected}B). Both objects must come from the same pipeline run.`
}

export function validateVectorIndex(records) {
  if (!Array.isArray(records))
    throw new Error('Vector index must be an array of structured records.')

  const ids = new Set()
  const repoRecords = new Set()
  const chunkRepos = new Set()
  for (const [index, record] of records.entries()) {
    if (!record || typeof record !== 'object' || Array.isArray(record))
      throw new Error(`Vector index record ${index} must be an object.`)
    if (typeof record.id !== 'string' || !record.id)
      throw new Error(`Vector index record ${index} is missing id.`)
    if (ids.has(record.id))
      throw new Error(`Vector index contains duplicate id ${record.id}.`)
    ids.add(record.id)

    if (typeof record.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(record.repo))
      throw new Error(`Vector index record ${record.id} has invalid repo.`)
    if (!VECTOR_RECORD_KINDS.has(record.kind))
      throw new Error(`Vector index record ${record.id} has invalid kind ${JSON.stringify(record.kind)}.`)

    const repoKey = record.repo.toLowerCase()
    if (record.kind === 'repo') {
      if (record.id !== `repo:${repoKey}`)
        throw new Error(`Repo vector record ${record.id} must use canonical id repo:${repoKey}.`)
      repoRecords.add(repoKey)
      continue
    }

    if (!record.id.startsWith(`readme:${repoKey}:`) || record.id === `readme:${repoKey}:`)
      throw new Error(`README vector record ${record.id} must use canonical repo-prefixed id.`)
    chunkRepos.add(repoKey)
    if (typeof record.heading !== 'string' || !record.heading.trim())
      throw new Error(`README vector record ${record.id} is missing heading.`)
    if (typeof record.text !== 'string' || !record.text.trim())
      throw new Error(`README vector record ${record.id} is missing text.`)
  }

  for (const repo of chunkRepos) {
    if (!repoRecords.has(repo))
      throw new Error(`README vector records for ${repo} have no matching repo metadata record.`)
  }

  return { recordCount: records.length, repoCount: repoRecords.size }
}

export async function vectorDigest(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
}

/** The manifest commits both exact object contents, not merely their vector count. */
export async function vectorManifest(records, indexBytes, binaryBytes) {
  const { repoCount } = validateVectorIndex(records)
  return {
    model: EMBEDDING_MODEL,
    input_profile: EMBEDDING_INPUT_PROFILE,
    dimensions: DIMS,
    count: records.length,
    repo_count: repoCount,
    index_sha256: await vectorDigest(indexBytes),
    binary_sha256: await vectorDigest(binaryBytes),
  }
}

export async function verifyVectorManifest(manifest, records, indexBytes, binaryBytes) {
  const expected = await vectorManifest(records, indexBytes, binaryBytes)
  if (Object.keys(expected).some(key => manifest?.[key] !== expected[key])) {
    throw new Error(
      `Vector manifest does not match the required ${EMBEDDING_INPUT_PROFILE} generation. Rebuild and publish one complete vector generation through CI.`,
    )
  }
  return EMBEDDING_INPUT_PROFILE
}
