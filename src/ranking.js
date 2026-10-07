// Explicit repository identities must be evidenced literally.
// Ordinary feature queries are fused across independent lexical, repository-semantic and
// README-semantic rankings. Source provenance never changes a channel's RRF contribution.

import { matchesSubjectGate } from './scoring.js'

export const RRF_K = 60

function presentationForVector(repo, repos, keywordScores, assets) {
  const keyword = keywordScores.get(repo)
  if (repos[repo]) {
    return {
      source: 'starred',
      badge: '⭐ Starred',
      tier: 'starred',
      extraItem: repos[repo],
    }
  }
  if (keyword) {
    return {
      source: keyword.source,
      badge: keyword.badge || '🌐 Public Ranking',
      tier: keyword.tier,
      extraItem: keyword.item,
    }
  }

  const asset = assets[repo]
  if (asset?.tier === 'curated') {
    return {
      source: 'curated',
      badge: '💎 Curated Asset',
      tier: 'curated',
      extraItem: asset,
    }
  }
  if (asset?.tier === 'community') {
    return {
      source: 'archive',
      badge: '🏛️ Historical Archive',
      tier: 'community',
      extraItem: asset,
    }
  }
  if (asset?.tier === 'starred') {
    return {
      source: 'starred',
      badge: '⭐ Starred',
      tier: 'starred',
      extraItem: asset,
    }
  }

  return {
    source: 'ranking',
    badge: '🌐 Public Ranking',
    tier: undefined,
    extraItem: asset,
  }
}

/**
 * @returns Map<repoName, {
 *   rrf, vScore, repoVScore, readmeVScore, kwWeight,
 *   source, badge, tier?, extraItem?
 * }>
 */
export function fuseRankings({
  repoVectorScores = new Map(),
  readmeVectorScores = new Map(),
  vectorEvidence = new Map(),
  keywordScores = new Map(),
  repos = {},
  assets = {},
  hardSubjects = [],
}) {
  const rrfMap = new Map()

  const addSemanticRanking = (scores, field) => {
    const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1])
    sorted.forEach(([repo, score], rank) => {
      const keyword = keywordScores.get(repo)
      const record = repos[repo] || keyword?.item || assets[repo]
      const semantic = vectorEvidence.get(repo)
      const pool = [
        repo,
        record?.name,
        record?.description,
        record?.reason,
        record?.summary,
        ...(record?.topics || []),
        ...(record?.categories || []),
        semantic?.readme_chunk?.heading,
        semantic?.readme_chunk?.text,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      // Hard identities and repository-name anchors may never be inferred from vector proximity alone.
      if (!matchesSubjectGate(pool, hardSubjects))
        return

      const presentation = presentationForVector(repo, repos, keywordScores, assets)
      const cur = rrfMap.get(repo) || {
        rrf: 0,
        vScore: 0,
        repoVScore: 0,
        readmeVScore: 0,
        kwWeight: 0,
        source: presentation.source,
        badge: presentation.badge,
        tier: presentation.tier,
        extraItem: presentation.extraItem,
        vectorEvidence: semantic,
      }
      cur.rrf += 1 / (RRF_K + rank + 1)
      cur[field] = score
      cur.vScore = Math.max(cur.repoVScore || 0, cur.readmeVScore || 0)
      cur.vectorEvidence = semantic || cur.vectorEvidence
      rrfMap.set(repo, cur)
    })
  }

  // Repository metadata and README chunks are independent semantic evidence planes. Collapsing
  // them before ranking lets a repository with many README chunks compete against a community
  // repository's single metadata vector with many more chances to produce one high cosine.
  addSemanticRanking(repoVectorScores, 'repoVScore')
  addSemanticRanking(readmeVectorScores, 'readmeVScore')

  const sortedKeywords = [...keywordScores.entries()].sort((a, b) => b[1].weight - a[1].weight)
  sortedKeywords.forEach(([repo, meta], rank) => {
    const cur = rrfMap.get(repo) || {
      rrf: 0,
      vScore: 0,
      repoVScore: 0,
      readmeVScore: 0,
      kwWeight: meta.weight,
      source: meta.source,
      badge: meta.badge || '🌐 Public Ranking',
      tier: meta.tier,
      extraItem: meta.item,
      sourceChannels: meta.sourceChannels,
      scoringSource: meta.scoringSource,
      readmeKeywordEvidence: meta.readmeEvidence,
    }
    const isStarred = !!repos[repo] || meta.tier === 'starred' || meta.source === 'starred'
    cur.rrf += 1 / (RRF_K + rank + 1)
    cur.kwWeight = meta.weight
    cur.source = meta.source
    cur.badge = meta.badge || (isStarred ? '⭐ Starred' : '🌐 Public Ranking')
    cur.tier = meta.tier || (isStarred ? 'starred' : cur.tier)
    cur.extraItem = meta.item || cur.extraItem
    cur.evidence = meta.evidence
    cur.channel = meta.channel || 'keyword'
    cur.sourceChannels = meta.sourceChannels || cur.sourceChannels
    cur.scoringSource = meta.scoringSource || cur.scoringSource
    if (meta.readmeEvidence)
      cur.readmeKeywordEvidence = meta.readmeEvidence
    rrfMap.set(repo, cur)
  })

  return rrfMap
}
