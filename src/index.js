import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createMcpHandler } from 'agents/mcp'
import { z } from 'zod'
import defaultIntents from '../data/intents.json'
import { appendIngest } from './append-store.js'
import { listReadmePage } from './archive-candidates.js'
import { AuthConfigError, authorizeCredential } from './auth.js'
import { DocumentUnavailableError } from './document-cache.js'
import {
  dataPlaneStatus,
  getAssetIndex,
  getCatalog,
  getDataGeneration,
  getHarvested,
  getRankings,
  getReadmeManifest,
  getVectors,
  JOURNAL_TTL_MS,
  seedHarvested,
} from './documents.js'
import { DIMS, EMBEDDING_MODEL, isEmbedding } from './embeddings.js'
import { bindReadmeEvidence, buildReadmeEvidence } from './evidence.js'
import {
  BadRequestError,
  booleanParam,
  corsHeaders,
  enumParam,
  errorResponse,
  intParam,
  okResponse,
  optionalString,
  PayloadTooLargeError,
  readJsonBody,
  stringParam,
} from './http.js'
import { foldIngestEntries } from './ingest-journal.js'
import { captureGithubDiscovery, searchGithubCode, searchGithubLive, searchWebTech } from './live-probes.js'
import { readmeBlobKey } from './object-keys.js'
import { ProbeRequestError, probeToolFailure } from './probe-errors.js'
import { staleSources } from './rankings-document.js'
import { consumePlatformRateLimit, PlatformRateLimitError, rateLimitStatus } from './rate-limit.js'
import { findReadmeEvidence, README_EVIDENCE_MAX_RESULTS } from './readme-evidence.js'
import { compareRepositories, getRepositoryDetails, RepositoryRequestError } from './repository-details.js'
import { RESULT_SOURCES } from './result-compiler.js'
import { retryUntilAcceptable } from './retry.js'
import { searchDocuments } from './search-engine.js'
import { DEFAULT_INGEST_CATEGORIES, INPUT_LIMITS, TOOL_DEFINITIONS } from './tool-schemas.js'
import { resolveToolset, ToolsetConfigError, toolsetStatus } from './toolsets.js'
import { VERSION } from './version.js'

const SILICONFLOW_URL = 'https://api.siliconflow.cn/v1/embeddings'

// A failed ingest is a failed request. The status says whose problem it is: the caller's (400), the
// upstream provider's (502), or ours (503).
const INGEST_ERROR_STATUS = {
  invalid_repo: 400,
  github_star_failed: 502,
  ingest_failed: 503,
}

// An ingest body is a repository name, a reason and a list of categories. 8 KiB is roughly forty
// times the largest legitimate payload, and small enough that reading one costs the isolate nothing.
const INGEST_BODY_LIMIT = 8 * 1024

// How long the rest of the fleet may still be serving the previous fold, quoted back to the caller
// so the statement matches what actually happens. Derived from the cache it describes.
const JOURNAL_TTL_SECONDS = Math.round(JOURNAL_TTL_MS / 1000)

// Query embeddings go through the shared retry shape (src/retry.js); the count lives here because
// it is this caller's policy, not the mechanism's.
const EMBED_ATTEMPTS = 2

/**
 * Whether the community data a response is built from came from the latest run.
 *
 * Every layer is collected from a different upstream and a failure keeps the previous copy, so
 * without this a caller cannot tell a list refreshed an hour ago from one that has been riding on
 * an old copy for days.
 */
function communityFreshness(rankings) {
  const stale = staleSources(rankings)
  return {
    updatedAt: rankings?.updatedAt || null,
    staleLayers: stale.map(entry => entry.name),
    oldestFetchAt: stale
      .map(entry => entry.at)
      .filter(Boolean)
      .sort()[0] || null,
  }
}

// Single Embedding Authority: SiliconFlow BAAI/bge-m3.
// Cross-provider fallback (e.g. to Cloudflare Workers AI) is intentionally prohibited:
// differing quantization (FP16 vs INT8), pooling layers, and tokenization produce
// non-isomorphic vector spaces. Comparing vectors across engines results in severe
// geometric drift and corrupted cosine similarity scores.
async function getQueryEmbedding(query, env) {
  const sfKey = env.SILICONFLOW_KEY
  const sfUrl = env.SILICONFLOW_URL || SILICONFLOW_URL

  if (!sfKey) {
    console.warn('[Embedding] SILICONFLOW_KEY not configured. Vector search disabled.')
    return null
  }

  try {
    return await retryUntilAcceptable(
      async (attempt) => {
        const resp = await fetch(sfUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${sfKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: EMBEDDING_MODEL,
            input: query,
          }),
          signal: AbortSignal.timeout(10000),
        })
        if (!resp.ok)
          console.warn(`[Embedding] SiliconFlow returned HTTP ${resp.status} (attempt ${attempt}/${EMBED_ATTEMPTS})`)
        return resp.ok ? await resp.json() : null
      },
      // A 200 with an unusable body is retried like a failure: providers answer rate limits and
      // proxy errors with one. Only a well-formed vector of the expected width is an answer.
      payload => isEmbedding(payload?.data?.[0]?.embedding),
      {
        attempts: EMBED_ATTEMPTS,
        baseMs: 400,
        onRetry: ({ attempt, error }) => {
          if (error)
            console.warn(`[Embedding] SiliconFlow request failed (attempt ${attempt}/${EMBED_ATTEMPTS}):`, error.message || String(error))
        },
      },
    ).then((payload) => {
      return payload ? new Float32Array(payload.data[0].embedding) : null
    })
  }
  catch (err) {
    console.warn(`[Embedding] SiliconFlow request failed: ${err.message || String(err)}`)
  }

  console.warn('[Embedding] Single authority SiliconFlow unavailable after retries. Falling back cleanly to lexical intent mode without corrupted vector drift.')
  return null
}

