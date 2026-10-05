import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { resetDocumentCaches } from '../src/documents.js'
import { errorResponse } from '../src/http.js'
import { searchGithubCode, searchGithubLive, searchWebTech } from '../src/live-probes.js'
import { githubFailure, ProbeRequestError, probeToolFailure } from '../src/probe-errors.js'

beforeEach(resetDocumentCaches)

function environment({ put = async () => {}, catalog = { repos: {} } } = {}) {
  return { R2: {
    get: async key => key === 'catalog.json' ? { json: async () => catalog } : null,
    list: async () => ({ objects: [], truncated: false }),
    put,
  } }
}

test('a successful empty repository search stays distinct from a failed request', async () => {
  const result = await searchGithubLive(environment(), { query: 'terminal' }, {
    fetcher: async () => Response.json({ items: [], total_count: 0 }),
  })
  assert.deepEqual(result.repos, [])
  assert.equal(result.total_found, 0)
  assert.equal(result.returned, 0)
})

test('a successful repository search builds qualifiers and keeps curated metadata', async () => {
  const result = await searchGithubLive(environment({ catalog: { repos: { 'acme/tool': { categories: ['research'], reason: 'saved for offline use' } } } }), {
    query: 'terminal language:rust',
    language: 'rust',
    limit: 2,
  }, {
    fetcher: async (url) => {
      const query = new URL(url).searchParams
      assert.equal((query.get('q').match(/language:/g) || []).length, 1)
      assert.equal(query.get('per_page'), '2')
      return Response.json({ total_count: 1, items: [{ full_name: 'acme/tool', stargazers_count: 12 }] })
    },
  })
  assert.equal(result.repos[0].source, 'starred')
  assert.equal(result.repos[0].user_reason, 'saved for offline use')
})

test('GitHub failures propagate for both repository and code probes', async () => {
  for (const probe of [searchGithubLive, searchGithubCode]) {
    for (const status of [401, 403, 429, 500, 503]) {
      await assert.rejects(probe(environment(), { query: 'terminal' }, {
        fetcher: async () => new Response(null, { status }),
      }), error => error instanceof ProbeRequestError && error.code === (status === 429 ? 'rate_limited' : status === 401 || status === 403 ? 'upstream_forbidden' : 'upstream_failed'))
    }
  }
})

test('network and malformed JSON failures are never successful empty searches', async () => {
  for (const probe of [searchGithubLive, searchGithubCode]) {
    await assert.rejects(probe(environment(), { query: 'terminal' }, {
      fetcher: async () => { throw new Error('offline') },
    }), /search: offline/)
    for (const body of ['not json', '{}', '{"items":[],"total_count":"zero"}']) {
      await assert.rejects(probe(environment(), { query: 'terminal' }, {
        fetcher: async () => new Response(body),
      }), error => error.code === 'invalid_upstream_response')
    }
  }
})

test('permission errors and rate limits have different status, and retry instructions survive both protocols', async () => {
  const error = githubFailure(new Response(null, { status: 403, headers: { 'Retry-After': '17' } }), 'GitHub code search')
  assert.equal(error.status, 503)
  assert.equal(error.retryAfterSeconds, 17)
  const rest = errorResponse(error.code, error.message, error.status, { retryAfterSeconds: error.retryAfterSeconds })
  assert.equal(rest.status, 503)
  assert.equal(rest.headers.get('Retry-After'), '17')
  assert.equal((await rest.json()).retry_after_seconds, 17)
  const mcp = probeToolFailure(error)
  assert.equal(mcp.isError, true)
  assert.equal(JSON.parse(mcp.content[0].text).retry_after_seconds, 17)
  assert.equal(githubFailure(new Response(null, { status: 403 }), 'code').code, 'upstream_forbidden')
})

test('rate-limit reset timestamps are relative and unknown waits remain unknown', () => {
  const response = new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '120' } })
  assert.equal(githubFailure(response, 'code', 100000).retryAfterSeconds, 20)
  assert.equal(githubFailure(new Response(null, { status: 429 }), 'code').retryAfterSeconds, undefined)
})

test('invalid search inputs fail without outbound calls or capture writes', async () => {
  const fetcher = () => {
    throw new Error('Outbound call forbidden')
  }
  await assert.rejects(searchGithubCode({}, { query: '  ' }, { fetcher }), error => error.status === 400)
  await assert.rejects(searchWebTech({}, { query: '  ' }, { fetcher }), error => error.status === 400)
  await assert.rejects(searchGithubLive(environment(), { since: 'bad-date' }, { fetcher }), RangeError)
})

