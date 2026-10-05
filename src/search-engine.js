import { resolveArchiveCandidates } from './archive-candidates.js'
import { buildCommunityIndex } from './community-index.js'
import { collectCommunityHits } from './community-layers.js'
import { DIMS } from './embeddings.js'
import { analyzeQuery } from './query-analysis.js'
import { fuseRankings } from './ranking.js'
import { snippetAround } from './readme-evidence.js'
import { compileResults } from './result-compiler.js'
import { evaluateFacetCoverage, explainTextMatch, intentMatchScore, matchesSubjectGate, scoreText, termMatcher } from './scoring.js'

export function searchDocuments({ catalog, rankings, assetIndex, harvested, vectors, queryVector, intents }, query, { category, source, scope = 'all', limit = 5, min_score = 0.25, explain = false } = {}) {
  const genericIntents = intents
  const repos = Object.fromEntries(Object.entries(catalog.repos || {}).map(
    ([name, record]) => [name.toLowerCase(), { ...record, repo: record.repo || name }],
  ))
  for (const item of harvested) {
    const key = item.repo.toLowerCase()
    if (repos[key])
      repos[key] = { ...repos[key], reason: item.reason || repos[key].reason, summary: item.summary || repos[key].summary }
  }
  const starredNames = new Set(Object.keys(repos).map(name => name.toLowerCase()))
  const targetCategory = category?.trim().toLowerCase()
  const targetSource = source?.trim().toLowerCase()
  const { queryTokens, matchedGroups, specificSubjects, hardSubjects, facets } = analyzeQuery(query, genericIntents)
  // The channels every catalogue-free layer scores through; defined in src/scoring.js so a layer
  // cannot weigh a match differently from its neighbours.
  const layerQuery = { specificSubjects, queryTokens, matchedGroups, facets, intents: genericIntents, explain }

  // 1. Vector Semantic Search (SiliconFlow BAAI/bge-m3, single embedding authority)
  const vectorScores = new Map()
  const vectorEvidence = new Map()
  if (scope === 'starred' || scope === 'all') {
    const { values: matrix, records, norms } = vectors

    if (matrix && records) {
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

            vectorScores.set(repoKey, Math.max(vectorScores.get(repoKey) || 0, cos))
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
                heading: record.heading,
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

      if (!matchesSubjectGate(textPool, specificSubjects))
        continue

      let score = 0
      const matches = termMatcher(textPool)
      const matchesName = termMatcher(name)
      const matchesShortName = termMatcher(r.name || '')
      const matchesReason = termMatcher(r.reason || '')

      // Subject bonus
      for (const sub of specificSubjects) {
        if (matches(sub))
          score += 40
        if (matchesName(sub))
          score += 30
        if (matchesReason(sub))
          score += 20
      }

      // User token direct matches
      for (const token of queryTokens) {
        if (matches(token)) {
          score += 8
          if (matchesShortName(token))
            score += 10
          if (matchesReason(token))
            score += 6
        }
      }

      // Intent groups are evidence dimensions, not bags of synonyms. Repeating several
      // ontology words from one domain may strengthen a match slightly, but cannot outscore a
      // repository that covers several distinct user requirements.
      for (const group of matchedGroups) {
        const groupWords = genericIntents[group] || []
        const matchedWords = groupWords.filter(matches)
        if (matchedWords.length === 0)
          continue
        const explicitlyTyped = matchedWords.filter(word => queryTokens.includes(word))
        score += explicitlyTyped.length > 0
          ? 8 + Math.min(explicitlyTyped.length - 1, 2)
          : intentMatchScore(groupWords, matches)
        if (matchedWords.some(matchesReason))
          score += 6
      }

      if (score > 0) {
        keywordScores.set(name, {
          weight: score,
          source: 'starred',
          item: r,
          facetCoverage: evaluateFacetCoverage(textPool, facets),
          evidence: explain ? explainTextMatch(textPool, layerQuery) : undefined,
        })
      }
    }
  }

  // The journal is immediately searchable even before the batch index catches up.
  if (scope !== 'starred') {
    for (const item of harvested) {
      if (starredNames.has(item.repo.toLowerCase()))
        continue
      const text = [item.repo, item.description, item.reason, item.summary, ...(item.topics || [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      if (!matchesSubjectGate(text, specificSubjects))
        continue
      const weight = scoreText(text, layerQuery)
      if (weight > 0) {
        keywordScores.set(item.repo.toLowerCase(), {
          weight,
          source: 'curated',
          badge: '💎 Curated Asset',
          tier: 'curated',
          item,
          facetCoverage: evaluateFacetCoverage(text, facets),
          evidence: explain ? explainTextMatch(text, layerQuery) : undefined,
        })
      }
    }
  }

  // Rankings: the five community layers, in the order src/community-layers.js declares. Their
  // candidates are scored with the shared channels and published with their provenance — never with
  // a `categories` value, which belongs to the deployer's own taxonomy.
  if (scope === 'rankings' || scope === 'all')
    collectCommunityHits({ rankings, query: layerQuery, keywordScores })

  // Level-2 存档检索: 从统一资产库 intent_inverted 查命中意图词对应的库
  // (覆盖持续增长的社区/存档库, 不依赖当日 rankings 快照)
  if (scope === 'all' || scope === 'rankings') {
    // 去重键集: 已在向量分或关键词分命中的库不再补分, 避免三重计分
    // (asset-index 是 catalog+rankings 超集; 长尾/存档库是 Level-2 的真正价值点)
    const scoredRepos = new Set()
    for (const name of keywordScores.keys())
      scoredRepos.add(name.toLowerCase())
    for (const name of vectorScores.keys())
      scoredRepos.add(name.toLowerCase())

    const archived = resolveArchiveCandidates({
      assetIndex,
      intents: genericIntents,
      matchedGroups,
      queryTokens,
      scoredRepos,
      specificSubjects,
      targetCategory,
      facets,
    })

    for (const entry of archived) {
      keywordScores.set(entry.repo.toLowerCase(), {
        weight: entry.weight,
        channel: 'archive',
        source: entry.source,
        badge: entry.badge,
        tier: entry.tier,
        item: entry.item,
        facetCoverage: entry.facetCoverage,
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

  // 3. Reciprocal Rank Fusion (RRF) between Vector & Intent Scores
  const rrfMap = fuseRankings({
    vectorScores,
    vectorEvidence,
    keywordScores,
    repos,
    specificSubjects,
    hardSubjects,
    facets,
  })

  const ingestedByName = new Map(harvested.map(item => [item.repo.toLowerCase(), item]))
  for (const [name, stats] of rrfMap) {
    if (!repos[name] && ingestedByName.has(name)) {
      stats.source = 'curated'
      stats.badge = '💎 Curated Asset'
      stats.extraItem = ingestedByName.get(name)
    }
  }

  // 4. Compile and Sort Results
  const communityMap = buildCommunityIndex({ rankings, harvested })

  return compileResults({
    rrfMap,
    repos,
    communityMap,
    targetCategory,
    targetSource,
    minScore: min_score,
    limit,
    explain,
    applyCommunityDiversityCap: scope === 'all' && !targetSource,
  })
}
