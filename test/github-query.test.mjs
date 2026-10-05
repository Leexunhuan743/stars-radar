import assert from 'node:assert/strict'
// Query assembly, shared by the Worker tool and the pipeline script.
//
// GitHub rejects a query that states the same qualifier twice with conflicting values (422), so
// injecting one the caller already wrote is a hard failure, not a cosmetic one. The Worker guarded
// against it and the pipeline entry point did not — the same input therefore worked through one
// path and broke the other.
import { test } from 'node:test'
import { parseDateRange } from '../src/date-range.js'
import { buildRepositoryQuery, hasQualifier } from '../src/github-query.js'

const build = options => buildRepositoryQuery({ parseDateRange, ...options })

test('defaults are injected for a bare query', () => {
  const query = build({ query: 'agent memory', since: '30d' })
  assert.match(query, /^agent memory /)
  assert.match(query, /created:\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}/)
  assert.match(query, /fork:false/)
  assert.match(query, /archived:false/)
})

test('a qualifier the caller already wrote is never duplicated', () => {
  // Each of these is a spelling GitHub accepts, and each used to get a conflicting twin injected.
  const cases = [
    ['stars', 'stars:>100 terminal', /stars:>=15/, 'stars:>100'],
    ['created', 'created:2026-01-01..2026-02-01 terminal', /created:2026-06/, 'created:2026-01-01..2026-02-01'],
    ['language', 'language:rust terminal', /language:go/, 'language:rust'],
    ['fork', 'fork:true terminal', /fork:false/, 'fork:true'],
    ['archived', 'archived:true terminal', /archived:false/, 'archived:true'],
    ['negated', '-stars:>100 terminal', /stars:>=15/, '-stars:>100'],
    ['parenthesised', '(stars:>100) terminal', /stars:>=15/, '(stars:>100)'],
  ]

  for (const [label, query, unwanted, expected] of cases) {
    const built = build({ query, since: '30d', minStars: 15, language: 'go' })
    assert.doesNotMatch(built, unwanted, `${label}: the caller's own qualifier must not be duplicated`)
    assert.ok(built.includes(expected), `${label}: the caller's qualifier must survive`)
  }

  // A date window is the one where "not duplicated" needs counting rather than a pattern: the
  // caller's own window contains the substring an injected one would start with.
  const countOccurrences = (text, needle) => text.split(needle).length - 1
  const withWindow = build({ query: 'created:2026-01-01..2026-02-01 terminal', since: '30d' })
  assert.equal(countOccurrences(withWindow, 'created:'), 1, 'exactly one created: window may survive')

  const injected = build({ query: 'terminal', since: '30d' })
  assert.equal(countOccurrences(injected, 'created:'), 1)
})

test('a caller who asked for forks keeps them, and a caller who asked for none gets a filter', () => {
  assert.doesNotMatch(build({ query: 'fork:true x' }), /fork:false/)
  assert.match(build({ query: 'x' }), /fork:false/)
})

test('zero stars means "no threshold", not "stars >= 0"', () => {
  assert.doesNotMatch(build({ query: 'x', minStars: 0 }), /stars:/)
})

test('the qualifier detector recognises the spellings GitHub accepts', () => {
  assert.equal(hasQualifier('stars:>100 x', 'stars'), true)
  assert.equal(hasQualifier('-stars:>100', 'stars'), true)
  assert.equal(hasQualifier('(stars:>100)', 'stars'), true)
  assert.equal(hasQualifier('x stars:>100', 'stars'), true)
  assert.equal(hasQualifier('mystars:>100', 'stars'), false, 'a longer word is not a star threshold')
  assert.equal(hasQualifier('', 'stars'), false)
  assert.equal(hasQualifier(undefined, 'stars'), false)
})
