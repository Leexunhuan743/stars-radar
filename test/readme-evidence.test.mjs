import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  README_EVIDENCE_SNIPPET,
  findReadmeEvidence,
  splitReadmeSections,
} from '../src/readme-evidence.js'

const INTENTS = {
  storage: ['webdav', 's3', 'storage'],
}

test('README evidence ignores frontmatter and keeps markdown section headings', () => {
  const markdown = [
    '---',
    'repo: acme/tool',
    'description: frontmatter webdav should not be evidence',
    '---',
    '# Overview',
    'A local-first application.',
    '',
    '## Features',
    'Supports WebDAV synchronization and S3-compatible storage.',
  ].join('\n')

  const sections = splitReadmeSections(markdown)
  assert.deepEqual(sections.map(section => section.heading), ['Overview', 'Features'])
  assert.doesNotMatch(sections.map(section => section.text).join(' '), /frontmatter webdav/)
})

test('the strongest literal README section is returned with verifiable matching evidence', () => {
  const markdown = [
    '# Overview',
    'WebDAV support is available.',
    '',
    '## Storage',
    'Supports WebDAV synchronization together with S3-compatible storage and storage migration.',
  ].join('\n')

  const [hit] = findReadmeEvidence(markdown, 'webdav s3', INTENTS)
  assert.equal(hit.heading, 'Storage')
  assert.match(hit.snippet, /WebDAV/)
  assert.match(hit.snippet, /S3-compatible/)
  assert.ok(hit.matched_tokens.includes('webdav'))
  assert.ok(hit.matched_tokens.includes('s3'))
  assert.ok(hit.keyword_weight > 0)
})

test('semantic similarity alone never fabricates a README snippet', () => {
  const markdown = '# Features\nSupports WebDAV synchronization and S3-compatible storage.'
  assert.deepEqual(findReadmeEvidence(markdown, 'cloud sync', {}), [])
})

test('README snippets stay bounded even when the matching section is very long', () => {
  const markdown = '# Features\n' + 'prefix '.repeat(100) + 'WebDAV synchronization ' + 'suffix '.repeat(100)
  const [hit] = findReadmeEvidence(markdown, 'webdav', {})
  assert.ok(hit.snippet.length <= README_EVIDENCE_SNIPPET + 2, 'ellipsis may add at most two characters')
  assert.match(hit.snippet, /WebDAV/)
})

test('missing README or disabled limits produce no evidence', () => {
  assert.deepEqual(findReadmeEvidence('', 'webdav', INTENTS), [])
  assert.deepEqual(findReadmeEvidence('# Features\nWebDAV', '', INTENTS), [])
  assert.deepEqual(findReadmeEvidence('# Features\nWebDAV', 'webdav', INTENTS, { limit: 0 }), [])
})
