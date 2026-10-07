import { appendJsonLines } from './append-store.js'
import { buildCommunityIndex } from './community-index.js'
import { parseDateRange } from './date-range.js'
import { getCatalog, getHarvested, getRankings } from './documents.js'
import { EVIDENCE_TRUST } from './evidence.js'
import { buildRepositoryQuery } from './github-query.js'
import { enrichLiveResults } from './live-results.js'
import { PROBE_CAPTURE_PREFIX } from './object-keys.js'
import { buildProbeCaptures, PROBE_MIN_STARS } from './probe-capture.js'
import { githubFailure, ProbeRequestError, readGithubSearch, requestProbe } from './probe-errors.js'

// Exa's keyless MCP tier answers with HTTP 200 and a human-readable quota notice
// instead of an error status, so a caller that trusts the status code returns the
// notice as if it were a search result. Real results always carry this shape.
const EXA_THROTTLE_MARKER = /rate limit|create your own exa api key|quota/i

function parseExaResults(body, limit) {
  return body.slice(0, limit).map((r, i) => ({
    rank: i + 1,
    title: r.title,
    url: r.url,
    snippet: r.text || (r.highlights || []).join(' ') || '',
    trust: EVIDENCE_TRUST.EXTERNAL_UNTRUSTED,
    source: 'exa_search',
  }))
}

// Keyless Exa speaks MCP, not REST: the REST endpoint answers 402 for per-request
// payment. This drives the minimal initialize -> initialized -> tools/call handshake.
async function searchExaKeyless(fetcher, { fullQuery, limit }) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  }
  const initResponse = await fetcher('https://mcp.exa.ai/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'stars-radar', version: '1.0' },
      },
    }),
    signal: AbortSignal.timeout(8000),
  })
  if (!initResponse.ok)
    throw new ProbeRequestError('invalid_upstream_response', `Exa MCP initialize failed with status ${initResponse.status}.`)

  const sessionId = initResponse.headers.get('mcp-session-id')
  await initResponse.text()
  if (!sessionId)
    throw new ProbeRequestError('invalid_upstream_response', 'Exa MCP did not return a session id.')

  await fetcher('https://mcp.exa.ai/mcp', {
    method: 'POST',
    headers: { ...headers, 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    signal: AbortSignal.timeout(8000),
  })

  const callResponse = await fetcher('https://mcp.exa.ai/mcp', {
    method: 'POST',
    headers: { ...headers, 'mcp-session-id': sessionId },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'web_search_exa', arguments: { query: fullQuery, numResults: limit } },
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!callResponse.ok)
    throw new ProbeRequestError('invalid_upstream_response', `Exa MCP search failed with status ${callResponse.status}.`)

  const payloads = parseSseData(await callResponse.text())
  const message = payloads.find(p => p?.result || p?.error)
  if (!message)
    throw new ProbeRequestError('invalid_upstream_response', 'Exa MCP returned no JSON-RPC payload.')
  if (message.error)
    throw new ProbeRequestError('invalid_upstream_response', `Exa MCP error: ${message.error.message || 'unknown'}`)

  const text = message.result?.content?.[0]?.text
  if (typeof text !== 'string')
    throw new ProbeRequestError('invalid_upstream_response', 'Exa MCP returned no content block.')
  if (EXA_THROTTLE_MARKER.test(text))
    throw new ProbeRequestError('invalid_upstream_response', 'Exa keyless MCP tier is rate limited.')

  // Keyless Exa returns a prose block rather than JSON. Extract the result records
  // it emits; a block that yields no records is a failure, not an empty search.
  // Escaped newlines survive JSON encoding as literal backslash-n, so normalize first.
  const prose = text.replace(/\\n/g, '\n')
  const results = []
  for (const chunk of prose.split(/\n(?=Title:\s)/)) {
    const title = chunk.match(/^Title:\s?(.*)$/m)?.[1]?.trim()
    const url = chunk.match(/^URL:\s?(\S+)$/m)?.[1]?.trim()
    if (title && url) {
      results.push({
        rank: results.length + 1,
        title,
        url,
        snippet: chunk.replace(/^(Title|URL|Published|Author|Highlights):.*$/gm, '').trim(),
        trust: EVIDENCE_TRUST.EXTERNAL_UNTRUSTED,
        source: 'exa_search',
      })
      if (results.length >= limit)
        break
    }
  }
  if (!results.length)
    throw new ProbeRequestError('invalid_upstream_response', 'Exa MCP returned no parsable results.')

  return {
    provider: 'exa_search',
    freshness_applied: false,
    query: fullQuery,
    count: results.length,
    results,
  }
}

