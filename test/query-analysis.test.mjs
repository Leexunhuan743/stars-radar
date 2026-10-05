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

test('documented named anchors and full repository names retain their subject role inside the ontology', () => {
  const intents = { agents: ['antigravity', 'deepseek', 'pi', 'mcp'] }
  assert.deepEqual(analyzeQuery('antigravity', intents).specificSubjects, ['antigravity'])
  assert.deepEqual(analyzeQuery('acme/mcp-server', intents).specificSubjects, ['acme/mcp-server'])
})

test('hard subjects distinguish explicit identities from ordinary feature language', () => {
  const named = analyzeQuery('antigravity terminal', INTENTS)
  assert.deepEqual(named.hardSubjects, ['antigravity'])

  const repo = analyzeQuery('acme/mcp-server', INTENTS)
  assert.deepEqual(repo.hardSubjects, ['acme/mcp-server'])

  const feature = analyzeQuery('webdav sync', INTENTS)
  assert.deepEqual(feature.specificSubjects.sort(), ['sync', 'webdav'])
  assert.deepEqual(feature.hardSubjects, [], 'ordinary features may be evidenced semantically from README embeddings')
})
