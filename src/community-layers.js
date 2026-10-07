// The community layers a catalogue-free search draws on, as data.
//
// Each entry answers three questions and nothing else: where its candidates come from, what text a
// candidate is scored on, and what the hit looks like once it is offered. They used to be five
// copies of one loop inside `performHybridSearch` — which is why §5.14 found the scoring channels
// written out six times, and why every copy ended up fabricating a `categories` value.
//
// That fabrication is the second reason this is a table. `categories` on a result means "a category
// the deployer assigned" — it comes from their own GitHub lists, it is filtered by `?category=`, and
// it is theirs. A source's provenance is a different thing: `trending`, `hellogithub`, `breakout`,
// `skill`, `skill_repo`. Writing `categories: ['trending']` into a hit put a source label into the
// deployer's namespace, where it could collide with one of their real lists (a list they happen to
// call `trending` or `open-source`) and claimed a categorisation they never made. Provenance
// travels in `source` and the badge; the source's OWN classification (HelloGitHub's section, for
// instance) still counts as scoring text — it describes the repository — but is never published as
// a category.
//
// The order still decides the primary presentation source, but duplicate observations are retained
// in `sourceChannels`. Multiple boards observing the same repository are evidence, not duplicate
// results; ranking is deliberately NOT boosted here until a real retrieval benchmark justifies it.

import { explainTextMatch, matchesSubjectGate, scoreText } from './scoring.js'

/** Trending boards and Top Starred both publish `{ repo, description, language, stars, url }`. */
export const COMMUNITY_LAYERS = [
  {
    source: 'trending',
    badge: ({ board }) => `🔥 Trending (${board})`,
    entries: rankings => Object.entries(rankings.trending || {})
      .flatMap(([board, list]) => list.map(item => ({ item, board }))),
    key: ({ item }) => item.repo,
    text: ({ item }) => `${item.repo} ${item.description || ''} ${item.language || ''}`,
    project: ({ item }) => ({
      repo: item.repo,
      url: item.url,
      stars: item.stars,
      description: item.description,
    }),
  },
  {
    source: 'top_starred',
    badge: ({ board }) => `🏆 Top Starred (${board})`,
    entries: rankings => Object.entries(rankings.topStarred || {})
      .flatMap(([board, list]) => list.map(item => ({ item, board }))),
    key: ({ item }) => item.repo,
    text: ({ item }) => `${item.repo} ${item.description || ''} ${item.language || ''} ${(item.topics || []).join(' ')}`,
    project: ({ item }) => ({
      repo: item.repo,
      url: item.url,
      stars: item.stars,
      description: item.description,
    }),
  },
  {
    source: 'hellogithub',
    badge: ({ item }) => `📖 HelloGitHub (${item.issue})`,
    entries: rankings => (rankings.helloGitHub || []).map(item => ({ item })),
    key: ({ item }) => item.repo,
    // The section it was published under is part of what the repository is about, so it belongs in
    // the scoring text even though it is never published as a category.
    text: ({ item }) => `${item.repo} ${item.name || ''} ${item.description_zh || ''} ${item.category || ''}`,
    project: ({ item }) => ({
      repo: item.repo,
      url: item.url,
      stars: undefined,
      description: item.description_zh,
    }),
  },
  {
    source: 'breakout',
    badge: () => '🚀 Breakout New',
    entries: rankings => (rankings.breakoutWeekly || []).map(item => ({ item })),
    key: ({ item }) => item.repo,
    text: ({ item }) => `${item.repo} ${item.description || ''} ${item.language || ''}`,
    project: ({ item }) => ({
      repo: item.repo,
      url: item.url,
      stars: item.stars,
      description: item.description,
    }),
  },
  {
    source: 'skill',
    // A skill is not a repository: it is a namespaced entry from a leaderboard, which is why its
    // key is prefixed and its "stars" are installs.
    badge: () => '⚡ Agent Skill',
    entries: rankings => (rankings.agentSkills || []).map(item => ({ item })),
    key: ({ item }) => `skill:${item.skill}`,
    text: ({ item }) => `${item.skill} ${item.vendor || ''} ${item.description || ''} ${item.description_zh || ''}`,
    project: ({ item }) => ({
      repo: item.skill,
      url: item.url,
      stars: item.installs,
      description: item.description_zh || item.description,
    }),
  },
  {
    source: 'skill_repo',
    badge: () => '⚡ Agent Skill Repo',
    entries: rankings => (rankings.agentSkillRepos || []).map(item => ({ item })),
    key: ({ item }) => item.repo,
    text: ({ item }) => `${item.repo} ${item.description || ''} ${item.language || ''} ${(item.topics || []).join(' ')}`,
    project: ({ item }) => ({
      repo: item.repo,
      url: item.url,
      stars: item.stars,
      description: item.description,
    }),
  },
]

/**
 * Offers every candidate the community layers have for a query, into `keywordScores`.
 *
 * @param {{ rankings: object, query: object, keywordScores: Map<string, object> }} params `query` is
 *   the shape {@link scoreText} takes.
 */
const COMMUNITY_SOURCE_NAMES = new Set(COMMUNITY_LAYERS.map(layer => layer.source))

export function collectCommunityHits({ rankings, query, keywordScores }) {
  for (const layer of COMMUNITY_LAYERS) {
    for (const entry of layer.entries(rankings)) {
      const key = layer.key(entry).toLowerCase()
      const existing = keywordScores.get(key)
      // Personal / curated evidence is authoritative and keeps its own scoring record. Community
      // layers may still be represented later through the shared community index.
      if (existing && !COMMUNITY_SOURCE_NAMES.has(existing.source))
        continue

      const text = layer.text(entry).toLowerCase()
      if (!matchesSubjectGate(text, query.specificSubjects))
        continue

      const score = scoreText(text, query)
      if (score > 0) {
        if (existing) {
          if (score > existing.weight) {
            existing.weight = score
            existing.scoringSource = layer.source
            existing.evidence = query.explain ? explainTextMatch(text, query) : undefined
          }
          existing.sourceChannels = [...new Set([...(existing.sourceChannels || [existing.source]), layer.source])]
          continue
        }
        keywordScores.set(key, {
          weight: score,
          source: layer.source,
          sourceChannels: [layer.source],
          scoringSource: layer.source,
          badge: layer.badge(entry),
          item: layer.project(entry),
          evidence: query.explain ? explainTextMatch(text, query) : undefined,
        })
      }
    }
  }
}
