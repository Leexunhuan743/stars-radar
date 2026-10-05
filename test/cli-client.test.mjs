import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
// The two Python clients, run for real.
//
// They are the user-facing surface — a reader follows the README, sets WORKER_URL and MCP_API_KEY,
// and runs one of these — and until now nothing executed them: the only test read their source text.
// A source scan cannot see the defect this file exists to pin down, because the defect is a
// *behaviour*: a failed request printed "[Stars Radar] … failed: …" on stderr **and**
// "No repositories found" on stdout, then exited 0. A rate-limited lookup therefore looked exactly
// like an honest empty result to everything except a human reading both streams.
//
// The stub is a real HTTP server on a loopback port, so the request the client sends is asserted
// too: path, query parameters, and the bearer header.
import { before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'scripts', 'search_stars_cli.py')
const AUDIT = path.join(ROOT, 'scripts', 'audit_cf_deployment.py')

/** The interpreter that will run them, or null when this machine has none. */
function findPython() {
  for (const candidate of ['python', 'python3']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (!probe.error && probe.status === 0)
      return candidate
  }
  return null
}

const PYTHON = findPython()

/** A stub Worker: every request is recorded, and the reply comes from `handler`. */
async function withStubServer(handler, run) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body }
      requests.push(record)
      handler(record, res)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  try {
    return await run(`http://127.0.0.1:${port}`, requests)
  }
  finally {
    await new Promise(resolve => server.close(resolve))
  }
}

