import assert from 'node:assert/strict'
// Tests for the README corpus writer.
//
// `renderEnrichedMarkdown` writes the frontmatter that the Worker reads back through
// `src/frontmatter.js`. The writer and the reader live in different modules and are never run
// together in a test, so a change to one can silently break README retrieval for every
// repository — that cross-module contract is the whole reason this file exists.
//
// Cleaning and escaping are exercised through that entry point rather than directly: they are
// only ever called from there, so the reachable behaviour is what matters. (It used to also
// cover the AWESOME_STARS.md / stars.opml generators, which were deleted along with the exports.)
import { test } from 'node:test'
import { renderEnrichedMarkdown } from '../scripts/star_export.js'
import {
  parseFrontmatter,
  README_BLOCK_SCALAR_FIELDS,
  README_FRONTMATTER_FIELDS,
  README_JSON_FIELDS,
} from '../src/frontmatter.js'

const REPO = {
  repo: 'Acme/PlayMaster',
  name: 'PlayMaster',
  url: 'https://github.com/Acme/PlayMaster',
  stars: 5000,
  language: 'Kotlin',
  description: 'a music player',
  reason: '一句话推荐理由',
  summary: '功能概述',
  categories: ['media-players', 'desktop-apps'],
  topics: ['music', 'kotlin'],
}

/** The README body as the Worker would see it, after the generated header. */
function bodyOf(readme, repo = REPO) {
  return parseFrontmatter(renderEnrichedMarkdown(repo, readme)).body
}

/** `renderEnrichedMarkdown` only truncates documents longer than this. */
const CLEAN_LIMIT = 25000

test('what renderEnrichedMarkdown writes, the Worker can read back', () => {
  // The cross-module contract that get_repo_readme depends on.
  const { metadata, body } = parseFrontmatter(renderEnrichedMarkdown(REPO, '# PlayMaster\n\nBody text.'))

  assert.equal(metadata.repo, 'Acme/PlayMaster')
  assert.equal(metadata.stars, '5000')
  assert.equal(metadata.url, 'https://github.com/Acme/PlayMaster')
  assert.equal(metadata.reason, '一句话推荐理由')
  assert.equal(metadata.summary, '功能概述')
  assert.equal(metadata.description, 'a music player')
  assert.deepEqual(JSON.parse(metadata.categories), ['media-players', 'desktop-apps'])
  assert.deepEqual(JSON.parse(metadata.topics), ['music', 'kotlin'])
  assert.match(body, /Body text\./, 'the README body survives the round trip')
  assert.match(body, /PlayMaster/, 'the generated header is part of the body the Worker returns')
})

test('a repository without categories falls back to everything-else in both directions', () => {
  const { metadata } = parseFrontmatter(renderEnrichedMarkdown({ ...REPO, categories: undefined }, ''))
  assert.deepEqual(JSON.parse(metadata.categories), ['everything-else'])
})

test('an empty README still produces readable frontmatter', () => {
  const { metadata } = parseFrontmatter(renderEnrichedMarkdown(REPO, null))
  assert.equal(metadata.repo, 'Acme/PlayMaster')
  assert.equal(metadata.reason, '一句话推荐理由')
})

/** Every key `renderEnrichedMarkdown` is allowed to emit, in the order it writes them. */
const FRONTMATTER_KEYS = README_FRONTMATTER_FIELDS

test('the writer and the reader share one field list', () => {
  // The contract used to be a list in the writer and a promise in the reader's comment, which is how
  // a renamed field silently changes what `get_repo_readme` returns. The list now lives in
  // src/frontmatter.js and the writer emits from it, so a field cannot be added on one side only.
  const { metadata } = parseFrontmatter(renderEnrichedMarkdown(REPO, 'body'))
  assert.deepEqual(
    Object.keys(metadata),
    FRONTMATTER_KEYS,
    'the reader receives exactly the declared fields, in the declared order',
  )
  assert.ok(
    README_BLOCK_SCALAR_FIELDS.every(field => FRONTMATTER_KEYS.includes(field)),
    'every block-scalar field must be a declared field',
  )
  assert.ok(
    README_JSON_FIELDS.every(field => FRONTMATTER_KEYS.includes(field)),
    'every JSON field must be a declared field',
  )
})

/** How the reader reassembles a block scalar: continuation lines joined by one space. */
function joinLines(value) {
  return value.replace(/\r?\n/g, ' ').trim()
}

test('a multi-line value cannot be mistaken for new frontmatter keys', () => {
  // The reader starts a new key at any line that is not indented, so an unindented
  // continuation line truncates the value and forges a field the writer never set.
  const reason = 'line one\nsummary: injected'
  const { metadata } = parseFrontmatter(renderEnrichedMarkdown({ ...REPO, reason }, ''))

  assert.equal(metadata.reason, 'line one summary: injected')
  assert.equal(metadata.summary, '功能概述', 'the real summary is untouched')
  assert.deepEqual(Object.keys(metadata), FRONTMATTER_KEYS, 'no key appears that the writer did not emit')
})

test('a continuation line cannot overwrite a real field', () => {
  const reason = 'first line\nrepo: evil/ghost\nurl: https://evil.example/steal'
  const { metadata } = parseFrontmatter(renderEnrichedMarkdown({ ...REPO, reason }, ''))

  assert.equal(metadata.repo, 'Acme/PlayMaster')
  assert.equal(metadata.url, 'https://github.com/Acme/PlayMaster')
  assert.equal(metadata.reason, 'first line repo: evil/ghost url: https://evil.example/steal')
  assert.deepEqual(Object.keys(metadata), FRONTMATTER_KEYS)
})

