import { parseFrontmatter } from './frontmatter.js'
import { analyzeQuery } from './query-analysis.js'
import { explainTextMatch, matchesSubjectGate, scoreText } from './scoring.js'

export const README_EVIDENCE_MAX_RESULTS = 5
export const README_EVIDENCE_MAX_CHUNK = 1200
export const README_EVIDENCE_SNIPPET = 360
export const README_VECTOR_BASE_CHUNKS = 6
export const README_VECTOR_MAX_CHUNKS = 12
export const README_VECTOR_MIN_CHARS = 80
export const README_VECTOR_IMPORTANT_MIN_CHARS = 24

const IMPORTANT_HEADING = /\b(?:requirements?|compatibility|platforms?|providers?|integrations?|features?|install(?:ation)?|usage|api|license|support)\b|支持|平台|兼容|要求|依赖|集成|功能|安装|用法|许可证/i

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
    .filter((section) => {
      if (section.text.length >= README_VECTOR_MIN_CHARS)
        return true
      return section.text.length >= README_VECTOR_IMPORTANT_MIN_CHARS
        && IMPORTANT_HEADING.test(section.heading_path.join(' '))
    })
}

export function readmeVectorBudget(sections) {
  const count = sections.length
  if (count <= README_VECTOR_BASE_CHUNKS)
    return count

  const totalChars = sections.reduce((sum, section) => sum + section.text.length, 0)
  if (count <= 8 && totalChars <= 9000)
    return Math.min(count, 8)
  if (count <= 12 && totalChars <= 18000)
    return Math.min(count, 10)
  return Math.min(count, README_VECTOR_MAX_CHUNKS)
}

function sectionInformationScore(section) {
  const heading = section.heading_path.join(' ')
  const headingBonus = IMPORTANT_HEADING.test(heading) ? 1500 : 0
  const lengthScore = Math.min(section.text.length, README_EVIDENCE_MAX_CHUNK)
  const tokens = section.text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const uniqueRatio = tokens.length > 0 ? new Set(tokens).size / tokens.length : 0
  return headingBonus + lengthScore + Math.round(uniqueRatio * 300)
}

export function selectReadmeVectorChunks(markdown, { limit } = {}) {
  if (!markdown)
    return []

  const sections = readmeVectorCandidates(markdown)
  const budget = limit === undefined
    ? readmeVectorBudget(sections)
    : Math.max(0, Math.min(Number(limit) || 0, README_VECTOR_MAX_CHUNKS, sections.length))

  if (budget <= 0)
    return []
  if (sections.length <= budget)
    return sections

  // Partition the README into deterministic source-order regions and choose the most informative
  // section from each region. This preserves whole-document coverage while preferring capability,
  // compatibility and requirement sections over boilerplate of similar position.
  const selected = []
  const used = new Set()
  for (let slot = 0; slot < budget; slot++) {
    const start = Math.floor(slot * sections.length / budget)
    const end = Math.max(start + 1, Math.floor((slot + 1) * sections.length / budget))
    const candidates = sections.slice(start, end)
      .map((section, offset) => ({ section, index: start + offset }))
      .sort((a, b) => sectionInformationScore(b.section) - sectionInformationScore(a.section) || a.index - b.index)
    const winner = candidates[0]
    if (!winner || used.has(winner.index))
      continue
    used.add(winner.index)
    selected.push(winner)
  }

  if (selected.length < budget) {
    const remaining = sections
      .map((section, index) => ({ section, index }))
      .filter(entry => !used.has(entry.index))
      .sort((a, b) => sectionInformationScore(b.section) - sectionInformationScore(a.section) || a.index - b.index)
    for (const entry of remaining) {
      selected.push(entry)
      if (selected.length >= budget)
        break
    }
  }

  return selected
    .sort((a, b) => a.index - b.index)
    .map(entry => entry.section)
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
