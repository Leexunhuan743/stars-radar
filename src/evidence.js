// Evidence identity and trust contracts shared by search and repository research surfaces.
//
// Ranking signals answer "why was this candidate ordered here?"; evidence answers
// "what source can a caller inspect to support a factual claim?". Keeping the two
// separate prevents cosine similarity or a keyword weight from masquerading as proof.

export const EVIDENCE_TRUST = Object.freeze({
  SYSTEM: 'system',
  USER_TRUSTED: 'user_trusted',
  EXTERNAL_STRUCTURED: 'external_structured',
  EXTERNAL_UNTRUSTED: 'external_untrusted',
})

function token(value) {
  return String(value || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown'
}

export function evidenceId(kind, repo, identity) {
  return `ev:${token(kind)}:${token(repo)}:${token(identity)}`
}

export function generationIdentity(generation) {
  if (!generation?.id)
    return null
  return {
    id: generation.id,
    commit: generation.commit || null,
    published_at: generation.published_at || null,
  }
}

export function buildReadmeEvidence({
  kind = 'readme_chunk',
  repo,
  chunkId,
  heading,
  snippet,
  similarity,
  keywordWeight,
  matchedTokens = [],
  matchedSubjects = [],
  matchedIntents = [],
  ref,
  generation,
  readmeSha256,
  contentSha256,
  ordinal,
  chunkOrdinal,
  headingPath,
  fetchedAt,
} = {}) {
  const identity = chunkId || ref?.sha256 || readmeSha256 || fetchedAt || `live:${heading || 'README'}`
  return {
    id: evidenceId(kind, repo, identity),
    kind,
    repo,
    trust: EVIDENCE_TRUST.EXTERNAL_UNTRUSTED,
    generation: generationIdentity(generation),
    source: {
      kind: 'github_readme',
      url: repo ? `https://github.com/${repo}` : null,
      fetched_at: fetchedAt || null,
      snapshot_at: generation?.published_at || null,
    },
    content: {
      readme_sha256: ref?.sha256 || readmeSha256 || null,
      object_key: ref?.object_key || null,
      status: ref?.status || null,
      upstream_pushed_at: ref?.upstream_pushed_at || null,
      source_pushed_at: ref?.source_pushed_at || null,
      preserved_from_generation: ref?.preserved_from_generation || null,
      content_sha256: contentSha256 || null,
      ordinal: Number.isInteger(ordinal) ? ordinal : null,
      chunk_ordinal: Number.isInteger(chunkOrdinal) ? chunkOrdinal : null,
      chunk_id: chunkId || null,
      heading: heading || 'README',
      heading_path: Array.isArray(headingPath) ? headingPath : null,
      snippet: snippet || '',
    },
    match: {
      ...(Number.isFinite(similarity) ? { semantic_similarity: Number(similarity.toFixed(4)) } : {}),
      ...(Number.isFinite(keywordWeight) ? { keyword_weight: keywordWeight } : {}),
      matched_tokens: matchedTokens,
      matched_subjects: matchedSubjects,
      matched_intents: matchedIntents,
    },
  }
}

export function bindReadmeEvidence(evidence, { ref, generation } = {}) {
  if (!evidence || !String(evidence.kind || '').startsWith('readme_'))
    return evidence
  return {
    ...evidence,
    generation: generationIdentity(generation),
    source: {
      ...(evidence.source || {}),
      snapshot_at: generation?.published_at || null,
    },
    content: {
      ...(evidence.content || {}),
      readme_sha256: ref?.sha256 || evidence.content?.readme_sha256 || null,
      object_key: ref?.object_key || evidence.content?.object_key || null,
      status: ref?.status || evidence.content?.status || null,
      upstream_pushed_at: ref?.upstream_pushed_at || evidence.content?.upstream_pushed_at || null,
      source_pushed_at: ref?.source_pushed_at || evidence.content?.source_pushed_at || null,
      preserved_from_generation: ref?.preserved_from_generation || evidence.content?.preserved_from_generation || null,
    },
  }
}

export function bindResultReadmeEvidence(results, manifest = {}) {
  for (const result of results || []) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(result?.repo || ''))
      continue
    const ref = manifest.repos?.[result.repo.toLowerCase()]
    result.evidence = (result.evidence || []).map(item => bindReadmeEvidence(item, {
      ref,
      generation: manifest.generation,
    }))
  }
  return results
}

export function buildRepositoryEvidence({
  kind,
  repo,
  source,
  trust = EVIDENCE_TRUST.EXTERNAL_STRUCTURED,
  fetchedAt = null,
  snapshotAt = null,
  generation = null,
  identity,
  fields = [],
} = {}) {
  const stableIdentity = identity || fetchedAt || snapshotAt || generation?.id || source || kind
  return {
    id: evidenceId(kind, repo, stableIdentity),
    kind,
    repo,
    trust,
    generation: generationIdentity(generation),
    source: {
      kind: source,
      url: repo ? `https://github.com/${repo}` : null,
      fetched_at: fetchedAt,
      snapshot_at: snapshotAt,
    },
    fields: [...new Set(fields)],
  }
}