test('a code result keeps its snippet, file location and total count', async () => {
  const result = await searchGithubCode({}, { query: 'registerTool', repo: 'acme/tool' }, {
    fetcher: async (url) => {
      assert.ok(new URL(url).searchParams.get('q').includes('repo:acme/tool'))
      return Response.json({ total_count: 50, incomplete_results: true, items: [{ repository: { full_name: 'acme/tool' }, path: 'src/main.js', html_url: 'https://github.com/acme/tool/blob/main/src/main.js', text_matches: [{ fragment: 'server.registerTool()' }] }] })
    },
  })
  assert.equal(result.total_found, 50)
  assert.equal(result.incomplete_results, true)
  assert.equal(result.matches[0].path, 'src/main.js')
  assert.ok(result.matches[0].snippet.includes('server.registerTool()'))
})

test('failed repository probes never append a capture, and capture errors are explicit partial outcomes', async () => {
  let writes = 0
  const env = environment({ put: async () => {
    writes++
    throw new Error('R2 offline')
  } })
  await assert.rejects(searchGithubLive(env, { query: 'terminal', persist: true }, {
    fetcher: async () => new Response(null, { status: 503 }),
  }), ProbeRequestError)
  assert.equal(writes, 0)
  const result = await searchGithubLive(env, { query: 'terminal', persist: true }, {
    fetcher: async () => Response.json({ total_count: 1, items: [{ full_name: 'acme/tool', stargazers_count: 100, description: 'terminal tool' }] }),
  })
  assert.equal(writes, 1)
  assert.equal(result.returned, 1)
  assert.equal(result.capture.captured, 0)
  assert.equal(result.capture.capture_error, 'R2 offline')
})

test('an explicit empty web API result is successful and does not run another provider', async () => {
  let calls = 0
  const result = await searchWebTech({ BRAVE_SEARCH_API_KEY: 'fixture' }, { query: 'niche api' }, {
    fetcher: async () => {
      calls++
      return Response.json({ web: { results: [] } })
    },
  })
  assert.equal(result.count, 0)
  assert.equal(result.provider, 'brave_search')
  assert.equal(calls, 1)
})

test('web search falls back after an upstream failure and returns the successful provider', async () => {
  const result = await searchWebTech({ BRAVE_SEARCH_API_KEY: 'fixture', TAVILY_API_KEY: 'fixture' }, { query: 'mcp docs' }, {
    fetcher: async url => url.includes('brave.com')
      ? new Response(null, { status: 503 })
      : Response.json({ results: [{ title: 'MCP', url: 'https://example.com/mcp', content: 'Protocol guide' }] }),
  })
  assert.equal(result.provider, 'tavily_search')
  assert.equal(result.results[0].title, 'MCP')
})

test('a valid Brave response with a nullable web section is an empty search', async () => {
  const result = await searchWebTech({ BRAVE_SEARCH_API_KEY: 'fixture' }, { query: 'niche api' }, {
    fetcher: async () => Response.json({ type: 'search', query: { original: 'niche api' }, web: null }),
  })
  assert.equal(result.provider, 'brave_search')
  assert.equal(result.count, 0)
})

test('web provider errors and a keyless challenge page produce a visible failure', async () => {
  await assert.rejects(searchWebTech({ BRAVE_SEARCH_API_KEY: 'fixture', TAVILY_API_KEY: 'fixture' }, { query: 'mcp docs' }, {
    fetcher: async url => url.includes('duckduckgo') ? new Response('<html>Please complete the challenge</html>') : Response.json({ error: 'quota' }),
  }), error => error.code === 'search_unavailable' && error.status === 503)
})

test('keyless HTML distinguishes explicit no-results from an unparseable response', async () => {
  const result = await searchWebTech({}, { query: 'mcp docs', freshness: 'week' }, {
    fetcher: async () => new Response('<div class="no-results">No results found</div>'),
  })
  assert.equal(result.count, 0)
  assert.equal(result.provider, 'duckduckgo_html (keyless)')
  assert.equal(result.freshness_applied, false)
})

test('Tavily receives the requested time window instead of silently dropping freshness', async () => {
  const result = await searchWebTech({ TAVILY_API_KEY: 'fixture' }, { query: 'mcp docs', freshness: 'week' }, {
    fetcher: async (url, options) => {
      assert.equal(url, 'https://api.tavily.com/search')
      assert.equal(JSON.parse(options.body).time_range, 'week')
      return Response.json({ results: [] })
    },
  })
  assert.equal(result.freshness_applied, true)
})
