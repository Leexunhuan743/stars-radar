// Tests for the GitHub API access that the star sync depends on.
//
// Pagination is the reason this matters: a wrong stop condition truncates the user's
// library silently, and the caller cannot tell a short list from a complete one. The
// rate-limit path is the other risk — a limit must be waited out and the same page
// retried, while any other failure must propagate rather than be swallowed into a short
// list. One failure strategy holds for the whole module: a call that could not complete throws,
// and `null` means only "GitHub says there is nothing there" (a 404). The README fetch used to
// answer null for both, which is how a failed fetch became an empty corpus document that the
// incremental plan then never revisited.
//
// The request itself is asserted, not just the responses: the stub alone would happily
// serve a page to a request with the wrong `per_page`, the wrong media type or no token,
// and every one of those is a real defect that produces plausible-looking output.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchReadme, getAllStarredRepos, mapLimit } from '../scripts/github_stars.js'

const PER_PAGE = 100
/** Mirrors the floor in `retryDelay`, so the assertions below stay readable. */
const MIN_WAIT_MS = 5000
/**
 * Mirrors `MAX_RATE_LIMIT_RETRIES` in scripts/github_stars.js.
 *
 * Kept as a literal on purpose: a range assertion ("at least one, at most five") accepts any
 * bound in that window, so the retry budget could be widened or narrowed without a single
 * test noticing. Both rate-limit loops are counted against this exact number instead.
 */
const MAX_RATE_LIMIT_RETRIES = 3
const realFetch = globalThis.fetch

test('malformed star listings fail rather than becoming an empty catalogue', async () => {
  globalThis.fetch = async () => json({ message: 'unexpected response' })
  await assert.rejects(getAllStarredRepos('test-token'), /non-array response/)
  globalThis.fetch = async () => json([{ repo: { full_name: '../invalid/path' } }])
  await assert.rejects(getAllStarredRepos('test-token'), /invalid repository identity/)
})

test('private repositories are excluded from the published corpus', async () => {
  globalThis.fetch = async () => json([
    { repo: { full_name: 'acme/private', private: true } },
    { repo: { full_name: 'acme/public', private: false } },
  ])
  const repos = await getAllStarredRepos('test-token')
  assert.deepEqual(repos.map(repo => repo.full_name), ['acme/public'])
})

test.after(() => {
  globalThis.fetch = realFetch
})

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function starEntry(fullName, starredAt) {
  return {
    starred_at: starredAt,
    repo: { full_name: fullName, html_url: `https://github.com/${fullName}`, stargazers_count: 1 },
  }
}

/** Serve `pages[page-1]` and record every requested page number. */
function stubPaged(pages, { onRequest } = {}) {
  const requested = []
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url))
    const page = Number(parsed.searchParams.get('page'))
    requested.push(page)
    if (onRequest)
      onRequest({ url: parsed, init })
    return pages[page - 1] === undefined ? json([]) : json(pages[page - 1])
  }
  return requested
}

/**
 * The request the listing must send.
 *
 * `per_page` matters most: the stop condition compares the response length against
 * PER_PAGE, so requesting fewer makes every page look final and truncates the library
 * after one request without any error.
 */
function assertListRequest({ url, init }) {
  assert.equal(url.origin + url.pathname, 'https://api.github.com/user/starred')
  assert.equal(url.searchParams.get('per_page'), String(PER_PAGE), 'a smaller page size would look like the end of the list')
  assert.equal(init.headers.get('accept'), 'application/vnd.github.v3.star+json', 'this media type is what carries starred_at')
  assert.equal(init.headers.get('authorization'), 'Bearer token', 'an unauthenticated request hits the much smaller anonymous limit')
}

/** A 403 whose headers decide whether it is a rate limit (transient) or a real denial. */
function forbidden({ remaining, resetInSeconds, retryAfter } = {}) {
  const headers = {}
  if (remaining !== undefined)
    headers['x-ratelimit-remaining'] = remaining
  if (resetInSeconds !== undefined)
    headers['x-ratelimit-reset'] = String(Math.floor(Date.now() / 1000) + resetInSeconds)
  if (retryAfter !== undefined)
    headers['retry-after'] = retryAfter
  return json({ message: 'API rate limit exceeded' }, 403, headers)
}

