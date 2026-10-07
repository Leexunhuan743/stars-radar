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
 * @param {string|undefined} params.sourcePushedAt The upstream push timestamp represented by the cached README.
 * @param {string|undefined} params.pushedAt The repository's current `pushed_at` from GitHub.
 * @returns {boolean} true when the README must be fetched again.
 */
export function needsReadmeDownload({ fileExists, sourcePushedAt, pushedAt }) {
  if (!fileExists)
    return true
  if (!pushedAt || !sourcePushedAt)
    return true
  return sourcePushedAt !== pushedAt
}