test('empty, colon-bearing and CRLF values all survive the round trip', () => {
  for (const value of ['', 'fix: the colon case', 'first\r\nsecond', '一\n二\n三']) {
    const { metadata } = parseFrontmatter(renderEnrichedMarkdown({ ...REPO, reason: value, summary: value, description: value }, ''))

    assert.equal(metadata.reason, joinLines(value))
    assert.equal(metadata.summary, joinLines(value))
    assert.equal(metadata.description, joinLines(value))
    assert.deepEqual(Object.keys(metadata), FRONTMATTER_KEYS)
  }
})

test('a README long enough to be truncated still leaves the frontmatter intact', () => {
  const reason = 'line one\nsummary: injected'
  const readme = `# Title\n\n## Changelog\n${'x'.repeat(CLEAN_LIMIT)}`
  const { metadata, body } = parseFrontmatter(renderEnrichedMarkdown({ ...REPO, reason }, readme))

  assert.equal(metadata.reason, 'line one summary: injected')
  assert.equal(metadata.summary, '功能概述')
  assert.deepEqual(Object.keys(metadata), FRONTMATTER_KEYS)
  assert.match(body, /Changelog truncated for indexing/)
})

test('an embedded base64 image is replaced before the README is indexed', () => {
  // A data URI of this size is megabytes of noise in the corpus and matches nothing useful.
  // The 100-character payload is the boundary: anything shorter is text a README may
  // legitimately contain, so the pattern must not reach down to it.
  const payload = `data:image/png;base64,${'A'.repeat(200)}`
  const body = bodyOf(`# Title\n\n![logo](${payload})\n\ntail`)
  assert.doesNotMatch(body, /base64,/, 'the payload must not survive')
  assert.match(body, /\[embedded image\]/)
  assert.match(body, /tail/)

  const atBoundary = `data:image/png;base64,${'A'.repeat(100)}`
  assert.match(bodyOf(`![l](${atBoundary})`), /\[embedded image\]/, 'exactly 100 characters is over the threshold')

  const belowBoundary = `data:image/png;base64,${'A'.repeat(99)}`
  assert.doesNotMatch(bodyOf(`![l](${belowBoundary})`), /\[embedded image\]/, '99 characters must be left alone')
})

test('a README larger than the limit has its changelog truncated', () => {
  const readme = `# Title\n\n## Changelog\n${'x'.repeat(CLEAN_LIMIT)}`
  assert.ok(readme.length > CLEAN_LIMIT, 'the fixture must be over the limit')

  const body = bodyOf(readme)
  assert.match(body, /Changelog truncated for indexing/)
  assert.ok(body.length < readme.length, 'truncation must remove more than it adds')
})

test('the limit is enforced above it and not below it', () => {
  // The threshold is only reachable as a boundary: one character either side of it decides
  // whether a repository loses its changelog, and the padding has to clear the regex's own
  // 1000-character minimum so that the length is genuinely the deciding factor.
  const padding = 'x'.repeat(1500)

  // 25001 raw characters: over the limit, so the section is cut.
  const prefix = '# Title\n\n## Changelog\n'
  const over = `${prefix}${padding}${'y'.repeat(CLEAN_LIMIT + 1 - prefix.length - padding.length)}`
  assert.equal(over.length, CLEAN_LIMIT + 1, 'the fixture must be exactly one over')
  assert.match(bodyOf(over), /Changelog truncated for indexing/)

  // 25000 raw characters: at the limit, so the document is passed through untouched.
  const at = over.slice(0, CLEAN_LIMIT)
  assert.equal(at.length, CLEAN_LIMIT)
  const atBody = bodyOf(at)
  assert.doesNotMatch(atBody, /Changelog truncated for indexing/, 'the limit itself is inclusive')
  assert.match(atBody, /## Changelog/)
})

test('a long README with only a stub changelog keeps that changelog', () => {
  // The truncation regex demands at least 1000 characters after the heading. A long
  // document whose changelog section is short must survive intact — otherwise a release
  // note of a few lines would delete the tail of an otherwise legitimate README.
  const readme = `# Title\n\n${'z'.repeat(CLEAN_LIMIT + 1000)}\n\n## Changelog\nv1.0 fixes a bug.`
  const body = bodyOf(readme)

  assert.match(body, /## Changelog\nv1\.0 fixes a bug\./, 'a short changelog is content, not noise')
  assert.doesNotMatch(body, /truncated/)
})

test('a short README is passed through unchanged and a long one is not always truncated', () => {
  const short = '# Title\n\n## Changelog\nshort'
  assert.match(bodyOf(short), /## Changelog\nshort/, 'a short document keeps its changelog verbatim')
  assert.doesNotMatch(bodyOf(short), /truncated/)
})

test('a missing README degrades to the generated header alone', () => {
  for (const readme of [undefined, null, '']) {
    const body = bodyOf(readme)
    assert.match(body, /# Acme\/PlayMaster/, 'the header is still written')
    assert.match(body, /推荐理由 \(Reason\)/)
    // "alone" is the claim: nothing may be appended in place of the absent README.
    assert.match(body, /---\s*$/, 'the body ends at the header, with no trailing content')
  }
})