function parseSseData(body) {
  const payloads = []
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:'))
      continue
    try {
      payloads.push(JSON.parse(line.slice(5).trim()))
    }
    catch {
      // A malformed frame is skipped; a payload-less stream still fails below.
    }
  }
  return payloads
}

export async function searchGithubLive(env, {
  query = '',
  language,
  minStars = 15,
  sort = 'stars',
  order = 'desc',
  since,
  until,
  limit = 10,
} = {}, { fetcher = fetch } = {}) {
  const catalog = await getCatalog(env)
  const reposCatalog = catalog.repos || {}
  const rankings = await getRankings(env)

  // Inspect the user-supplied query for qualifiers we auto-inject, so we never
  // duplicate them (GitHub Search API rejects conflicting duplicates with 422).
  const userQuery = (query || '').trim()
  const githubQuery = buildRepositoryQuery({ query: userQuery, since, until, minStars, language, parseDateRange })

  const apiUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(githubQuery)}&sort=${sort}&order=${order}&per_page=${Math.min(limit, 30)}`

  const headers = {
    'User-Agent': 'Stars-Radar-MCP',
    'Accept': 'application/vnd.github.v3+json',
  }
  if (env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`
  }

  const operation = 'GitHub repository search'
  const response = await requestProbe(apiUrl, { headers, signal: AbortSignal.timeout(15000) }, fetcher, operation)
  const data = await readGithubSearch(response, operation)
  const items = data.items
  const totalCount = data.total_count

  // Live results carry the same badge as hybrid search, so they read the same community view —
  // derived once, in one place, from the journal plus the community layers.
  const communitySet = buildCommunityIndex({ rankings, harvested: await getHarvested(env) })

  const enriched = enrichLiveResults(items, { reposCatalog, communityIndex: communitySet })

  return {
    source: 'github_live_search',
    query: githubQuery,
    total_found: totalCount,
    ...(typeof data.incomplete_results === 'boolean' ? { incomplete_results: data.incomplete_results } : {}),
    returned: enriched.length,
    repos: enriched,
  }
}

export async function captureGithubDiscovery(env, {
  repo,
  query,
} = {}, { fetcher = fetch } = {}) {
  let cleanRepo = String(repo || '').trim()
  cleanRepo = cleanRepo.replace(/^https?:\/\/github\.com\//i, '')
  cleanRepo = cleanRepo.replace(/\.git$/i, '')
  cleanRepo = cleanRepo.replace(/\/$/, '')
  const cleanQuery = String(query || '').trim()

  if (!/^[\w.-]+\/[\w.-]+$/.test(cleanRepo) || cleanRepo.split('/').some(part => part === '.' || part === '..'))
    throw new ProbeRequestError('invalid_repo', 'Discovery capture requires a repository in owner/repo format.', 400)
  if (!cleanQuery)
    throw new ProbeRequestError('invalid_query', 'Discovery capture requires the originating search query.', 400)

  const headers = {
    'User-Agent': 'Stars-Radar-MCP',
    'Accept': 'application/vnd.github+json',
  }
  if (env.GITHUB_TOKEN)
    headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`

  const operation = 'GitHub discovery capture'
  const encodedRepo = cleanRepo.split('/').map(encodeURIComponent).join('/')
  const response = await requestProbe(
    `https://api.github.com/repos/${encodedRepo}`,
    { headers, signal: AbortSignal.timeout(10000) },
    fetcher,
    operation,
  )
  if (!response.ok)
    throw githubFailure(response, operation)

  let data
  try {
    data = await response.json()
  }
  catch (error) {
    throw new ProbeRequestError('invalid_upstream_response', `${operation}: GitHub returned invalid JSON (${error.message}).`)
  }
  if (typeof data?.full_name !== 'string' || !Number.isFinite(data.stargazers_count))
    throw new ProbeRequestError('invalid_upstream_response', `${operation}: GitHub repository metadata is incomplete.`)

  const [capture] = buildProbeCaptures([{
    repo: data.full_name,
    url: data.html_url,
    stars: data.stargazers_count,
    description: data.description || '',
    language: data.language || '',
    topics: data.topics || [],
    created_at: data.created_at,
    pushed_at: data.pushed_at,
  }], { query: cleanQuery })

  if (!capture) {
    return {
      captured: 0,
      repo: data.full_name,
      capture_skipped: `repository does not meet the capture rule (>=${PROBE_MIN_STARS} stars and non-empty description)`,
    }
  }

  try {
    const captureKey = await appendJsonLines(env, PROBE_CAPTURE_PREFIX, [capture])
    return { captured: 1, repo: data.full_name, query: cleanQuery, capture_key: captureKey }
  }
  catch (error) {
    throw new ProbeRequestError('capture_failed', `Could not append discovery capture: ${error.message || String(error)}`, 503)
  }
}

