// Repository identities and explicitly named product anchors must be evidenced literally.
// Ordinary feature subjects may use a conservative semantic fallback because README evidence is
// embedded even when GitHub's short metadata does not mention the feature.

import { matchesSubjectGate } from './scoring.js'

export const RRF_K = 60
export const STARRED_BOOST = 1.5
export const SEMANTIC_SUBJECT_FALLBACK = 0.65

/**
 * @returns Map<repoName, {rrf, vScore, kwWeight, source, badge, tier?, extraItem?}>
 */
export function fuseRankings({
  vectorScores,
  keywordScores,
  repos,
  specificSubjects,
  hardSubjects = specificSubjects,
}) {
  const rrfMap = new Map()

  const sortedVectors = [...vectorScores.entries()].sort((a, b) => b[1] - a[1])
  sortedVectors.forEach(([repo, vScore], rank) => {
    const record = repos[repo] || keywordScores.get(repo)?.item
    const pool = [repo, record?.name, record?.description, record?.reason, record?.summary, ...(record?.topics || []), ...(record?.categories || [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    // Hard identities (owner/repo and named anchors such as antigravity/deepseek/pi) may never be
    // inferred from vector proximity alone. For ordinary feature subjects, a high semantic score
    // may be evidence from the README text that was embedded offline but is not present in metadata.
    if (!matchesSubjectGate(pool, hardSubjects))
      return
    if (!matchesSubjectGate(pool, specificSubjects) && vScore < SEMANTIC_SUBJECT_FALLBACK)
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
      scoringSource: meta.scoringSource,
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
    cur.scoringSource = meta.scoringSource || cur.scoringSource
    rrfMap.set(repo, cur)
  })

  return rrfMap
}
