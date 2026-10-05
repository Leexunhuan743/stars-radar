// Decides which starred repositories need their README corpus refreshed.
//
// Extracted from scripts/index.js — which needs GitHub credentials and network to run — because
// this predicate is what makes the sync incremental, and getting it wrong is expensive in both
// directions: too eager re-downloads every README on every run, too lax leaves the corpus stale
// while the catalogue moves ahead. It is also the predicate that was silently wrong in
// production once (the catalogue stores `pushedAt`, the reader asked for `pushed_at`), where the
// cost was a full re-download every run rather than a visible failure.

/**
 * @param {object} params
 * @param {boolean} params.fileExists Whether `stars/<owner>/<repo>.md` is already on disk.
 * @param {object|undefined} params.cachedEntry The catalogue entry from the previous run.
 * @param {string|undefined} params.pushedAt The repository's current `pushed_at` from GitHub.
 * @returns {boolean} true when the README must be fetched again.
 */
export function needsReadmeDownload({ fileExists, cachedEntry, pushedAt }) {
  // A missing file always wins: the corpus is what the Worker reads, and the catalogue alone is
  // not enough to answer get_repo_readme.
  if (!fileExists)
    return true
  // No cached entry means this repository is new to the catalogue.
  if (!cachedEntry)
    return true
  // Repository metadata may advance even when a README refresh failed. Compare the live push
  // against the push that the cached README actually represents, not the catalogue snapshot itself.
  // Missing readmePushedAt is treated as unknown and therefore forces a refresh; no pre-v2 fallback
  // is retained.
  if (!pushedAt || !cachedEntry.readmePushedAt)
    return true
  return cachedEntry.readmePushedAt !== pushedAt
}
