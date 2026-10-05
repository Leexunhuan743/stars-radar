import assert from 'node:assert/strict'
// The shared half of candidate scoring.
//
// Every community layer plus the archive pass scores a text pool the same way, so the weights are
// defined once and tested once. The behaviour worth pinning is not the arithmetic but the two ways
// this used to go wrong: a subject that only earns a bonus instead of gating, and an intent
// synonym being weighed like a token the user actually typed.
import { test } from 'node:test'
import { INTENT_REPEAT_BONUS, INTENT_WEIGHT, matchesSubjectGate, scoreText, SUBJECT_WEIGHT, TOKEN_WEIGHT } from '../src/scoring.js'

const INTENTS = { browser: ['browser', 'chrome', 'firefox'], terminal: ['shell', 'tui'] }

function query(overrides = {}) {
  return {
    specificSubjects: [],
    queryTokens: [],
    matchedGroups: new Set(),
    intents: INTENTS,
    ...overrides,
  }
}

test('each channel contributes its own weight', () => {
  assert.equal(scoreText('acme/tool a browser extension', query({ specificSubjects: ['browser'] })), SUBJECT_WEIGHT)
  assert.equal(scoreText('acme/tool a browser extension', query({ queryTokens: ['browser'] })), TOKEN_WEIGHT)
  assert.equal(scoreText('acme/tool a browser extension', query({ matchedGroups: new Set(['browser']) })), INTENT_WEIGHT)
})

test('an unmatched candidate scores zero, which the caller reads as "do not offer it"', () => {
  assert.equal(scoreText('acme/tool a text editor', query({ specificSubjects: ['browser'], queryTokens: ['browser'], matchedGroups: new Set(['browser']) })), 0)
})

test('the channels add up rather than replacing each other', () => {
  // A subject the user named and also typed scores on both channels: the token channel is what
  // keeps a query that names nothing but a word still working.
  assert.equal(scoreText('browser', query({ specificSubjects: ['browser'], queryTokens: ['browser'] })), SUBJECT_WEIGHT + TOKEN_WEIGHT)
})

test('a group synonym weighs less than a token the user typed', () => {
  // The distinction is the point of having two channels: "chrome" is a guess the expansion made,
  // so it must not outrank the word the user actually wrote.
  const typed = scoreText('chrome', query({ queryTokens: ['chrome'] }))
  const expanded = scoreText('chrome', query({ matchedGroups: new Set(['browser']) }))
  assert.ok(expanded < typed, `an expanded synonym (${expanded}) must weigh less than a typed token (${typed})`)
})

test('intent synonym repetition saturates instead of linearly multiplying evidence', () => {
  assert.equal(
    scoreText('chrome firefox', query({ matchedGroups: new Set(['browser']) })),
    INTENT_WEIGHT + INTENT_REPEAT_BONUS,
  )
  assert.equal(
    scoreText('browser chrome firefox', query({ matchedGroups: new Set(['browser']) })),
    INTENT_WEIGHT + (2 * INTENT_REPEAT_BONUS),
    'three synonyms hit the repeat cap instead of contributing three full intent weights',
  )
})

test('an unknown group contributes nothing instead of throwing', () => {
  // Group names come from the query analysis, which reads its own word lists; a name that is not in
  // the intent table is a mismatch between the two, not a reason to fail a search.
  assert.equal(scoreText('anything', query({ matchedGroups: new Set(['nope']) })), 0)
})

test('a named subject gates the candidate rather than merely scoring it', () => {
  assert.equal(matchesSubjectGate('acme/tool a browser extension', ['browser']), true)
  assert.equal(matchesSubjectGate('acme/tool a text editor', ['browser']), false)
  assert.equal(matchesSubjectGate('acme/tool a text editor', []), true, 'with no named subject every candidate is eligible')
  assert.equal(matchesSubjectGate('acme/tool a text editor', ['browser', 'editor']), true, 'one named subject is enough')
})

test('compound terms share one lexical meaning and short subjects do not match inside unrelated words', () => {
  const intents = { media: ['music-player'] }
  assert.equal(scoreText('MUSIC player', { ...query(), matchedGroups: new Set(['media']), intents }), 5)
  assert.equal(matchesSubjectGate('an API client', ['pi']), false)
  assert.equal(matchesSubjectGate('oh-my-pi coding harness', ['pi']), true)
  assert.equal(matchesSubjectGate('Acme/mcp_server', ['acme/mcp-server']), false)
  assert.equal(matchesSubjectGate('Acme/mcp-server-extra', ['acme/mcp-server']), false)
  assert.equal(matchesSubjectGate('https://github.com/Acme/mcp-server', ['acme/mcp-server']), true)
})