/** Records what the code under test wanted to wait, so no test actually sleeps. */
function recordingWait(waits) {
  return async (ms) => {
    waits.push(ms)
  }
}

test('a full page followed by a short page yields every repository', async () => {
  const first = Array.from({ length: PER_PAGE }, (_, i) => starEntry(`owner/r${i}`, '2026-01-01T00:00:00Z'))
  const second = [starEntry('owner/last', '2025-12-31T00:00:00Z')]
  const requested = stubPaged([first, second], { onRequest: assertListRequest })

  const repos = await getAllStarredRepos('token')

  assert.equal(repos.length, PER_PAGE + 1, 'no repository may be dropped')
  assert.deepEqual(requested, [1, 2], 'paging stops after the short page')
  assert.equal(repos[0].full_name, 'owner/r0')
  assert.equal(repos.at(-1).full_name, 'owner/last')
})

test('an exactly-full final page still triggers one more request', async () => {
  // The stop condition is "fewer than a page", so a full page cannot be assumed final.
  const full = Array.from({ length: PER_PAGE }, (_, i) => starEntry(`owner/r${i}`))
  const requested = stubPaged([full, []], { onRequest: assertListRequest })

  const repos = await getAllStarredRepos('token')

  assert.equal(repos.length, PER_PAGE)
  assert.deepEqual(requested, [1, 2], 'an empty page terminates the loop')
})

test('a page one short of full is treated as the last page', async () => {
  // The boundary between "keep paging" and "stop" is exactly PER_PAGE - 1, and a fixture
  // of only 100 and 0 leaves everything in between unconstrained.
  const almostFull = Array.from({ length: PER_PAGE - 1 }, (_, i) => starEntry(`owner/r${i}`))
  const requested = stubPaged([almostFull, [starEntry('owner/never-fetched')]])

  const repos = await getAllStarredRepos('token')

  assert.equal(repos.length, PER_PAGE - 1)
  assert.deepEqual(requested, [1], 'a short page ends the listing without another request')
})

test('an empty first page yields an empty library and a single request', async () => {
  const requested = stubPaged([[]], { onRequest: assertListRequest })
  assert.deepEqual(await getAllStarredRepos('token'), [])
  assert.deepEqual(requested, [1])
})

test('the star+json wrapper is unwrapped and starred_at is carried onto the repo', async () => {
  stubPaged([[starEntry('a/b', '2026-02-02T03:04:05Z')]])
  const [repo] = await getAllStarredRepos('token')
  assert.equal(repo.full_name, 'a/b', 'the entry is the repo, not the wrapper')
  assert.equal(repo.starred_at, '2026-02-02T03:04:05Z')
  assert.equal(repo.html_url, 'https://github.com/a/b')
})

test('a plain listing without the wrapper still works', async () => {
  stubPaged([[{ full_name: 'plain/repo', html_url: 'https://github.com/plain/repo' }]])
  const [repo] = await getAllStarredRepos('token')
  assert.equal(repo.full_name, 'plain/repo')
})

test('a rate-limited page is waited out and the same page is retried', async () => {
  const full = Array.from({ length: PER_PAGE }, (_, i) => starEntry(`owner/r${i}`))
  const requested = []
  const waits = []
  let attempts = 0

  globalThis.fetch = async (url) => {
    const page = Number(new URL(String(url)).searchParams.get('page'))
    requested.push(page)
    if (attempts++ === 0)
      return forbidden({ remaining: '0', resetInSeconds: 0 })
    return json(page === 1 ? full : [])
  }

  const repos = await getAllStarredRepos('token', { wait: recordingWait(waits) })

  assert.equal(repos.length, PER_PAGE, 'the retry must recover the page rather than skip it')
  assert.deepEqual(requested, [1, 1, 2], 'the same page is requested again after waiting')
  assert.deepEqual(waits, [MIN_WAIT_MS], 'a reset time in the past floors to the minimum rather than spinning')
})

