import { parseFrontmatter } from './frontmatter.js'
import { analyzeQuery } from './query-analysis.js'
import { explainTextMatch, matchesSubjectGate, scoreText } from './scoring.js'

export const README_EVIDENCE_MAX_RESULTS = 5
export const README_EVIDENCE_MAX_CHUNK = 1200
export const README_EVIDENCE_SNIPPET = 360
export const README_VECTOR_MAX_CHUNKS = 8
export const README_VECTOR_MIN_CHARS = 24

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

  const generatedPrefix = `# ${repo}`
  const generatedMarker = '> **分类 (Categories)**:'
  if (!body.startsWith(generatedPrefix) || !body.slice(0, 1200).includes(generatedMarker))
    return body

  const separator = body.indexOf('\n---\n\n')
  return separator >= 0 ? body.slice(separator + 6) : body
}

export function splitReadmeSections(markdown) {
  const lines = upstreamReadmeBody(markdown).split(/\r?\n/)
  const sections = []
  const headingStack = []
  let heading = 'README'
  let headingPath = ['README']
  let bodyLines = []
  let sectionOrdinal = 0

  const flush = () => {
    const text = cleanMarkdown(bodyLines.join('\n'))
    const chunks = chunkText(text)
    chunks.forEach((chunk, chunkOrdinal) => {
      sections.push({
        section_ordinal: sectionOrdinal,
        section_chunk_ordinal: chunkOrdinal,
        heading,
        heading_path: headingPath,
        text: chunk,
      })
    })
    if (chunks.length > 0)
      sectionOrdinal++
    bodyLines = []
  }

  for (const line of lines) {
    const leadingSpaces = line.length - line.trimStart().length
    const candidate = leadingSpaces <= 3 ? line.trimStart() : line
    let headingLevel = 0
    while (headingLevel < 6 && candidate[headingLevel] === '#')
      headingLevel++

    if (leadingSpaces <= 3 && headingLevel > 0 && candidate[headingLevel] === ' ') {
      flush()
      let rawHeading = candidate.slice(headingLevel + 1).trim()
      while (rawHeading.endsWith('#'))
        rawHeading = rawHeading.slice(0, -1).trimEnd()
      heading = cleanMarkdown(rawHeading) || 'README'
      headingStack.length = Math.max(0, headingLevel - 1)
      headingStack[headingLevel - 1] = heading
      headingPath = headingStack.filter(Boolean)
      continue
    }
    bodyLines.push(line)
  }
  flush()
  return sections
}

export function snippetAround(text, terms = [], maxLength = README_EVIDENCE_SNIPPET) {
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

function readmeVectorCandidates(markdown) {
  return splitReadmeSections(markdown)
    .filter(section => section.text.length >= README_VECTOR_MIN_CHARS)
}

export function selectReadmeVectorChunks(markdown, { limit = README_VECTOR_MAX_CHUNKS } = {}) {
  if (!markdown)
    return []

  const sections = readmeVectorCandidates(markdown)
  const budget = Math.max(0, Math.min(Number(limit) || 0, README_VECTOR_MAX_CHUNKS, sections.length))
  if (budget <= 0)
    return []
  if (sections.length <= budget)
    return sections
  if (budget === 1)
    return [sections[0]]

  // README introductions and early feature overviews carry disproportionate capability
  // information. Preserve the first two chunks, then spread the remaining budget uniformly across
  // the rest of the document. This keeps the same fixed memory bound while avoiding a blind spot
  // where section 2 is skipped in long READMEs (observed by the private README-only benchmark).
  const selected = []
  const used = new Set()
  const frontCount = Math.min(2, budget)
  for (let index = 0; index < frontCount; index++) {
    used.add(index)
    selected.push(sections[index])
  }

  const remaining = budget - selected.length
  if (remaining > 0) {
    const first = frontCount
    const last = sections.length - 1
    for (let slot = 0; slot < remaining; slot++) {
      const index = remaining === 1
        ? first
        : Math.round(first + slot * (last - first) / (remaining - 1))
      if (used.has(index))
        continue
      used.add(index)
      selected.push(sections[index])
    }
  }

  if (selected.length < budget) {
    for (let index = 0; index < sections.length && selected.length < budget; index++) {
      if (used.has(index))
        continue
      used.add(index)
      selected.push(sections[index])
    }
  }

  return selected.sort((a, b) => a.section_ordinal - b.section_ordinal || a.section_chunk_ordinal - b.section_chunk_ordinal)
}

export function findReadmeEvidence(markdown, query, intents, { limit = 2 } = {}) {
  if (!markdown || !query || limit <= 0)
    return []

  const { queryTokens, matchedGroups, specificSubjects } = analyzeQuery(query, intents)
  const scoringQuery = { queryTokens, matchedGroups, specificSubjects, intents }
  const hits = []

  for (const section of splitReadmeSections(markdown)) {
    const pool = `${section.heading} ${section.text}`.toLowerCase()
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
      section_ordinal: section.section_ordinal,
      section_chunk_ordinal: section.section_chunk_ordinal,
      heading: section.heading,
      heading_path: section.heading_path,
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
