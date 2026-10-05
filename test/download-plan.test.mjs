import assert from 'node:assert/strict'
// The incrementality predicate.
//
// Its failure mode in production was a full re-download of every README on every run: the
// catalogue publishes `pushedAt`, so a cached entry read under any other name made every
// comparison "changed". The cost is 928 GitHub API calls and ~17 MB of transfer per run, which is
// why this is worth pinning down rather than leaving inline in an orchestration script that no
// test can import.
import { test } from 'node:test'
import { needsReadmeDownload } from '../scripts/download-plan.js'

test('a repository whose push date is unchanged is not downloaded again', () => {
  assert.equal(
    needsReadmeDownload({
      fileExists: true,
      cachedEntry: { repo: 'acme/tool', pushedAt: '2026-02-01T00:00:00Z' },
      pushedAt: '2026-02-01T00:00:00Z',
    }),
    false,
  )
})

test('a new push date, a new repository and a missing file all mean download', () => {
  assert.equal(
    needsReadmeDownload({
      fileExists: true,
      cachedEntry: { repo: 'acme/tool', pushedAt: '2026-02-01T00:00:00Z' },
      pushedAt: '2026-02-02T00:00:00Z',
    }),
    true,
    'a moved push date means the rendered README is stale',
  )
  assert.equal(
    needsReadmeDownload({ fileExists: true, cachedEntry: undefined, pushedAt: '2026-02-01T00:00:00Z' }),
    true,
    'a repository with no cached entry is new to the corpus',
  )
  assert.equal(
    needsReadmeDownload({ fileExists: false, cachedEntry: { pushedAt: '2026-02-01T00:00:00Z' }, pushedAt: '2026-02-01T00:00:00Z' }),
    true,
    'the corpus file itself is what the Worker reads, so its absence is always a download',
  )
})

test('a date missing on either side downloads rather than assuming it is current', () => {
  assert.equal(needsReadmeDownload({ fileExists: true, cachedEntry: { pushedAt: '' }, pushedAt: '2026-02-01T00:00:00Z' }), true)
  assert.equal(needsReadmeDownload({ fileExists: true, cachedEntry: { pushedAt: '2026-02-01T00:00:00Z' }, pushedAt: undefined }), true)
})

test('a stale README is retried even after repository metadata advances', () => {
  assert.equal(
    needsReadmeDownload({
      fileExists: true,
      cachedEntry: {
        repo: 'acme/tool',
        pushedAt: '2026-02-02T00:00:00Z',
        readmePushedAt: '2026-02-01T00:00:00Z',
      },
      pushedAt: '2026-02-02T00:00:00Z',
    }),
    true,
    'repository metadata freshness must not make an older README look current',
  )
})

test('a successfully refreshed README records its own push clock', () => {
  assert.equal(
    needsReadmeDownload({
      fileExists: true,
      cachedEntry: {
        pushedAt: '2026-02-02T00:00:00Z',
        readmePushedAt: '2026-02-02T00:00:00Z',
      },
      pushedAt: '2026-02-02T00:00:00Z',
    }),
    false,
  )
})