export async function searchGithubCode(env, {
  query = '',
  repo,
  language,
  extension,
  path: filePath,
  limit = 5,
} = {}, { fetcher = fetch } = {}) {
  const cleanQ = query.trim()
  if (!cleanQ)
    throw new ProbeRequestError('invalid_query', 'GitHub code search requires a non-empty code term.', 400)

  const qParts = [cleanQ]
  if (repo)
    qParts.push(`repo:${repo.trim()}`)
  if (language)
    qParts.push(`language:${language.trim()}`)
  if (extension)
    qParts.push(`extension:${extension.trim().replace(/^\./, '')}`)
  if (filePath)
    qParts.push(`path:${filePath.trim()}`)

  if (!extension && !filePath) {
    qParts.push('-filename:package-lock.json -filename:pnpm-lock.yaml -filename:yarn.lock -extension:min.js')
  }

  const githubQuery = qParts.join(' ')
  const apiUrl = `https://api.github.com/search/code?q=${encodeURIComponent(githubQuery)}&per_page=${Math.min(limit, 15)}`

  const headers = {
    'User-Agent': 'Stars-Radar-MCP',
    'Accept': 'application/vnd.github.v3.text-match+json',
  }
  if (env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`
  }

  const operation = 'GitHub code search'
  const response = await requestProbe(apiUrl, { headers, signal: AbortSignal.timeout(15000) }, fetcher, operation)
  const data = await readGithubSearch(response, operation)
  const items = data.items

  const matches = items.map((item, idx) => {
    const repoName = item.repository?.full_name || 'unknown'
    const targetPath = item.path
    const htmlUrl = item.html_url
    const textMatch = item.text_matches?.[0]
    const fragment = (textMatch?.fragment || '')
      .trim()
      .replace(/!\[.*?\]\(https?:\/\/.*?\)/g, '')

    const ext = targetPath.split('.').pop() || ''

    return {
      rank: idx + 1,
      repo: repoName,
      path: targetPath,
      url: htmlUrl,
      language: ext,
      snippet: fragment ? `\`\`\`${ext}\n${fragment}\n\`\`\`` : '(No snippet fragment returned)',
      trust: EVIDENCE_TRUST.EXTERNAL_UNTRUSTED,
    }
  })

  return {
    source: 'github_code_search',
    query: githubQuery,
    total_found: data.total_count,
    ...(typeof data.incomplete_results === 'boolean' ? { incomplete_results: data.incomplete_results } : {}),
    returned: matches.length,
    notice: 'Untrusted external code snippets are provided for structural and syntax reference only.',
    matches,
  }
}

const unavailableMessage = 'No configured web search provider succeeded. Configure BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, EXA_API_KEY or TAVILY_PROXY_KEY and retry.'

export const WEB_INTENSITY_MODES = { low: true, medium: true, high: true }

export async function searchWebTech(env, {
  query = '',
  domain,
  freshness = 'all',
  limit = 5,
  intensity = 'low',
} = {}, { fetcher = fetch } = {}) {
  const fullQuery = `${query.trim()}${domain ? ` site:${domain.trim()}` : ''}`
  if (!query.trim())
    throw new ProbeRequestError('invalid_query', 'Technical web search requires a non-empty query.', 400)

  const context = { env, fetcher, query: query.trim(), fullQuery, domain, freshness, limit }
  const providers = resolveWebProviders(context)
  if (!providers.length)
    throw new ProbeRequestError('search_unavailable', unavailableMessage, 503)

  const mode = WEB_INTENSITY_MODES[intensity] ? intensity : 'low'

  if (mode === 'high')
    return mergeProviderResults(await Promise.allSettled(providers.map(p => p.run(context))), providers, context)

  if (mode === 'medium')
    return runRacingProviders(providers, context)

  return runSequentialProviders(providers, context)
}

