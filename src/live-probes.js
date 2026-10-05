import { appendJsonLines } from './append-store.js'
import { buildCommunityIndex } from './community-index.js'
import { EVIDENCE_TRUST } from './evidence.js'
import { parseDateRange } from './date-range.js'
import { getCatalog, getHarvested, getRankings } from './documents.js'
import { buildRepositoryQuery } from './github-query.js'
import { enrichLiveResults } from './live-results.js'
import { PROBE_CAPTURE_PREFIX } from './object-keys.js'
import { buildProbeCaptures, PROBE_MIN_STARS } from './probe-capture.js'
import { githubFailure, ProbeRequestError, readGithubSearch, requestProbe } from './probe-errors.js'

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

export async function searchWebTech(env, {
  query = '',
  domain,
  freshness = 'all',
  limit = 5,
} = {}, { fetcher = fetch } = {}) {
  let fullQuery = query.trim()
  if (!fullQuery)
    throw new ProbeRequestError('invalid_query', 'Technical web search requires a non-empty query.', 400)
  if (domain)
    fullQuery += ` site:${domain.trim()}`

  // 1. Primary Provider: Brave Search API
  if (env.BRAVE_SEARCH_API_KEY) {
    try {
      const freshnessMap = { day: 'pd', week: 'pw', month: 'pm', year: 'py', all: '' }
      const bFreshness = freshnessMap[freshness] || ''
      let bUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(fullQuery)}&count=${limit}`
      if (bFreshness)
        bUrl += `&freshness=${bFreshness}`

      const resp = await fetcher(bUrl, {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': env.BRAVE_SEARCH_API_KEY,
        },
        signal: AbortSignal.timeout(8000),
      })
      if (resp.ok) {
        const data = await resp.json()
        // Brave's documented web section is nullable, even in a valid search response.
        const emptySearch = data?.type === 'search' && typeof data.query?.original === 'string' && data.web == null
        if (!Array.isArray(data?.web?.results) && !emptySearch)
          throw new ProbeRequestError('invalid_upstream_response', 'Brave search returned an invalid result list.')
        const webResults = data.web?.results || []
        const parsed = webResults.slice(0, limit).map((r, i) => ({
          rank: i + 1,
          title: r.title?.replace(/<[^>]+>/g, '').trim(),
          url: r.url,
          snippet: r.description?.replace(/<[^>]+>/g, '').trim() || '',
          trust: EVIDENCE_TRUST.EXTERNAL_UNTRUSTED,
          source: 'brave_search',
        }))
        return {
          provider: 'brave_search',
          freshness_applied: freshness !== 'all',
          query: fullQuery,
          count: parsed.length,
          results: parsed,
        }
      }
    }
    catch (e) {
      console.warn('Brave Search failed, falling back:', e.message)
    }
  }

  // 2. Secondary Provider: Tavily Search API
  if (env.TAVILY_API_KEY) {
    try {
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
      if (resp.ok) {
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
        return {
          provider: 'tavily_search',
          freshness_applied: freshness !== 'all',
          query: fullQuery,
          count: results.length,
          results,
        }
      }
    }
    catch (e) {
      console.warn('Tavily Search failed, falling back:', e.message)
    }
  }

  throw new ProbeRequestError(
    'search_unavailable',
    'No configured web search provider succeeded. Configure BRAVE_SEARCH_API_KEY or TAVILY_API_KEY and retry.',
    503,
  )
}
