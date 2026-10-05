// Final result compilation: source/badge derivation, category and min_score
// filtering, and the relevance-then-RRF ordering.
//
// Extracted from src/index.js — which cannot be imported outside the worker runtime —
// because a mutation study showed the whole suite stayed green while this loop had its
// primary sort key inverted, relevance_score zeroed, and the `_rrf` tie-breaker removed.
// The Worker imports this via src/index.js; test/result-compiler.test.mjs imports it
// directly, so there is one source of truth rather than a drifting replica.
import { buildReadmeEvidence, EVIDENCE_TRUST } from './evidence.js'
import { applyCommunityCap, relevanceScore } from './relevance.js'

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
  applyCommunityDiversityCap = false,
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

    const factualEvidence = []
    if (explain && stats.vectorEvidence?.readme_chunk) {
      factualEvidence.push(buildReadmeEvidence({
        kind: 'readme_chunk',
        repo: info.repo || repoName,
        chunkId: stats.vectorEvidence.readme_chunk.chunk_id,
        readmeSha256: stats.vectorEvidence.readme_chunk.readme_sha256,
        contentSha256: stats.vectorEvidence.readme_chunk.content_sha256,
        ordinal: stats.vectorEvidence.readme_chunk.ordinal,
        heading: stats.vectorEvidence.readme_chunk.heading,
        snippet: stats.vectorEvidence.readme_chunk.snippet,
        similarity: stats.vectorEvidence.readme_chunk.similarity,
      }))
    }

    const channels = [
      ...(stats.vScore > 0 ? ['vector'] : []),
      ...(stats.kwWeight > 0 ? [stats.channel || 'keyword'] : []),
    ]
    const trust = {}
    if (info.reason)
      trust.reason = EVIDENCE_TRUST.USER_TRUSTED
    if (info.summary)
      trust.summary = EVIDENCE_TRUST.USER_TRUSTED
    if (info.description)
      trust.description = EVIDENCE_TRUST.EXTERNAL_UNTRUSTED

    results.push({
      repo: repoName.startsWith('skill:') ? repoName : (info.repo || repoName),
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
              facet_coverage: stats.facetCoverage || {
                matched: 0,
                total: 0,
                ratio: null,
                matched_facets: [],
              },
              literal_matches: {
                tokens: stats.evidence?.matched_tokens || [],
                subjects: stats.evidence?.matched_subjects || [],
                intents: stats.evidence?.matched_intents || [],
              },
            }
          : {}),
      },
      ...(explain ? { evidence: factualEvidence } : {}),
      _rrf: stats.rrf || 0,
    })
  }

  // Ranking score is the relevance strength; RRF is only an internal tie-breaker.
  results.sort((a, b) => b.ranking.score - a.ranking.score || b._rrf - a._rrf)
  for (const r of results)
    delete r._rrf

  // Diversity is a policy for the default mixed view, not a property of community results.
  // Explicit source/rankings queries must be able to fill the requested limit.
  return applyCommunityDiversityCap ? applyCommunityCap(results, limit) : results.slice(0, limit)
}
