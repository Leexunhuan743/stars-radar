import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { ACTIVE_GENERATION_KEY, createGenerationPointer, generationKey } from '../src/data-generation.js'
import { resetDocumentCaches } from '../src/documents.js'
import { errorResponse } from '../src/http.js'
import { captureGithubDiscovery, searchGithubCode, searchGithubLive, searchWebTech } from '../src/live-probes.js'
import { githubFailure, ProbeRequestError, probeToolFailure } from '../src/probe-errors.js'

beforeEach(resetDocumentCaches)

const GENERATION_ID = '20261005T083000Z-ceaa138fd814-5151'
const POINTER = createGenerationPointer(
  GENERATION_ID,
  'ceaa138fd814f70ff2a194cf050a789e7e77cf95',
  '2026-10-05T08:30:00.000Z',
)

function environment({ put = async () => {}, catalog = { repos: {} } } = {}) {
  return { R2: {
    get: async (key) => {
      if (key === ACTIVE_GENERATION_KEY)
        return { json: async () => POINTER }
      if (key === generationKey(GENERATION_ID, 'catalog.json'))
        return { json: async () => catalog }
      return null
    },
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

test('live repository search never writes capture state', async () => {
  let writes = 0
  const env = environment({
    put: async () => {
      writes++
    },
  })
  const result = await searchGithubLive(env, { query: 'terminal' }, {
    fetcher: async () => Response.json({ total_count: 1, items: [{ full_name: 'acme/tool', stargazers_count: 100, description: 'terminal tool' }] }),
  })

  assert.equal(result.returned, 1)
  assert.equal(writes, 0)
  assert.equal('capture' in result, false)
})

test('explicit discovery capture re-fetches GitHub metadata before writing', async () => {
  const writes = []
  const env = environment({
    put: async (key, body) => {
      writes.push({ key, body })
    },
  })
  env.GITHUB_TOKEN = 'fixture-token'

  const result = await captureGithubDiscovery(env, { repo: 'acme/tool', query: 'terminal mcp' }, {
    fetcher: async (url, options) => {
      assert.equal(url, 'https://api.github.com/repos/acme/tool')
      assert.equal(options.headers.Authorization, 'Bearer fixture-token')
      return Response.json({
        full_name: 'acme/tool',
        html_url: 'https://github.com/acme/tool',
        stargazers_count: 120,
        description: 'terminal tool',
        language: 'Rust',
        topics: ['terminal'],
        created_at: '2026-01-01T00:00:00Z',
        pushed_at: '2026-10-01T00:00:00Z',
      })
    },
  })

  assert.equal(result.captured, 1)
  assert.equal(result.repo, 'acme/tool')
  assert.equal(writes.length, 1)
  assert.match(writes[0].key, /^state\/probe-captures\//)
  const stored = JSON.parse(writes[0].body.trim())
  assert.equal(stored.repo, 'acme/tool')
  assert.equal(stored.stars, 120)
  assert.equal(stored.query, 'terminal mcp')
})

test('capture rejects weak or invalid discoveries and reports write failures', async () => {
  await assert.rejects(
    captureGithubDiscovery(environment(), { repo: 'not-a-repo', query: 'terminal' }),
    error => error instanceof ProbeRequestError && error.code === 'invalid_repo' && error.status === 400,
  )
  await assert.rejects(
    captureGithubDiscovery(environment(), { repo: 'acme/tool', query: '' }),
    error => error instanceof ProbeRequestError && error.code === 'invalid_query' && error.status === 400,
  )

  let writes = 0
  const weak = await captureGithubDiscovery(environment({
    put: async () => {
      writes++
    },
  }), { repo: 'acme/tool', query: 'terminal' }, {
    fetcher: async () => Response.json({ full_name: 'acme/tool', stargazers_count: 12, description: 'small tool' }),
  })
  assert.equal(weak.captured, 0)
  assert.equal(writes, 0)

  await assert.rejects(
    captureGithubDiscovery(environment({
      put: async () => {
        throw new Error('R2 offline')
      },
    }), { repo: 'acme/tool', query: 'terminal' }, {
      fetcher: async () => Response.json({ full_name: 'acme/tool', stargazers_count: 100, description: 'terminal tool' }),
    }),
    error => error instanceof ProbeRequestError && error.code === 'capture_failed' && error.status === 503,
  )
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

test('web search falls back to the keyless Exa MCP tier when no provider is configured', async () => {
  const urls = []
  const result = await searchWebTech({}, { query: 'mcp docs' }, {
    fetcher: async (url, options) => {
      urls.push(String(url))
      const body = JSON.parse(options.body)
      if (body.method === 'initialize')
        return new Response('data: {}\n\n', { status: 200, headers: { 'mcp-session-id': 'fixture-session' } })
      if (body.method === 'notifications/initialized')
        return new Response('', { status: 200 })
      return new Response(
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'Title: MCP spec\\nURL: https://modelcontextprotocol.io/spec\\n\\nBody text.' }] } })}\n\n`,
        { status: 200 },
      )
    },
  })
  assert.equal(result.provider, 'exa_search')
  assert.equal(result.freshness_applied, false)
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].url, 'https://modelcontextprotocol.io/spec')
  assert.ok(urls.every(url => url === 'https://mcp.exa.ai/mcp'))
})

test('a rate-limited keyless Exa response fails instead of returning the quota notice as results', async () => {
  await assert.rejects(
    searchWebTech({}, { query: 'mcp docs' }, {
      fetcher: async (url, options) => {
        const body = JSON.parse(options.body)
        if (body.method === 'initialize')
          return new Response('data: {}\n\n', { status: 200, headers: { 'mcp-session-id': 'fixture-session' } })
        if (body.method === 'notifications/initialized')
          return new Response('', { status: 200 })
        return new Response(
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'You have hit the Exa free MCP rate limit. Create your own Exa API key.' }] } })}\n\n`,
          { status: 200 },
        )
      },
    }),
    error => error.code === 'search_unavailable' && error.status === 503,
  )
})

