import { parseFrontmatter } from './frontmatter.js'
import { analyzeQuery } from './query-analysis.js'
import { explainTextMatch, matchesSubjectGate, scoreText } from './scoring.js'

export const README_EVIDENCE_MAX_RESULTS = 5
export const README_EVIDENCE_MAX_CHUNK = 1200
export const README_EVIDENCE_SNIPPET = 360

function cleanMarkdown(text) {
  return String(text || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*\x60\x60\x60[^\n]*$/gm, ' ')
    .replace(/^\s*[-*_]{3,}\s*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function chunkText(text, maxLength = README_EVIDENCE_MAX_CHUNK) {
  if (text.length <= maxLength)
    return text ? [text] : []

  const chunks = []
  let cursor = 0
  while (cursor < text.length) {
    let end = Math.min(text.length, cursor + maxLength)
    if (end < text.length) {
      const boundary = Math.max(
        text.lastIndexOf('. ', end),
        text.lastIndexOf('。', end),
        text.lastIndexOf(' ', end),
      )
      if (boundary > cursor + Math.floor(maxLength * 0.6))
        end = boundary + 1
    }
    chunks.push(text.slice(cursor, end).trim())
    cursor = end
  }
  return chunks.filter(Boolean)
}

function upstreamReadmeBody(markdown) {
  const { metadata, body } = parseFrontmatter(String(markdown || ''))
  const repo = metadata.repo
  if (!repo)
    return body

  const generatedPrefix = '# ' + repo
  const generatedMarker = '> **分类 (Categories)**:'
  if (!body.startsWith(generatedPrefix) || !body.slice(0, 1200).includes(generatedMarker))
    return body

  const separator = body.indexOf('\n---\n\n')
  return separator >= 0 ? body.slice(separator + 6) : body
}

export function splitReadmeSections(markdown) {
  const lines = upstreamReadmeBody(markdown).split(/\r?\n/)
  const sections = []
  let heading = 'README'
  let bodyLines = []

  const flush = () => {
    const text = cleanMarkdown(bodyLines.join('\n'))
    for (const chunk of chunkText(text))
      sections.push({ heading, text: chunk })
    bodyLines = []
  }

  for (const line of lines) {
    const match = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (match) {
      flush()
      heading = cleanMarkdown(match[2]) || 'README'
      continue
    }
    bodyLines.push(line)
  }
  flush()
  return sections
}

function snippetAround(text, terms, maxLength = README_EVIDENCE_SNIPPET) {
  if (text.length <= maxLength)
    return text

  const lower = text.toLowerCase()
  const positions = terms
    .map(term => lower.indexOf(String(term).toLowerCase()))
    .filter(index => index >= 0)
  const anchor = positions.length > 0 ? Math.min(...positions) : 0
  const half = Math.floor(maxLength / 2)
  let start = Math.max(0, anchor - half)
  const end = Math.min(text.length, start + maxLength)
  if (end - start < maxLength)
    start = Math.max(0, end - maxLength)

  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return prefix + text.slice(start, end).trim() + suffix
}

export function findReadmeEvidence(markdown, query, intents, { limit = 2 } = {}) {
  if (!markdown || !query || limit <= 0)
    return []

  const { queryTokens, matchedGroups, specificSubjects } = analyzeQuery(query, intents)
  const scoringQuery = { queryTokens, matchedGroups, specificSubjects, intents }
  const hits = []

  for (const section of splitReadmeSections(markdown)) {
    const pool = (section.heading + ' ' + section.text).toLowerCase()
    if (!matchesSubjectGate(pool, specificSubjects))
      continue

    const weight = scoreText(pool, scoringQuery)
    if (weight <= 0)
      continue

    const evidence = explainTextMatch(pool, scoringQuery)
    const terms = [
      ...evidence.matched_subjects,
      ...evidence.matched_tokens,
      ...evidence.matched_intents.flatMap(match => match.terms),
    ]
    hits.push({
      heading: section.heading,
      snippet: snippetAround(section.text, [...new Set(terms)]),
      keyword_weight: weight,
      matched_tokens: evidence.matched_tokens,
      matched_subjects: evidence.matched_subjects,
      matched_intents: evidence.matched_intents,
    })
  }

  return hits
    .sort((a, b) => b.keyword_weight - a.keyword_weight)
    .slice(0, limit)
}
