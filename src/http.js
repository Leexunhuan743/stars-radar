// HTTP plumbing shared by every route: CORS, JSON responses, and the parameter contract.
//
// Why this is its own module: the Worker entry (`src/index.js`) imports `agents/mcp`, which
// resolves a `cloudflare:` scheme that plain Node cannot load, so nothing defined there can be
// tested. Every route used to parse its own query string with a bare `Number(value)`, which meant
// `?limit=abc` reached the search engine as `NaN` and `?limit=99999` was passed straight through —
// while the MCP surface, serving the same engine, enforced `min(1).max(...)` with zod. The two
// surfaces therefore disagreed about what a valid request is, and only one of them was checkable.
//
// The ranges below mirror the zod schemas in `src/tool-schemas.js`; that file remains the tool
// contract, and this one exists so the REST surface cannot drift from it silently.

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

/** Thrown for a request the caller can fix; routes translate it into a 400. */
export class BadRequestError extends Error {
  constructor(parameter, value, expectation) {
    super(`Invalid value for "${parameter}": ${JSON.stringify(value)}. Expected ${expectation}.`)
    this.name = 'BadRequestError'
    this.parameter = parameter
    this.value = value
  }
}

/** Thrown for a body larger than the route accepts; routes translate it into a 413. */
export class PayloadTooLargeError extends Error {
  constructor(limit) {
    super(`Request body is larger than the ${limit} bytes this endpoint accepts.`)
    this.name = 'PayloadTooLargeError'
    this.limit = limit
  }
}

/**
 * Reads a JSON request body, refusing one that is too large.
 *
 * `await req.json()` on its own reads whatever the caller sent: the ingest endpoint takes three
 * short strings, so a body of any size is either a mistake or an attempt to make the isolate spend
 * its budget on parsing. The declared length is checked first because it is free, and the body is
 * measured again after reading because `Content-Length` is the caller's claim rather than a fact.
 *
 * @param {Request} req
 * @param {{ limit: number }} options
 * @returns {Promise<object>} the parsed body.
 */
export async function readJsonBody(req, { limit }) {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit)
    throw new PayloadTooLargeError(limit)

  const text = await req.text()
  // Measured in bytes, not characters: a body of multi-byte characters is larger than its length.
  if (new TextEncoder().encode(text).length > limit)
    throw new PayloadTooLargeError(limit)

  try {
    return JSON.parse(text)
  }
  catch (e) {
    throw new BadRequestError('body', text.slice(0, 80), `valid JSON (${e.message})`)
  }
}

export function corsHeaders() {
  return { ...CORS_HEADERS }
}

/** The low-level builder; routes go through {@link okResponse} so the envelope is not optional. */
export function jsonResponse(body, { status = 200, pretty = false } = {}) {
  return new Response(JSON.stringify(body, null, pretty ? 2 : undefined), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  })
}

/**
 * A successful response.
 *
 * Every endpoint answers with the same two fields — `ok` and `data` — because the payload shape
 * used to depend on the endpoint: `/api/search` returned a bare array while `/api/live` returned an
 * object, so a caller had to know which was which and a client that guessed wrong saw "no results"
 * instead of an error. `/api/search` returning an array with no top-level field for its own count
 * or freshness had the same problem in the other direction.
 *
 * `meta` carries what is true of the payload rather than in it — currently the freshness of the
 * cached community data, so a caller can tell "not updated since Tuesday" from "updated a minute
 * ago" without reading `/health` first.
 */
export function okResponse(data, { pretty = false, meta } = {}) {
  return jsonResponse(meta ? { ok: true, data, meta } : { ok: true, data }, { pretty })
}

/** A failed response: same envelope, `ok: false`, and the reason. */
export function errorResponse(error, message, status, { retryAfterSeconds } = {}) {
  const response = jsonResponse({
    ok: false,
    error,
    message,
    ...(retryAfterSeconds !== undefined ? { retry_after_seconds: retryAfterSeconds } : {}),
  }, { status })
  if (retryAfterSeconds !== undefined)
    response.headers.set('Retry-After', String(retryAfterSeconds))
  return response
}

/**
 * Reads an integer query parameter, rejecting anything the MCP schema would reject.
 *
 * @param {string|null} raw
 * @param {{ parameter: string, fallback: number, min?: number, max?: number }} options
 */
export function intParam(raw, { parameter, fallback, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY }) {
  if (raw === null || raw === undefined || raw === '')
    return fallback
  // `Number('')` is 0 and `Number('12abc')` is NaN: neither is an integer the caller meant, and
  // silently accepting them is how a bad request becomes a wrong answer.
  if (!/^-?\d+$/.test(String(raw).trim()))
    throw new BadRequestError(parameter, raw, 'a whole number')
  const value = Number(raw)
  if (value < min || value > max) {
    const range = Number.isFinite(min) && Number.isFinite(max)
      ? `a whole number between ${min} and ${max}`
      : (Number.isFinite(min) ? `a whole number >= ${min}` : `a whole number <= ${max}`)
    throw new BadRequestError(parameter, raw, range)
  }
  return value
}

/** Reads an enum query parameter. */
export function enumParam(raw, { parameter, allowed, fallback }) {
  if (raw === null || raw === undefined || raw === '')
    return fallback
  if (!allowed.includes(raw))
    throw new BadRequestError(parameter, raw, `one of ${allowed.map(value => `"${value}"`).join(', ')}`)
  return raw
}

/** Reads a boolean query parameter in the two spellings the API documents (`1`/`true`). */
export function booleanParam(raw) {
  return raw === '1' || raw === 'true'
}

/** Reads an optional string parameter, treating an empty value as absent. */
export function optionalString(raw, { parameter = 'value', maxLength = Number.POSITIVE_INFINITY } = {}) {
  if (raw === null || raw === undefined)
    return undefined
  const trimmed = raw.trim()
  if (trimmed === '')
    return undefined
  if (trimmed.length > maxLength)
    throw new BadRequestError(parameter, trimmed.slice(0, 80), `a string no longer than ${maxLength} characters`)
  return trimmed
}

/** Reads a string parameter with explicit length bounds, preserving empty-string semantics when allowed. */
export function stringParam(raw, { parameter, fallback = '', minLength = 0, maxLength = Number.POSITIVE_INFINITY } = {}) {
  if (raw === null || raw === undefined)
    return fallback
  const value = String(raw).trim()
  if (value.length < minLength || value.length > maxLength) {
    const range = Number.isFinite(maxLength)
      ? `a string between ${minLength} and ${maxLength} characters`
      : `a string at least ${minLength} characters long`
    throw new BadRequestError(parameter, value.slice(0, 80), range)
  }
  return value
}
