import assert from 'node:assert/strict'
// One community view, shared by both search paths.
//
// The hybrid search annotates results with this layer and the live probe badges them with it; when
// the two derived their own copies, adding a source to one of them would have made a repository's
// badge depend on which endpoint answered. These assertions are about the derivation itself, since
// the callers only use `.get()` and `.has()`.
import { test } from 'node:test'
import { buildCommunityIndex } from '../src/community-index.js'

test('every community source contributes to the index', () => {
  const index = buildCommunityIndex({
    harvested: [{ repo: 'user/Ingested', stars: 5 }],
    rankings: {
      breakoutWeekly: [{ repo: 'break/Out', stars: 10 }],
      agentSkillRepos: [{ repo: 'skill/Repo', stars: 20 }],
      helloGitHub: [{ repo: 'hello/Pick', description_zh: 'curated' }],
      trending: {
        overall_daily: [{ repo: 'trend/Daily', stars: 30 }],
        rust_weekly: [{ repo: 'trend/Rust', stars: 40 }],
      },
    },
  })

  assert.deepEqual(
    [...index.keys()].sort(),
    ['break/out', 'hello/pick', 'skill/repo', 'trend/daily', 'trend/rust', 'user/ingested'],
    'keys are lowercased so a lookup cannot depend on GitHub casing',
  )
})

test('the user ingest supersedes boards for the same repository regardless of casing', () => {
  // An ingested repository is described by its ingest record; whatever the trending board last said
  // about it is not the more authoritative description.
  const index = buildCommunityIndex({
    harvested: [{ repo: 'Acme/Tool', stars: 1, reason: 'ingested by the user' }],
    rankings: {
      breakoutWeekly: [{ repo: 'acme/tool', stars: 2, reason: 'breakout' }],
      trending: { overall_daily: [{ repo: 'ACME/TOOL', stars: 3, reason: 'trending' }] },
    },
  })

  assert.equal(index.size, 1, 'one repository, one record')
  assert.equal(index.get('acme/tool').reason, 'ingested by the user')
  assert.deepEqual(index.get('acme/tool').source_channels, ['breakout', 'trending', 'curated'])
})

test('a missing or empty document is an empty index, not a crash', () => {
  assert.equal(buildCommunityIndex().size, 0)
  assert.equal(buildCommunityIndex({ rankings: {}, harvested: [] }).size, 0)
  assert.equal(buildCommunityIndex({ rankings: { trending: {} } }).size, 0)
})

test('records without a repository name are skipped rather than keyed undefined', () => {
  const index = buildCommunityIndex({
    harvested: [null, { stars: 1 }, { repo: 'ok/one' }],
    rankings: { trending: { overall_daily: [undefined, { repo: 'ok/two' }] } },
  })
  assert.deepEqual([...index.keys()].sort(), ['ok/one', 'ok/two'])
})
