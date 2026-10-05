import assert from 'node:assert/strict'
// The five community layers, as the table they now are.
//
// Two properties are worth pinning, and neither could be tested while these were five copies of one
// loop inside the Worker entry (which plain Node cannot import):
//
//   * **provenance is not a category.** Each layer used to publish a `categories` value invented from
//     the board it came from — `trending`, `breakout-weekly`, `agent-skills`, and `open-source` as a
//     fallback. `categories` means "a category the deployer assigned", and it is what `?category=`
//     filters on, so those values answered a filter about the deployer's taxonomy with a source's
//     label. The decision (2026-09-15) is that a source's provenance travels in `source` and the
//     badge, and never in `categories`.
//   * **the order of the layers decides the primary presentation source**, while duplicate
//     observations accumulate in sourceChannels instead of being discarded.
import { test } from 'node:test'
import { collectCommunityHits, COMMUNITY_LAYERS } from '../src/community-layers.js'

const INTENTS = { browser: ['browser', 'chrome'], terminal: ['shell', 'tui'] }

function query(overrides = {}) {
  return { specificSubjects: [], queryTokens: [], matchedGroups: new Set(), intents: INTENTS, ...overrides }
}

/** One published document carrying a candidate for every layer. */
function rankings() {
  return {
    trending: { overall_daily: [{ repo: 'acme/trending-tool', url: 'https://github.com/acme/trending-tool', stars: 10, description: 'a browser tool', language: 'Rust' }] },
    helloGitHub: [{ repo: 'acme/hg-pick', url: 'https://github.com/acme/hg-pick', name: 'HG Pick', description_zh: 'browser 浏览器工具', category: '浏览器项目', issue: '2026-09' }],
    breakoutWeekly: [{ repo: 'acme/new-tool', url: 'https://github.com/acme/new-tool', stars: 3, description: 'brand new browser thing', language: 'Go' }],
    agentSkills: [{ skill: 'browser-helper', vendor: 'acme', url: 'https://skills.test/browser-helper', installs: 120, description: 'helps in the browser', description_zh: '浏览器助手' }],
    agentSkillRepos: [{ repo: 'acme/skill-repo', url: 'https://github.com/acme/skill-repo', stars: 8, description: 'browser skills collection', language: 'TypeScript', topics: ['skill'] }],
  }
}

function collect(overrides = {}) {
  const keywordScores = new Map()
  collectCommunityHits({ rankings: rankings(), query: query(overrides), keywordScores })
  return keywordScores
}

test('every layer declares provenance, and none of them publishes a category', () => {
  // The table is the whole surface a new layer can be added through, so this is where the rule lives.
  assert.equal(COMMUNITY_LAYERS.length, 5)
  for (const layer of COMMUNITY_LAYERS) {
    assert.ok(layer.source, 'a layer must declare the provenance its hits carry')
    assert.equal(typeof layer.badge, 'function', 'the badge is what tells a reader where a hit came from')
  }

  for (const [key, stats] of collect({ queryTokens: ['browser'] })) {
    assert.ok(stats.source, `${key} must carry its provenance`)
    assert.ok(stats.badge, `${key} must carry a badge`)
    assert.equal('categories' in stats.item, false, `${key} claims a category: ${JSON.stringify(stats.item.categories)}`)
  }
})

test('the badges say which board a hit came from', () => {
  const stats = collect({ queryTokens: ['browser'] })
  assert.equal(stats.get('acme/trending-tool').badge, '🔥 Trending (overall_daily)')
  assert.equal(stats.get('acme/hg-pick').badge, '📖 HelloGitHub (2026-09)')
  assert.equal(stats.get('acme/new-tool').badge, '🚀 Breakout New')
  assert.equal(stats.get('skill:browser-helper').badge, '⚡ Agent Skill')
  assert.equal(stats.get('acme/skill-repo').badge, '⚡ Agent Skill Repo')
})

test('a skill is keyed apart from a repository, and carries installs as its stars', () => {
  // A skill is not `owner/repo`: keying it by name alone would let a skill collide with a repository
  // of the same name, and the leaderboard's "stars" are installs.
  const stats = collect({ queryTokens: ['browser'] })
  const skill = stats.get('skill:browser-helper')
  assert.ok(skill, 'the skill layer keys on `skill:<name>`')
  assert.equal(skill.item.repo, 'browser-helper', 'the name is published as the repository field')
  assert.equal(skill.item.stars, 120, 'installs are what the leaderboard publishes')
  assert.equal(skill.item.description, '浏览器助手', 'the Chinese description is preferred when present')
})

test('the first layer stays primary while later layers are retained as corroborating evidence', () => {
  // Order still decides the primary presentation, but a second independent board must not vanish.
  const doc = rankings()
  doc.breakoutWeekly.push({ repo: 'acme/trending-tool', url: 'https://github.com/acme/trending-tool', stars: 10, description: 'a browser tool' })

  const keywordScores = new Map()
  collectCommunityHits({ rankings: doc, query: query({ queryTokens: ['browser'] }), keywordScores })

  const hit = keywordScores.get('acme/trending-tool')
  assert.equal(hit.source, 'trending', 'the earlier layer remains the primary source')
  assert.deepEqual(hit.sourceChannels, ['trending', 'breakout'])
  assert.equal([...keywordScores.keys()].filter(k => k === 'acme/trending-tool').length, 1, 'one result carries both observations')
})

test('a named subject still gates every layer', () => {
  // Shared with the rest of the engine (§5.14): a query that names one tool must not be answered with
  // same-category neighbours from the boards.
  const keywordScores = new Map()
  collectCommunityHits({
    rankings: rankings(),
    query: query({ specificSubjects: ['antigravity'], queryTokens: ['browser'] }),
    keywordScores,
  })

  assert.equal(keywordScores.size, 0, 'no board hit mentions the named subject')
})

test('a hit that matches nothing is not offered', () => {
  // scoreText returns 0 for "this candidate has nothing to do with the query", and a 0-weight hit
  // would still occupy the key and hide the same repository from a later layer.
  assert.equal(collect({ queryTokens: ['kubernetes'] }).size, 0)
})

test('the source\u2019s own classification still counts as scoring text', () => {
  // HelloGitHub's section describes what the repository is about, so it stays in the text pool even
  // though it is never published as a category: that is the difference between matching and claiming.
  // `浏览器项目` is the section and appears nowhere else in that entry's text.
  const hit = collect({ queryTokens: ['项目'] }).get('acme/hg-pick')
  assert.ok(hit, 'the HelloGitHub section name participates in matching')
  assert.equal('categories' in hit.item, false)
})


test('the strongest corroborating source supplies the scoring evidence without changing primary provenance', () => {
  const doc = rankings()
  doc.trending.overall_daily = [{
    repo: 'acme/shared',
    description: 'browser helper',
    language: 'Rust',
  }]
  doc.breakoutWeekly = [{
    repo: 'acme/shared',
    description: 'browser browser chrome chrome helper',
    language: 'Rust',
  }]

  const keywordScores = new Map()
  collectCommunityHits({
    rankings: doc,
    query: query({ queryTokens: ['browser', 'chrome'], explain: true }),
    keywordScores,
  })

  const hit = keywordScores.get('acme/shared')
  assert.equal(hit.source, 'trending', 'presentation provenance remains stable')
  assert.equal(hit.scoringSource, 'breakout', 'the source that produced the stronger score is explicit')
  assert.deepEqual(hit.sourceChannels, ['trending', 'breakout'])
  assert.ok(hit.evidence.matched_tokens.includes('chrome'))
})
