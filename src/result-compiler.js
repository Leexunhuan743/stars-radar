// Final result compilation: source/badge derivation, category and min_score
// filtering, and the relevance-then-RRF ordering.
//
// Extracted from src/index.js — which cannot be imported outside the worker runtime —
// because a mutation study showed the whole suite stayed green while this loop had its
// primary sort key inverted, relevance_score zeroed, and the `_rrf` tie-breaker removed.
// The Worker imports this via src/index.js; test/result-compiler.test.mjs imports it
// directly, so there is one source of truth rather than a drifting replica.
import { buildReadmeEvidence, buildRepositoryEvidence, EVIDENCE_TRUST } from './evidence.js'
import { relevanceScore } from './relevance.js'

/**
 * Every value `source` can carry in a result, declared once.
 *
 * It is the contract clients filter by (`?source=`), so it has to be complete: a source missing from
 * this list is one a caller cannot ask for, and the request would be rejected as invalid rather than
 * answered. Two modules produce these values — the archive channel names its tiers
 * (`starred`/`curated`/`archive`) and this compiler names the rest — and a test drives both to check
 * they stay inside this list.
 */
export const RESULT_SOURCES = [
  'starred',
  'curated',
  'archive',
  'community',
  'ranking',
  'trending',
  'top_starred',
  'hellogithub',
  'breakout',
  'skill',
  'skill_repo',
]

