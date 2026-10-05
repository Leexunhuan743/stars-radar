// A concrete subject must be evidenced by metadata; high semantic similarity alone cannot prove it.

import { matchesSubjectGate } from './scoring.js'

export const RRF_K = 60
export const STARRED_BOOST = 1.5

/**
 * @returns Map<repoName, {rrf, vScore, kwWeight, source, badge, tier?, extraItem?}>
 */
export function fuseRankings({
  vectorScores,
  keywordScores,
  repos,
  specificSubjects,
}) {
  const rrfMap = new Map()

  const sortedVectors = [...vectorScores.entries()].sort((a, b) => b[1] - a[1])
  sortedVectors.forEach(([repo, vScore], rank) => {
    const record = repos[repo] || keywordScores.get(repo)?.item
    const pool = [repo, record?.name, record?.description, record?.reason, record?.summary, ...(record?.topics || []), ...(record?.categories || [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    if (!matchesSubjectGate(pool, specificSubjects))
      return

    const cur = rrfMap.get(repo) || {
      rrf: 0,
      vScore,
      kwWeight: 0,
      source: 'starred',
      badge: '⭐ Starred',
    }
    cur.rrf += 1 / (RRF_K + rank + 1)
    cur.vScore = vScore
    rrfMap.set(repo, cur)
  })

  const sortedKeywords = [...keywordScores.entries()].sort((a, b) => b[1].weight - a[1].weight)
  sortedKeywords.forEach(([repo, meta], rank) => {
    const cur = rrfMap.get(repo) || {
      rrf: 0,
      vScore: 0,
      kwWeight: meta.weight,
      source: meta.source,
      badge: meta.badge || '⭐ Starred',
      tier: meta.tier,
      extraItem: meta.item,
      sourceChannels: meta.sourceChannels,
    }
    // Private stars keep their visibility without displacing relevance: the boost
    // only breaks ties, because relevance_score is the primary sort key.
    const isStarred = !!repos[repo] || meta.tier === 'starred' || meta.source === 'starred'
    cur.rrf += (1 / (RRF_K + rank + 1)) * (isStarred ? STARRED_BOOST : 1)
    cur.kwWeight = meta.weight
    cur.source = meta.source
    cur.badge = meta.badge || (isStarred ? '⭐ Starred' : '🌐 Public Ranking')
    cur.tier = meta.tier || (isStarred ? 'starred' : undefined)
    cur.extraItem = meta.item
    cur.evidence = meta.evidence
    cur.channel = meta.channel || 'keyword'
    cur.sourceChannels = meta.sourceChannels || cur.sourceChannels
    rrfMap.set(repo, cur)
  })

  return rrfMap
}
