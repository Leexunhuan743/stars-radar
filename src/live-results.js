// Turning GitHub search results into what the caller sees.
//
// This is where a repository's provenance is decided — whether it is one of yours, part of the
// community layer, or an unvetted discovery — and the badge is the only signal a caller has for how
// much to trust a result. It lived inline in the Worker entry, so nothing verified that a starred
// repository outranks a community one, that the badge and the source field agree, or that the
// user's own category and reason travel with the result.

const DISCOVERY = { badge: '🌐 Global Discovery', source: 'global' }
const STARRED = { badge: '⭐ Starred', source: 'starred' }
const COMMUNITY = { badge: '⚡ Community Ingested', source: 'community' }

/**
 * Looks up the catalogue entry for a search result.
 *
 * The catalogue is keyed by `owner/name`, the same key GitHub returns, so this is a plain lookup.
 *
 * There used to be a fallback here comparing the catalogue's `name` field against the *full* name
 * ("owner/name" versus "name"), which could never match: it was dead code wearing the appearance of
 * renamed-repository support. Making it work would mean matching on the repository name alone, and
 * that badges another owner's identically named repository as one of yours — worse than not
 * recognising a rename, which GitHub's own redirects already handle when the repository is fetched.
 */
function findCatalogEntry(reposCatalog, fullName) {
  return reposCatalog[fullName]
}

/**
 * @param {object[]} items Raw items from the GitHub search API.
 * @param {object} context
 * @param {object} context.reposCatalog The user's catalogue, keyed by `owner/name`.
 * @param {Map<string, object>} context.communityIndex See src/community-index.js.
 * @returns {object[]} the enriched results, in the order GitHub returned them.
 */
export function enrichLiveResults(items, { reposCatalog = {}, communityIndex = new Map() } = {}) {
  return (items || []).map((item, index) => {
    const fullName = item.full_name
    const userStar = findCatalogEntry(reposCatalog, fullName)
    const communityRecord = communityIndex.get(fullName.toLowerCase())
    const isCommunity = !!communityRecord

    // Starred wins over community: the user's own choice is the stronger statement, and a
    // repository can legitimately be both.
    const provenance = userStar ? STARRED : (isCommunity ? COMMUNITY : DISCOVERY)

    return {
      rank: index + 1,
      repo: fullName,
      url: item.html_url,
      stars: item.stargazers_count,
      description: item.description || '',
      language: item.language || '',
      created_at: item.created_at,
      pushed_at: item.pushed_at,
      topics: item.topics || [],
      is_starred: !!userStar,
      source: provenance.source,
      badge: provenance.badge,
      user_categories: userStar?.categories || undefined,
      user_reason: userStar?.reason || undefined,
      community_sources: communityRecord?.source_channels?.length ? communityRecord.source_channels : undefined,
    }
  })
}
