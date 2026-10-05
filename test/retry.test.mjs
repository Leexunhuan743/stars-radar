import assert from 'node:assert/strict'
// The shared retry shape.
//
// Five separate retry loops used to live in this repository, each with its own attempt count and
// delay. These assertions are about the properties that were impossible to check across five copies:
// the attempt budget is a budget (not attempts + 1), a non-retryable error stops immediately, and
// backoff is bounded so a provider cannot be hammered.
import { test } from 'node:test'
import { backoffDelay, retryAsync, retryUntilAcceptable } from '../src/retry.js'

/** Collects the delays instead of waiting them out. */
function recordingSleep() {
  const delays = []
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms)
    },
  }
}

test('the attempt count is the number of attempts, and the last failure is reported', async () => {
  const { delays, sleep } = recordingSleep()
  let calls = 0
  const failure = new Error('provider is down')

  await assert.rejects(
    retryAsync(async () => {
      calls++
      throw failure
    }, { attempts: 3, sleep }),
    /provider is down/,
  )

  assert.equal(calls, 3, 'three attempts means three attempts')
  assert.deepEqual(delays, [250, 500], 'the delay happens between attempts, not after the last one')
})

test('the first success stops the loop and is returned', async () => {
  const { delays, sleep } = recordingSleep()
  let calls = 0
  const result = await retryAsync(async () => {
    calls++
    if (calls < 3)
      throw new Error('not yet')
    return 'ok'
  }, { attempts: 5, sleep })

  assert.equal(result, 'ok')
  assert.equal(calls, 3)
  assert.deepEqual(delays, [250, 500])
})

test('an error the caller calls fatal stops immediately', async () => {
  const { delays, sleep } = recordingSleep()
  let calls = 0
  const fatal = Object.assign(new Error('404 not found'), { status: 404 })

  await assert.rejects(
    retryAsync(async () => {
      calls++
      throw fatal
    }, { attempts: 5, shouldRetry: error => error.status !== 404, sleep }),
    /404 not found/,
  )

  assert.equal(calls, 1, 'a request that cannot succeed must not be repeated')
  assert.deepEqual(delays, [])
})

test('the backoff doubles and stops at the ceiling', () => {
  assert.equal(backoffDelay(1, { baseMs: 100, maxMs: 1000 }), 100)
  assert.equal(backoffDelay(2, { baseMs: 100, maxMs: 1000 }), 200)
  assert.equal(backoffDelay(4, { baseMs: 100, maxMs: 1000 }), 800)
  assert.equal(backoffDelay(9, { baseMs: 100, maxMs: 1000 }), 1000, 'a long outage must not turn into a long sleep')
})

test('observers see each retry and the give-up', async () => {
  const { sleep } = recordingSleep()
  const retries = []
  const giveUps = []

  await assert.rejects(
    retryAsync(async () => {
      throw new Error('nope')
    }, {
      attempts: 2,
      sleep,
      onRetry: context => retries.push(context.attempt),
      onGiveUp: error => giveUps.push(error.message),
    }),
  )

  assert.deepEqual(retries, [1], 'only the attempt that is followed by another one is a retry')
  assert.deepEqual(giveUps, ['nope'])
})

test('a zero or missing attempt count is refused rather than silently doing nothing', async () => {
  await assert.rejects(retryAsync(async () => 'never', { attempts: 0 }), /positive attempt count/)
  await assert.rejects(retryAsync(async () => 'never', {}), /positive attempt count/)
})

test('an unacceptable result is retried, then returned as-is', async () => {
  // Providers answer 200 with an unusable body more often than they answer 500: a rate-limit page,
  // an empty data array. "The request worked" and "we got an answer" are different questions.
  const { delays, sleep } = recordingSleep()
  let calls = 0
  const result = await retryUntilAcceptable(
    async () => {
      calls++
      return { data: [] }
    },
    payload => payload.data.length > 0,
    { attempts: 3, sleep },
  )

  assert.equal(calls, 3, 'an empty answer is retried')
  assert.deepEqual(result, { data: [] })
  assert.deepEqual(delays, [250, 500])
})

test('an acceptable result is returned on the first try', async () => {
  const { delays, sleep } = recordingSleep()
  const result = await retryUntilAcceptable(
    async () => ({ data: [1] }),
    payload => payload.data.length > 0,
    { attempts: 3, sleep },
  )
  assert.deepEqual(result, { data: [1] })
  assert.deepEqual(delays, [])
})

test('a thrown error still propagates out of retryUntilAcceptable', async () => {
  const { sleep } = recordingSleep()
  await assert.rejects(
    retryUntilAcceptable(async () => {
      throw new Error('connection reset')
    }, () => true, { attempts: 2, sleep }),
    /connection reset/,
  )
})
