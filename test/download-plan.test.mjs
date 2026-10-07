import assert from 'node:assert/strict'
import { test } from 'node:test'
import { needsReadmeDownload } from '../scripts/download-plan.js'

test('an unchanged README source clock is reused', () => {
  assert.equal(
    needsReadmeDownload({
      fileExists: true,
      sourcePushedAt: '2026-02-01T00:00:00Z',
      pushedAt: '2026-02-01T00:00:00Z',
    }),
    false,
  )
})

test('a changed source clock requires a refresh', () => {
  assert.equal(
    needsReadmeDownload({
      fileExists: true,
      sourcePushedAt: '2026-02-01T00:00:00Z',
      pushedAt: '2026-02-02T00:00:00Z',
    }),
    true,
  )
})

test('missing content or either clock requires a refresh', () => {
  assert.equal(
    needsReadmeDownload({
      fileExists: false,
      sourcePushedAt: '2026-02-01T00:00:00Z',
      pushedAt: '2026-02-01T00:00:00Z',
    }),
    true,
  )
  assert.equal(needsReadmeDownload({ fileExists: true, pushedAt: '2026-02-01T00:00:00Z' }), true)
  assert.equal(needsReadmeDownload({ fileExists: true, sourcePushedAt: '2026-02-01T00:00:00Z' }), true)
})
