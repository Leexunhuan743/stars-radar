// How a query scores a repository that is not in the personal catalogue.
//
// Three channels — `+40` for a named subject, `+8` for a token the user typed, `+5` for a synonym
// from a matched intent group — and they were written out once per community layer, six times in
// all. That is not only repetition: a weight change had to be found in six loops, and a layer added
// later could weigh the same match differently from every other layer without anyone noticing,
// because nothing compared them.
//
// Every searchable source uses this same scoring contract so source provenance does not secretly
// change relevance.

export const SUBJECT_WEIGHT = 40
export const TOKEN_WEIGHT = 8
export const INTENT_WEIGHT = 5
export function intentMatchScore(words, matches) {
  return (words || []).some(matches) ? INTENT_WEIGHT : 0
}

export function termMatcher(text) {
  const normalize = value => value.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ')
  const original = text.toLowerCase()
  const pool = normalize(text)
  return (term) => {
    if (/^[\w.-]+\/[\w.-]+$/.test(term)) {
      const escaped = term.toLowerCase().replaceAll('.', '\\.')
      return new RegExp(`(^|[^\\w.-])${escaped}(?![\\w.-])`).test(original)
    }
    const normalized = normalize(term)
    if (/^[a-z0-9]{1,2}$/.test(normalized))
      return new RegExp(`(^|[^a-z0-9])${normalized}([^a-z0-9]|$)`).test(pool)
    return pool.includes(normalized)
  }
}

export function containsTerm(text, term) {
  return termMatcher(text)(term)
}

export function mergeMatchEvidence(...items) {
  const tokens = new Set()
  const subjects = new Set()
  const intents = new Map()

  for (const item of items.filter(Boolean)) {
    for (const token of item.matched_tokens || [])
      tokens.add(token)
    for (const subject of item.matched_subjects || [])
      subjects.add(subject)
    for (const match of item.matched_intents || []) {
      const terms = intents.get(match.domain) || new Set()
      for (const term of match.terms || [])
        terms.add(term)
      intents.set(match.domain, terms)
    }
  }

  return {
    matched_tokens: [...tokens],
    matched_subjects: [...subjects],
    matched_intents: [...intents.entries()].map(([domain, terms]) => ({
      domain,
      terms: [...terms],
    })),
  }
}

export function scoreMatchEvidence(evidence) {
  return (evidence?.matched_subjects?.length || 0) * SUBJECT_WEIGHT
    + (evidence?.matched_tokens?.length || 0) * TOKEN_WEIGHT
    + (evidence?.matched_intents?.length || 0) * INTENT_WEIGHT
}

/**
 * Scores one flattened text pool against a query.
 *
 * @param {string} text Lower-cased text of the candidate repository.
 * @param {{ specificSubjects: string[], queryTokens: string[], matchedGroups: Set<string>, intents: object }} query
 * @returns {number} 0 when nothing matched; the caller treats 0 as "do not offer this candidate".
 */
export function scoreText(text, { specificSubjects, queryTokens, matchedGroups, intents }) {
  let score = 0
  const matches = termMatcher(text)

  for (const subject of specificSubjects) {
    if (matches(subject))
      score += SUBJECT_WEIGHT
  }
  for (const token of queryTokens) {
    if (matches(token))
      score += TOKEN_WEIGHT
  }
  for (const group of matchedGroups)
    score += intentMatchScore(intents[group] || [], matches)

  return score
}

/**
 * A subject named in the query is a hard filter, not a bonus.
 *
 * Without it, a query for one specific tool is answered with same-category neighbours: they score
 * through the intent channel and, in a small catalogue, outrank nothing else at all. The layers
 * below only offer candidates whose text mentions a named subject.
 */
export function matchesSubjectGate(text, specificSubjects) {
  return specificSubjects.length === 0 || specificSubjects.some(subject => containsTerm(text, subject))
}

/** Reports literal matches from the same text pool used for scoring, without inventing semantic evidence. */
export function explainTextMatch(text, { specificSubjects, queryTokens, matchedGroups, intents }) {
  const matches = termMatcher(text)
  return {
    matched_tokens: queryTokens.filter(matches),
    matched_subjects: specificSubjects.filter(matches),
    matched_intents: [...matchedGroups]
      .map(domain => ({ domain, terms: (intents[domain] || []).filter(matches) }))
      .filter(match => match.terms.length > 0),
  }
}
