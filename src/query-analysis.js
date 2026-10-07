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

// Words that carry no discriminating power. They should neither become hard
// subjects nor earn lexical score merely because an English description contains prose glue.
const STOPWORDS = new Set([
  'and',
  'app',
  'apps',
  'as',
  'based',
  'be',
  'for',
  'from',
  'github',
  'in',
  'into',
  'is',
  'mcp',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'tool',
  'tools',
  'use',
  'using',
  'with',
])

const REQUIREMENT_ANCHOR_STOPWORDS = new Set([
  ...STOPWORDS,
  'ai',
  'api',
  'client',
  'compatible',
  'complete',
  'editor',
  'framework',
  'full',
  'fully',
  'include',
  'includes',
  'including',
  'linux',
  'llm',
  'local',
  'manager',
  'model',
  'models',
  'must',
  'native',
  'only',
  'plugin',
  'plugins',
  'provide',
  'provides',
  'reader',
  'required',
  'requires',
  'run',
  'running',
  'runtime',
  'server',
  'service',
  'support',
  'supported',
  'supports',
  'use',
  'using',
  'web',
  'windows',
])

function requirementAnchors(text) {
  const tokens = String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9+_.-]+/g) || []
  return [...new Set(tokens
    .map(token => token.replace(/^[._-]+|[._-]+$/g, ''))
    .filter(token => token.length >= 3 && !REQUIREMENT_ANCHOR_STOPWORDS.has(token)))]
}

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
  const lowerQuery = query.toLowerCase()
  const whitespaceTokens = lowerQuery.split(/\s+/).filter(t => t.length > 1 && !STOPWORDS.has(t))
  const repositoryIdentities = whitespaceTokens.filter(t => /^[\w.-]+\/[\w.-]+$/.test(t))
  let fragmentSource = lowerQuery
  for (const identity of repositoryIdentities)
    fragmentSource = fragmentSource.replaceAll(identity, ' ')
  const technicalFragments = fragmentSource.match(/[a-z0-9][a-z0-9+_.-]+/g) || []
  const queryTokens = [...new Set([
    ...whitespaceTokens,
    ...technicalFragments.filter(t => t.length > 1 && !STOPWORDS.has(t)),
  ])]
  const matchedGroups = new Set()
  const subjectCandidates = []

  for (const t of queryTokens) {
    if (/^[\w.-]+\/[\w.-]+$/.test(t))
      subjectCandidates.push(t)
    else if (tokenToGroup.has(t))
      matchedGroups.add(tokenToGroup.get(t))
    else if (!STOPWORDS.has(t))
      subjectCandidates.push(t)
  }

  // Scan the whole query against every intent keyword rather than the whitespace
  // tokens, which is what makes multi-character CJK phrases match at all.
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
    if (/^[\w.-]+\/[\w.-]+$/.test(subject))
      return true
    if (matchedKeywords.has(subject))
      return false
    for (const keyword of matchedKeywords) {
      if (containsTerm(keyword, subject) || containsTerm(subject, keyword))
        return false
    }
    return true
  })

  const hardSubjects = specificSubjects.filter(subject => /^[\w.-]+\/[\w.-]+$/.test(subject))

  return { queryTokens, matchedGroups, specificSubjects, hardSubjects }
}

/**
 * Splits an explicit hard-requirement query into the requested base capability and mandatory clause.
 * ASCII technical anchors stay literal on purpose: a candidate may not satisfy "CUDA", "eBPF" or
 * "Fever" merely by being semantically adjacent to those technologies.
 */
export function hardRequirementClauses(query, intents) {
  const match = /(?:但\s*)?(?:同时\s*)?(?:必须|要求|must\b|required\b)/i.exec(query)
  if (!match)
    return []

  const before = query.slice(0, match.index)
    .replace(/[，,；;:\s]+$/g, '')
    .replace(/(?:同时|并且|and)\s*$/i, '')
    .trim()
  let after = query.slice(match.index + match[0].length).trim()

  const onlyIndex = after.lastIndexOf('只能')
  if (onlyIndex >= 0)
    after = after.slice(onlyIndex + '只能'.length).trim()

  return [before, after]
    .filter(Boolean)
    .map(text => ({
      ...analyzeQuery(text, intents),
      anchors: requirementAnchors(text),
      raw: text,
    }))
}

export function hasHardRequirements(query, intents) {
  return hardRequirementClauses(query, intents).length > 0
}
