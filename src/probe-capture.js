// What a live probe records.
//
// The probe layer is the only place where a search result becomes an asset, so the rule that
// decides which discoveries are worth keeping is load-bearing: it decides what the next asset-store
// run can promote into the community tier. It lived inline in the Worker entry — untestable — and
// the thresholds were only discoverable by reading the code, while the tool schema documented them
// in prose to every client.
//
// Two properties matter and are easy to break silently:
//   * a capture is metadata only. Nothing here may reach the vector index on its own, which is why
//     the shape is enumerated rather than spread from the search result;
//   * the same repository discovered by the same query twice is one observation, not two — the
//     promotion rule requires *different* queries, so the query id must be recorded faithfully.

/** Thresholds from `src/tool-schemas.js`'s `persist` contract, named so both can cite them. */
export const PROBE_MIN_STARS = 50
export const PROBE_MAX_CAPTURES = 3

/**
 * @param {object[]} discoveries Enriched live-search results.
 * @param {{ query: string, now?: () => Date }} context `query` identifies the observation; the
 *   promotion rule counts distinct values of it.
 * @returns {object[]} the captures to append, newest-first by stars.
 */
export function buildProbeCaptures(discoveries, { query, now = () => new Date() } = {}) {
  const capturedAt = now().toISOString()
  return (discoveries || [])
    .filter(item => (item?.stars || 0) >= PROBE_MIN_STARS && item?.description)
    .sort((a, b) => (b.stars || 0) - (a.stars || 0))
    .slice(0, PROBE_MAX_CAPTURES)
    .map(item => ({
      repo: item.repo,
      url: item.url,
      stars: item.stars,
      description: item.description,
      language: item.language,
      topics: item.topics,
      created_at: item.created_at,
      pushed_at: item.pushed_at,
      query,
      captured_at: capturedAt,
    }))
}
