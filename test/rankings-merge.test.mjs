// Tests for the community-board merge, which decides what the leaderboard channels see.
//
// This was the last untested stretch of the ranking pipeline, and it is where the two data
// defects the merge review found lived: a skill listed twice on one board collected its tag
// twice, and a board without a rank column had to be numbered against all five files.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeBoardSkills, selectRecentIssues } from '../scripts/rankings_merge.js'

function row(skill, { rank, tag = 'best' } = {}) {
  return { skill, vendor: 'v', url: `https://x/${skill}`, description: 'd', description_zh: '曰', rank, tags: [tag] }
}

test('a skill on several boards gets one entry carrying every tag', () => {
  const merged = mergeBoardSkills([
    [row('alpha', { rank: 1, tag: 'rising' })],
    [row('alpha', { rank: 4, tag: 'official' })],
  ])

  assert.equal(merged.length, 1, 'the boards share a skill, so there is one entry')
  assert.deepEqual(merged[0].tags, ['rising', 'official'])
  assert.equal(merged[0].rank, 1, 'the first board that ranked it decides')
})

test('a skill listed twice on one board still carries that tag once', () => {
  // The upstream boards do repeat a skill inside a single file, and the tag is what the
  // Worker filters on, so a duplicate would be shipped to clients.
  const merged = mergeBoardSkills([
    [row('alpha', { rank: 1, tag: 'top_installs' }), row('alpha', { rank: 9, tag: 'top_installs' })],
  ])

  assert.equal(merged.length, 1)
  assert.deepEqual(merged[0].tags, ['top_installs'], 'a repeated tag must not accumulate')
})

test('an unranked board is numbered in board order, continuing after ranked boards', () => {
  // The rank column is absent on some boards, and the number then depends on how many
  // skills were already known — which is why the per-file parser leaves it undefined.
  const merged = mergeBoardSkills([
    [row('ranked', { rank: 7, tag: 'best' })],
    [row('a', { tag: 'rising' }), row('b', { tag: 'rising' })],
  ])

  assert.deepEqual(merged.map(r => [r.skill, r.rank]), [['ranked', 7], ['a', 8], ['b', 9]])
})

test('numbering starts at one when nothing was ranked', () => {
  const merged = mergeBoardSkills([[row('a', { tag: 'rising' }), row('b', { tag: 'rising' })]])
  assert.deepEqual(merged.map(r => r.rank), [1, 2])
})

test('an unranked skill adopts a rank if a later board provides one', () => {
  const merged = mergeBoardSkills([
    [row('alpha', { tag: 'rising' })],
    [row('alpha', { rank: 3, tag: 'official' })],
  ])

  assert.equal(merged[0].rank, 3, 'a real rank beats an invented one')
  assert.deepEqual(merged[0].tags, ['rising', 'official'])
})

test('rows without a skill name are skipped rather than merged under undefined', () => {
  const merged = mergeBoardSkills([[row('', { rank: 1 }), row('alpha', { rank: 2 })]])
  assert.deepEqual(merged.map(r => r.skill), ['alpha'])
})

test('merging returns copies, so the caller cannot mutate the parsed rows', () => {
  const original = row('alpha', { rank: 1, tag: 'rising' })
  const merged = mergeBoardSkills([[original]])
  merged[0].tags.push('injected')

  assert.deepEqual(original.tags, ['rising'], 'the parser output must stay untouched')
})

test('an empty board list yields an empty result', () => {
  assert.deepEqual(mergeBoardSkills(), [])
  assert.deepEqual(mergeBoardSkills([[], []]), [])
})

test('selectRecentIssues reads numbers as numbers, not as text', () => {
  // A plain string sort would put issue 9 above issue 10. The upstream files are unpadded,
  // so this is the ordering that decides which two issues get parsed.
  const files = [
    { name: 'HelloGitHub9.md' },
    { name: 'HelloGitHub10.md' },
    { name: 'HelloGitHub100.md' },
    { name: 'HelloGitHub11.md' },
    { name: 'README.md' },
    { name: 'HelloGitHubDraft.md' },
    { name: 'HelloGitHub12.md.bak' },
    { name: 'renamed-HelloGitHub13.md' },
  ]

  assert.deepEqual(selectRecentIssues(files).map(f => f.name), ['HelloGitHub100.md', 'HelloGitHub11.md'])
})

test('selectRecentIssues tolerates an empty or malformed listing', () => {
  assert.deepEqual(selectRecentIssues([]), [])
  assert.deepEqual(selectRecentIssues(undefined), [])
  assert.deepEqual(selectRecentIssues([{}, { name: null }]), [])
  assert.deepEqual(selectRecentIssues([{ name: 'HelloGitHub.md' }]), [], 'the number is required')
})
