// The shape of the community document the scheduled build publishes.
//
// Declared once because two sides depend on it: `scripts/fetch_rankings.js` fills it in, and the
// Worker serves this exact shape as its placeholder when the object does not exist yet, so every
// consumer sees the same keys either way.
//
// `harvested` deliberately is not part of it: user ingests live in the append-only journal
// (src/ingest-journal.js), because a document that both the build and the Worker replace cannot
// hold something that must never be lost.

export function emptyRankings() {
  return {
    trending: {},
    topStarred: {},
    helloGitHub: [],
    agentSkills: [],
    agentSkillRepos: [],
    breakoutWeekly: [],
  }
}

// The community layers are collected from six independent upstreams, and each one can fail on its
// own while the run still succeeds: the fetcher logs a warning and keeps the previous list. That
// made a stale list indistinguishable from a fresh one — `updatedAt` moves on every run either way,
// so nothing downstream could tell that a layer had not been refreshed for days.
//
// Every layer therefore carries its own provenance, and a retained layer keeps the timestamp of the
// run that actually fetched it.
export const COMMUNITY_SOURCES = ['trending', 'topStarred', 'helloGitHub', 'agentSkills', 'agentSkillRepos', 'breakoutWeekly']

/** @returns {object} an empty provenance record, one entry per community layer. */
export function emptySourceReport() {
  return Object.fromEntries(COMMUNITY_SOURCES.map(name => [name, { status: 'unknown', at: null }]))
}

/**
 * Records the outcome of one layer's fetch.
 *
 * @param {object} sources The provenance record being built.
 * @param {string} name One of {@link COMMUNITY_SOURCES}.
 * @param {{ status: 'fresh'|'retained', count?: number, error?: string, at: string, previous?: object }} outcome
 */
export function recordSource(sources, name, outcome) {
  sources[name] = {
    status: outcome.status,
    at: outcome.at,
    count: outcome.count ?? 0,
    ...(outcome.error ? { error: outcome.error } : {}),
    // When a layer is retained, the timestamp that matters is the one from the run that last
    // fetched it — that is what makes staleness visible.
    ...(outcome.status === 'retained' && outcome.previous?.at ? { at: outcome.previous.at } : {}),
  }
  return sources
}

/**
 * The layers whose data did not come from this run.
 *
 * @returns {{ name: string, status: string, at: string|null, error?: string }[]} one entry per layer
 *   that is retained or was never reported, each carrying its last real fetch time.
 */
export function staleSources(document) {
  const sources = document?.sources || {}
  return COMMUNITY_SOURCES
    .filter(name => sources[name] && sources[name].status !== 'fresh')
    .map(name => ({ name, ...sources[name] }))
}

/** Age in hours of the oldest retained layer, or 0 when everything is fresh. */
export function stalenessHours(document, now = Date.now()) {
  const stale = staleSources(document).filter(entry => entry.at)
  if (stale.length === 0)
    return 0
  const oldest = Math.min(...stale.map(entry => Date.parse(entry.at)))
  return Number.isFinite(oldest) ? Math.round(((now - oldest) / 3600000) * 10) / 10 : 0
}
