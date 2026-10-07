import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { INPUT_LIMITS, TOOL_DEFINITIONS } from '../src/tool-schemas.js'

function parse(tool, input) {
  return z.object(TOOL_DEFINITIONS[tool].inputSchema).safeParse(input)
}

test('repository references and curator metadata are bounded on MCP writes', () => {
  assert.equal(parse('star_and_ingest_repo', {
    repo: 'a/'.concat('x'.repeat(INPUT_LIMITS.repo)),
    reason: 'ok',
    categories: [],
  }).success, false)

  assert.equal(parse('star_and_ingest_repo', {
    repo: 'a/b',
    reason: 'x'.repeat(INPUT_LIMITS.reason + 1),
    categories: [],
  }).success, false)

  assert.equal(parse('star_and_ingest_repo', {
    repo: 'a/b',
    categories: Array.from({ length: INPUT_LIMITS.categoryCount + 1 }, (_, index) => `c${index}`),
  }).success, false)

  assert.equal(parse('star_and_ingest_repo', {
    repo: 'a/b',
    reason: 'x'.repeat(INPUT_LIMITS.reason),
    categories: ['c'.repeat(INPUT_LIMITS.category)],
  }).success, true)
})

test('probe-specific optional strings have explicit upper bounds', () => {
  assert.equal(parse('search_github_live', {
    query: 'tool',
    language: 'x'.repeat(INPUT_LIMITS.language + 1),
  }).success, false)
  assert.equal(parse('search_github_code', {
    query: 'registerTool',
    path: 'x'.repeat(INPUT_LIMITS.path + 1),
  }).success, false)
  assert.equal(parse('search_web_tech', {
    query: 'workers',
    domain: 'x'.repeat(INPUT_LIMITS.domain + 1),
  }).success, false)
})

test('opaque cursors are bounded without imposing repository-name rules on them', () => {
  assert.equal(parse('list_starred_repos', {
    cursor: 'x'.repeat(INPUT_LIMITS.cursor),
  }).success, true)
  assert.equal(parse('list_starred_repos', {
    cursor: 'x'.repeat(INPUT_LIMITS.cursor + 1),
  }).success, false)
})
