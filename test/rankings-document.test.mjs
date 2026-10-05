import assert from 'node:assert/strict'
// Provenance for the community layers.
//
// Each layer is fetched from a different upstream and can fail alone while the run succeeds — the
// fetcher keeps the previous list and logs a warning. Before this record existed, `updatedAt` moved
// on every run regardless, so a layer that had not refreshed for days looked exactly like a fresh
// one. These assertions pin down the two things that make staleness visible: a retained layer keeps
// the timestamp of the run that actually fetched it, and every layer reports its own status.
import { test } from 'node:test'
import {
  COMMUNITY_SOURCES,
  emptyRankings,
  emptySourceReport,
  recordSource,
  stalenessHours,
  staleSources,
} from '../src/rankings-document.js'

const at = iso => new Date(iso).toISOString()

test('a fresh report names every community layer and claims nothing yet', () => {
  const report = emptySourceReport()
  assert.deepEqual(Object.keys(report).sort(), [...COMMUNITY_SOURCES].sort())
  assert.ok(COMMUNITY_SOURCES.every(name => report[name].status === 'unknown'))
  assert.equal(staleSources({ sources: report }).length, COMMUNITY_SOURCES.length, 'an unknown layer is not fresh data')
})

test('a fetched layer records when it was fetched and how much it returned', () => {
  const report = emptySourceReport()
  recordSource(report, 'trending', { status: 'fresh', count: 8, at: at('2026-09-15T08:00:00Z') })
  assert.deepEqual(report.trending, { status: 'fresh', at: at('2026-09-15T08:00:00Z'), count: 8 })
  assert.deepEqual(staleSources({ sources: report }).map(entry => entry.name).includes('trending'), false)
})

test('a retained layer keeps the timestamp of the run that last fetched it', () => {
  // This is the whole point: the document is rewritten every six hours, and only the per-layer
  // timestamp can reveal that this layer has been riding on an old copy for days.
  const report = emptySourceReport()
  recordSource(report, 'helloGitHub', {
    status: 'retained',
    at: at('2026-09-15T08:00:00Z'),
    previous: { status: 'fresh', at: at('2026-09-10T08:00:00Z'), count: 80 },
    error: 'HTTP 502',
  })

  assert.equal(report.helloGitHub.at, at('2026-09-10T08:00:00Z'), 'the fetch time, not the run time')
  assert.equal(report.helloGitHub.status, 'retained')
  assert.equal(report.helloGitHub.error, 'HTTP 502', 'why it was retained is part of the record')
})

test('staleness is reported per layer, and the summary is the oldest one', () => {
  const report = emptySourceReport()
  recordSource(report, 'trending', { status: 'fresh', count: 8, at: at('2026-09-15T08:00:00Z') })
  recordSource(report, 'helloGitHub', { status: 'retained', at: at('2026-09-15T08:00:00Z'), previous: { at: at('2026-09-14T08:00:00Z') } })
  recordSource(report, 'agentSkills', { status: 'retained', at: at('2026-09-15T08:00:00Z'), previous: { at: at('2026-09-12T08:00:00Z') } })

  const stale = staleSources({ sources: report })
  // Layers that were never reported ("unknown") are not fresh data either, so they appear here as
  // well — the record is meant to be read as "what can I trust", not as a fetch log.
  assert.deepEqual(
    stale.map(entry => entry.name).sort(),
    ['agentSkillRepos', 'agentSkills', 'breakoutWeekly', 'helloGitHub', 'topStarred'],
    'the retained layers and the never-reported ones are both not fresh',
  )
  assert.deepEqual(
    stale.filter(entry => entry.status === 'retained').map(entry => entry.name).sort(),
    ['agentSkills', 'helloGitHub'],
  )
  assert.equal(
    stalenessHours({ sources: report }, Date.parse('2026-09-15T08:00:00Z')),
    72,
    'the summary reports the oldest layer with a known fetch time',
  )
})

test('a document with no provenance reports zero staleness rather than guessing', () => {
  assert.equal(stalenessHours(emptyRankings()), 0)
  assert.equal(stalenessHours(undefined), 0)
})

test('the published shape still carries the six layers and nothing else', () => {
  // The provenance lives beside the layers, not inside them: a consumer that only reads
  // `trending`/`topStarred`/… keeps working.
  assert.deepEqual(Object.keys(emptyRankings()).sort(), [...COMMUNITY_SOURCES].sort())
})