function enrichCategoriesWithTopRepos(catalog) {
  const categories = catalog.categories || []
  const hasTopRepos = categories.some(c => c.topRepos && c.topRepos.length > 0)
  if (hasTopRepos) {
    return categories
  }
  const catRepos = new Map()
  for (const [name, info] of Object.entries(catalog.repos || {})) {
    for (const cat of (info.categories || [])) {
      const key = cat.toLowerCase()
      if (!catRepos.has(key))
        catRepos.set(key, [])
      catRepos.get(key).push({ name, stars: info.stars || 0 })
    }
  }
  for (const list of catRepos.values()) {
    list.sort((a, b) => b.stars - a.stars)
  }
  return categories.map((c) => {
    const top = (c.topRepos && c.topRepos.length > 0)
      ? c.topRepos
      : (catRepos.get(c.name.toLowerCase()) || []).slice(0, 3)
    return {
      ...c,
      topRepos: top,
    }
  })
}

export default {
  fetch: async (req, env, ctx) => {
    try {
      return await handleRequest(req, env, ctx)
    }
    catch (e) {
      // A document that could not be read is a server-side fault, and it must not be answered
      // with an empty-but-successful result: that is exactly how an R2 outage used to look
      // like "no repositories matched".
      if (e instanceof DocumentUnavailableError) {
        console.error(e)
        return errorResponse('data_unavailable', e.message, 503)
      }
      // A parameter the caller can fix is a 400, not a crash: the REST surface used to hand
      // whatever it was given to the engine, so a typo became a wrong answer instead of an error.
      if (e instanceof BadRequestError)
        return errorResponse('invalid_parameter', e.message, 400)
      if (e instanceof ProbeRequestError)
        return errorResponse(e.code, e.message, e.status, { retryAfterSeconds: e.retryAfterSeconds })
      if (e instanceof RepositoryRequestError)
        return errorResponse('repository_unavailable', e.message, e.status)
      throw e
    }
  },
}