test('a secondary limit waits for the retry-after the server asked for', async () => {
  const requested = []
  const waits = []
  let attempts = 0

  globalThis.fetch = async (url) => {
    requested.push(Number(new URL(String(url)).searchParams.get('page')))
    // A secondary limit keeps x-ratelimit-remaining high; only retry-after reveals it.
    if (attempts++ === 0)
      return forbidden({ remaining: '42', retryAfter: '7' })
    return json([])
  }

  const repos = await getAllStarredRepos('token', { wait: recordingWait(waits) })

  assert.deepEqual(repos, [])
  assert.deepEqual(requested, [1, 1])
  assert.deepEqual(waits, [7000], 'the header value is an instruction, not just a flag')
})

test('a rate limit with no usable reset time falls back to a longer wait', async () => {
  // A primary limit reports remaining=0 but the reset header can be absent or unusable;
  // the fallback is longer than the floor, so it is worth pinning separately.
  const waits = []
  let attempts = 0
  globalThis.fetch = async () => {
    if (attempts++ === 0)
      return forbidden({ remaining: '0' })
    return json([])
  }

  await getAllStarredRepos('token', { wait: recordingWait(waits) })

  assert.equal(waits.length, 1)
  assert.ok(waits[0] > MIN_WAIT_MS, `without a reset time the wait must be the longer default, got ${waits[0]}`)
})

test('a persistent rate limit gives up after exactly the retry budget', async () => {
  // Every response is a limit, so a naive `while (true)` would follow it indefinitely. The
  // exact count is asserted because an approximate bound cannot tell a budget of three from
  // one that retries forever in practice.
  const waits = []
  globalThis.fetch = async () => forbidden({ remaining: '0', resetInSeconds: 0 })

  await assert.rejects(
    () => getAllStarredRepos('token', { wait: recordingWait(waits) }),
    'an endlessly rate-limited listing must fail rather than hang',
  )
  assert.equal(waits.length, MAX_RATE_LIMIT_RETRIES, `the listing retries ${MAX_RATE_LIMIT_RETRIES} times, saw ${waits.length}`)
})

test('a 429 that survives the transport retries is treated as a rate limit', async () => {
  // ofetch retries some statuses itself; a 429 that still surfaces here is a secondary
  // limit, and it must not be mistaken for a permission error.
  const waits = []
  globalThis.fetch = async () => new Response('slow down', { status: 429 })

  await assert.rejects(() => getAllStarredRepos('token', { wait: recordingWait(waits) }))
  assert.ok(waits.length >= 1, 'the limit must be waited out before giving up')
})

test('a non-rate-limit failure propagates instead of returning a short list', async () => {
  globalThis.fetch = async () => new Response('boom', { status: 500 })
  await assert.rejects(() => getAllStarredRepos('token'), 'a 500 must not be mistaken for an empty library')
})

test('a 403 without rate-limit headers propagates too', async () => {
  // A permission error looks like a rate limit by status code alone; the headers are
  // what distinguish them, and without them the response cannot be trusted.
  globalThis.fetch = async () => forbidden()
  await assert.rejects(() => getAllStarredRepos('token'))
})

test('fetchReadme returns the raw markdown', async () => {
  let request
  globalThis.fetch = async (url, init) => {
    request = { url: new URL(String(url)), init }
    return new Response('# Title\n', { status: 200 })
  }

  assert.equal(await fetchReadme('token', 'a/b'), '# Title\n')
  assert.equal(request.url.pathname, '/repos/a/b/readme')
  assert.equal(request.init.headers.get('accept'), 'application/vnd.github.raw+json', 'the raw media type skips the JSON envelope')
  assert.equal(request.init.headers.get('authorization'), 'Bearer token')
})

test('fetchReadme treats a missing README as null rather than an error', async () => {
  // Most repositories have no README; a 404 here is an expected outcome of the sync.
  globalThis.fetch = async () => json({ message: 'Not Found' }, 404)
  assert.equal(await fetchReadme('token', 'a/b'), null)
})