test('a configured Exa key uses the REST endpoint instead of the keyless tier', async () => {
  let seen
  const result = await searchWebTech({ EXA_API_KEY: 'fixture' }, { query: 'mcp docs', domain: 'modelcontextprotocol.io', freshness: 'week' }, {
    fetcher: async (url, options) => {
      seen = { url: String(url), body: JSON.parse(options.body), headers: options.headers }
      return Response.json({
        results: [{ title: 'MCP spec', url: 'https://modelcontextprotocol.io/spec', text: 'Body text.' }],
      })
    },
  })
  assert.equal(seen.url, 'https://api.exa.ai/search')
  assert.equal(seen.headers['x-api-key'], 'fixture')
  assert.deepEqual(seen.body.includeDomains, ['modelcontextprotocol.io'])
  assert.ok(seen.body.startPublishedDate)
  assert.equal(result.provider, 'exa_search')
  assert.equal(result.freshness_applied, true)
  assert.equal(result.results[0].snippet, 'Body text.')
})

test('exhausted configured web providers fail visibly without a hidden HTML fallback', async () => {
  const urls = []
  const calls = []
  await assert.rejects(
    searchWebTech(
      { BRAVE_SEARCH_API_KEY: 'fixture', TAVILY_API_KEY: 'fixture', EXA_API_KEY: 'fixture', TAVILY_PROXY_KEY: 'fixture' },
      { query: 'mcp docs' },
      {
        fetcher: async (url, options) => {
          urls.push(String(url))
          calls.push(JSON.parse(options.body).method ?? 'rest')
          return new Response(null, { status: 503 })
        },
      },
    ),
    error => error.code === 'search_unavailable' && error.status === 503,
  )
  assert.equal(urls.length, 4)
  assert.ok(urls.some(url => url.includes('brave.com')))
  assert.ok(urls.some(url => url.includes('api.tavily.com')))
  assert.ok(urls.some(url => url.includes('api.exa.ai')))
  assert.ok(urls.some(url => url.includes('tavily.sharyuke.com')))
  assert.ok(!calls.includes('tools/call'))
})

test('the Tavily-compatible proxy is tried after Exa and unwraps its envelope', async () => {
  let seen
  const result = await searchWebTech({ TAVILY_PROXY_KEY: 'thb-fixture' }, { query: 'mcp docs', freshness: 'week' }, {
    fetcher: async (url, options) => {
      seen = { url: String(url), body: JSON.parse(options.body), headers: options.headers }
      return Response.json({
        code: 0,
        message: 'success',
        data: { ok: true, credits: 1, data: { results: [{ title: 'MCP spec', url: 'https://modelcontextprotocol.io/spec', content: 'Body text.' }] } },
      })
    },
  })
  assert.equal(seen.url, 'https://tavily.sharyuke.com/api/proxy/search')
  assert.equal(seen.headers.Authorization, 'Bearer thb-fixture')
  assert.equal(seen.body.time_range, 'week')
  assert.equal(result.provider, 'tavily_proxy_search')
  assert.equal(result.freshness_applied, true)
  assert.equal(result.results[0].snippet, 'Body text.')
})

