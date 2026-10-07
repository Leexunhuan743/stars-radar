import { resolveArchiveCandidates } from './archive-candidates.js'
import { buildCommunityIndex } from './community-index.js'
import { collectCommunityHits } from './community-layers.js'
import { DIMS } from './embeddings.js'
import { EVIDENCE_TRUST } from './evidence.js'
import { analyzeQuery, hardRequirementClauses } from './query-analysis.js'
import { fuseRankings } from './ranking.js'
import { snippetAround } from './readme-evidence.js'
import { compileResults } from './result-compiler.js'
import {
  containsTerm,
  explainTextMatch,
  matchesSubjectGate,
  mergeMatchEvidence,
  scoreMatchEvidence,
} from './scoring.js'

function requirementClauseMatches(text, clause, intents) {
  const pool = String(text || '').toLowerCase()
  if (!pool)
    return false

  // Explicit technical names in a mandatory clause are requirements, not semantic hints.
  // "CUDA + tensor-parallel + OpenAI-compatible" may not be satisfied by an arbitrary LLM server.
  if (clause.anchors.length > 0)
    return clause.anchors.every(anchor => containsTerm(pool, anchor))

  // CJK-only clauses fall back to intent/subject coverage because they do not expose stable
  // ASCII protocol or technology anchors.
  for (const group of clause.matchedGroups) {
    if (!(intents[group] || []).some(term => containsTerm(pool, term)))
      return false
  }

  if (clause.specificSubjects.length > 0
    && !clause.specificSubjects.some(subject => containsTerm(pool, subject))) {
    return false
  }

  if (clause.matchedGroups.size === 0 && clause.specificSubjects.length === 0) {
    if (clause.queryTokens.length === 0 || !clause.queryTokens.some(token => containsTerm(pool, token)))
      return false
  }

  return true
}

function recordRequirementCoverage(coverage, repoKey, text, clauses, intents) {
  if (clauses.length === 0)
    return
  const current = coverage.get(repoKey) || clauses.map(() => false)
  clauses.forEach((clause, index) => {
    if (!current[index] && requirementClauseMatches(text, clause, intents))
      current[index] = true
  })
  coverage.set(repoKey, current)
}

