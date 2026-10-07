import { containsTerm, scoreText } from './scoring.js'
// Level-2 (archive / curated / community) candidate resolution for hybrid search.
//
// Extracted from src/index.js so the key-space contract between the producer
// (scripts/asset_store.js) and the consumer (the Worker) is unit-testable under
// plain Node — src/index.js imports `agents/mcp`, which resolves a `cloudflare:`
// scheme that Node cannot load.
//
// Key-space contract: `assetIndex.repos` is keyed by the LOWERCASED repo full
// name (scripts/asset_store.js lowercases every key in loadPersistedState and in
// every upsert), while `intent_inverted` values are display names that keep the
// original GitHub casing. Every lookup therefore normalises to lowercase; doing
// an exact-match lookup against `intent_inverted` values silently drops every
// repository whose name contains an uppercase letter.

const TIER_PRESENTATION = {
  starred: { source: 'starred', badge: '⭐ Starred' },
  curated: { source: 'curated', badge: '💎 Curated Asset' },
  community: { source: 'archive', badge: '🏛️ Historical Archive' },
}

/**
 * Page repositories from the active generation's README reference manifest.
 *
 * Cursor is an integer offset encoded as a string. The manifest is immutable for a generation,
 * so pagination cannot drift while an isolate remains bound to that generation.
 */
export async function listReadmePage(readmes, { limit = 20, cursor } = {}) {
  const repos = Object.values(readmes?.repos || {})
    .map(ref => ref.repo)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
  const offset = cursor === undefined || cursor === null || cursor === '' ? 0 : Number(cursor)
  if (!Number.isInteger(offset) || offset < 0)
    throw new Error('README cursor must be a non-negative integer offset.')

  const page = repos.slice(offset, offset + limit)
  const next = offset + page.length
  return {
    count: page.length,
    repos: page,
    has_more: next < repos.length,
    next_cursor: next < repos.length ? String(next) : null,
  }
}

export function resolveArchiveCandidates({
  assetIndex,
  intents,
  matchedGroups,
  scoredRepos,
  specificSubjects,
  targetCategory,
  queryTokens = [],
}) {
  // getAssetIndex always returns an object (an unreadable asset-index yields empty
  // maps), so these are read directly rather than guarded.
  const assetRepos = assetIndex.repos
  const inverted = assetIndex.intent_inverted

  const referenced = new Set()
  for (const [key, record] of Object.entries(assetRepos)) {
    const pool = [record.repo || key, record.name, record.description, record.reason, record.summary, ...(record.topics || [])].filter(Boolean).join(' ')
    if (queryTokens.some(token => containsTerm(pool, token)))
      referenced.add(key.toLowerCase())
  }
  for (const group of matchedGroups) {
    for (const word of (intents[group] || [])) {
      const hits = inverted[word.toLowerCase()]
      if (!Array.isArray(hits))
        continue
      for (const repo of hits)
        referenced.add(repo.toLowerCase())
    }
  }

  const resolved = []
  for (const repoName of referenced) {
    const key = repoName.toLowerCase()
    // Repos already carried by the vector or keyword channel are skipped so the
    // archive cannot triple-count them (asset-index is a superset of catalog +
    // rankings; the long tail only reachable here is the point of this channel).
    if (scoredRepos.has(key))
      continue

    const record = assetRepos[key]
    if (!record)
      continue

    if (targetCategory && !(record.categories || []).some(c => c.toLowerCase() === targetCategory))
      continue

    const displayName = record.repo || repoName
    const pool = [
      displayName,
      record.name,
      record.description,
      record.reason,
      record.summary,
      record.language,
      ...(record.topics || []),
      ...(record.categories || []),
    ].filter(Boolean).join(' ').toLowerCase()
    if (specificSubjects.length > 0 && !specificSubjects.some(sub => containsTerm(pool, sub)))
      continue

    // Archive recall should still reflect evidence strength. A flat constant made every
    // long-tail candidate tie regardless of whether it matched one weak synonym or several
    // explicit query terms, which becomes unstable as the archive grows.
    const weight = scoreText(pool, { specificSubjects, queryTokens, matchedGroups, intents })
    if (weight <= 0)
      continue

    const tier = record.tier || 'community'
    const presentation = TIER_PRESENTATION[tier] || TIER_PRESENTATION.community
    resolved.push({
      repo: displayName,
      weight,
      source: presentation.source,
      badge: presentation.badge,
      tier,
      item: {
        repo: displayName,
        url: record.url || `https://github.com/${displayName}`,
        stars: record.stars,
        categories: record.categories || [],
        description: record.description,
        reason: record.reason,
        summary: record.summary,
        tier,
      },
    })
  }

  return resolved
}