test('fetchReadme waits out a rate limit and retries', async () => {
  const waits = []
  let attempts = 0
  globalThis.fetch = async () => {
    if (attempts++ === 0)
      return forbidden({ remaining: '0', resetInSeconds: 0 })
    return new Response('# Retried\n', { status: 200 })
  }

  assert.equal(await fetchReadme('token', 'a/b', { wait: recordingWait(waits) }), '# Retried\n')
  assert.equal(attempts, 2, 'the retry replaces the failed attempt')
  assert.deepEqual(waits, [MIN_WAIT_MS])
})

test('fetchReadme throws once the retry budget is spent on a rate limit', async () => {
  // It used to return null here, which the caller could not tell apart from "this repository has no
  // README" — and writing the document for a null is what made the miss permanent.
  const waits = []
  globalThis.fetch = async () => forbidden({ remaining: '0', resetInSeconds: 0 })

  await assert.rejects(
    () => fetchReadme('token', 'a/b', { wait: recordingWait(waits) }),
    /Could not fetch the README for a\/b/,
  )
  assert.equal(waits.length, MAX_RATE_LIMIT_RETRIES, `the fetch retries ${MAX_RATE_LIMIT_RETRIES} times, saw ${waits.length}`)
})

test('fetchReadme throws for any other failure too', async () => {
  globalThis.fetch = async () => new Response('nope', { status: 500 })
  await assert.rejects(() => fetchReadme('token', 'a/b'), /Could not fetch the README for a\/b/)
})

test('only a 404 is the "there is no README" answer', async () => {
  // The single outcome that may be treated as a fact about the repository rather than as a failure
  // of ours: the corpus document is still written, and it is not retried forever.
  globalThis.fetch = async () => json({ message: 'Not Found' }, 404)
  assert.equal(await fetchReadme('token', 'a/b'), null)

  globalThis.fetch = async () => new Response('forbidden', { status: 403 })
  await assert.rejects(() => fetchReadme('token', 'a/b'), 'a permission error is not a missing README')
})

test('mapLimit preserves order and runs no more than the limit concurrently', async () => {
  const items = Array.from({ length: 25 }, (_, i) => i)
  let inFlight = 0
  let peak = 0

  const { results } = await mapLimit(items, 4, async (n) => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise(resolve => setTimeout(resolve, 1))
    inFlight--
    return n * 2
  })

  assert.deepEqual(results, items.map(n => n * 2), 'results stay in input order')
  assert.equal(peak, 4, 'the pool must actually reach its limit, and never exceed it')
})

test('mapLimit reports per-item failures as their own list, without losing the other results', async () => {
  // The failures used to be left inside the results array, where the only caller never looked — a
  // silently incomplete corpus. They now have to be handled by name.
  const { results, failures } = await mapLimit([1, 2, 3], 2, async (n) => {
    if (n === 2)
      throw new Error('boom')
    return n
  })

  assert.equal(results[0], 1)
  assert.equal(results[2], 3, 'a failure must not abandon the remaining items')
  assert.equal(results[1], undefined)
  assert.equal(failures.length, 1)
  assert.equal(failures[0].index, 1, 'the failure carries where it happened')
  assert.equal(failures[0].item, 2, 'and which item it was, so the caller can name it')
  assert.equal(failures[0].error.message, 'boom')
})

test('mapLimit keeps failures in input order however they finish', async () => {
  // The list is reported to a human next to the item names, so it may not depend on which worker
  // happened to fail first.
  const { failures } = await mapLimit([30, 20, 10], 3, async (n) => {
    await new Promise(resolve => setTimeout(resolve, n))
    throw new Error(`failed ${n}`)
  })

  assert.deepEqual(failures.map(f => f.item), [30, 20, 10])
})

test('mapLimit handles an empty list', async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 'never'), { results: [], failures: [] })
})

test('mapLimit processes every item exactly once when the limit exceeds the count', async () => {
  // A worker pool sized by the limit rather than the item count creates idle workers, which
  // is harmless: they take no item. What must hold is that no item is taken twice and none
  // is skipped, which is what the shared cursor is for.
  const seen = []
  const { results } = await mapLimit([1, 2, 3], 10, async (n) => {
    seen.push(n)
    return n
  })

  assert.deepEqual(results, [1, 2, 3])
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3], 'each item is taken exactly once')
})