// low walks every configured provider in order and returns the first success, so a
// wider configuration costs more upstream calls but never a change in behavior.
async function runSequentialProviders(providers, context) {
  for (const provider of providers) {
    try {
      return await provider.run(context)
    }
    catch (error) {
      console.warn(`${provider.name} failed, falling back:`, error.message)
    }
  }
  throw new ProbeRequestError('search_unavailable', unavailableMessage, 503)
}

function resolveWebProviders(context) {
  const { env } = context
  return [
    env.BRAVE_SEARCH_API_KEY && { name: 'brave_search', run: searchBrave },
    env.TAVILY_API_KEY && { name: 'tavily_search', run: searchTavily },
    // Exa always participates: without a key it serves the keyless MCP tier.
    { name: 'exa_search', run: searchExa },
    env.TAVILY_PROXY_KEY && { name: 'tavily_proxy_search', run: searchTavilyProxy },
  ].filter(Boolean)
}

// medium keeps the two leading providers in flight at once and takes whichever
// settles first, so a single dead provider no longer costs a full timeout. If
// both fail the remaining providers still run, preserving fallback coverage.
async function runRacingProviders(providers, context) {
  const [first, second, ...rest] = providers
  if (!second)
    return first.run(context)

  const racers = [first, second].map(provider => provider.run(context).catch((error) => {
    console.warn(`${provider.name} failed, falling back:`, error.message)
    throw error
  }))

  try {
    return await Promise.any(racers)
  }
  catch {
    // Every provider failed, so the caller gets one normalized failure rather
    // than whichever upstream error happened to arrive first.
    for (const provider of rest) {
      try {
        return await provider.run(context)
      }
      catch (error) {
        console.warn(`${provider.name} failed, falling back:`, error.message)
      }
    }
    throw new ProbeRequestError('search_unavailable', unavailableMessage, 503)
  }
}

// high runs every configured provider and merges by URL, keeping each provider's
// rank per URL so one result can report several corroborating sources.
function mergeProviderResults(settled, providers, context) {
  const successful = settled
    .map((outcome, index) => ({ outcome, provider: providers[index] }))
    .filter(({ outcome }) => outcome.status === 'fulfilled')

  if (!successful.length)
    throw new ProbeRequestError('search_unavailable', unavailableMessage, 503)

  const byUrl = new Map()
  for (const { outcome, provider } of successful) {
    for (const result of outcome.value.results) {
      if (!result.url)
        continue
      const existing = byUrl.get(result.url)
      if (existing) {
        existing.sources.push({ provider: provider.name, rank: result.rank })
        if (!existing.snippet && result.snippet)
          existing.snippet = result.snippet
      }
      else {
        byUrl.set(result.url, {
          url: result.url,
          title: result.title,
          snippet: result.snippet,
          trust: result.trust,
          source: provider.name,
          sources: [{ provider: provider.name, rank: result.rank }],
        })
      }
    }
  }

  const results = [...byUrl.values()].slice(0, context.limit).map((r, i) => ({ rank: i + 1, ...r }))
  return {
    provider: 'merged',
    providers_used: successful.map(({ provider }) => provider.name),
    freshness_applied: context.freshness !== 'all',
    query: context.fullQuery,
    count: results.length,
    results,
  }
}

