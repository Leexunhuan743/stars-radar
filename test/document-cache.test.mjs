import assert from 'node:assert/strict'
// Behaviour of the R2 document cache under the four outcomes it distinguishes.
//
// The bug this guards against was invisible for a long time: a failed read was cached as an
// empty document, so callers saw "no data" for 30 minutes instead of an error. Every test below
// therefore asserts on what the *caller* observes across successive loads, not on internals.
import { test } from 'node:test'
import {
  createDocumentCache,
  DOCUMENT_STATUS,
  DocumentUnavailableError,
} from '../src/document-cache.js'

function makeCache({ read, empty = () => ({ repos: {} }), ttlMs = 1000, now = () => 0 } = {}) {
  return createDocumentCache({ name: 'catalog.json', read, empty, ttlMs, now })
}

test('a successful read is cached until the TTL expires', async () => {
  let reads = 0
  let clock = 0
  const cache = makeCache({
    now: () => clock,
    read: async () => {
      reads++
      return { repos: { a: 1 } }
    },
  })

  assert.deepEqual(await cache.load(), { repos: { a: 1 } })
  clock = 500
  await cache.load()
  assert.equal(reads, 1, 'a second load inside the TTL must not touch R2')
  assert.equal(cache.status(), DOCUMENT_STATUS.FRESH)

  clock = 1500
  await cache.load()
  assert.equal(reads, 2, 'an expired entry must be read again')
})

test('an absent object serves the empty document and is cached', async () => {
  let reads = 0
  const cache = makeCache({
    read: async () => {
      reads++
      return null
    },
  })

  assert.deepEqual(await cache.load(), { repos: {} }, 'a fresh install must see an empty document, not an error')
  assert.equal(cache.status(), DOCUMENT_STATUS.MISSING)
  await cache.load()
  assert.equal(reads, 1, 'absence is a normal state and must be negative-cached')
})

test('a failed read with nothing cached fails the call and caches nothing', async () => {
  let reads = 0
  const cache = makeCache({
    read: async () => {
      reads++
      throw new Error('R2 unreachable')
    },
  })

  await assert.rejects(cache.load(), DocumentUnavailableError, 'a failure must not be reported as an empty document')
  assert.equal(cache.status(), DOCUMENT_STATUS.UNAVAILABLE)

  await assert.rejects(cache.load(), DocumentUnavailableError)
  assert.equal(reads, 2, 'a failure must not be cached: the second call has to try again')
})

test('a failed read with a cached copy serves it, and the next call retries', async () => {
  let reads = 0
  let clock = 0
  let failing = false
  const cache = makeCache({
    now: () => clock,
    read: async () => {
      reads++
      if (failing)
        throw new Error('R2 unreachable')
      return { repos: { a: 1 } }
    },
  })

  await cache.load()
  assert.equal(reads, 1)

  // The fault can only be noticed when a read is attempted, i.e. once the entry expires.
  clock = 2000
  failing = true
  assert.deepEqual(
    await cache.load(),
    { repos: { a: 1 } },
    'a stale copy is better than a wrong empty answer while R2 is unreachable',
  )
  assert.equal(reads, 2)
  assert.equal(cache.status(), DOCUMENT_STATUS.STALE)

  await cache.load()
  assert.equal(reads, 3, 'the retry must happen on the next request, not after another full TTL')

  failing = false
  assert.deepEqual(await cache.load(), { repos: { a: 1 } })
  assert.equal(reads, 4, 'a retry after recovery must read again rather than trust the stale copy')
  assert.equal(cache.status(), DOCUMENT_STATUS.FRESH, 'a successful retry must clear the degraded status')
})

test('the reader receives whatever the caller passed to load', async () => {
  // The Worker's reader signature is `env => env.R2.get(key)`. When the cache called `read()`
  // with no arguments, every read threw on an undefined binding and the cache — correctly —
  // reported `unavailable`, so a deployed Worker answered 503 to every request. No test noticed
  // because every fixture reader ignored its arguments.
  const seen = []
  const cache = makeCache({
    read: async (env) => {
      seen.push(env)
      return { repos: {} }
    },
  })

  const bindings = { R2: { get: async () => null } }
  await cache.load(bindings)
  assert.deepEqual(seen, [bindings], 'the bindings must reach the reader')

  // A second, concurrent load must not produce a reader call without bindings either.
  await cache.load(bindings)
  assert.deepEqual(seen, [bindings], 'a cached value must not re-run the reader')
})

test('concurrent loads share a single read', async () => {
  let reads = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const cache = makeCache({
    read: async () => {
      reads++
      await gate
      return { repos: {} }
    },
  })

  const inFlight = [cache.load(), cache.load(), cache.load()]
  release()
  await Promise.all(inFlight)
  assert.equal(reads, 1, 'three simultaneous requests must not produce three R2 reads')
})
