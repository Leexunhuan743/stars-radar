import assert from 'node:assert/strict'
// Regression tests for query interpretation.
//
// These rules encode two bugs that were fixed without a test:
//   * a CJK query has no whitespace to split on, so every repository was vetoed by
//     the subject filter and a good question returned nothing;
//   * intent keywords are category anchors, and treating them as subjects vetoed
//     every repository that did not literally contain the word.
//
// The fixture is synthetic on purpose: the behaviour must not depend on the current
// contents of src/intents.json. Keywords are deliberately mixed-case so that each
// lowercasing in the implementation is actually constrained by an assertion — the
// real intents.json happens to be all-lowercase, which would let those calls be
// deleted unnoticed.
import { test } from 'node:test'
import { analyzeQuery } from '../src/query-analysis.js'

const INTENTS = {
  terminal_cli_tools: ['terminal', 'CLI', 'Shell'],
  multimedia_graphics_3d: ['player', '播放器', 'graphics'],
}

test('an intent keyword activates its group instead of becoming a subject', () => {
  const { matchedGroups, specificSubjects } = analyzeQuery('terminal player', INTENTS)
  assert.deepEqual([...matchedGroups].sort(), ['multimedia_graphics_3d', 'terminal_cli_tools'])
  assert.deepEqual(specificSubjects, [], 'category anchors must never act as subjects')
})

test('keyword matching is case-insensitive in both directions', () => {
  // Lowercased query token against a mixed-case keyword.
  assert.ok(analyzeQuery('cli', INTENTS).matchedGroups.has('terminal_cli_tools'))
  // A token only the whole-query scan can match: "mycli" is not the keyword "CLI",
  // so this fails unless the scan lowercases the keyword too.
  assert.ok(
    analyzeQuery('mycli', INTENTS).matchedGroups.has('terminal_cli_tools'),
    'the substring scan must lowercase the keyword before comparing',
  )
  // The subject filter must lowercase as well, or "mycli" survives as a subject and
  // vetoes every repository that does not contain it.
  assert.deepEqual(
    analyzeQuery('mycli', INTENTS).specificSubjects,
    [],
    'a token containing a matched keyword must not survive as a subject, whatever the keyword casing',
  )
  assert.ok(analyzeQuery('SHELL', INTENTS).matchedGroups.has('terminal_cli_tools'), 'uppercase queries must match')
})

test('a whitespace-free CJK query still activates its intent group', () => {
  // The whole reason the substring scan exists: there is nothing to split here.
  const { matchedGroups, specificSubjects } = analyzeQuery('推荐一个播放器', INTENTS)
  assert.ok(matchedGroups.has('multimedia_graphics_3d'), 'CJK phrase must match the intent keyword it contains')
  assert.deepEqual(
    specificSubjects,
    [],
    'a CJK query must not leave subjects behind, or the subject veto empties the result set',
  )
})

test('a concrete named subject survives alongside an activated group', () => {
  const { matchedGroups, specificSubjects } = analyzeQuery('antigravity 反代 terminal', INTENTS)
  assert.deepEqual([...matchedGroups], ['terminal_cli_tools'])
  assert.deepEqual(specificSubjects.sort(), ['antigravity', '反代'].sort())
})

test('stopwords and single-character tokens are ignored', () => {
  const { specificSubjects } = analyzeQuery('github tool mcp apps a antigravity', INTENTS)
  assert.deepEqual(specificSubjects, ['antigravity'])
})

test('a token containing a matched keyword is dropped as a partial overlap', () => {
  // "myplayer" contains "player", which is an activated keyword: it is a category
  // anchor wearing a longer name, not a repository name.
  const { specificSubjects } = analyzeQuery('myplayer', INTENTS)
  assert.deepEqual(specificSubjects, [])
})

test('query tokens are lowercased and length-filtered', () => {
  const { queryTokens } = analyzeQuery('Terminal A 反代', INTENTS)
  assert.deepEqual(queryTokens, ['terminal', '反代'], 'single characters are dropped, the rest is lowercased')
})

test('mixed-language punctuation still exposes technical feature tokens', () => {
  const { queryTokens } = analyzeQuery(
    '播放器要 Anime4K，抓取前 click、scroll、write，导出 figures/images，并处理 UTF-8 BOM',
    INTENTS,
  )
  for (const token of ['anime4k', 'click', 'scroll', 'write', 'figures', 'images', 'utf-8', 'bom'])
    assert.ok(queryTokens.includes(token), `missing technical token ${token}`)
})

test('ontology terms stay intents while full repository names stay subjects', () => {
  const intents = { agents: ['antigravity', 'deepseek', 'pi', 'mcp'] }
  assert.deepEqual(analyzeQuery('antigravity', intents).specificSubjects, [])
  assert.ok(analyzeQuery('antigravity', intents).matchedGroups.has('agents'))
  assert.deepEqual(analyzeQuery('acme/mcp-server', intents).specificSubjects, ['acme/mcp-server'])
})

test('the parser hard-gates explicit repository identities only', () => {
  const named = analyzeQuery('antigravity terminal', INTENTS)
  assert.deepEqual(named.hardSubjects, [])

  const repo = analyzeQuery('acme/mcp-server', INTENTS)
  assert.deepEqual(repo.hardSubjects, ['acme/mcp-server'])

  const feature = analyzeQuery('webdav sync', INTENTS)
  assert.deepEqual(feature.specificSubjects.sort(), ['sync', 'webdav'])
  assert.deepEqual(feature.hardSubjects, [], 'multi-feature queries may be evidenced semantically from README embeddings')
})