export function compileResults({
  rrfMap,
  repos,
  communityMap,
  targetCategory,
  targetSource,
  minScore,
  limit,
  explain = false,
  catalogSnapshotAt = null,
  rankingSnapshotAt = null,
}) {
  const results = []
  const reposByName = new Map(Object.entries(repos).map(([name, record]) => [name.toLowerCase(), record]))
  for (const [repoName, stats] of rrfMap.entries()) {
    const starredItem = reposByName.get(repoName.toLowerCase())
    const isUserStarred = !!starredItem
    const commItem = communityMap.get(repoName.toLowerCase())
    const info = starredItem || commItem || stats.extraItem || {}
    const sourceChannels = [...new Set([
      ...(stats.sourceChannels || []),
      ...(commItem?.source_channels || []),
    ])]

    const source = isUserStarred ? 'starred' : (stats.source !== 'starred' ? stats.source : (commItem ? 'community' : 'ranking'))
    const badge = isUserStarred ? '⭐ Starred' : (stats.badge && stats.badge !== '⭐ Starred' ? stats.badge : (commItem ? '⚡ Community Ingested' : '🌐 Public Ranking'))

    // Where a hit came from is a different axis from how the deployer filed it, so it is a separate
    // filter over the same results: `category` selects the deployer's lists, `source` selects the
    // channel (a trending board, HelloGitHub, the archive, the user's own stars).
    if (targetSource && source !== targetSource && !sourceChannels.includes(targetSource))
      continue

    if (targetCategory) {
      const cats = (info.categories || []).map(c => c.toLowerCase())
      if (!cats.includes(targetCategory))
        continue
    }

    const relevance = relevanceScore(stats)

    if (relevance < minScore)
      continue

    const resultRepo = info.repo || repoName
    const resultSourceKind = isUserStarred ? 'catalog' : source === 'curated' ? 'ingest_journal' : source
    const fieldOrigin = field => info.fieldOrigins?.[field] || null
    const defaultSnapshotAt = isUserStarred ? catalogSnapshotAt : rankingSnapshotAt
    const factualEvidence = []
    const provenance = {}
    if (explain) {
      const metadataFields = ['stars'].filter(field => info[field] !== undefined && info[field] !== null)
      if (metadataFields.length > 0) {
        const metadataEvidence = buildRepositoryEvidence({
          kind: 'repository_metadata',
          repo: resultRepo,
          source: resultSourceKind,
          trust: EVIDENCE_TRUST.EXTERNAL_STRUCTURED,
          snapshotAt: isUserStarred ? catalogSnapshotAt : rankingSnapshotAt,
          fields: metadataFields,
        })
        factualEvidence.push(metadataEvidence)
        for (const field of metadataFields)
          provenance[field] = metadataEvidence.id
      }

      if (info.description) {
        const descriptionEvidence = buildRepositoryEvidence({
          kind: 'repository_description',
          repo: resultRepo,
          source: resultSourceKind,
          trust: EVIDENCE_TRUST.EXTERNAL_UNTRUSTED,
          snapshotAt: isUserStarred ? catalogSnapshotAt : rankingSnapshotAt,
          fields: ['description'],
        })
        factualEvidence.push(descriptionEvidence)
        provenance.description = descriptionEvidence.id
      }

      for (const field of ['reason', 'summary'].filter(field => info[field])) {
        const origin = fieldOrigin(field)
        const trusted = origin?.trust === EVIDENCE_TRUST.USER_TRUSTED
        const fieldEvidence = buildRepositoryEvidence({
          kind: trusted ? 'personal_note' : 'community_text',
          repo: resultRepo,
          source: origin?.source || resultSourceKind,
          trust: trusted ? EVIDENCE_TRUST.USER_TRUSTED : EVIDENCE_TRUST.EXTERNAL_UNTRUSTED,
          snapshotAt: origin?.snapshotAt ?? defaultSnapshotAt,
          identity: `${field}:${origin?.source || resultSourceKind}:${origin?.snapshotAt || defaultSnapshotAt || 'unknown'}`,
          fields: [field],
        })
        factualEvidence.push(fieldEvidence)
        provenance[field] = fieldEvidence.id
      }

      if ((info.categories || []).length > 0) {
        const origin = fieldOrigin('categories')
        const categoryEvidence = buildRepositoryEvidence({
          kind: 'user_taxonomy',
          repo: resultRepo,
          source: origin?.source || (isUserStarred ? 'github_lists' : source === 'curated' ? 'ingest_journal' : 'asset_index'),
          trust: origin?.trust || EVIDENCE_TRUST.USER_TRUSTED,
          snapshotAt: origin?.snapshotAt ?? defaultSnapshotAt,
          fields: ['categories'],
        })
        factualEvidence.push(categoryEvidence)
        provenance.categories = categoryEvidence.id
      }

      const semanticReadme = stats.vectorEvidence?.readme_chunk
      const lexicalReadme = stats.readmeKeywordEvidence
      const readmeMatches = [semanticReadme, lexicalReadme]
        .filter(Boolean)
        .filter((item, index, list) => list.findIndex(candidate => candidate.chunk_id === item.chunk_id) === index)
      for (const readme of readmeMatches) {
        factualEvidence.push(buildReadmeEvidence({
          kind: 'readme_chunk',
          repo: resultRepo,
          chunkId: readme.chunk_id,
          readmeSha256: readme.readme_sha256,
          contentSha256: readme.content_sha256,
          ordinal: readme.ordinal,
          chunkOrdinal: readme.chunk_ordinal,
          heading: readme.heading,
          headingPath: readme.heading_path,
          snippet: readme.snippet,
          similarity: readme.similarity,
          keywordWeight: readme.keyword_weight,
          matchedTokens: readme.matched_tokens || [],
          matchedSubjects: readme.matched_subjects || [],
          matchedIntents: readme.matched_intents || [],
        }))
      }
    }

    const channels = [
      ...(stats.repoVScore > 0 ? ['repo_vector'] : []),
      ...(stats.readmeVScore > 0 ? ['readme_vector'] : []),
      ...((stats.vScore > 0 && !(stats.repoVScore > 0) && !(stats.readmeVScore > 0)) ? ['vector'] : []),
      ...(stats.kwWeight > 0 ? [stats.channel || 'keyword'] : []),
    ]
    const trust = {}
    if (info.reason)
      trust.reason = fieldOrigin('reason')?.trust || EVIDENCE_TRUST.EXTERNAL_UNTRUSTED
    if (info.summary)
      trust.summary = fieldOrigin('summary')?.trust || EVIDENCE_TRUST.EXTERNAL_UNTRUSTED
    if (info.description)
      trust.description = EVIDENCE_TRUST.EXTERNAL_UNTRUSTED

    results.push({
      repo: repoName.startsWith('skill:') ? repoName : resultRepo,
      url: info.url || `https://github.com/${repoName}`,
      source,
      source_badge: badge,
      stars: info.stars,
      categories: info.categories || [],
      reason: info.reason || undefined,
      summary: info.summary || undefined,
      description: info.description || undefined,
      ...(Object.keys(trust).length > 0 ? { trust } : {}),
      ...(sourceChannels.length > 0 ? { source_channels: sourceChannels } : {}),
      ranking: {
        score: relevance,
        ...(explain
          ? {
              channels,
              keyword_weight: stats.kwWeight,
              ...(stats.scoringSource ? { scoring_source: stats.scoringSource } : {}),
              vector_similarity: stats.vScore > 0 ? Number(stats.vScore.toFixed(4)) : null,
              repo_vector_similarity: stats.vectorEvidence?.repo_similarity > 0
                ? Number(stats.vectorEvidence.repo_similarity.toFixed(4))
                : null,
              readme_vector_similarity: stats.vectorEvidence?.readme_chunk?.similarity > 0
                ? Number(stats.vectorEvidence.readme_chunk.similarity.toFixed(4))
                : null,
              literal_matches: {
                tokens: stats.evidence?.matched_tokens || [],
                subjects: stats.evidence?.matched_subjects || [],
                intents: stats.evidence?.matched_intents || [],
              },
            }
          : {}),
      },
      ...(explain
        ? {
            provenance,
            evidence: factualEvidence,
          }
        : {}),
      _rrf: stats.rrf || 0,
    })
  }

  // Calibrated relevance is the ranking authority. It preserves semantic-only and lexical-only
  // strength while rewarding cross-channel corroboration; RRF only resolves equal fused relevance
  // using independent repository, README and lexical rank evidence.
  results.sort((a, b) => b.ranking.score - a.ranking.score || b._rrf - a._rrf)
  for (const r of results)
    delete r._rrf

  return results.slice(0, limit)
}
