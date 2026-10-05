import assert from 'node:assert/strict'
// The REST parameter contract.
//
// Every route used to read its query string with a bare `Number(value)`, so `?limit=abc` reached
// the engine as `NaN` and `?limit=99999` was passed through, while the MCP surface serving the same
// engine rejected both. These tests pin the REST surface to the same ranges as `src/tool-schemas.js`.
import { test } from 'node:test'
import {
  BadRequestError,
  booleanParam,
  corsHeaders,
  enumParam,
  errorResponse,
  intParam,
  jsonResponse,
  okResponse,
  optionalString,
  PayloadTooLargeError,
  readJsonBody,
} from '../src/http.js'

test('an absent or empty integer parameter falls back to the documented default', () => {
  const options = { parameter: 'limit', fallback: 5, min: 1, max: 20 }
  assert.equal(intParam(null, options), 5)
  assert.equal(intParam(undefined, options), 5)
  assert.equal(intParam('', options), 5)
  assert.equal(intParam(' 7 ', options), 7, 'surrounding whitespace comes from the URL, not from a different value')
})

test('a non-numeric or out-of-range integer is rejected instead of becoming NaN', () => {
  const options = { parameter: 'limit', fallback: 5, min: 1, max: 20 }
  for (const bad of ['abc', '1.5', '12abc', 'NaN', '0', '-3', '21', '1e3']) {
    assert.throws(
      () => intParam(bad, options),
      BadRequestError,
      `${JSON.stringify(bad)} must be refused rather than passed to the engine`,
    )
  }
  assert.equal(intParam('20', options), 20, 'the documented maximum is inclusive')
  assert.equal(intParam('1', options), 1, 'the documented minimum is inclusive')
})

test('an enum parameter only accepts the documented values', () => {
  const options = { parameter: 'scope', allowed: ['all', 'starred', 'rankings'], fallback: 'all' }
  assert.equal(enumParam(null, options), 'all')
  assert.equal(enumParam('rankings', options), 'rankings')
  assert.throws(() => enumParam('Rankings', options), BadRequestError, 'values are case-sensitive on purpose')
  assert.throws(() => enumParam('everything', options), BadRequestError)
})

test('the boolean and string readers match what the API documents', () => {
  assert.equal(booleanParam('1'), true)
  assert.equal(booleanParam('true'), true)
  assert.equal(booleanParam('0'), false)
  assert.equal(booleanParam(null), false)
  assert.equal(optionalString(' rust '), 'rust')
  assert.equal(optionalString(''), undefined)
  assert.equal(optionalString(null), undefined)
})

test('responses carry the JSON content type and the CORS headers', async () => {
  const response = jsonResponse({ ok: true, data: { fine: true } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Content-Type'), 'application/json')
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*')
  assert.deepEqual(await response.json(), { ok: true, data: { fine: true } })
  assert.deepEqual(corsHeaders(), {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  })
})

test('every answer uses one envelope, so a client never has to guess the payload shape', async () => {
  // `/api/search` used to return a bare array while `/api/live` returned an object, and a client
  // reading `body.results` off the array saw "no matches" where the server had answered fine.
  const ok = okResponse([1, 2, 3])
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { ok: true, data: [1, 2, 3] })

  const failed = errorResponse('invalid_parameter', 'limit must be a whole number', 400)
  assert.equal(failed.status, 400)
  assert.deepEqual(await failed.json(), {
    ok: false,
    error: 'invalid_parameter',
    message: 'limit must be a whole number',
  })
})

test('meta carries what is true of the payload rather than in it', async () => {
  // Cached community data can be days old while the run timestamp keeps moving, so the freshness
  // travels beside the payload instead of being something the caller has to ask /health about.
  const fresh = await okResponse([1], { meta: { staleLayers: [], oldestFetchAt: null } }).json()
  assert.deepEqual(fresh.meta, { staleLayers: [], oldestFetchAt: null })

  const plain = await okResponse([1]).json()
  assert.equal('meta' in plain, false, 'an endpoint with nothing to say about its payload omits meta')
})

test('a JSON body is read, and a body that is not JSON is refused with the body quoted back', async () => {
  const ok = await readJsonBody(new Request('https://x/api/ingest', {
    method: 'POST',
    body: JSON.stringify({ repo: 'acme/tool', reason: 'why' }),
  }), { limit: 8192 })
  assert.deepEqual(ok, { repo: 'acme/tool', reason: 'why' })

  const broken = new Request('https://x/api/ingest', { method: 'POST', body: '{"repo": ' })
  await assert.rejects(readJsonBody(broken, { limit: 8192 }), (err) => {
    assert.ok(err instanceof BadRequestError)
    assert.equal(err.parameter, 'body')
    assert.match(err.message, /Unexpected end of JSON input/, 'the parse failure must be reported, not swallowed')
    return true
  })
})

test('a declared length over the limit is refused before the body is read', async () => {
  // The cheap check first: a caller claiming a large body should not make the isolate read it.
  const req = new Request('https://x/api/ingest', {
    method: 'POST',
    headers: { 'content-length': String(64 * 1024) },
    body: '{}',
  })
  await assert.rejects(readJsonBody(req, { limit: 8192 }), PayloadTooLargeError)
})

test('a body is measured in bytes, so multi-byte characters cannot slip under the limit', async () => {
  // `Content-Length` is the caller's claim; three-byte characters make a body far larger than its
  // string length, and a limit checked in characters would let it through.
  const body = JSON.stringify({ repo: '中'.repeat(4000) }) // 4000 three-byte characters
  const req = new Request('https://x/api/ingest', { method: 'POST', body })
  assert.ok(body.length < 8192, 'the string length is under the limit')
  await assert.rejects(readJsonBody(req, { limit: 8192 }), PayloadTooLargeError)
})

test('an ingest body that is legitimately sized passes', async () => {
  const body = JSON.stringify({ repo: 'owner/name', reason: 'x'.repeat(500), categories: ['cli-tools'] })
  const parsed = await readJsonBody(new Request('https://x/api/ingest', { method: 'POST', body }), { limit: 8 * 1024 })
  assert.equal(parsed.repo, 'owner/name')
})
