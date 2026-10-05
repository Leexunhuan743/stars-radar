import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  findReadmeEvidence,
  README_EVIDENCE_SNIPPET,
  README_VECTOR_MAX_CHUNKS,
  readmeVectorBudget,
  selectReadmeVectorChunks,
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
  assert.deepEqual(findReadmeEvidence(markdown, 'remote replication', {}), [])
})

test('README snippets stay bounded even when the matching section is very long', () => {
  const markdown = `# Features\n${'prefix '.repeat(100)}WebDAV synchronization ${'suffix '.repeat(100)}`
  const [hit] = findReadmeEvidence(markdown, 'webdav', {})
  assert.ok(hit.snippet.length <= README_EVIDENCE_SNIPPET + 2, 'ellipsis may add at most two characters')
  assert.match(hit.snippet, /WebDAV/)
})

test('missing README or disabled limits produce no evidence', () => {
  assert.deepEqual(findReadmeEvidence('', 'webdav', INTENTS), [])
  assert.deepEqual(findReadmeEvidence('# Features\nWebDAV', '', INTENTS), [])
  assert.deepEqual(findReadmeEvidence('# Features\nWebDAV', 'webdav', INTENTS, { limit: 0 }), [])
})

test('generated Stars Radar archive metadata never masquerades as upstream README evidence', () => {
  const archived = [
    '---',
    'repo: acme/tool',
    'reason: selected because it supports WebDAV',
    'description: WebDAV storage helper',
    '---',
    '# acme/tool',
    '> **分类 (Categories)**: `storage`',
    '> **推荐理由 (Reason)**: selected because it supports WebDAV',
    '> **功能概述 (Summary)**: storage helper',
    '> **项目简介 (Description)**: WebDAV storage helper',
    '',
    '---',
    '',
    '# Actual README',
    'A generic local utility with no protocol claims.',
  ].join('\n')

  assert.deepEqual(findReadmeEvidence(archived, 'webdav', {}), [])
  assert.deepEqual(splitReadmeSections(archived).map(section => section.heading), ['Actual README'])
})

test('README vector chunks use an adaptive bounded budget and retain source identity', () => {
  const markdown = Array.from({ length: 12 }, (_, index) => (
    `## Section ${index}\n${'feature detail '.repeat(12)} marker-${index}`
  )).join('\n\n')

  const sections = splitReadmeSections(markdown)
  assert.equal(readmeVectorBudget(sections), 10)
  const chunks = selectReadmeVectorChunks(markdown)
  assert.equal(chunks.length, 10)
  assert.ok(chunks.length <= README_VECTOR_MAX_CHUNKS)
  assert.equal(chunks[0].section_ordinal, 0)
  assert.equal(chunks.at(-1).section_ordinal, 11)
  assert.ok(chunks.every(chunk => Array.isArray(chunk.heading_path) && chunk.heading_path.length > 0))
  assert.ok(chunks.some(chunk => /marker-4|marker-5/.test(chunk.text)), 'middle README content should be represented')
})

test('short high-value README sections survive the generic minimum-length filter', () => {
  const markdown = [
    '# Tool',
    'A generic project description that is intentionally long enough to qualify as ordinary context.',
    '## Requirements',
    'Node 22 and Linux.',
    '## Compatibility',
    'Works with S3.',
  ].join('\n\n')

  const chunks = selectReadmeVectorChunks(markdown)
  assert.ok(chunks.some(chunk => chunk.heading === 'Requirements'))
  assert.ok(chunks.some(chunk => chunk.heading === 'Compatibility'))
})
