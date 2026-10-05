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
//   * **the order of the layers decides who offers a repository first**, because a key that is
//     already scored is skipped. Reordering the table is therefore a behaviour change, not a tidy-up.
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

test('the first layer to offer a repository keeps it', () => {
  // Order is behaviour: the loop skips a key that is already scored, so a repository on both the
  // trending board and the breakout board is published once, under the earlier layer.
  const doc = rankings()
  doc.breakoutWeekly.push({ repo: 'acme/trending-tool', url: 'https://github.com/acme/trending-tool', stars: 10, description: 'a browser tool' })

  const keywordScores = new Map()
  collectCommunityHits({ rankings: doc, query: query({ queryTokens: ['browser'] }), keywordScores })

  const hit = keywordScores.get('acme/trending-tool')
  assert.equal(hit.source, 'trending', 'the earlier layer wins')
  assert.equal([...keywordScores.keys()].filter(k => k === 'acme/trending-tool').length, 1, 'offered once')
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
