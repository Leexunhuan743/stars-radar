import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
// The intent tables themselves.
//
// They are data, and they drive scoring: `analyzeQuery` decides which groups a query activates,
// `scoreText` adds a fixed weight per matched keyword, and `buildIntentInverted` (in the pipeline)
// decides which repositories an intent word can reach. Nothing validated the file, so three defects
// were possible and silent:
//
//   * an upper-case keyword is dead in the scoring channel — `scoreText` compares it against an
//     already lower-cased text pool, so the word can never match while `analyzeQuery` (which
//     lower-cases at use time) still activates its group;
//   * a keyword repeated inside one domain scores twice for a single match, silently weighting that
//     synonym above its neighbours;
//   * an empty or non-string entry cannot match anything and has no obvious reader.
//
// The file is also the source of the domain names the READMEs describe, which is asserted in
// test/docs-coverage.test.mjs.
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INTENTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'intents.json'), 'utf-8'))

test('the ontology has the domains it is documented to have', () => {
  const domains = Object.keys(INTENTS)
  assert.equal(domains.length, 18, 'the READMEs, /health and the tool schemas all describe 18 domains')
  for (const domain of domains)
    assert.match(domain, /^[a-z][a-z0-9_]*$/, `${domain} is not a snake_case domain name`)

  const empty = domains.filter(domain => !Array.isArray(INTENTS[domain]) || INTENTS[domain].length === 0)
  assert.deepEqual(empty, [], 'a domain with no keywords can never be activated')
})

test('every keyword is usable by the scoring channel that reads it', () => {
  // The decisive property: keywords are matched against a lower-cased text pool with a plain
  // `includes`, so anything that is not already lower-case and trimmed is a keyword that can never
  // fire. It would still mark its group as matched, which is the confusing half.
  const unusable = []
  for (const [domain, words] of Object.entries(INTENTS)) {
    for (const word of words) {
      if (typeof word !== 'string' || word.trim() === '') {
        unusable.push(`${domain}: ${JSON.stringify(word)} is not a keyword`)
        continue
      }
      if (word !== word.toLowerCase() || word !== word.trim())
        unusable.push(`${domain}: ${JSON.stringify(word)} is not lower-case and trimmed`)
    }
  }
  assert.deepEqual(unusable, [])
})

test('a keyword appears at most once per domain', () => {
  // `scoreText` adds its weight once per occurrence, so a duplicate silently doubles the weight of
  // that synonym — a scoring change nobody intended and nothing would report.
  const duplicated = []
  for (const [domain, words] of Object.entries(INTENTS)) {
    const seen = new Set()
    for (const word of words) {
      if (seen.has(word))
        duplicated.push(`${domain}: ${word}`)
      seen.add(word)
    }
  }
  assert.deepEqual(duplicated, [])
})

test('the tables are large enough to be the ontology they claim to be', () => {
  // A guard against the file being truncated by a bad merge: 18 domains of a handful of words each
  // would still satisfy every assertion above.
  const total = Object.values(INTENTS).reduce((sum, words) => sum + words.length, 0)
  assert.ok(total > 800, `the ontology is documented as roughly 951 keywords, found ${total}`)
  const smallest = Math.min(...Object.values(INTENTS).map(words => words.length))
  assert.ok(smallest >= 20, `the smallest domain holds ${smallest} keywords, which is too few to be a domain`)
})