async function searchBrave(context) {
  const { env, fetcher, fullQuery, freshness, limit } = context
  const freshnessMap = { day: 'pd', week: 'pw', month: 'pm', year: 'py', all: '' }
  const bFreshness = freshnessMap[freshness] || ''
  let url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(fullQuery)}&count=${limit}`
  if (bFreshness)
    url += `&freshness=${bFreshness}`

  const resp = await fetcher(url, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': env.BRAVE_SEARCH_API_KEY,
    },
    signal: AbortSignal.timeout(8000),
  })
  if (!resp.ok)
    throw new ProbeRequestError('invalid_upstream_response', `Brave search failed with status ${resp.status}.`)

  const data = await resp.json()
  // Brave's documented web section is nullable, even in a valid search response.
  const emptySearch = data?.type === 'search' && typeof data.query?.original === 'string' && data.web == null
  if (!Array.isArray(data?.web?.results) && !emptySearch)
    throw new ProbeRequestError('invalid_upstream_response', 'Brave search returned an invalid result list.')

  const parsed = (data.web?.results || []).slice(0, limit).map((r, i) => ({
    rank: i + 1,
    title: r.title?.replace(/<[^>]+>/g, '').trim(),
    url: r.url,
    snippet: r.description?.replace(/<[^>]+>/g, '').trim() || '',
    trust: EVIDENCE_TRUST.EXTERNAL_UNTRUSTED,
    source: 'brave_search',
  }))
  return { provider: 'brave_search', freshness_applied: freshness !== 'all', query: fullQuery, count: parsed.length, results: parsed }
}

async function searchTavily(context) {
  const { env, fetcher, fullQuery, freshness, limit } = context
  const resp = await fetcher('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: env.TAVILY_API_KEY,
      query: fullQuery,
      search_depth: 'basic',
      max_results: limit,
      ...(freshness !== 'all' ? { time_range: freshness } : {}),
    }),
    signal: AbortSignal.timeout(8000),
  })
  if (!resp.ok)
    throw new ProbeRequestError('invalid_upstream_response', `Tavily search failed with status ${resp.status}.`)

  const data = await resp.json()
  if (!Array.isArray(data.results))
    throw new ProbeRequestError('invalid_upstream_response', 'Tavily search returned an invalid result list.')

  const results = data.results.slice(0, limit).map((r, i) => ({
    rank: i + 1,
    title: r.title,
    url: r.url,
    snippet: r.content || '',
    trust: EVIDENCE_TRUST.EXTERNAL_UNTRUSTED,
    source: 'tavily_search',
  }))
  return { provider: 'tavily_search', freshness_applied: freshness !== 'all', query: fullQuery, count: results.length, results }
}

// With a key Exa uses the documented REST endpoint; without one it degrades to the
// keyless MCP tier, which is rate limited and cannot scope a domain or a date window.
async function searchExa(context) {
  const { env, fetcher, query, fullQuery, domain, freshness, limit } = context
  if (!env.EXA_API_KEY)
    return searchExaKeyless(fetcher, { fullQuery, limit })

  const resp = await fetcher('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.EXA_API_KEY,
    },
    body: JSON.stringify({
      query,
      type: 'auto',
      numResults: limit,
      contents: { text: { maxCharacters: 1200 } },
      ...(domain ? { includeDomains: [domain.trim()] } : {}),
      ...(freshness !== 'all' ? { startPublishedDate: exaStartDate(freshness) } : {}),
    }),
    signal: AbortSignal.timeout(8000),
  })
  if (!resp.ok)
    throw new ProbeRequestError('invalid_upstream_response', `Exa search failed with status ${resp.status}.`)

  const data = await resp.json()
  if (!Array.isArray(data?.results))
    throw new ProbeRequestError('invalid_upstream_response', 'Exa search returned an invalid result list.')

  const results = parseExaResults(data.results, limit)
  return { provider: 'exa_search', freshness_applied: freshness !== 'all', query: fullQuery, count: results.length, results }
}

// A Tavily-compatible proxy mirrors Tavily's request body but authenticates with a
// Bearer header and wraps its payload in a { code, message, data } envelope. Like
// Exa's keyless tier it reports quota exhaustion as HTTP 200 with a non-zero code.
async function searchTavilyProxy(context) {
  const { env, fetcher, fullQuery, freshness, limit } = context
  const resp = await fetcher(env.TAVILY_PROXY_URL || 'https://tavily.sharyuke.com/api/proxy/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.TAVILY_PROXY_KEY}`,
    },
    body: JSON.stringify({
      query: fullQuery,
      search_depth: 'basic',
      max_results: limit,
      ...(freshness !== 'all' ? { time_range: freshness } : {}),
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!resp.ok)
    throw new ProbeRequestError('invalid_upstream_response', `Tavily proxy search failed with status ${resp.status}.`)

  const data = await resp.json()
  if (data?.code !== 0)
    throw new ProbeRequestError('invalid_upstream_response', `Tavily proxy rejected the request: ${data?.message || 'unknown'}`)
  const raw = data?.data?.data?.results
  if (!Array.isArray(raw))
    throw new ProbeRequestError('invalid_upstream_response', 'Tavily proxy returned an invalid result list.')

  const results = raw.slice(0, limit).map((r, i) => ({
    rank: i + 1,
    title: r.title,
    url: r.url,
    snippet: r.content || '',
    trust: EVIDENCE_TRUST.EXTERNAL_UNTRUSTED,
    source: 'tavily_proxy_search',
  }))
  return { provider: 'tavily_proxy_search', freshness_applied: freshness !== 'all', query: fullQuery, count: results.length, results }
}

function exaStartDate(freshness) {
  const days = { day: 1, week: 7, month: 30, year: 365 }[freshness]
  if (!days)
    return undefined
  return new Date(Date.now() - days * 86400000).toISOString()
}