async function handleRequest(req, env, ctx) {
  // Preflight carries no Authorization header, so it must be answered before the key check.
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }

  {
    const url = new URL(req.url)
    const authHeader = req.headers.get('Authorization')
    const apiKey = authHeader?.replace(/^bearer\s+/i, '').trim()

    let auth
    try {
      auth = authorizeCredential(apiKey, env)
    }
    catch (error) {
      if (error instanceof AuthConfigError)
        return errorResponse('server_misconfigured', error.message, 500)
      throw error
    }
    const { canRead, canWrite } = auth

    if (!canRead)
      return errorResponse('unauthorized', 'Invalid API key. Supply your key via Authorization: Bearer <KEY> header.', 401)

    // Read and write capabilities are intentionally separate. The write credential may read so a
    // privileged operator does not need to juggle two keys in one session; the read key never writes.
    const writeForbidden = () => errorResponse(
      'write_forbidden',
      'This credential is read-only. Use MCP_WRITE_API_KEY for capture or ingest operations.',
      403,
    )
    const writeToolFailure = () => ({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({
        error: 'write_forbidden',
        message: 'This credential is read-only. Use the configured write credential for this operation.',
      }) }],
    })

    const checkRateLimit = async (binding, label) => {
      try {
        const decision = await consumePlatformRateLimit(binding, apiKey)
        if (!decision.success) {
          return {
            error: 'rate_limited',
            message: `${label} request budget exceeded for this credential at the current Cloudflare location.`,
            status: 429,
          }
        }
        return null
      }
      catch (error) {
        if (error instanceof PlatformRateLimitError) {
          return {
            error: 'rate_limiter_unavailable',
            message: `${label} rate limiter is configured but unavailable: ${error.message}`,
            status: 503,
          }
        }
        throw error
      }
    }

    const restRateLimit = async (binding, label) => {
      const failure = await checkRateLimit(binding, label)
      return failure ? errorResponse(failure.error, failure.message, failure.status) : null
    }

    const toolRateLimit = async (binding, label) => {
      const failure = await checkRateLimit(binding, label)
      if (!failure)
        return null
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(failure) }],
      }
    }

    // Direct REST API Endpoints
    if (url.pathname === '/health') {
      const generation = await getDataGeneration(env)
      const catalog = await getCatalog(env)
      const rankings = await getRankings(env)
      const assetIndex = await getAssetIndex(env)
      const readmes = await getReadmeManifest(env)
      const vectors = await getVectors(env)
      const harvested = await getHarvested(env)
      const dataPlane = dataPlaneStatus()
      return okResponse({
        // `degraded` is the difference between "nothing is published yet" and "R2 could not be
        // read": both used to answer 200 ok with an empty body of data.
        status: dataPlane.degraded ? 'degraded' : 'ok',
        name: 'Stars Radar',
        version: VERSION,
        vectorModel: EMBEDDING_MODEL,
        vectorInputProfile: vectors.inputProfile || null,
        vectorDimensions: DIMS,
        totalStarred: catalog.totalRepos || Object.keys(catalog.repos || {}).length,
        totalAssets: assetIndex.totalRepos || Object.keys(assetIndex.repos || {}).length,
        vectorCount: vectors.records?.length || 0,
        repoVectorCount: vectors.records?.filter(record => record.kind === 'repo').length || 0,
        readmeChunkVectorCount: vectors.records?.filter(record => record.kind === 'readme_chunk').length || 0,
        readmeRefs: Object.keys(readmes.repos || {}).length,
        harvestedIngests: harvested.length,
        dataGeneration: generation.id
          ? { id: generation.id, publishedAt: generation.published_at, commit: generation.commit }
          : null,
        dataPlane: dataPlane.statuses,
        rateLimits: rateLimitStatus(env),
        mcpToolset: toolsetStatus(env.MCP_TOOLSET),
        // Which community layers are actually from the latest run, and how old the oldest one is.
        // `updatedAt` alone cannot answer that: it moves on every run whether or not a layer
        // refreshed, which is how stale data came to look fresh.
        communityFreshness: communityFreshness(rankings),
        rankingsAvailable: {
          trendingCategories: Object.keys(rankings.trending || {}),
          topStarredLanguages: Object.keys(rankings.topStarred || {}),
          helloGitHubPicks: (rankings.helloGitHub || []).length,
          agentSkillsTop: (rankings.agentSkills || []).length,
          agentSkillRepos60d: (rankings.agentSkillRepos || []).length,
        },
      })
    }

    if (url.pathname === '/api/repository') {
      const include_readme = booleanParam(url.searchParams.get('include_readme'))
      const refresh = booleanParam(url.searchParams.get('refresh'))
      if (refresh) {
        const limited = await restRateLimit(env.EXPENSIVE_RATE_LIMITER, 'expensive')
        if (limited)
          return limited
      }
      const repo = stringParam(url.searchParams.get('repo'), { parameter: 'repo', minLength: 3, maxLength: INPUT_LIMITS.repo })
      return okResponse(await getRepositoryDetails(env, await researchDocuments(env), repo, { include_readme, refresh }))
    }

    if (url.pathname === '/api/compare') {
      const repos = stringParam(url.searchParams.get('repos'), { parameter: 'repos', minLength: 1, maxLength: (INPUT_LIMITS.repo * 5) + 4 }).split(',')
      const refresh = booleanParam(url.searchParams.get('refresh'))
      if (refresh) {
        const limited = await restRateLimit(env.EXPENSIVE_RATE_LIMITER, 'expensive')
        if (limited)
          return limited
      }
      return okResponse(await compareRepositories(env, await researchDocuments(env), repos, { refresh }))
    }

    if (url.pathname === '/api/categories') {
      const catalog = await getCatalog(env)
      return okResponse(enrichCategoriesWithTopRepos(catalog))
    }

    if (url.pathname === '/api/search') {
      const q = stringParam(url.searchParams.get('q'), { parameter: 'q', fallback: '', maxLength: INPUT_LIMITS.query })
      const category = optionalString(url.searchParams.get('category'), { parameter: 'category', maxLength: INPUT_LIMITS.category })
      const scope = enumParam(url.searchParams.get('scope'), { parameter: 'scope', allowed: ['all', 'starred', 'rankings'], fallback: 'all' })
      const source = enumParam(url.searchParams.get('source'), { parameter: 'source', allowed: RESULT_SOURCES, fallback: undefined })
      const limit = intParam(url.searchParams.get('limit'), { parameter: 'limit', fallback: 10, min: 1, max: 20 })
      const explain = booleanParam(url.searchParams.get('explain'))
      if (scope !== 'rankings') {
        const limited = await restRateLimit(env.EXPENSIVE_RATE_LIMITER, 'expensive')
        if (limited)
          return limited
      }
      const results = await performHybridSearch(env, q, { category, source, scope, limit, explain })
      return okResponse(results, { pretty: true })
    }

    if (url.pathname === '/api/trending') {
      const rankings = await getRankings(env)
      const cat = enumParam(url.searchParams.get('category'), {
        parameter: 'category',
        allowed: ['overall_daily', 'overall_weekly', 'rust_weekly', 'python_weekly', 'typescript_weekly', 'go_weekly', 'cpp_weekly', 'csharp_weekly', 'breakout_weekly'],
        fallback: 'overall_daily',
      })
      const list = cat === 'breakout_weekly' ? (rankings.breakoutWeekly || []) : (rankings.trending?.[cat] || [])
      return okResponse(list, { meta: communityFreshness(rankings) })
    }

    if (url.pathname === '/api/skills') {
      const rankings = await getRankings(env)
      const type = enumParam(url.searchParams.get('type'), { parameter: 'type', allowed: ['all', 'repos'], fallback: 'all' })
      const limit = intParam(url.searchParams.get('limit'), { parameter: 'limit', fallback: 50, min: 1, max: 100 })
      const meta = communityFreshness(rankings)
      if (type === 'repos') {
        return okResponse((rankings.agentSkillRepos || []).slice(0, limit), { meta })
      }
      const list = (rankings.agentSkills || []).slice(0, limit)
      return okResponse(list, { meta })
    }

    if (url.pathname === '/api/live') {
      const q = stringParam(url.searchParams.get('q'), { parameter: 'q', fallback: '', maxLength: INPUT_LIMITS.query })
      const language = optionalString(url.searchParams.get('language'), { parameter: 'language', maxLength: INPUT_LIMITS.language })
      const minStars = intParam(url.searchParams.get('min_stars'), { parameter: 'min_stars', fallback: 15, min: 0 })
      const sort = enumParam(url.searchParams.get('sort'), { parameter: 'sort', allowed: ['stars', 'updated', 'forks'], fallback: 'stars' })
      const order = enumParam(url.searchParams.get('order'), { parameter: 'order', allowed: ['desc', 'asc'], fallback: 'desc' })
      const since = optionalString(url.searchParams.get('since'), { parameter: 'since', maxLength: INPUT_LIMITS.dateRange })
      const until = optionalString(url.searchParams.get('until'), { parameter: 'until', maxLength: INPUT_LIMITS.dateRange })
      const limit = intParam(url.searchParams.get('limit'), { parameter: 'limit', fallback: 10, min: 1, max: 30 })
      const limited = await restRateLimit(env.EXPENSIVE_RATE_LIMITER, 'expensive')
      if (limited)
        return limited
      let result
      try {
        result = await searchGithubLive(env, {
          query: q,
          language,
          minStars,
          sort,
          order,
          since,
          until,
          limit,
        })
      }
      catch (e) {
        // RangeError is the date-window parser rejecting caller input; anything
        // else is a server-side fault and must not be reported as a bad request.
        if (!(e instanceof RangeError))
          throw e
        return errorResponse('invalid_date_range', e.message, 400)
      }
      return okResponse(result, { pretty: true })
    }

    if (url.pathname === '/api/capture' && req.method === 'POST') {
      if (!canWrite)
        return writeForbidden()
      const limited = await restRateLimit(env.WRITE_RATE_LIMITER, 'write')
      if (limited)
        return limited
      try {
        const body = z.object(TOOL_DEFINITIONS.capture_github_discovery.inputSchema).parse(await readJsonBody(req, { limit: INGEST_BODY_LIMIT }))
        return okResponse(await captureGithubDiscovery(env, body), { pretty: true })
      }
      catch (e) {
        if (e instanceof PayloadTooLargeError)
          return errorResponse('payload_too_large', e.message, 413)
        if (e instanceof ProbeRequestError)
          return errorResponse(e.code, e.message, e.status, { retryAfterSeconds: e.retryAfterSeconds })
        return errorResponse('invalid_request', e.message, 400)
      }
    }

    if (url.pathname === '/api/code') {
      const q = stringParam(url.searchParams.get('q'), { parameter: 'q', fallback: '', maxLength: INPUT_LIMITS.codeQuery })
      const repo = optionalString(url.searchParams.get('repo'), { parameter: 'repo', maxLength: INPUT_LIMITS.repo })
      const language = optionalString(url.searchParams.get('language'), { parameter: 'language', maxLength: INPUT_LIMITS.language })
      const extension = optionalString(url.searchParams.get('extension'), { parameter: 'extension', maxLength: INPUT_LIMITS.extension })
      const path = optionalString(url.searchParams.get('path'), { parameter: 'path', maxLength: INPUT_LIMITS.path })
      const limit = intParam(url.searchParams.get('limit'), { parameter: 'limit', fallback: 5, min: 1, max: 15 })
      const limited = await restRateLimit(env.EXPENSIVE_RATE_LIMITER, 'expensive')
      if (limited)
        return limited
      const result = await searchGithubCode(env, {
        query: q,
        repo,
        language,
        extension,
        path,
        limit,
      })
      return okResponse(result, { pretty: true })
    }

    if (url.pathname === '/api/web') {
      const q = stringParam(url.searchParams.get('q'), { parameter: 'q', fallback: '', maxLength: INPUT_LIMITS.query })
      const domain = optionalString(url.searchParams.get('domain'), { parameter: 'domain', maxLength: INPUT_LIMITS.domain })
      const freshness = enumParam(url.searchParams.get('freshness'), { parameter: 'freshness', allowed: ['all', 'day', 'week', 'month', 'year'], fallback: 'all' })
      const limit = intParam(url.searchParams.get('limit'), { parameter: 'limit', fallback: 5, min: 1, max: 10 })
      const limited = await restRateLimit(env.EXPENSIVE_RATE_LIMITER, 'expensive')
      if (limited)
        return limited
      const result = await searchWebTech(env, {
        query: q,
        domain,
        freshness,
        limit,
      })
      return okResponse(result, { pretty: true })
    }

    if (url.pathname === '/api/ingest' && req.method === 'POST') {
      if (!canWrite)
        return writeForbidden()
      const limited = await restRateLimit(env.WRITE_RATE_LIMITER, 'write')
      if (limited)
        return limited
      try {
        const body = z.object(TOOL_DEFINITIONS.star_and_ingest_repo.inputSchema).parse(await readJsonBody(req, { limit: INGEST_BODY_LIMIT }))
        const result = await starAndIngestRepo(env, body)
        // A domain failure (`invalid_repo`, `github_star_failed`, `ingest_failed`) is a failure:
        // returning it inside a 200 with `ok: true` would make the envelope contradict itself, and
        // a caller checking only the status would record a failed ingest as a success.
        if (result?.error)
          return errorResponse(result.error, result.message, INGEST_ERROR_STATUS[result.error] ?? 500)
        return okResponse(result, { pretty: true })
      }
      catch (e) {
        if (e instanceof PayloadTooLargeError)
          return errorResponse('payload_too_large', e.message, 413)
        // A body that is not JSON, or a `repo` that is missing entirely, never reaches the domain.
        return errorResponse('invalid_request', e.message, 400)
      }
    }

    // Initialize MCP Server with a deployer-selected capability profile. REST stays available;
    // MCP_TOOLSET only changes what an MCP client can discover/call through listTools.
    let activeToolset
    try {
      activeToolset = resolveToolset(env.MCP_TOOLSET)
    }
    catch (error) {
      if (error instanceof ToolsetConfigError)
        return errorResponse('server_misconfigured', error.message, 500)
      throw error
    }

    const instructionLines = [
      'Stars Radar is an open-source intelligence and GitHub stars retrieval cockpit.',
      `Active MCP toolset: ${activeToolset.name} (${activeToolset.tools.size} tools).`,
      'Core workflow:',
      '  - search_github_stars: curated personal/ingested semantic retrieval.',
      '  - get_repo_readme: repository metadata and README evidence.',
      '  - compare_repositories: compact evidence comparison for 2–5 candidates.',
      '  - list_categories / get_category_repos / list_starred_repos: browse the personal archive.',
    ]
    if (activeToolset.tools.has('search_github_live')) {
      instructionLines.push(
        'Open-world research:',
        '  - search_github_live: read-only GitHub repository discovery.',
        '  - search_github_code: concrete public code/API usage.',
        '  - search_web_tech: broader technical web research.',
        '  - get_trending_repos / get_top_skills / get_hellogithub_picks: cached community intelligence.',
      )
    }
    if (activeToolset.tools.has('capture_github_discovery')) {
      instructionLines.push(
        'Explicit mutations (only on clear user intent):',
        '  - capture_github_discovery: persist one selected discovery observation.',
        '  - star_and_ingest_repo: star and graduate a repository into curated assets.',
      )
    }
    instructionLines.push('Context management: prefer limit=5..10 and minimal fields to protect the context window.')

    // NOTE: instructions must live in the SECOND argument (ServerOptions), not serverInfo.
    const server = new McpServer(
      { name: 'Stars Radar MCP', version: VERSION },
      { instructions: instructionLines.join('\n') },
    )
    const registerTool = (name, config, handler) => {
      if (activeToolset.tools.has(name))
        server.registerTool(name, config, handler)
    }
    registerTool(
      TOOL_DEFINITIONS.search_github_stars.name,
      { description: TOOL_DEFINITIONS.search_github_stars.description, inputSchema: TOOL_DEFINITIONS.search_github_stars.inputSchema, annotations: { readOnlyHint: TOOL_DEFINITIONS.search_github_stars.readOnly } },
      async ({ query, category, source, scope = 'all', limit = 5, min_score = 0.25, explain = false }) => {
        try {
          if (scope !== 'rankings') {
            const limited = await toolRateLimit(env.EXPENSIVE_RATE_LIMITER, 'expensive')
            if (limited)
              return limited
          }
          const results = await performHybridSearch(env, query, { category, source, scope, limit, min_score, explain })
          return {
            content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
          }
        }
        catch (err) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Search failed: ${err.message || String(err)}` }],
          }
        }
      },
    )
    registerTool(
      TOOL_DEFINITIONS.get_repo_readme.name,
      { description: TOOL_DEFINITIONS.get_repo_readme.description, inputSchema: TOOL_DEFINITIONS.get_repo_readme.inputSchema, annotations: { readOnlyHint: TOOL_DEFINITIONS.get_repo_readme.readOnly } },
      async ({ repo, include_readme = true, refresh = false }) => {
        try {
          if (refresh) {
            const limited = await toolRateLimit(env.EXPENSIVE_RATE_LIMITER, 'expensive')
            if (limited)
              return limited
          }
          const result = await getRepositoryDetails(env, await researchDocuments(env), repo, { include_readme, refresh })
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        }
        catch (err) {
          return { isError: true, content: [{ type: 'text', text: err.message }] }
        }
      },
    )

    registerTool(
      TOOL_DEFINITIONS.compare_repositories.name,
      { description: TOOL_DEFINITIONS.compare_repositories.description, inputSchema: TOOL_DEFINITIONS.compare_repositories.inputSchema, annotations: { readOnlyHint: TOOL_DEFINITIONS.compare_repositories.readOnly } },
      async ({ repos, refresh = false }) => {
        try {
          if (refresh) {
            const limited = await toolRateLimit(env.EXPENSIVE_RATE_LIMITER, 'expensive')
            if (limited)
              return limited
          }
          const result = await compareRepositories(env, await researchDocuments(env), repos, { refresh })
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        }
        catch (err) {
          return { isError: true, content: [{ type: 'text', text: err.message }] }
        }
      },
    )
    registerTool(
      TOOL_DEFINITIONS.get_trending_repos.name,
      { description: TOOL_DEFINITIONS.get_trending_repos.description, inputSchema: TOOL_DEFINITIONS.get_trending_repos.inputSchema, annotations: { readOnlyHint: TOOL_DEFINITIONS.get_trending_repos.readOnly } },
      async ({ category = 'overall_daily', limit = 10 }) => {
        try {
          const rankings = await getRankings(env)
          const catalog = await getCatalog(env)
          const starredSet = new Set(Object.keys(catalog.repos || {}).map(k => k.toLowerCase()))

          let rawList = []
          if (category === 'breakout_weekly') {
            rawList = rankings.breakoutWeekly || []
          }
          else {
            rawList = rankings.trending?.[category] || []
          }

          const enriched = rawList.slice(0, limit).map((r) => {
            const isStarred = starredSet.has(r.repo.toLowerCase())
            return {
              ...r,
              is_starred: isStarred,
              badge: isStarred ? '⭐ Starred' : (category === 'breakout_weekly' ? '🚀 Breakout New' : '🔥 Trending'),
            }
          })

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                trending_category: category,
                total: enriched.length,
                repos: enriched,
              }, null, 2),
            }],
          }
        }
        catch (err) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Failed to fetch trending: ${err.message || String(err)}` }],
          }
        }
      },
    )
    registerTool(
      TOOL_DEFINITIONS.search_github_live.name,
      { description: TOOL_DEFINITIONS.search_github_live.description, inputSchema: TOOL_DEFINITIONS.search_github_live.inputSchema, annotations: { readOnlyHint: TOOL_DEFINITIONS.search_github_live.readOnly } },
      async ({ query, language, min_stars = 15, sort = 'stars', order = 'desc', since, until, limit = 10 }) => {
        try {
          const limited = await toolRateLimit(env.EXPENSIVE_RATE_LIMITER, 'expensive')
          if (limited)
            return limited
          const result = await searchGithubLive(env, { query, language, minStars: min_stars, sort, order, since, until, limit })
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          }
        }
        catch (err) {
          if (err instanceof ProbeRequestError)
            return probeToolFailure(err)
          return {
            isError: true,
            content: [{ type: 'text', text: `Live GitHub search failed: ${err.message || String(err)}` }],
          }
        }
      },
    )
    registerTool(
      TOOL_DEFINITIONS.capture_github_discovery.name,
      { description: TOOL_DEFINITIONS.capture_github_discovery.description, inputSchema: TOOL_DEFINITIONS.capture_github_discovery.inputSchema, annotations: { readOnlyHint: TOOL_DEFINITIONS.capture_github_discovery.readOnly } },
      async ({ repo, query }) => {
        if (!canWrite)
          return writeToolFailure()
        const limited = await toolRateLimit(env.WRITE_RATE_LIMITER, 'write')
        if (limited)
          return limited
        try {
          const result = await captureGithubDiscovery(env, { repo, query })
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        }
        catch (err) {
          if (err instanceof ProbeRequestError)
            return probeToolFailure(err)
          return { isError: true, content: [{ type: 'text', text: `Discovery capture failed: ${err.message || String(err)}` }] }
        }
      },
    )
    registerTool(
      TOOL_DEFINITIONS.search_github_code.name,
      { description: TOOL_DEFINITIONS.search_github_code.description, inputSchema: TOOL_DEFINITIONS.search_github_code.inputSchema, annotations: { readOnlyHint: TOOL_DEFINITIONS.search_github_code.readOnly } },
      async ({ query, repo, language, extension, path: filePath, limit = 5 }) => {
        try {
          const limited = await toolRateLimit(env.EXPENSIVE_RATE_LIMITER, 'expensive')
          if (limited)
            return limited
          const result = await searchGithubCode(env, { query, repo, language, extension, path: filePath, limit })
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          }
        }
        catch (err) {
          if (err instanceof ProbeRequestError)
            return probeToolFailure(err)
          return {
            isError: true,
            content: [{ type: 'text', text: `GitHub code search failed: ${err.message || String(err)}` }],
          }
        }
      },
    )
    registerTool(
      TOOL_DEFINITIONS.search_web_tech.name,
      { description: TOOL_DEFINITIONS.search_web_tech.description, inputSchema: TOOL_DEFINITIONS.search_web_tech.inputSchema, annotations: { readOnlyHint: TOOL_DEFINITIONS.search_web_tech.readOnly } },
      async ({ query, domain, freshness = 'all', limit = 5 }) => {
        try {
          const limited = await toolRateLimit(env.EXPENSIVE_RATE_LIMITER, 'expensive')
          if (limited)
            return limited
          const result = await searchWebTech(env, { query, domain, freshness, limit })
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          }
        }
        catch (err) {
          if (err instanceof ProbeRequestError)
            return probeToolFailure(err)
          return {
            isError: true,
            content: [{ type: 'text', text: `Web search failed: ${err.message || String(err)}` }],
          }
        }
      },
    )
    registerTool(
      TOOL_DEFINITIONS.star_and_ingest_repo.name,
      { description: TOOL_DEFINITIONS.star_and_ingest_repo.description, inputSchema: TOOL_DEFINITIONS.star_and_ingest_repo.inputSchema, annotations: { readOnlyHint: TOOL_DEFINITIONS.star_and_ingest_repo.readOnly } },
      async ({ repo, reason, categories = DEFAULT_INGEST_CATEGORIES }) => {
        if (!canWrite)
          return writeToolFailure()
        const limited = await toolRateLimit(env.WRITE_RATE_LIMITER, 'write')
        if (limited)
          return limited
        try {
          const result = await starAndIngestRepo(env, { repo, reason, categories })
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          }
        }
        catch (err) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Star and ingest failed: ${err.message || String(err)}` }],
          }
        }
      },
    )
    registerTool(
      TOOL_DEFINITIONS.get_top_skills.name,
      { description: TOOL_DEFINITIONS.get_top_skills.description, inputSchema: TOOL_DEFINITIONS.get_top_skills.inputSchema, annotations: { readOnlyHint: TOOL_DEFINITIONS.get_top_skills.readOnly } },
      async ({ type = 'all', limit = 20 }) => {
        try {
          const rankings = await getRankings(env)
          const allSkills = rankings.agentSkills || []
          const skillRepos = rankings.agentSkillRepos || []

          let list
          if (type === 'repos') {
            list = skillRepos.slice(0, limit)
          }
          else if (type === 'rising') {
            list = allSkills.filter(s => (s.tags || []).includes('rising')).slice(0, limit)
          }
          else if (type === 'trending') {
            list = allSkills.filter(s => (s.tags || []).includes('trending')).slice(0, limit)
          }
          else if (type === 'skills') {
            list = allSkills.slice(0, limit)
          }
          else {
            list = {
              top_skills: allSkills.slice(0, Math.min(limit, 25)),
              skill_repos_60d: skillRepos.slice(0, Math.min(limit, 25)),
            }
          }

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                source: 'LinklyAI 60d Multi-board + GitHub 60d Breakout Repos',
                filter: type,
                count: Array.isArray(list) ? list.length : (list.top_skills.length + list.skill_repos_60d.length),
                result: list,
              }, null, 2),
            }],
          }
        }
        catch (err) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Failed to fetch agent skills: ${err.message || String(err)}` }],
          }
        }
      },
    )
    registerTool(
      TOOL_DEFINITIONS.get_hellogithub_picks.name,
      { description: TOOL_DEFINITIONS.get_hellogithub_picks.description, inputSchema: TOOL_DEFINITIONS.get_hellogithub_picks.inputSchema, annotations: { readOnlyHint: TOOL_DEFINITIONS.get_hellogithub_picks.readOnly } },
      async ({ category, limit = 10 }) => {
        try {
          const rankings = await getRankings(env)
          let picks = rankings.helloGitHub || []
          if (category) {
            const target = category.toLowerCase().trim()
            picks = picks.filter(p => p.category?.toLowerCase().includes(target))
          }
          const sliced = picks.slice(0, limit)
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                source: 'HelloGitHub Monthly Curations',
                count: sliced.length,
                picks: sliced,
              }, null, 2),
            }],
          }
        }
        catch (err) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Failed to fetch HelloGitHub picks: ${err.message || String(err)}` }],
          }
        }
      },
    )
    registerTool(
      TOOL_DEFINITIONS.list_categories.name,
      { description: TOOL_DEFINITIONS.list_categories.description, inputSchema: TOOL_DEFINITIONS.list_categories.inputSchema, annotations: { readOnlyHint: TOOL_DEFINITIONS.list_categories.readOnly } },
      async () => {
        try {
          const catalog = await getCatalog(env)
          const enriched = enrichCategoriesWithTopRepos(catalog)
          const categories = enriched.map(c => ({
            name: c.name,
            description: c.description,
            count: c.count,
            top_repos: (c.topRepos || []).map(r => `${r.name} (⭐ ${r.stars})`),
          }))
          return {
            content: [{ type: 'text', text: JSON.stringify(categories, null, 2) }],
          }
        }
        catch (err) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Failed to list categories: ${err.message || String(err)}` }],
          }
        }
      },
    )
    registerTool(
      TOOL_DEFINITIONS.get_category_repos.name,
      { description: TOOL_DEFINITIONS.get_category_repos.description, inputSchema: TOOL_DEFINITIONS.get_category_repos.inputSchema, annotations: { readOnlyHint: TOOL_DEFINITIONS.get_category_repos.readOnly } },
      async ({ category, limit = 25 }) => {
        try {
          const catalog = await getCatalog(env)
          const targetCat = category.trim().toLowerCase()
          const matched = []

          for (const [name, info] of Object.entries(catalog.repos || {})) {
            const cats = (info.categories || []).map(c => c.toLowerCase())
            if (cats.includes(targetCat)) {
              matched.push({
                repo: name,
                stars: info.stars,
                url: info.url,
                description: info.description,
                reason: info.reason,
                summary: info.summary,
              })
            }
          }

          matched.sort((a, b) => (b.stars || 0) - (a.stars || 0))
          const sliced = matched.slice(0, limit)

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                category: targetCat,
                total_in_category: matched.length,
                returned: sliced.length,
                repos: sliced,
              }, null, 2),
            }],
          }
        }
        catch (err) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Failed to fetch category repos: ${err.message || String(err)}` }],
          }
        }
      },
    )
    registerTool(
      TOOL_DEFINITIONS.list_starred_repos.name,
      { description: TOOL_DEFINITIONS.list_starred_repos.description, inputSchema: TOOL_DEFINITIONS.list_starred_repos.inputSchema, annotations: { readOnlyHint: TOOL_DEFINITIONS.list_starred_repos.readOnly } },
      async ({ limit = 20, cursor }) => {
        try {
          const result = await listReadmePage(await getReadmeManifest(env), { limit, cursor })

          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          }
        }
        catch (err) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Failed to list repositories: ${err.message || String(err)}` }],
          }
        }
      },
    )
    registerTool(
      TOOL_DEFINITIONS.get_radar_status.name,
      { description: TOOL_DEFINITIONS.get_radar_status.description, inputSchema: TOOL_DEFINITIONS.get_radar_status.inputSchema, annotations: { readOnlyHint: TOOL_DEFINITIONS.get_radar_status.readOnly } },
      async () => {
        try {
          const [generation, catalog, rankings, readmes, vectors, harvested] = await Promise.all([
            getDataGeneration(env),
            getCatalog(env),
            getRankings(env),
            getReadmeManifest(env),
            getVectors(env),
            getHarvested(env),
          ])
          const vectorRecords = vectors?.records || []
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                workspace: 'Stars Radar',
                version: VERSION,
                data_generation: generation.id
                  ? { id: generation.id, published_at: generation.published_at, commit: generation.commit }
                  : null,
                total_starred: Object.keys(catalog.repos || {}).length,
                vector_db_capacity: vectorRecords.length,
                repo_vector_count: vectorRecords.filter(record => record.kind === 'repo').length,
                readme_chunk_vector_count: vectorRecords.filter(record => record.kind === 'readme_chunk').length,
                readme_refs: Object.keys(readmes.repos || {}).length,
                vector_dimensions: DIMS,
                vector_model: EMBEDDING_MODEL,
                vector_input_profile: vectors.inputProfile || null,
                rate_limits: rateLimitStatus(env),
                mcp_toolset: {
                  name: activeToolset.name,
                  tool_count: activeToolset.tools.size,
                  write_tools_exposed: activeToolset.tools.has('capture_github_discovery'),
                },
                intent_domains: Object.keys(defaultIntents || {}).length,
                community_layers: {
                  trending_categories: Object.keys(rankings.trending || {}).length,
                  breakout_new_stars: (rankings.breakoutWeekly || []).length,
                  hello_github_picks: (rankings.helloGitHub || []).length,
                  agent_skills: (rankings.agentSkills || []).length,
                  agent_skill_repos_60d: (rankings.agentSkillRepos || []).length,
                  harvested_ingests: harvested.length,
                },
                search_tool_hint: 'Curated+community: search_github_stars | whole-GitHub probe: search_github_live | code: search_github_code | web: search_web_tech',
              }, null, 2),
            }],
          }
        }
        catch (err) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Failed to read radar status: ${err.message || String(err)}` }],
          }
        }
      },
    )

    // MCP served on the canonical `/mcp` endpoint. `createMcpHandler` 404s any
    // path that isn't its route.
    if (url.pathname === '/mcp') {
      return createMcpHandler(server, { route: '/mcp' })(req, env, ctx)
    }

    return errorResponse('not_found', `No endpoint matches ${url.pathname}. See the endpoint table in README.md.`, 404)
  }
}

// True BAAI/bge-m3 1024-Dim Vectors + Intent & Subject Anchoring Hybrid Engine
async function researchDocuments(env) {
  const [catalog, assetIndex, harvested, readmes] = await Promise.all([
    getCatalog(env),
    getAssetIndex(env),
    getHarvested(env),
    getReadmeManifest(env),
  ])
  return { catalog, assetIndex, harvested, readmes }
}

async function attachReadmeEvidence(env, results, query) {
  const candidates = results
    .slice(0, README_EVIDENCE_MAX_RESULTS)
    .filter(result => /^[\w.-]+\/[\w.-]+$/.test(result.repo || ''))
  const manifest = await getReadmeManifest(env)

  await Promise.all(candidates.map(async (result) => {
    const ref = manifest.repos?.[result.repo.toLowerCase()]
    result.evidence = (result.evidence || []).map(item => bindReadmeEvidence(item, {
      ref,
      generation: manifest.generation,
    }))

    const readmeState = {
      status: ref?.status === 'unavailable' ? 'unavailable' : (ref?.status === 'absent' ? 'absent' : 'missing'),
      generation_id: manifest.generation?.id || null,
      readme_sha256: ref?.sha256 || null,
      preserved_from_generation: ref?.preserved_from_generation || null,
      literal_hits: 0,
    }
    try {
      if (ref?.sha256) {
        const object = await env.R2.get(readmeBlobKey(ref.sha256))
        if (object) {
          readmeState.status = ref.status === 'stale' ? 'stale' : 'ok'
          const hits = findReadmeEvidence(await object.text(), query, defaultIntents)
          readmeState.literal_hits = hits.length
          result.evidence.push(...hits.map(hit => buildReadmeEvidence({
            kind: 'readme_literal',
            repo: result.repo,
            chunkId: `literal:${ref.sha256}:${hit.section_ordinal}`,
            heading: hit.heading,
            snippet: hit.snippet,
            keywordWeight: hit.keyword_weight,
            matchedTokens: hit.matched_tokens,
            matchedSubjects: hit.matched_subjects,
            matchedIntents: hit.matched_intents,
            ref,
            generation: manifest.generation,
          })))
        }
      }
    }
    catch (error) {
      readmeState.status = 'unavailable'
      console.warn(`[README evidence] Could not read ${result.repo}: ${error.message || String(error)}`)
    }
    result.evidence_state = { readme: readmeState }
  }))

  return results
}

async function performHybridSearch(env, query, options = {}) {
  const [catalog, rankings, assetIndex, harvested] = await Promise.all([
    getCatalog(env),
    getRankings(env),
    getAssetIndex(env),
    getHarvested(env),
  ])
  let vectors = { values: null, norms: null, records: null }
  let queryVector = null
  if (options.scope !== 'rankings') {
    const loaded = await getVectors(env)
    vectors = { values: loaded.vectors, norms: loaded.norms, records: loaded.records }
    if (vectors.values && vectors.records?.length > 0)
      queryVector = await getQueryEmbedding(query, env)
  }
  const results = searchDocuments({ catalog, rankings, assetIndex, harvested, vectors, queryVector, intents: defaultIntents }, query, options)
  return options.explain ? attachReadmeEvidence(env, results, query) : results
}

async function starAndIngestRepo(env, { repo, reason, categories = DEFAULT_INGEST_CATEGORIES } = {}) {
  const cleanRepo = repo.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '')
  if (!/^[\w.-]+\/[\w.-]+$/.test(cleanRepo)) {
    return {
      error: 'invalid_repo',
      message: 'Repo must be in "owner/repo" format with valid characters.',
    }
  }

  const headers = {
    'User-Agent': 'Stars-Radar-MCP',
    'Accept': 'application/vnd.github.v3+json',
  }
  if (env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`
  }

  // Confirm the repository exists before anything is written, because the journal is permanent
  // truth: an entry recorded from a repository GitHub has never heard of is an entry no later run
  // repairs, and it folds into the hot set as a curated asset with no metadata. A typo used to be
  // reported as a success (`staged_in_radar: true`) on the strength of the format check alone.
  let repoData = null
  try {
    const repoResp = await fetch(`https://api.github.com/repos/${cleanRepo}`, { headers, signal: AbortSignal.timeout(10000) })
    if (repoResp.status === 404) {
      return {
        error: 'invalid_repo',
        message: `GitHub has no repository ${cleanRepo}. Check the owner and name; nothing was recorded.`,
      }
    }
    if (!repoResp.ok) {
      return {
        error: 'github_star_failed',
        message: `GitHub answered ${repoResp.status} for ${cleanRepo}, so its metadata could not be read; nothing was recorded.`,
      }
    }
    repoData = await repoResp.json()
  }
  catch (e) {
    return {
      error: 'github_star_failed',
      message: `Could not reach GitHub to confirm ${cleanRepo} exists (${e.message || String(e)}); nothing was recorded.`,
    }
  }

  let starredOnGitHub = false
  try {
    const starResp = await fetch(`https://api.github.com/user/starred/${cleanRepo}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Length': '0' },
      signal: AbortSignal.timeout(10000),
    })
    if (starResp.status === 204 || starResp.ok) {
      starredOnGitHub = true
    }
    else {
      // Not fatal: the repository is real and the ingest is about to be recorded. It is reported in
      // the response, so a caller can tell "did not star it" from "starred it".
      console.warn(`GitHub refused to star ${cleanRepo}: ${starResp.status} ${starResp.statusText}`)
    }
  }
  catch (e) {
    console.warn('Could not star on GitHub:', e.message)
  }

  const repoItem = {
    repo: cleanRepo,
    name: cleanRepo.split('/')[1],
    url: repoData.html_url || `https://github.com/${cleanRepo}`,
    stars: repoData.stargazers_count || 0,
    description: repoData.description || '',
    language: repoData.language || '',
    categories,
    reason: reason || `Ingested via Stars Radar on ${new Date().toISOString().slice(0, 10)}`,
    summary: repoData.description || '',
    topics: repoData.topics || [],
    created_at: repoData.created_at,
    pushed_at: repoData.pushed_at,
    ingested_at: new Date().toISOString(),
  }

  // The ingest is recorded by appending to the journal — one new object, never a replacement of
  // a document another writer owns. There is no conflict to report any more: two simultaneous
  // ingests simply produce two entries that fold into one view.
  const view = await getHarvested(env)
  let journalKey
  try {
    journalKey = await appendIngest(env, repoItem)
  }
  catch (e) {
    return {
      error: 'ingest_failed',
      message: `Could not append ${cleanRepo} to the ingest journal: ${e.message || String(e)}. GitHub star ${starredOnGitHub ? 'succeeded' : 'did not succeed'}.`,
      starred_on_github: starredOnGitHub,
    }
  }

  // Fold the new entry into the cached view so this isolate sees its own write immediately,
  // whether or not it was the isolate that served the previous requests.
  seedHarvested(foldIngestEntries([...view, { ...repoItem, by: 'worker' }]))

  return {
    success: true,
    repo: cleanRepo,
    starred_on_github: starredOnGitHub,
    staged_in_radar: true,
    journal_key: journalKey,
    badge: '⚡ Community Ingested',
    details: repoItem,
    message: `Recorded ${cleanRepo} in the ingest journal (${journalKey}). GitHub star ${starredOnGitHub ? 'succeeded' : 'did not succeed'}. This isolate can search the entry immediately in all/rankings scope; other isolates re-read the journal within ${JOURNAL_TTL_SECONDS}s. The scheduled build folds it into the asset index every 6 hours.`,
  }
}
