import { repoFromReadmeKey } from './object-keys.js'
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
 * Page the archive bucket until enough README objects are collected.
 *
 * `R2.list` applies `limit` to every object in the bucket, and the bucket also holds the JSON
 * state objects — `asset-index.json`, `catalog.json` and `embeddings-index.json` sort before
 * most READMEs, so a single page can consist entirely of them. Filtering such a page after the
 * fact reports an empty library while claiming more is available, which is what this helper
 * exists to prevent: `limit` means "this many repositories".
 *
 * `maxPages` bounds the work so a bucket that never yields a README cannot spin forever; when
 * the budget runs out with READMEs still unread, `has_more` stays true and `next_cursor` is
 * null, because resuming from an unread position would silently skip objects.
 */
export async function listReadmePage(r2, { limit = 20, cursor } = {}, maxPages = 20) {
  const repos = []
  let nextCursor = cursor
  let morePages = false

  for (let page = 0; page < maxPages; page++) {
    const options = { limit }
    if (nextCursor)
      options.cursor = nextCursor

    const listed = await r2.list(options)
    for (const object of listed.objects || []) {
      const repo = repoFromReadmeKey(object.key)
      if (repo)
        repos.push(repo)
    }

    morePages = Boolean(listed.truncated)
    nextCursor = listed.cursor
    if (!morePages || repos.length >= limit)
      break
  }

  const pageOfRepos = repos.slice(0, limit)
  return {
    count: pageOfRepos.length,
    repos: pageOfRepos,
    has_more: morePages || repos.length > limit,
    next_cursor: morePages && repos.length <= limit ? nextCursor : null,
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
