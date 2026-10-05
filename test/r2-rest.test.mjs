import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
// The R2 REST transport.
//
// The rule worth testing is the one that used to be wrong: the target is resolved from the three
// environment variables or refused, never guessed. The previous `R2_BUCKET || 'github-stars'`
// fallback could read from, or write to, a bucket nobody named — and because CI deliberately runs
// without the REST credentials (it uses `aws s3`), "not configured" has to be a clean, quiet answer
// rather than a wrong one.
import { afterEach, test } from 'node:test'
import { putObject, r2Target, readObject } from '../scripts/r2-rest.js'

const VARS = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'CLOUDFLARE_API_TOKEN']
const saved = Object.fromEntries(VARS.map(k => [k, process.env[k]]))
const realFetch = globalThis.fetch
const realWarn = console.warn

afterEach(() => {
  for (const key of VARS) {
    if (saved[key] === undefined)
      delete process.env[key]
    else
      process.env[key] = saved[key]
  }
  globalThis.fetch = realFetch
  console.warn = realWarn
})

function setAll() {
  process.env.R2_ACCOUNT_ID = 'acct'
  process.env.R2_BUCKET = 'the-bucket'
  process.env.CLOUDFLARE_API_TOKEN = 'tok'
}

function captureWarnings() {
  const warnings = []
  console.warn = (...args) => warnings.push(args.join(' '))
  return warnings
}

test('a fully configured environment yields the target it named', () => {
  setAll()
  assert.deepEqual(r2Target('test'), { accountId: 'acct', bucket: 'the-bucket', token: 'tok' })
})

test('a missing variable yields no target, and the warning names what is missing', () => {
  // The alternative — a default bucket name — is how a local run writes into somebody else's bucket.
  for (const missing of VARS) {
    setAll()
    delete process.env[missing]
    const warnings = captureWarnings()

    assert.equal(r2Target('test'), null)
    assert.equal(warnings.length, 1, 'the skip must be reported, not silent')
    assert.match(warnings[0], new RegExp(missing), `the warning must name ${missing}`)
    assert.match(warnings[0], /test:/, 'and the operation that was skipped')
  }
})

test('an unconfigured environment never guesses a bucket', () => {
  for (const key of VARS) delete process.env[key]
  const warnings = captureWarnings()

  assert.equal(r2Target('test'), null)
  assert.equal(warnings[0].includes('github-stars'), false, 'no bucket name may be invented')
})

test('objects are addressed under the account and bucket that were configured', async () => {
  setAll()
  const target = r2Target('test')
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || 'GET', headers: init.headers, body: init.body })
    return new Response('{"success":true}', { status: 200 })
  }

  await putObject(target, 'embeddings.bin', 'application/octet-stream', Buffer.from([1, 2, 3]))

  assert.equal(requests[0].url, 'https://api.cloudflare.com/client/v4/accounts/acct/r2/buckets/the-bucket/objects/embeddings.bin')
  assert.equal(requests[0].method, 'PUT')
  // ofetch normalises the headers it passes on, so read them the way fetch would.
  const headers = new Headers(requests[0].headers)
  assert.equal(headers.get('authorization'), 'Bearer tok')
  assert.equal(headers.get('content-type'), 'application/octet-stream')
})

test('reading an object returns its bytes', async () => {
  setAll()
  globalThis.fetch = async () => new Response(Buffer.from([9, 8, 7]), { status: 200 })
  const data = await readObject(r2Target('test'), 'embeddings.bin')
  assert.ok(Buffer.isBuffer(data))
  assert.deepEqual([...data], [9, 8, 7])
})

test('reading refuses an empty object rather than reporting zero vectors', async () => {
  // An empty binary half parses as "zero vectors" and would look like a consistent pair, which is
  // why it must fail here instead of travelling further.
  setAll()
  globalThis.fetch = async () => new Response(Buffer.alloc(0), { status: 200 })
  await assert.rejects(readObject(r2Target('test'), 'embeddings.bin'), /embeddings\.bin in R2 is empty/)
})

test('a refused read throws, so the caller decides what a missing baseline means', async () => {
  setAll()
  globalThis.fetch = async () => new Response('not found', { status: 404 })
  await assert.rejects(readObject(r2Target('test'), 'embeddings-index.json'), /404/)
})

test('a failed Cloudflare envelope is a write failure even with HTTP 200', async () => {
  setAll()
  globalThis.fetch = async () => Response.json({ success: false, errors: [{ message: 'permission denied' }] })
  await assert.rejects(putObject(r2Target('test'), 'state/ingest-journal/fixture.jsonl', 'application/x-ndjson', 'payload'), /did not acknowledge writing.*permission denied/)
})
