import assert from 'node:assert/strict'
// Regression tests for the frontmatter parser that get_repo_readme depends on.
//
// The parser reads exactly the YAML subset scripts/star_export.js writes: flat `key: value`
// pairs plus `key: |-` block scalars with indented continuation lines. The fixture below
// mirrors that shape, including the cases that actually broke README retrieval.
import { test } from 'node:test'
import { parseFrontmatter } from '../src/frontmatter.js'

const DOC = [
  '---',
  'project: Mnemo',
  'repo: acme-org/Mnemo',
  'stars: 42',
  'categories: ["reading-notes","desktop-apps"]',
  'reason: |-',
  '  一句话推荐理由',
  '  第二行理由',
  'summary: |-',
  '  功能概述',
  'url: https://github.com/acme-org/Mnemo',
  '---',
  '',
  '# Mnemo',
  '',
  'README body line one.',
].join('\n')

test('flat pairs and block scalars are both recovered', () => {
  const { metadata } = parseFrontmatter(DOC)
  assert.equal(metadata.repo, 'acme-org/Mnemo')
  assert.equal(metadata.stars, '42')
  assert.equal(metadata.url, 'https://github.com/acme-org/Mnemo')
  assert.equal(metadata.reason, '一句话推荐理由 第二行理由', 'indented lines join the block scalar')
  assert.equal(metadata.summary, '功能概述')
})

test('the JSON-encoded category list survives parsing so get_repo_readme can JSON.parse it', () => {
  const { metadata } = parseFrontmatter(DOC)
  assert.deepEqual(JSON.parse(metadata.categories), ['reading-notes', 'desktop-apps'])
})

test('the body keeps its markdown and drops the frontmatter block', () => {
  const { body } = parseFrontmatter(DOC)
  assert.ok(body.startsWith('\n# Mnemo'), 'the leading newline after the closing fence is preserved')
  assert.match(body, /README body line one\./)
  assert.doesNotMatch(body, /repo: acme-org\/Mnemo/)
})

test('a document with no frontmatter is returned unchanged', () => {
  const plain = '# Just a README\n\nNo frontmatter here.'
  const { metadata, body } = parseFrontmatter(plain)
  assert.deepEqual(metadata, {})
  assert.equal(body, plain)
})

test('CRLF input (a Windows checkout) parses identically', () => {
  const { metadata, body } = parseFrontmatter(DOC.replace(/\n/g, '\r\n'))
  assert.equal(metadata.repo, 'acme-org/Mnemo')
  assert.equal(metadata.reason, '一句话推荐理由 第二行理由')
  assert.match(body, /README body line one\./)
})

test('an empty value is kept as an empty string rather than dropping the key', () => {
  const { metadata } = parseFrontmatter('---\nrepo: a/b\nreason:\nsummary: x\n---\nbody')
  assert.equal(metadata.reason, '')
  assert.equal(metadata.summary, 'x')
})

test('a continuation line containing a colon is NOT mistaken for a new key', () => {
  // The indentation guard is what distinguishes them. Without it the block scalar is
  // truncated at the colon and the curator's reason is silently cut in half.
  const { metadata } = parseFrontmatter([
    '---',
    'reason: |-',
    '  see also: https://example.com',
    '  second line',
    'summary: after',
    '---',
    'body',
  ].join('\n'))
  assert.equal(metadata.reason, 'see also: https://example.com second line')
  assert.equal(metadata.summary, 'after', 'the following key must still be parsed')
})

test('tab-indented continuation lines are accepted as well as space-indented ones', () => {
  const { metadata } = parseFrontmatter('---\nreason: |-\n\tfirst\n\tsecond\nsummary: x\n---\nbody')
  assert.equal(metadata.reason, 'first second')
})

test('surrounding whitespace in a value is trimmed', () => {
  const { metadata } = parseFrontmatter('---\nrepo:    a/b   \n---\nbody')
  assert.equal(metadata.repo, 'a/b')
})

test('frontmatter is only recognised at the very start of the document', () => {
  const { metadata } = parseFrontmatter('Not frontmatter\n---\nrepo: a/b\n---\nbody')
  assert.deepEqual(metadata, {}, 'a fence further down is part of the text, not frontmatter')
})

test('a horizontal rule in the body does not end the frontmatter early', () => {
  // The frontmatter block is delimited lazily, so the first closing fence wins. If it were
  // greedy, everything up to the last "---" would be parsed as metadata and the body would
  // lose the markdown that follows the rule.
  const { metadata, body } = parseFrontmatter('---\nrepo: a/b\n---\n\n# Title\n\n---\n\nmore text')
  assert.equal(metadata.repo, 'a/b')
  assert.match(body, /# Title/, 'content before the rule survives')
  assert.match(body, /more text/, 'content after the rule survives too')
})
