// GitHub API access for the star sync: the paginated star listing, the README fetch and
// the bounded-concurrency map.
//
// Extracted from scripts/index.js, which executes the whole sync at import time and
// therefore cannot be imported by a test. Pagination bugs are the reason this is worth
// testing: a wrong stop condition truncates the library silently, and the caller has no
// way to tell a short list from a complete one.
//
// The token is a parameter rather than module state so a test can drive these against a
// stubbed fetch without touching the environment.
//
// One failure strategy for the whole module: a call that could not complete **throws**, and `null`
// is only ever the answer to "is there a README here?" (404). The README fetch used to answer `null`
// for both, which made "GitHub told us there is nothing" and "we could not ask" the same value at
// the call site — where the wrong one writes an empty corpus document that the incremental plan
// then never revisits.

import { $fetch } from 'ofetch'

const API = 'https://api.github.com'
const PER_PAGE = 100

function headersFor(token) {
  return {
    'authorization': `Bearer ${token}`,
    'user-agent': 'github-stars-mcp',
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Never retry sooner than this, so a stale header cannot spin the loop. */
const MIN_WAIT_MS = 5000
/** Used when a rate limit is signalled without any hint of how long to wait. */
const DEFAULT_WAIT_MS = 60000
/** Give up after this many waits rather than retrying a permanent denial forever. */
const MAX_RATE_LIMIT_RETRIES = 3

/**
 * How long to wait before retrying `err`, or `null` if it is not retryable.
 *
 * Both rate-limit signals are honoured: a primary limit reports
 * `x-ratelimit-remaining: 0` with a reset timestamp, while GitHub's secondary limit often
 * reports only `retry-after` with no reset. A 429 says the same thing without headers.
 * Reading the status code alone would instead retry a real permission error forever.
 */
function retryDelayFor(err) {
  const status = err?.status
  if (status !== 403 && status !== 429)
    return null

  const header = name => err.response?.headers?.get(name)
  const remaining = header('x-ratelimit-remaining')
  const retryAfter = header('retry-after')
  // A 403 that names neither signal is a permission error, not a limit.
  if (status === 403 && remaining !== '0' && !retryAfter)
    return null

  // `retry-after` is in seconds and is a direct instruction, so it takes precedence.
  const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : Number.NaN
  if (Number.isFinite(retryAfterMs))
    return Math.max(retryAfterMs, MIN_WAIT_MS)

  const resetTime = Number(header('x-ratelimit-reset')) * 1000
  return resetTime ? Math.max(resetTime - Date.now(), MIN_WAIT_MS) : DEFAULT_WAIT_MS
}

/**
 * One repository's README.
 *
 * Two outcomes, and the difference is load-bearing:
 *   - `null` — GitHub answered "this repository has no README". An expected outcome of the sync,
 *     and the corpus document is still written, because the frontmatter is worth keeping.
 *   - a throw — the README could not be read (rate limit exhausted, 5xx, timeout). The caller must
 *     NOT write a document in that case: `needsReadmeDownload` skips a file that exists, so an
 *     empty document written now is never repaired — the corpus keeps a README-less entry for a
 *     repository that has one, and nothing anywhere reports it.
 *
 * @param {string} token GitHub token.
 * @param {string} repoFullName `owner/name`.
 * @param {{ wait?: (ms: number) => Promise<void> }} [options] Test seam for the rate-limit wait.
 * @returns {Promise<string|null>} the raw markdown, or `null` when the repository has no README.
 */
export async function fetchReadme(token, repoFullName, { wait = sleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await $fetch(`${API}/repos/${repoFullName}/readme`, {
        headers: {
          ...headersFor(token),
          accept: 'application/vnd.github.raw+json',
        },
        retry: 2,
        retryStatusCodes: [500, 502, 503, 504],
        timeout: 15000,
      })
    }
    catch (err) {
      if (err.status === 404)
        return null

      const delay = retryDelayFor(err)
      // Bounded, so a server that keeps answering 403 cannot loop this forever.
      if (delay !== null && attempt < MAX_RATE_LIMIT_RETRIES) {
        console.warn(`Rate limit reached for ${repoFullName}. Waiting ${Math.ceil(delay / 1000)}s...`)
        await wait(delay)
        continue
      }

      throw new Error(`Could not fetch the README for ${repoFullName}: ${err.message || String(err)}`)
    }
  }
}

/**
 * Every repository the token's owner has starred, newest first as GitHub returns them.
 *
 * `wait` is injectable so a rate-limit test does not actually sleep.
 */
export async function getAllStarredRepos(token, { wait = sleep } = {}) {
  const repos = []
  let attempts = 0
  let page = 1
  while (true) {
    let pageItems
    try {
      pageItems = await $fetch(`${API}/user/starred`, {
        query: { page, per_page: PER_PAGE },
        headers: {
          ...headersFor(token),
          accept: 'application/vnd.github.v3.star+json',
        },
        retry: 3,
        retryDelay: 300,
        timeout: 30000,
      })
    }
    catch (err) {
      // A rate limit is transient, so wait it out and retry the same page. Anything else
      // is a real failure and must not be swallowed into a short list.
      const delay = retryDelayFor(err)
      // Bounded, so a permanently forbidden request cannot loop this forever.
      if (delay !== null && attempts < MAX_RATE_LIMIT_RETRIES) {
        attempts++
        console.warn(`Rate limit reached during starred repos listing. Waiting ${Math.ceil(delay / 1000)}s...`)
        await wait(delay)
        continue
      }
      throw err
    }

    if (!Array.isArray(pageItems))
      throw new Error(`Could not list starred repositories on page ${page}: GitHub returned a non-array response`)
    if (pageItems.length === 0)
      break

    for (const item of pageItems) {
      // The star+json media type wraps each entry; a plain listing does not.
      const repo = item.repo || item
      if (!repo?.full_name || !/^[\w.-]+\/[\w.-]+$/.test(repo.full_name))
        throw new Error(`Could not list starred repositories on page ${page}: invalid repository identity`)
      if (repo.private)
        continue
      repo.starred_at = item.starred_at
      repos.push(repo)
    }

    console.log(`Page ${page}: got ${pageItems.length} repos, total: ${repos.length}`)
    if (pageItems.length < PER_PAGE)
      break
    page++
  }
  return repos
}

/**
 * Runs `worker` over `items` with at most `limit` in flight.
 *
 * Failures are returned rather than thrown — one repository failing must not abandon the other
 * nine hundred — but they are returned as their own list, because they used to be left inside the
 * results array where the only caller never looked at them. A swallowed per-item failure is a
 * silently incomplete corpus.
 *
 * @param {any[]} items
 * @param {number} limit How many workers may run at once.
 * @param {(item: any, index: number) => Promise<any>} worker
 * @returns {Promise<{ results: any[], failures: { index: number, item: any, error: Error }[] }>} the
 *   per-item results in input order, and the failures as their own list.
 */
export async function mapLimit(items, limit, worker) {
  const results = Array.from({ length: items.length })
  const failures = []
  let nextIndex = 0
  let done = 0

  async function runWorker() {
    while (true) {
      const idx = nextIndex++
      if (idx >= items.length)
        return
      const item = items[idx]
      try {
        results[idx] = await worker(item, idx)
      }
      catch (err) {
        results[idx] = undefined
        failures.push({ index: idx, item, error: err instanceof Error ? err : new Error(String(err)) })
      }
      finally {
        done++
        if (done % 25 === 0 || done === items.length)
          console.log(`Sync progress: ${done}/${items.length}`)
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker())
  await Promise.all(workers)
  failures.sort((a, b) => a.index - b.index)
  return { results, failures }
}
