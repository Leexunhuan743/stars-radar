// Retrying an operation that talks to somebody else's service.
//
// The repository had five separate retry loops — the Worker's embedding call, its two GitHub search
// calls, the pipeline's embedding call, and `scripts/github_stars.js`'s rate-limit retries — each
// with its own attempt count, its own delay, and its own idea of what counts as retryable. That
// made two questions unanswerable without reading all five: does a 500 from the provider get
// retried everywhere, and does anything retry a 404 forever?
//
// This module owns the shape; callers own the policy through `shouldRetry` and `onGiveUp`.
//
// Not retried here on purpose: `src/document-cache.js`'s R2 reads. Their retry is "the next
// request", which is a different mechanism (and a different failure semantic) rather than a loop.

/** Delays double per attempt, capped, which is what a rate-limited provider expects. */
export function backoffDelay(attempt, { baseMs = 250, maxMs = 4000 } = {}) {
  return Math.min(baseMs * 2 ** (attempt - 1), maxMs)
}

/**
 * Calls `operation` until it succeeds, up to `attempts` times.
 *
 * @param {(attempt: number) => Promise<unknown>} operation
 * @param {object} options
 * @param {number} options.attempts Total attempts, including the first.
 * @param {number} [options.baseMs] First backoff delay.
 * @param {number} [options.maxMs] Backoff ceiling.
 * @param {(error: unknown, attempt: number) => boolean} [options.shouldRetry] Decides whether a
 *   thrown error is worth another attempt. Defaults to retrying everything, which is only correct
 *   for idempotent reads.
 * @param {(context: { attempt: number, error?: unknown, delayMs: number }) => void} [options.onRetry]
 * @param {(error: unknown) => void} [options.onGiveUp]
 * @param {() => Promise<void>} [options.sleep] Injectable for tests.
 * @returns {Promise<unknown>} the first successful result, or whatever the last attempt returned.
 */
export async function retryAsync(operation, {
  attempts,
  baseMs = 250,
  maxMs = 4000,
  shouldRetry = () => true,
  onRetry,
  onGiveUp,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1)
    throw new Error(`retryAsync needs a positive attempt count, got ${JSON.stringify(attempts)}`)

  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation(attempt)
    }
    catch (error) {
      lastError = error
      if (attempt === attempts || !shouldRetry(error, attempt)) {
        onGiveUp?.(error)
        throw error
      }
      const delayMs = backoffDelay(attempt, { baseMs, maxMs })
      onRetry?.({ attempt, error, delayMs })
      await sleep(delayMs)
    }
  }
  // Unreachable: the loop either returns or throws.
  throw lastError
}

/**
 * Calls `operation` until `isAcceptable` says the result is usable, treating an unacceptable result
 * like a failure.
 *
 * Providers answer 200 with an unusable body more often than they answer 500 — a rate limit page, an
 * HTML error behind a proxy, an empty `data` array — so "the request succeeded" and "we got an
 * answer" are separate questions.
 *
 * @param {(attempt: number) => Promise<unknown>} operation
 * @param {(result: unknown) => boolean} isAcceptable
 * @param {object} options As {@link retryAsync}, plus:
 * @param {(result: unknown, attempt: number) => boolean} [options.shouldRetryResult] Extra filter
 *   for results that are unacceptable but not worth retrying.
 */
export async function retryUntilAcceptable(operation, isAcceptable, options = {}) {
  const { shouldRetryResult = () => true } = options
  try {
    return await retryAsync(async (attempt) => {
      const result = await operation(attempt)
      if (!isAcceptable(result) && !shouldRetryResult(result, attempt))
        throw Object.assign(new Error('Unacceptable result, and not worth retrying'), { unacceptable: true, result })
      if (!isAcceptable(result))
        throw Object.assign(new Error('Unacceptable result'), { unacceptable: true, result })
      return result
    }, options)
  }
  catch (error) {
    // An unacceptable result is returned rather than thrown: the caller usually wants to answer with
    // whatever the provider said, not with an exception about its shape.
    if (error?.unacceptable)
      return error.result
    throw error
  }
}
