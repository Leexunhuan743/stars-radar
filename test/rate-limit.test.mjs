import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  consumePlatformRateLimit,
  PlatformRateLimitError,
  rateLimitStatus,
} from '../src/rate-limit.js'

test('an absent binding is explicitly disabled rather than pretending to enforce a limit', async () => {
  assert.deepEqual(await consumePlatformRateLimit(undefined, 'actor'), { enabled: false, success: true })
  assert.deepEqual(rateLimitStatus({}), {
    expensive_requests: false,
    write_requests: false,
    locality: 'cloudflare_location',
  })
})

test('a configured binding receives the actor key and reports allow/deny decisions', async () => {
  const keys = []
  const binding = {
    async limit({ key }) {
      keys.push(key)
      return { success: keys.length === 1 }
    },
  }

  assert.deepEqual(await consumePlatformRateLimit(binding, 'read-key'), { enabled: true, success: true })
  assert.deepEqual(await consumePlatformRateLimit(binding, 'read-key'), { enabled: true, success: false })
  assert.deepEqual(keys, ['read-key', 'read-key'])
})

test('a configured but broken limiter fails closed', async () => {
  await assert.rejects(
    consumePlatformRateLimit({ limit: async () => { throw new Error('binding unavailable') } }, 'actor'),
    error => error instanceof PlatformRateLimitError && /binding unavailable/.test(error.message),
  )
  await assert.rejects(
    consumePlatformRateLimit({ limit: async () => ({}) }, 'actor'),
    PlatformRateLimitError,
  )
})

test('status reports configured bindings without consuming them', () => {
  assert.deepEqual(rateLimitStatus({
    EXPENSIVE_RATE_LIMITER: { limit() {} },
    WRITE_RATE_LIMITER: { limit() {} },
  }), {
    expensive_requests: true,
    write_requests: true,
    locality: 'cloudflare_location',
  })
})
