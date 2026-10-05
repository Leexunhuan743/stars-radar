// Building GitHub search queries.
//
// The Worker guarded against duplicating a qualifier the caller already wrote (the Search API
// rejects conflicting duplicates with 422), while `scripts/harvest_and_ingest.js` concatenated the
// same qualifiers unconditionally — so the same "created" window written by a user broke the
// pipeline entry point and not the tool. Two implementations of one rule, only one of them
// defended, is exactly the kind of asymmetry that lives unnoticed in two files.
//
// Kept dependency-free so both sides import it.

/**
 * True when the caller's own query already contains this qualifier.
 *
 * The prefix class matters: GitHub accepts `-stars:>100` (negation) and `(stars:>100`, and
 * injecting a second `stars:` beside either is the conflict that gets rejected. A qualifier name
 * must also start a word — the version this was extracted from allowed any letters in front, so
 * `mystars:100` counted as a star threshold and suppressed the real one.
 */
export function hasQualifier(query, name) {
  return new RegExp(`(^|\\s|\\(|-)${name}:`).test(query || '')
}

/**
 * Assembles a repository search query, injecting only the qualifiers the caller did not write.
 *
 * @param {object} options
 * @param {string} [options.query] The caller's own query text.
 * @param {string} [options.since] Date window start (`7d`, `YYYY-MM-DD`, or a full range in
 *   `until`).
 * @param {string} [options.until] Date window end.
 * @param {number} [options.minStars] Minimum star threshold; 0 injects nothing.
 * @param {string} [options.language] Language qualifier.
 * @param {(since: string, until?: string) => { sinceStr: string, untilStr: string }} options.parseDateRange
 *   The shared date-window parser; passed in so this module does not decide how dates are read.
 * @returns {string} the query to send.
 */
export function buildRepositoryQuery({ query = '', since, until, minStars = 0, language, parseDateRange }) {
  const userQuery = String(query || '').trim()
  const parts = []
  if (userQuery)
    parts.push(userQuery)

  if ((since || until) && !hasQualifier(userQuery, 'created')) {
    const { sinceStr, untilStr } = parseDateRange(since || '30d', until)
    parts.push(`created:${sinceStr}..${untilStr}`)
  }

  if (minStars > 0 && !hasQualifier(userQuery, 'stars'))
    parts.push(`stars:>=${minStars}`)
  if (language && !hasQualifier(userQuery, 'language'))
    parts.push(`language:${language}`)

  // Excluding forks and archives is a default, not a policy: a caller who asked for them keeps them.
  if (!hasQualifier(userQuery, 'fork'))
    parts.push('fork:false')
  if (!hasQualifier(userQuery, 'archived'))
    parts.push('archived:false')

  return parts.join(' ')
}