test('the Tavily-compatible proxy honors a configured endpoint override', async () => {
  let url
  await searchWebTech({ TAVILY_PROXY_KEY: 'thb-fixture', TAVILY_PROXY_URL: 'https://proxy.example/api/proxy/search' }, { query: 'mcp docs' }, {
    fetcher: async (u) => {
      url = String(u)
      return Response.json({ code: 0, data: { data: { results: [] } } })
    },
  })
  assert.equal(url, 'https://proxy.example/api/proxy/search')
})

test('an exhausted-credit proxy envelope fails instead of returning an empty result list', async () => {
  await assert.rejects(
    searchWebTech({ TAVILY_PROXY_KEY: 'thb-fixture' }, { query: 'mcp docs' }, {
      fetcher: async () => Response.json({ code: 42901, message: 'Credit exhausted', data: null }),
    }),
    error => error.code === 'search_unavailable' && error.status === 503,
  )
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

test('low intensity walks providers in configuration order and stops at the first success', async () => {
  const called = []
  const result = await searchWebTech(
    { BRAVE_SEARCH_API_KEY: 'fixture', TAVILY_API_KEY: 'fixture' },
    { query: 'mcp docs', intensity: 'low' },
    {
      fetcher: async (url) => {
        called.push(String(url))
        if (String(url).includes('brave.com'))
          return new Response(null, { status: 503 })
        return Response.json({ results: [{ title: 'T', url: 'https://t.example', content: 'body' }] })
      },
    },
  )
  assert.equal(result.provider, 'tavily_search')
  assert.ok(!called.some(url => url.includes('exa.ai')))
})

test('medium intensity races the leading providers and reports the one that answered', async () => {
  const started = []
  const result = await searchWebTech(
    { BRAVE_SEARCH_API_KEY: 'fixture', TAVILY_API_KEY: 'fixture' },
    { query: 'mcp docs', intensity: 'medium' },
    {
      fetcher: async (url) => {
        started.push(String(url))
        if (String(url).includes('brave.com'))
          return new Response(null, { status: 503 })
        return Response.json({ results: [{ title: 'T', url: 'https://t.example', content: 'body' }] })
      },
    },
  )
  assert.equal(result.provider, 'tavily_search')
  // Both racers are launched before either settles, so the healthy provider does
  // not wait for the dead one to time out.
  assert.ok(started.some(url => url.includes('brave.com')))
  assert.ok(started.some(url => url.includes('tavily.com')))
})

test('high intensity merges every provider and records each corroborating source', async () => {
  const result = await searchWebTech(
    { BRAVE_SEARCH_API_KEY: 'fixture', TAVILY_API_KEY: 'fixture' },
    { query: 'mcp docs', intensity: 'high', limit: 5 },
    {
      fetcher: async (url) => {
        if (String(url).includes('brave.com')) {
          return Response.json({ web: { results: [
            { title: 'Spec', url: 'https://shared.example/doc', description: 'brave snippet' },
            { title: 'Only Brave', url: 'https://brave-only.example' },
          ] } })
        }
        if (String(url).includes('api.tavily.com')) {
          return Response.json({ results: [
            { title: 'Spec', url: 'https://shared.example/doc', content: 'tavily snippet' },
          ] })
        }
        // Exa keyless tier still participates and fails here.
        return new Response(null, { status: 500 })
      },
    },
  )
  assert.equal(result.provider, 'merged')
  assert.deepEqual(result.providers_used.sort(), ['brave_search', 'tavily_search'])
  assert.equal(result.results.length, 2)
  const shared = result.results.find(r => r.url === 'https://shared.example/doc')
  assert.deepEqual(shared.sources.map(s => s.provider).sort(), ['brave_search', 'tavily_search'])
})

test('an unknown intensity falls back to the low sequence', async () => {
  const result = await searchWebTech({ TAVILY_API_KEY: 'fixture' }, { query: 'mcp docs', intensity: 'turbo' }, {
    fetcher: async () => Response.json({ results: [{ title: 'T', url: 'https://t.example', content: 'body' }] }),
  })
  assert.equal(result.provider, 'tavily_search')
})
