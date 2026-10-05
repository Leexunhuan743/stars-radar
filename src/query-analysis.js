// Query interpretation for hybrid search: which intent groups a query activates,
// and which tokens are concrete subjects.
//
// Extracted from src/index.js (which cannot be imported outside the worker runtime)
// so the two rules below are covered by regression tests. Both encode previously
// fixed bugs:
//
//   * CJK queries have no whitespace to split on, so "推荐一个播放器" produced zero
//     tokens and every repository was hard-filtered away by the subject veto,
//     yielding an empty result set for a perfectly good question.
//   * Intent keywords are generic category anchors, not repository names. Treating
//     them as concrete subjects vetoes every repository that does not literally
//     contain the word, so "terminal tools" matched almost nothing.

import { containsTerm } from './scoring.js'

// These documented project anchors must keep their entity meaning even inside the intent lexicon.
const NAMED_SUBJECTS = new Set(['antigravity', 'deepseek', 'pi'])

// Words that carry no discriminating power and must never act as subjects.
const STOPWORDS = new Set(['tool', 'tools', 'app', 'apps', 'github', 'mcp'])

function buildTokenToGroupMap(intents) {
  const map = new Map()
  for (const [group, words] of Object.entries(intents)) {
    for (const w of words)
      map.set(w.toLowerCase(), group)
  }
  return map
}

export function analyzeQuery(query, intents) {
  const tokenToGroup = buildTokenToGroupMap(intents)
  const queryTokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 1)
  const matchedGroups = new Set()
  const subjectCandidates = []

  for (const t of queryTokens) {
    if (NAMED_SUBJECTS.has(t) || /^[\w.-]+\/[\w.-]+$/.test(t))
      subjectCandidates.push(t)
    else if (tokenToGroup.has(t))
      matchedGroups.add(tokenToGroup.get(t))
    else if (!STOPWORDS.has(t))
      subjectCandidates.push(t)
  }

  // Scan the whole query against every intent keyword rather than the whitespace
  // tokens, which is what makes multi-character CJK phrases match at all.
  const lowerQuery = query.toLowerCase()
  for (const [group, words] of Object.entries(intents)) {
    if (words.some(w => containsTerm(lowerQuery, w)))
      matchedGroups.add(group)
  }

  // A token that is contained in (or contains) a matched group's keyword is a
  // category anchor, not a subject — this is also what drops partial CJK overlaps
  // such as "播放器" inside a longer token.
  const matchedKeywords = new Set()
  for (const group of matchedGroups) {
    for (const w of (intents[group] || []))
      matchedKeywords.add(w.toLowerCase())
  }

  const specificSubjects = subjectCandidates.filter((subject) => {
    if (NAMED_SUBJECTS.has(subject) || /^[\w.-]+\/[\w.-]+$/.test(subject))
      return true
    if (matchedKeywords.has(subject))
      return false
    for (const keyword of matchedKeywords) {
      if (containsTerm(keyword, subject) || containsTerm(subject, keyword))
        return false
    }
    return true
  })

  const hardSubjects = specificSubjects.filter(subject =>
    NAMED_SUBJECTS.has(subject) || /^[\w.-]+\/[\w.-]+$/.test(subject),
  )

  const hardSet = new Set(hardSubjects)
  const facets = [
    ...specificSubjects.map(subject => ({
      id: `subject:${subject}`,
      kind: hardSet.has(subject) ? 'identity' : 'subject',
      value: subject,
      terms: [subject],
    })),
    ...[...matchedGroups].sort().map(group => ({
      id: `intent:${group}`,
      kind: 'intent',
      value: group,
      terms: [...new Set((intents[group] || []).map(word => word.toLowerCase()))],
    })),
  ]

  return { queryTokens, matchedGroups, specificSubjects, hardSubjects, facets }
}
