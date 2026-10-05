export class ProbeRequestError extends Error {
  constructor(code, message, status = 502, retryAfterSeconds) {
    super(message)
    this.name = 'ProbeRequestError'
    this.code = code
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export function githubFailure(response, operation, now = Date.now()) {
  const retry = response.headers.get('retry-after')
  const limited = response.status === 429 || (response.status === 403 && (retry !== null || response.headers.get('x-ratelimit-remaining') === '0'))
  if (limited) {
    const reset = response.headers.get('x-ratelimit-reset')
    const seconds = retry !== null ? Number(retry) : reset !== null ? Math.ceil(Number(reset) - now / 1000) : null
    const wait = Number.isFinite(seconds) && seconds !== null ? Math.max(1, seconds) : undefined
    return new ProbeRequestError('rate_limited', `${operation}: GitHub rate limit reached${wait ? `; retry after ${wait}s` : ''}.`, 503, wait)
  }
  return new ProbeRequestError(
    response.status === 422 ? 'invalid_query' : response.status === 401 || response.status === 403 ? 'upstream_forbidden' : 'upstream_failed',
    `${operation}: GitHub returned HTTP ${response.status}.`,
    response.status === 422 ? 400 : 502,
  )
}

export async function requestProbe(url, options, fetcher, operation) {
  try {
    return await fetcher(url, options)
  }
  catch (error) {
    throw new ProbeRequestError('upstream_unavailable', `${operation}: ${error.message || String(error)}`)
  }
}

export async function readGithubSearch(response, operation) {
  if (!response.ok)
    throw githubFailure(response, operation)
  let data
  try {
    data = await response.json()
  }
  catch (error) {
    throw new ProbeRequestError('invalid_upstream_response', `${operation}: GitHub returned invalid JSON (${error.message}).`)
  }
  if (!Array.isArray(data?.items) || !Number.isFinite(data.total_count))
    throw new ProbeRequestError('invalid_upstream_response', `${operation}: GitHub search response is missing items or total_count.`)
  return data
}

export function probeToolFailure(error) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({
      error: error.code,
      message: error.message,
      ...(error.retryAfterSeconds !== undefined ? { retry_after_seconds: error.retryAfterSeconds } : {}),
    }) }],
  }
}