export function searchDocuments({ catalog, rankings, assetIndex, harvested, vectors, queryVector, intents }, query, { category, source, scope = 'all', limit = 5, min_score = 0.25, explain = false } = {}) {
  const genericIntents = intents
  const catalogSnapshotAt = catalog.generatedAt || null
  const repos = Object.fromEntries(Object.entries(catalog.repos || {}).map(([name, record]) => {
    const fieldOrigins = {
      ...(record.reason
        ? { reason: { source: 'catalog', snapshotAt: catalogSnapshotAt, trust: EVIDENCE_TRUST.USER_TRUSTED } }
        : {}),
      ...(record.summary
        ? { summary: { source: 'catalog', snapshotAt: catalogSnapshotAt, trust: EVIDENCE_TRUST.USER_TRUSTED } }
        : {}),
      ...((record.categories || []).length > 0
        ? { categories: { source: 'github_lists', snapshotAt: catalogSnapshotAt, trust: EVIDENCE_TRUST.USER_TRUSTED } }
        : {}),
    }
    return [name.toLowerCase(), { ...record, repo: record.repo || name, fieldOrigins }]
  }))

  // Current ingest records own only explicit user fields. Description remains external metadata;
  // reason and taxonomy carry user-trusted provenance.
  const curated = harvested.map(item => ({
    ...item,
    fieldOrigins: {
      ...(item.reason
        ? { reason: { source: 'ingest_journal', snapshotAt: item.ingested_at || null, trust: EVIDENCE_TRUST.USER_TRUSTED } }
        : {}),
      ...((item.categories || []).length > 0
        ? { categories: { source: 'ingest_journal', snapshotAt: item.ingested_at || null, trust: EVIDENCE_TRUST.USER_TRUSTED } }
        : {}),
    },
  }))

  const curatedByName = new Map(curated.map(item => [item.repo.toLowerCase(), item]))
  const assetRepos = assetIndex.repos || {}

  for (const item of curated) {
    const key = item.repo.toLowerCase()
    if (repos[key] && item.reason) {
      repos[key] = {
        ...repos[key],
        reason: item.reason,
        fieldOrigins: {
          ...(repos[key].fieldOrigins || {}),
          reason: item.fieldOrigins.reason,
        },
      }
    }
  }
  const starredNames = new Set(Object.keys(repos).map(name => name.toLowerCase()))
  const targetCategory = category?.trim().toLowerCase()
  const targetSource = source?.trim().toLowerCase()
  const { queryTokens, matchedGroups, specificSubjects, hardSubjects } = analyzeQuery(query, genericIntents)
  const requirementClauses = hardRequirementClauses(query, genericIntents)
  const requirementCoverage = new Map()
  const vectorHardSubjects = [...hardSubjects]
  if (vectorHardSubjects.length === 0 && specificSubjects.length === 1) {
    const subject = specificSubjects[0]
    const namedIdentityExists = [
      ...Object.values(repos).map(repo => [repo.repo, repo.name].filter(Boolean).join(' ')),
      ...curated.map(repo => [repo.repo, repo.name].filter(Boolean).join(' ')),
      ...Object.values(assetRepos).map(repo => [repo.repo, repo.name].filter(Boolean).join(' ')),
    ].some(identity => containsTerm(identity, subject))
    if (namedIdentityExists)
      vectorHardSubjects.push(subject)
  }
  // The channels every catalogue-free layer scores through; defined in src/scoring.js so a layer
  // cannot weigh a match differently from its neighbours.
  const layerQuery = { specificSubjects, queryTokens, matchedGroups, intents: genericIntents, explain }

  // README chunks already live in the vector index. Scan those same bounded chunks lexically too:
  // rare flags, protocol names and exact feature terms should not depend on embedding proximity alone.
  const readmeKeywordScores = new Map()

  // 1. Vector Semantic Search (SiliconFlow BAAI/bge-m3, single embedding authority)
  const repoVectorScores = new Map()
  const readmeVectorScores = new Map()
  const vectorEvidence = new Map()
  if (scope === 'starred' || scope === 'all') {
    const { values: matrix, records, norms } = vectors

    if (matrix && records) {
      for (const record of records) {
        if (record.kind !== 'readme_chunk')
          continue
        const repoKey = record.repo.toLowerCase()
        if (scope === 'starred' && !starredNames.has(repoKey))
          continue
        const textPool = `${record.heading || ''} ${record.text || ''}`.toLowerCase()
        recordRequirementCoverage(requirementCoverage, repoKey, textPool, requirementClauses, genericIntents)
        const literal = explainTextMatch(textPool, layerQuery)
        const chunkWeight = scoreMatchEvidence(literal)
        if (chunkWeight <= 0)
          continue

        const previous = readmeKeywordScores.get(repoKey)
        const aggregateEvidence = mergeMatchEvidence(previous?.evidence, literal)
        const aggregateWeight = scoreMatchEvidence(aggregateEvidence)
        const terms = [
          ...literal.matched_subjects,
          ...literal.matched_tokens,
          ...literal.matched_intents.flatMap(match => match.terms),
        ]
        const chunkEvidence = {
          chunk_id: record.id,
          readme_sha256: record.readme_sha256 || null,
          content_sha256: record.content_sha256 || null,
          ordinal: Number.isInteger(record.ordinal) ? record.ordinal : null,
          chunk_ordinal: Number.isInteger(record.chunk_ordinal) ? record.chunk_ordinal : null,
          heading: record.heading,
          heading_path: Array.isArray(record.heading_path) ? record.heading_path : null,
          snippet: snippetAround(record.text || '', [...new Set(terms)]),
          keyword_weight: chunkWeight,
          matched_tokens: literal.matched_tokens,
          matched_subjects: literal.matched_subjects,
          matched_intents: literal.matched_intents,
        }
        const keepPreviousChunk = previous && previous.bestChunkWeight >= chunkWeight
        readmeKeywordScores.set(repoKey, {
          weight: aggregateWeight,
          evidence: aggregateEvidence,
          readmeEvidence: keepPreviousChunk ? previous.readmeEvidence : chunkEvidence,
          bestChunkWeight: keepPreviousChunk ? previous.bestChunkWeight : chunkWeight,
        })
      }

      const qVector = queryVector

      if (qVector && qVector.length === DIMS) {
        let normQ = 0
        for (let j = 0; j < DIMS; j++) normQ += qVector[j] * qVector[j]
        normQ = Math.sqrt(normQ)

        if (normQ > 0) {
          const maxVectors = Math.min(records.length, Math.floor(matrix.length / DIMS))
          for (let i = 0; i < maxVectors; i++) {
            const record = records[i]
            const repoKey = record.repo.toLowerCase()
            if (scope === 'starred' && !starredNames.has(repoKey))
              continue

            let dot = 0
            let squared = 0
            const offset = i * DIMS
            const cachedNorm = norms?.[i]
            for (let j = 0; j < DIMS; j++) {
              const v = matrix[offset + j]
              dot += qVector[j] * v
              if (cachedNorm === undefined)
                squared += v * v
            }

            const normV = cachedNorm === undefined ? Math.sqrt(squared) : cachedNorm
            const cos = normV > 0 ? dot / (normQ * normV) : 0
            if (cos <= 0.2)
              continue

            if (record.kind === 'repo')
              repoVectorScores.set(repoKey, Math.max(repoVectorScores.get(repoKey) || 0, cos))
            else
              readmeVectorScores.set(repoKey, Math.max(readmeVectorScores.get(repoKey) || 0, cos))

            const semantic = vectorEvidence.get(repoKey) || {
              repo_similarity: 0,
              readme_chunk: null,
            }

            if (record.kind === 'repo') {
              semantic.repo_similarity = Math.max(semantic.repo_similarity, cos)
            }
            else if (!semantic.readme_chunk || cos > semantic.readme_chunk.similarity) {
              const textPool = `${record.heading} ${record.text}`.toLowerCase()
              const literal = explain ? explainTextMatch(textPool, layerQuery) : null
              const terms = literal
                ? [
                    ...literal.matched_subjects,
                    ...literal.matched_tokens,
                    ...literal.matched_intents.flatMap(match => match.terms),
                  ]
                : []
              semantic.readme_chunk = {
                chunk_id: record.id,
                readme_sha256: record.readme_sha256 || null,
                content_sha256: record.content_sha256 || null,
                ordinal: Number.isInteger(record.ordinal) ? record.ordinal : null,
                chunk_ordinal: Number.isInteger(record.chunk_ordinal) ? record.chunk_ordinal : null,
                heading: record.heading,
                heading_path: Array.isArray(record.heading_path) ? record.heading_path : null,
                text: record.text,
                snippet: snippetAround(record.text, [...new Set(terms)]),
                similarity: cos,
              }
            }

            vectorEvidence.set(repoKey, semantic)
          }
        }
      }
    }
  }

  // 2. Domain Intent & Subject Anchoring
  const keywordScores = new Map()
  for (const [repoKey, hit] of readmeKeywordScores) {
    const item = repos[repoKey] || curatedByName.get(repoKey)
    if (!item)
      continue
    keywordScores.set(repoKey, {
      weight: hit.weight,
      source: repos[repoKey] ? 'starred' : 'curated',
      badge: repos[repoKey] ? '⭐ Starred' : '💎 Curated Asset',
      item,
      evidence: hit.evidence,
      readmeEvidence: hit.readmeEvidence,
    })
  }

  // Personal Stars
  if (scope === 'starred' || scope === 'all') {
    for (const [name, r] of Object.entries(repos)) {
      if (targetCategory && !(r.categories || []).map(c => c.toLowerCase()).includes(targetCategory)) {
        continue
      }

      const textPool = [
        r.name?.toLowerCase() || '',
        name.toLowerCase(),
        r.description?.toLowerCase() || '',
        r.reason?.toLowerCase() || '',
        r.summary?.toLowerCase() || '',
        ...(r.topics || []).map(t => t.toLowerCase()),
        ...(r.categories || []).map(c => c.toLowerCase()),
      ].join(' ')
      recordRequirementCoverage(requirementCoverage, name, textPool, requirementClauses, genericIntents)

      if (!matchesSubjectGate(textPool, specificSubjects))
        continue

      const literal = explainTextMatch(textPool, layerQuery)
      const score = scoreMatchEvidence(literal)

      if (score > 0) {
        const previous = keywordScores.get(name)
        const evidence = mergeMatchEvidence(previous?.evidence, literal)
        keywordScores.set(name, {
          weight: scoreMatchEvidence(evidence),
          source: 'starred',
          item: r,
          evidence,
          readmeEvidence: previous?.readmeEvidence,
        })
      }
    }
  }

  // The journal is immediately searchable even before the batch index catches up.
  if (scope !== 'starred') {
    for (const item of curated) {
      if (starredNames.has(item.repo.toLowerCase()))
        continue
      const text = [item.repo, item.description, item.reason, item.summary, ...(item.topics || [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      recordRequirementCoverage(requirementCoverage, item.repo.toLowerCase(), text, requirementClauses, genericIntents)
      if (!matchesSubjectGate(text, specificSubjects))
        continue
      const literal = explainTextMatch(text, layerQuery)
      const weight = scoreMatchEvidence(literal)
      if (weight > 0) {
        const key = item.repo.toLowerCase()
        const previous = keywordScores.get(key)
        const evidence = mergeMatchEvidence(previous?.evidence, literal)
        keywordScores.set(key, {
          weight: scoreMatchEvidence(evidence),
          source: 'curated',
          badge: '💎 Curated Asset',
          tier: 'curated',
          item,
          evidence,
          readmeEvidence: previous?.readmeEvidence,
        })
      }
    }
  }

  // Rankings: the community layers, in the order src/community-layers.js declares. Their
  // candidates are scored with the shared channels and published with their provenance — never with
  // a `categories` value, which belongs to the deployer's own taxonomy.
  if (scope === 'rankings' || scope === 'all')
    collectCommunityHits({ rankings, query: layerQuery, keywordScores })

  if (requirementClauses.length > 0) {
    for (const [repoKey, meta] of keywordScores) {
      const item = meta.item || {}
      const pool = [
        item.repo || repoKey,
        item.name,
        item.description,
        item.reason,
        item.summary,
        item.language,
        ...(item.topics || []),
        ...(item.categories || []),
      ].filter(Boolean).join(' ').toLowerCase()
      recordRequirementCoverage(requirementCoverage, repoKey, pool, requirementClauses, genericIntents)
    }
  }

  // Level-2 存档检索: 从统一资产库 intent_inverted 查命中意图词对应的库
  // (覆盖持续增长的社区/存档库, 不依赖当日 rankings 快照)
  if (scope === 'all' || scope === 'rankings') {
    // Archive is a lexical evidence channel, so semantic presence must never suppress it.
    // Only an existing lexical/community hit is skipped here to avoid counting the same textual
    // observation twice. RRF is specifically responsible for combining independent lexical and
    // semantic evidence for the same repository.
    const scoredRepos = new Set([...keywordScores.keys()].map(name => name.toLowerCase()))

    const archived = resolveArchiveCandidates({
      assetIndex,
      intents: genericIntents,
      matchedGroups,
      queryTokens,
      scoredRepos,
      specificSubjects,
      targetCategory,
    })

    for (const entry of archived) {
      keywordScores.set(entry.repo.toLowerCase(), {
        weight: entry.weight,
        channel: 'archive',
        source: entry.source,
        badge: entry.badge,
        tier: entry.tier,
        item: entry.item,
        evidence: explain
          ? explainTextMatch(
              [
                entry.repo,
                assetIndex.repos[entry.repo.toLowerCase()]?.name,
                entry.item.description,
                entry.item.reason,
                entry.item.summary,
                assetIndex.repos[entry.repo.toLowerCase()]?.language,
                ...(assetIndex.repos[entry.repo.toLowerCase()]?.topics || []),
                ...(entry.item.categories || []),
              ].filter(Boolean).join(' ').toLowerCase(),
              layerQuery,
            )
          : undefined,
      })
    }
  }

  if (requirementClauses.length > 0) {
    for (const [repoKey, meta] of keywordScores) {
      const item = meta.item || {}
      const pool = [
        item.repo || repoKey,
        item.name,
        item.description,
        item.reason,
        item.summary,
        item.language,
        ...(item.topics || []),
        ...(item.categories || []),
      ].filter(Boolean).join(' ').toLowerCase()
      recordRequirementCoverage(requirementCoverage, repoKey, pool, requirementClauses, genericIntents)
    }
  }

  // 3. Reciprocal Rank Fusion (RRF) across independent evidence planes.
  const rrfMap = fuseRankings({
    repoVectorScores,
    readmeVectorScores,
    vectorEvidence,
    keywordScores,
    repos,
    assets: assetRepos,
    hardSubjects: vectorHardSubjects,
  })

  if (requirementClauses.length > 0) {
    for (const repoKey of [...rrfMap.keys()]) {
      const coverage = requirementCoverage.get(repoKey)
      if (!coverage || coverage.some(matched => !matched))
        rrfMap.delete(repoKey)
    }
  }

  const ingestedByName = new Map(curated.map(item => [item.repo.toLowerCase(), item]))
  for (const [name, stats] of rrfMap) {
    if (!repos[name] && ingestedByName.has(name)) {
      stats.source = 'curated'
      stats.badge = '💎 Curated Asset'
      stats.extraItem = ingestedByName.get(name)
    }
  }

  // 4. Compile and Sort Results
  const communityMap = buildCommunityIndex({ rankings, harvested: curated })

  return compileResults({
    rrfMap,
    repos,
    communityMap,
    targetCategory,
    targetSource,
    minScore: min_score,
    limit,
    explain,
    catalogSnapshotAt,
    rankingSnapshotAt: rankings.generatedAt || null,
  })
}
