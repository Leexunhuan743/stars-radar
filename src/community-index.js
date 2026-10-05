// The community layer, keyed by repository.
//
// Two search paths need to answer "is this repository part of the community layer?" — the hybrid
// search (which annotates results it already scored) and the live probe (which badges what it
// found on GitHub). Each built its own view from the same four sources, in the same precedence
// order, with the same lowercasing; a third source added to one and not the other would have made
// the badge depend on which endpoint the caller used.
//
// Precedence is deliberate and is what the tests pin down: a repository that the user ingested is
// described by the ingest record, not by whatever the trending board said about it last week.

/**
 * @param {object} options
 * @param {object} [options.rankings] The community document the pipeline publishes.
 * @param {object[]} [options.harvested] The folded ingest journal.
 * @returns {Map<string, object>} repository (lowercased) to the record describing it.
 */
export function buildCommunityIndex({ rankings, harvested } = {}) {
  const byRepo = new Map()
  const add = (items, source) => {
    for (const item of items || []) {
      if (!item?.repo)
        continue
      const key = item.repo.toLowerCase()
      const previous = byRepo.get(key)
      const sourceChannels = [...new Set([
        ...(previous?.source_channels || []),
        ...(source ? [source] : []),
      ])]
      byRepo.set(key, { ...(previous || {}), ...item, source_channels: sourceChannels })
    }
  }

  // Weakest first: each later source supersedes the previous record's fields for the same
  // repository, while source_channels accumulates every independent observation.
  add((rankings || {}).breakoutWeekly, 'breakout')
  add((rankings || {}).agentSkillRepos, 'skill_repo')
  add((rankings || {}).helloGitHub, 'hellogithub')
  for (const list of Object.values((rankings || {}).trending || {}))
    add(list, 'trending')
  add(harvested, 'curated')

  return byRepo
}