function runClient(script, args, baseUrl) {
  // Asynchronous on purpose: `spawnSync` blocks this process's event loop, and the stub Worker runs
  // in it — a synchronous child would wait for an answer nobody could send until it had exited.
  return new Promise((resolve) => {
    const child = spawn(PYTHON, [script, ...args], {
      env: { ...process.env, WORKER_URL: baseUrl, MCP_API_KEY: 'test-key', PYTHONIOENCODING: 'utf-8' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => stdout += chunk)
    child.stderr.on('data', chunk => stderr += chunk)
    child.on('error', error => resolve({ status: null, stdout, stderr, error }))
    child.on('close', status => resolve({ status, stdout, stderr }))
  })
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

before(() => {
  if (!PYTHON)
    console.warn('[cli-client] No Python interpreter found; the client tests will be skipped.')
})

test('help and local harvest validation do not require Worker credentials', { skip: !PYTHON }, () => {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8' }
  delete env.WORKER_URL
  delete env.MCP_API_KEY
  const help = spawnSync(PYTHON, [CLI, '--help'], { env, encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.ok(help.stdout.includes('--harvest'))
  const harvest = spawnSync(PYTHON, [CLI, '--harvest', '--limit', '0'], { env, encoding: 'utf8' })
  assert.equal(harvest.status, 1)
  assert.ok(harvest.stderr.includes('Harvest limit'))
  assert.equal(harvest.stderr.includes('WORKER_URL environment variable is required'), false)
  const api = spawnSync(PYTHON, [CLI, 'terminal'], { env, encoding: 'utf8' })
  assert.equal(api.status, 2)
  assert.ok(api.stderr.includes('WORKER_URL environment variable is required'))
})

test('the search CLI sends the request it documents and prints what came back', { skip: !PYTHON }, async () => {
  await withStubServer((_, res) => json(res, 200, {
    ok: true,
    data: [{ repo: 'acme/tool', stars: 1234, source_badge: '⭐ Starred', reason: 'why', url: 'https://github.com/acme/tool' }],
  }), async (baseUrl, requests) => {
    const { status, stdout, stderr } = await runClient(CLI, ['vector database', '--scope', 'starred', '--limit', '5'], baseUrl)

    assert.equal(status, 0, `a successful search must exit 0; stderr was: ${stderr}`)
    assert.match(stdout, /acme\/tool/)
    assert.match(stdout, /1,234/, 'star counts are formatted for reading')

    assert.equal(requests.length, 1)
    const url = new URL(requests[0].url, baseUrl)
    assert.equal(url.pathname, '/api/search')
    assert.equal(url.searchParams.get('q'), 'vector database')
    assert.equal(url.searchParams.get('scope'), 'starred')
    assert.equal(url.searchParams.get('limit'), '5')
    assert.equal(requests[0].headers.authorization, 'Bearer test-key', 'the key travels in the header, not the query string')
  })
})

test('an empty result says so and still exits 0', { skip: !PYTHON }, async () => {
  // The one case where "found nothing" is the truth, and the only case allowed to say it.
  await withStubServer((_, res) => json(res, 200, { ok: true, data: [] }), async (baseUrl) => {
    const { status, stdout } = await runClient(CLI, ['nothing matches this'], baseUrl)
    assert.equal(status, 0)
    assert.match(stdout, /No repositories found/)
  })
})

test('a failed lookup is reported once, on stderr, and never as an empty result', { skip: !PYTHON }, async () => {
  // This is the defect: the failure envelope used to be unwrapped into `None`, which the caller then
  // printed as "No repositories found" — on stdout, with exit code 0.
  await withStubServer((_, res) => json(res, 503, {
    ok: false,
    error: 'data_unavailable',
    message: 'the asset index could not be read',
  }), async (baseUrl) => {
    const { status, stdout, stderr } = await runClient(CLI, ['vector database'], baseUrl)

    assert.equal(status, 1, 'a failed lookup must not look like a successful run')
    assert.match(stderr, /data_unavailable/)
    assert.match(stderr, /the asset index could not be read/)
    assert.doesNotMatch(stdout, /No repositories found/, 'stdout must not claim an empty result for a failure')
  })
})

test('a failure envelope delivered with HTTP 200 is still a failure', { skip: !PYTHON }, async () => {
  // The envelope is the contract, not the status code: a proxy or an older deployment can answer 200
  // with `ok: false`, and the client must not read that as data.
  await withStubServer((_, res) => json(res, 200, {
    ok: false,
    error: 'invalid_parameter',
    message: 'limit must be a whole number',
  }), async (baseUrl) => {
    const { status, stdout, stderr } = await runClient(CLI, ['vector database'], baseUrl)
    assert.equal(status, 1)
    assert.match(stderr, /invalid_parameter/)
    assert.doesNotMatch(stdout, /No repositories found/)
  })
})

test('the deployment audit fails the run when a check fails', { skip: !PYTHON }, async () => {
  // It used to print ❌ lines and exit 0, which makes it a report rather than a gate: nothing running
  // it could tell a verified deployment from a broken one.
  await withStubServer((req, res) => {
    if (!req.headers.authorization)
      return json(res, 401, { ok: false, error: 'unauthorized', message: 'missing key' })
    return json(res, 503, { ok: false, error: 'data_unavailable', message: 'the asset index could not be read' })
  }, async (baseUrl) => {
    const { status, stdout } = await runClient(AUDIT, [], baseUrl)
    assert.equal(status, 1, 'a failed health check must fail the run')
    assert.match(stdout, /checks FAILED|❌/, 'and must say what failed')
  })
})

test('the deployment audit exits 0 when every check passes', { skip: !PYTHON }, async () => {
  // The other half of the same contract: a passing deployment must be distinguishable.
  const tools = [{ name: 'search_github_stars' }, { name: 'get_radar_status' }]
  await withStubServer((req, res) => {
    if (!req.headers.authorization)
      return json(res, 401, { ok: false, error: 'unauthorized', message: 'missing key' })
    if (req.url === '/health')
      return json(res, 200, { ok: true, data: { status: 'ok', totalStarred: 3, vectorModel: 'bge-m3', vectorDimensions: 1024, dataPlane: {} } })
    // The MCP surface answers as a JSON-RPC event stream.
    const body = JSON.parse(req.body || '{}')
    if (body.method === 'tools/list')
      return res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools } })}\n\n`)

    const args = body.params?.arguments || {}
    const payload = args.query !== undefined
      ? []
      : args.category !== undefined
        ? { repos: [] }
        : args.limit !== undefined
          ? { result: { top_skills: [] } }
          : { total_starred: 3 }
    return res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } })}\n\n`)
  }, async (baseUrl) => {
    const { status, stdout } = await runClient(AUDIT, [], baseUrl)
    assert.equal(status, 0, `a verified deployment must exit 0; stdout was: ${stdout}`)
    assert.match(stdout, /acceptance checks passed/)
  })
})
