import process from 'node:process'
import { $fetch } from 'ofetch'
import { parseDateRange } from '../src/date-range.js'
import { buildRepositoryQuery } from '../src/github-query.js'
import { publishHarvest } from './harvest-publish.js'
import { useEnvProxy } from './outbound-proxy.js'

const GITHUB_TOKEN = process.env.GITHUB_TOKEN

const headers = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'accept': 'application/vnd.github.v3+json',
  ...(GITHUB_TOKEN ? { authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
}

export async function harvestAndIngest({
  source = 'all',
  since = '30d',
  until = null,
  limit = 20,
  language = null,
  topic = null,
} = {}, { searchRepositories = $fetch, publishMetadata = publishHarvest } = {}) {
  if (!['all', 'skills', 'breakout'].includes(source))
    throw new Error('Harvest source must be all, skills or breakout')
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Harvest limit must be an integer between 1 and 100')
  const { sinceStr, untilStr } = parseDateRange(since, until)
  console.log(`\n======================================================`)
  console.log(`  Target Source: ${source.toUpperCase()}`)
  console.log(`  Date Window  : ${sinceStr} .. ${untilStr}`)
  console.log(`  Top Limit    : ${limit}`)
  console.log('  Vector Update: queued for the next CI build')
  console.log(`======================================================\n`)

  const collected = []

  // 1. Fetch from Breakout / GitHub Search
  if (source === 'all' || source === 'breakout') {
    console.log(`[1/3] Querying GitHub for breakout repositories (${sinceStr}..${untilStr})...`)
    // 与 Worker 侧同一个构造器：`--topic` 里如果已经写了 `created:`/`stars:` 这类限定符，
    // 再注入一次会被 GitHub 以 422 拒绝。这条防护以前只有 Worker 有。
    const q = buildRepositoryQuery({
      query: topic || '',
      since: sinceStr,
      until: untilStr,
      minStars: 20,
      language,
      parseDateRange: () => ({ sinceStr, untilStr }),
    })

    try {
      const data = await searchRepositories('https://api.github.com/search/repositories', {
        query: { q, sort: 'stars', order: 'desc', per_page: Math.min(limit * 2, 100) },
        headers,
        timeout: 25000,
      })

      if (!Array.isArray(data?.items))
        throw new Error('GitHub search response is missing its repository list')
      for (const item of data.items) {
        collected.push({
          repo: item.full_name,
          name: item.name,
          url: item.html_url,
          stars: item.stargazers_count,
          description: item.description || '',
          language: item.language || '',
          created_at: item.created_at,
          pushed_at: item.pushed_at,
          license: item.license?.spdx_id || null,
          archived: item.archived,
          topics: item.topics || [],
          categories: [],
          reason: `Breakout project created on ${item.created_at?.slice(0, 10)} with ${item.stargazers_count} stars`,
          summary: item.description || '',
        })
      }
      console.log(`  ✓ Found ${collected.length} breakout repositories`)
    }
    catch (err) {
      throw new Error(`Harvest ${source} repository search failed: ${err.message || String(err)}. Nothing was published.`)
    }
  }

  // 2. Fetch from Agent Skills (60-day window)
  if (source === 'all' || source === 'skills') {
    console.log(`[2/3] Querying Agent Skills created/active in date window...`)
    const skillQuery = buildRepositoryQuery({
      query: `topic:agent-skill${topic ? ` ${topic}` : ''}`,
      since: sinceStr,
      until: untilStr,
      minStars: 10,
      language,
      parseDateRange: () => ({ sinceStr, untilStr }),
    })

    try {
      const data = await searchRepositories('https://api.github.com/search/repositories', {
        query: { q: skillQuery, sort: 'stars', order: 'desc', per_page: 50 },
        headers,
        timeout: 25000,
      })

      if (!Array.isArray(data?.items))
        throw new Error('GitHub search response is missing its repository list')
      for (const item of data.items) {
        if (!collected.some(c => c.repo.toLowerCase() === item.full_name.toLowerCase())) {
          collected.push({
            repo: item.full_name,
            name: item.name,
            url: item.html_url,
            stars: item.stargazers_count,
            description: item.description || '',
            language: item.language || '',
            created_at: item.created_at,
            pushed_at: item.pushed_at,
            license: item.license?.spdx_id || null,
            archived: item.archived,
            topics: item.topics || [],
            categories: [],
            reason: `Agent Skill repository created on ${item.created_at?.slice(0, 10)} with ${item.stargazers_count} stars`,
            summary: item.description || '',
          })
        }
      }
      console.log(`  ✓ Aggregated skills; total items pool: ${collected.length}`)
    }
    catch (err) {
      throw new Error(`Harvest skills search failed: ${err.message || String(err)}. Nothing was published.`)
    }
  }

  // Deduplicate and sort by stars desc
  const uniqueMap = new Map()
  for (const c of collected) {
    if (!uniqueMap.has(c.repo.toLowerCase())) {
      uniqueMap.set(c.repo.toLowerCase(), c)
    }
  }
  const topList = Array.from(uniqueMap.values())
    .sort((a, b) => (b.stars || 0) - (a.stars || 0))
    .slice(0, limit)

  // 3. Print Report
  console.log(`\n======================================================`)
  console.log(`  HARVEST REPORT: Top ${topList.length} Repositories Found`)
  console.log(`======================================================\n`)

  for (let i = 0; i < topList.length; i++) {
    const item = topList[i]
    const lang = item.language ? ` [${item.language}]` : ''
    const stars = `⭐ ${(item.stars || 0).toLocaleString()}`
    const created = item.created_at ? ` (${item.created_at.slice(0, 10)})` : ''
    console.log(`[${i + 1}] ${item.repo} ${stars}${lang}${created}`)
    if (item.description) {
      console.log(`    📝 ${item.description.slice(0, 100)}`)
    }
    console.log(`    🔗 ${item.url}\n`)
  }

  const journalKey = topList.length > 0 ? await publishMetadata(topList) : null
  console.log(`Recorded ${topList.length} repositories${journalKey ? ` in ${journalKey}` : ''}. Vector generation and publication run in the next CI build.`)

  return {
    source,
    dateRange: `${sinceStr}..${untilStr}`,
    count: topList.length,
    repos: topList,
    journal_key: journalKey,
    vector_status: topList.length > 0 ? 'queued_for_ci' : 'no_repositories',
  }
}

// CLI entry point
if (process.argv[1]?.endsWith('harvest_and_ingest.js')) {
  useEnvProxy()

  const args = process.argv.slice(2)
  let source = 'all'
  let since = '14d'
  let until = null
  let limit = 15
  let language = null
  let topic = null

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source' && args[i + 1])
      source = args[++i]
    else if (args[i] === '--since' && args[i + 1])
      since = args[++i]
    else if (args[i] === '--until' && args[i + 1])
      until = args[++i]
    else if (args[i] === '--limit' && args[i + 1])
      limit = Number(args[++i])
    else if (args[i] === '--language' && args[i + 1])
      language = args[++i]
    else if (args[i] === '--topic' && args[i + 1])
      topic = args[++i]
  }

  harvestAndIngest({ source, since, until, limit, language, topic })
    .then(() => console.log('Done harvest and ingest.'))
    .catch((e) => {
      console.error('Harvest failed:', e.message || String(e))
      process.exitCode = 1
    })
}
