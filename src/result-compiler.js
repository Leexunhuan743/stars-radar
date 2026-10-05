// Final result compilation: source/badge derivation, category and min_score
// filtering, and the relevance-then-RRF ordering.
//
// Extracted from src/index.js — which cannot be imported outside the worker runtime —
// because a mutation study showed the whole suite stayed green while this loop had its
// primary sort key inverted, relevance_score zeroed, and the `_rrf` tie-breaker removed.
// The Worker imports this via src/index.js; test/result-compiler.test.mjs imports it
// directly, so there is one source of truth rather than a drifting replica.
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
      relevance_score: relevance,
      vector_similarity: stats.vScore ? Number(stats.vScore.toFixed(4)) : undefined,
      ...(sourceChannels.length > 0 ? { source_channels: sourceChannels } : {}),
      ...(explain
        ? {
            explanation: {
              channels: [
                ...(stats.vScore > 0 ? ['vector'] : []),
                ...(stats.kwWeight > 0 ? [stats.channel || 'keyword'] : []),
              ],
              keyword_weight: stats.kwWeight,
              vector_similarity: stats.vScore > 0 ? Number(stats.vScore.toFixed(4)) : null,
              matched_tokens: stats.evidence?.matched_tokens || [],
              matched_subjects: stats.evidence?.matched_subjects || [],
              matched_intents: stats.evidence?.matched_intents || [],
            },
          }
        : {}),
      _rrf: stats.rrf || 0, // 内部融合分(含 starred ×1.5), 仅作排序键, 返回前清除
    })
  }

  // 排序: relevance_score(相关性强度) 主键, RRF 融合分(含 starred ×1.5) 作精确 tie-breaker.
  // 避免纯 RRF 主排序按 rank 丢绝对强度, 致弱 starred(w26) 系统性压过高分 community(w43) 的病态倒挂.
  // 同分(非线性映射后大量并列)时 starred ×1.5 决定次序, 达成"私藏优先"而不牺牲相关性.
  results.sort((a, b) => b.relevance_score - a.relevance_score || b._rrf - a._rrf)
  for (const r of results)
    delete r._rrf

  // Diversity is a policy for the default mixed view, not a property of community results.
  // Explicit source/rankings queries must be able to fill the requested limit.
  return applyCommunityDiversityCap ? applyCommunityCap(results, limit) : results.slice(0, limit)
}
