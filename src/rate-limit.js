export class PlatformRateLimitError extends Error {
  constructor(message = 'Rate limiting is configured but currently unavailable.') {
    super(message)
    this.name = 'PlatformRateLimitError'
  }
}

/**
 * Consume one token from an optional Cloudflare Rate Limiting binding.
 *
 * Absence is explicit "disabled" for isolated local tests/development. Once a binding is
 * configured, errors fail closed: an unavailable limiter must not silently turn into unlimited
 * calls to paid embeddings or mutation endpoints.
 */
export async function consumePlatformRateLimit(binding, key) {
  if (!binding)
    return { enabled: false, success: true }

  if (typeof binding.limit !== 'function')
    throw new PlatformRateLimitError('Configured rate-limit binding does not expose limit().')

  try {
    const result = await binding.limit({ key })
    if (!result || typeof result.success !== 'boolean')
      throw new PlatformRateLimitError('Rate-limit binding returned an invalid response.')
    return { enabled: true, success: result.success }
  }
  catch (error) {
    if (error instanceof PlatformRateLimitError)
      throw error
    throw new PlatformRateLimitError(error.message || String(error))
  }
}

export function rateLimitStatus(env) {
  return {
    expensive_requests: Boolean(env?.EXPENSIVE_RATE_LIMITER),
    write_requests: Boolean(env?.WRITE_RATE_LIMITER),
    locality: 'cloudflare_location',
  }
}
