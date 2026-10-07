import { Buffer } from 'node:buffer'
import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import { $fetch } from 'ofetch'
import { parseDateRange } from '../src/date-range.js'
import { LOCAL_RANKINGS_DIR, RANKINGS_KEY } from '../src/object-keys.js'
import { COMMUNITY_SOURCES, emptyRankings, emptySourceReport, recordSource } from '../src/rankings-document.js'
import { mergeBoardSkills, selectRecentIssues } from './rankings_merge.js'
import { parseHelloGitHubMarkdown, parseSkillsCsv, parseTrendingHtml } from './rankings_parsers.js'

// One clock per run: every layer fetched in this run reports the same fetch time.
const now = () => new Date().toISOString()

const GITHUB_TOKEN = process.env.GITHUB_TOKEN

const headers = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  ...(GITHUB_TOKEN ? { authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
}

// Module 1: GitHub Trending Scraper
async function fetchGitHubTrending(cached = {}, sources = emptySourceReport()) {
  console.log('Fetching GitHub Trending (daily & weekly)...')
  const targets = [
    { name: 'overall_daily', url: 'https://github.com/trending?since=daily' },
    { name: 'overall_weekly', url: 'https://github.com/trending?since=weekly' },
    { name: 'rust_weekly', url: 'https://github.com/trending/rust?since=weekly' },
    { name: 'python_weekly', url: 'https://github.com/trending/python?since=weekly' },
    { name: 'typescript_weekly', url: 'https://github.com/trending/typescript?since=weekly' },
    { name: 'go_weekly', url: 'https://github.com/trending/go?since=weekly' },
    { name: 'cpp_weekly', url: 'https://github.com/trending/c++?since=weekly' },
    { name: 'csharp_weekly', url: 'https://github.com/trending/c%23?since=weekly' },
  ]

  const results = { ...cached }
  let freshCount = 0
  let retainedCount = 0
  let lastError

  for (const target of targets) {
    try {
      const html = await $fetch(target.url, { headers, timeout: 25000, retry: 2, retryDelay: 1000 })
      const repos = parseTrendingHtml(html)

      if (repos.length > 0) {
        results[target.name] = repos
        console.log(`  ✓ ${target.name}: ${repos.length} repos`)
        freshCount += 1
      }
      else {
        retainedCount += 1
      }
    }
    catch (err) {
      retainedCount += 1
      lastError = err.message || String(err)
      console.warn(`  ✗ Failed to fetch trending for ${target.name}, retaining cache: ${lastError}`)
    }
  }

  recordSource(sources, 'trending', retainedCount === 0
    ? { status: 'fresh', count: freshCount, at: now() }
    : { status: 'retained', count: Object.keys(results).length, at: now(), previous: sources.trending, error: lastError })

  return results
}

// Module 2: GitHub Language Top Starred Repositories (Search API)
async function fetchTopStarred(cached = {}, sources = emptySourceReport()) {
  console.log('Fetching Top Starred Repositories (Search API)...')
  if (!GITHUB_TOKEN) {
    console.warn('  ⚠ No GITHUB_TOKEN provided, skipping Top Starred search.')
    recordSource(sources, 'topStarred', { status: 'retained', count: Object.keys(cached).length, at: now(), previous: sources.topStarred, error: 'no GITHUB_TOKEN' })
    return cached
  }

  const languages = ['rust', 'typescript', 'python', 'go']
  const results = { ...cached }
  let freshCount = 0
  let retainedCount = 0
  let lastError

  for (const lang of languages) {
    try {
      const data = await $fetch('https://api.github.com/search/repositories', {
        query: {
          q: `stars:>10000 language:${lang}`,
          sort: 'stars',
          order: 'desc',
          per_page: 50,
        },
        headers: {
          ...headers,
          accept: 'application/vnd.github.v3+json',
        },
        timeout: 20000,
      })

      results[lang] = (data.items || []).map((item, idx) => ({
        rank: idx + 1,
        repo: item.full_name,
        url: item.html_url,
        stars: item.stargazers_count,
        description: item.description || '',
        language: item.language || lang,
        topics: item.topics || [],
      }))
      console.log(`  ✓ Top ${lang}: ${results[lang].length} repos`)
      freshCount += 1
      await new Promise(r => setTimeout(r, 1500))
    }
    catch (err) {
      retainedCount += 1
      lastError = err.message || String(err)
      console.warn(`  ✗ Failed to fetch Top Starred for ${lang}, retaining cache: ${lastError}`)
    }
  }

  recordSource(sources, 'topStarred', retainedCount === 0
    ? { status: 'fresh', count: freshCount, at: now() }
    : { status: 'retained', count: Object.keys(results).length, at: now(), previous: sources.topStarred, error: lastError })

  return results
}

// Module 3: HelloGitHub Curated Monthly Picks
async function fetchHelloGitHub(cached = [], sources = emptySourceReport()) {
  console.log('Fetching HelloGitHub Monthly Picks...')
  const picks = []
  let lastError
  try {
    const files = await $fetch('https://api.github.com/repos/521xueweihan/HelloGitHub/contents/content', {
      headers: {
        ...headers,
        accept: 'application/vnd.github.v3+json',
      },
      timeout: 20000,
    })

    const issueFiles = selectRecentIssues(files)

    for (const issue of issueFiles) {
      let rawContent = ''
      if (issue.download_url) {
        try {
          rawContent = await $fetch(issue.download_url, { headers, timeout: 20000 })
        }
        catch {
          // Fallback via API content
          const fileData = await $fetch(`https://api.github.com/repos/521xueweihan/HelloGitHub/contents/content/${issue.name}`, {
            headers: { ...headers, accept: 'application/vnd.github.v3+json' },
            timeout: 20000,
          })
          rawContent = Buffer.from(fileData.content, 'base64').toString('utf-8')
        }
      }

      picks.push(...parseHelloGitHubMarkdown(rawContent, issue.name))
      console.log(`  ✓ ${issue.name}: extracted picks`)
    }

    if (picks.length > 0) {
      recordSource(sources, 'helloGitHub', { status: 'fresh', count: picks.length, at: now() })
      return picks
    }
  }
  catch (err) {
    lastError = err.message || String(err)
    console.warn(`  ✗ Failed to fetch HelloGitHub, retaining cache: ${lastError}`)
  }

  const retained = cached.length > 0 ? cached : picks
  recordSource(sources, 'helloGitHub', { status: 'retained', count: retained.length, at: now(), previous: sources.helloGitHub, error: lastError || 'the upstream returned nothing' })
  return retained
}

// Module 4: Agent Skills Leaderboard (LinklyAI/best-skills - Multi-board 60d Aggregation)
async function fetchAgentSkills(cached = [], sources = emptySourceReport()) {
  console.log('Fetching Agent Skills Leaderboards (LinklyAI 60d Multi-board)...')
  const skillFiles = [
    { file: 'rising-stars.csv', tag: 'rising' },
    { file: 'trending-7d.csv', tag: 'trending' },
    { file: 'best-100.csv', tag: 'best' },
    { file: 'top-installs.csv', tag: 'top_installs' },
    { file: 'official-100.csv', tag: 'official' },
  ]

  const boardRows = []

  for (const { file, tag } of skillFiles) {
    try {
      const res = await $fetch(`https://api.github.com/repos/LinklyAI/best-skills/contents/data/latest/rankings/${file}`, {
        headers: {
          ...headers,
          accept: 'application/vnd.github.v3+json',
        },
        timeout: 20000,
      })
      const csvText = Buffer.from(res.content, 'base64').toString('utf-8')

      boardRows.push(parseSkillsCsv(csvText, tag))
    }
    catch (err) {
      console.warn(`  ✗ Failed to fetch ${file}: ${err.message || String(err)}`)
    }
  }

  const result = mergeBoardSkills(boardRows)
  if (result.length > 0) {
    console.log(`  ✓ Aggregated ${result.length} unique Agent Skills across 60d leaderboards`)
    recordSource(sources, 'agentSkills', { status: 'fresh', count: result.length, at: now() })
    return result
  }

  const retained = cached.length > 0 ? cached : result
  recordSource(sources, 'agentSkills', { status: 'retained', count: retained.length, at: now(), previous: sources.agentSkills, error: 'no board yielded rows' })
  return retained
}

// Module 5: Open-Source Agent Skill Repositories Born in Past 60 Days (GitHub Search)
async function fetchAgentSkillRepos(cached = [], sources = emptySourceReport()) {
  console.log('Fetching Open-Source Agent Skill Repositories (Born in Past 60 Days)...')
  if (!GITHUB_TOKEN) {
    console.warn('  ⚠ No GITHUB_TOKEN provided, skipping Skill Repos search.')
    return cached
  }

  const sixtyDaysAgo = parseDateRange('60d').sinceStr
  const queries = [
    `topic:agent-skill created:>${sixtyDaysAgo} stars:>10`,
    `topic:claude-skill created:>${sixtyDaysAgo} stars:>10`,
    `topic:agent-skills created:>${sixtyDaysAgo} stars:>10`,
    `"claude skill" created:>${sixtyDaysAgo} stars:>15`,
  ]

  const repoMap = new Map()
  for (const q of queries) {
    try {
      const data = await $fetch('https://api.github.com/search/repositories', {
        query: {
          q,
          sort: 'stars',
          order: 'desc',
          per_page: 50,
        },
        headers: {
          ...headers,
          accept: 'application/vnd.github.v3+json',
        },
        timeout: 25000,
      })

      for (const item of (data.items || [])) {
        if (!repoMap.has(item.full_name)) {
          repoMap.set(item.full_name, {
            repo: item.full_name,
            url: item.html_url,
            stars: item.stargazers_count,
            description: item.description || '',
            language: item.language || '',
            created_at: item.created_at,
            topics: item.topics || [],
          })
        }
      }
      await new Promise(r => setTimeout(r, 1000))
    }
    catch (err) {
      console.warn(`  ✗ Failed querying skill repos for "${q}": ${err.message || String(err)}`)
    }
  }

  const list = Array.from(repoMap.values()).sort((a, b) => b.stars - a.stars)
  if (list.length > 0) {
    console.log(`  ✓ Collected ${list.length} Agent Skill repositories born in past 60 days`)
    recordSource(sources, 'agentSkillRepos', { status: 'fresh', count: list.length, at: now() })
    return list
  }

  const retainedRepos = cached.length > 0 ? cached : list
  recordSource(sources, 'agentSkillRepos', { status: 'retained', count: retainedRepos.length, at: now(), previous: sources.agentSkillRepos, error: 'no query yielded repositories' })
  return retainedRepos
}

// Module 6: Breakout New Stars (Born in Past 14 Days)
async function fetchBreakoutWeekly(cached = [], sources = emptySourceReport()) {
  console.log('Fetching Breakout New Stars (Born in Past 14 Days)...')
  if (!GITHUB_TOKEN) {
    console.warn('  ⚠ No GITHUB_TOKEN provided, skipping Breakout Weekly search.')
    return cached
  }

  const daysAgo = parseDateRange('14d').sinceStr
  try {
    const data = await $fetch('https://api.github.com/search/repositories', {
      query: {
        q: `created:>${daysAgo} stars:>40`,
        sort: 'stars',
        order: 'desc',
        per_page: 100,
      },
      headers: {
        ...headers,
        accept: 'application/vnd.github.v3+json',
      },
      timeout: 25000,
    })

    const items = (data.items || []).map((item, idx) => ({
      rank: idx + 1,
      repo: item.full_name,
      url: item.html_url,
      stars: item.stargazers_count,
      description: item.description || '',
      language: item.language || '',
      created_at: item.created_at,
      topics: item.topics || [],
    }))
    console.log(`  ✓ Breakout Weekly: ${items.length} new repos born in past 14 days`)
    recordSource(sources, 'breakoutWeekly', { status: 'fresh', count: items.length, at: now() })
    return items
  }
  catch (err) {
    console.warn(`  ✗ Failed to fetch Breakout Weekly, retaining cache: ${err.message || String(err)}`)
    recordSource(sources, 'breakoutWeekly', { status: 'retained', count: cached.length, at: now(), previous: sources.breakoutWeekly, error: err.message || String(err) })
    return cached
  }
}

// Reads the community document this run extends.
//
// The distinction matters and used to be blurred: an *absent* baseline is the normal first-run
// state now that the document lives on R2 (the scheduled build downloads it, and on the first run
// there is nothing to download), while an *unreadable* one is a corrupt document — rebuilding
// from an empty baseline in that case would republish every layer as empty. Exported so both
// behaviours are covered by tests without reaching the network.
export function readRankingsBaseline(rankingsPath = path.join(LOCAL_RANKINGS_DIR, RANKINGS_KEY)) {
  if (!fs.existsSync(rankingsPath)) {
    console.log(`No ${rankingsPath} yet: starting from an empty baseline (first run).`)
    return emptyRankings()
  }
  try {
    return fs.readJsonSync(rankingsPath)
  }
  catch (e) {
    throw new Error(
      `Could not read ${rankingsPath}: ${e.message}. Refusing to rebuild the community layers `
      + `from an empty baseline.`,
    )
  }
}

// Main Runner with Graceful Degradation & Fallback Caching
export async function collectAllRankings() {
  console.log('=== Collecting Multi-Source Community Rankings ===')

  const oldRankings = readRankingsBaseline()

  // Provenance for this run, carried forward from the previous document so a layer that falls back
  // keeps the timestamp of the run that actually fetched it.
  const sources = { ...emptySourceReport(), ...(oldRankings.sources || {}) }

  const [trendingRes, topStarredRes, helloGitHubRes, agentSkillsRes, skillReposRes, breakoutRes] = await Promise.allSettled([
    fetchGitHubTrending(oldRankings.trending || {}, sources),
    fetchTopStarred(oldRankings.topStarred || {}, sources),
    fetchHelloGitHub(oldRankings.helloGitHub || [], sources),
    fetchAgentSkills(oldRankings.agentSkills || [], sources),
    fetchAgentSkillRepos(oldRankings.agentSkillRepos || [], sources),
    fetchBreakoutWeekly(oldRankings.breakoutWeekly || [], sources),
  ])

  const rankings = {
    ...emptyRankings(),
    // `updatedAt` is when this document was built, which happens every run whether or not a layer
    // was refreshed; `sources` is what says whether the data inside is this run's.
    updatedAt: now(),
    sources,
    trending: trendingRes.status === 'fulfilled' ? trendingRes.value : (oldRankings.trending || {}),
    topStarred: topStarredRes.status === 'fulfilled' ? topStarredRes.value : (oldRankings.topStarred || {}),
    helloGitHub: helloGitHubRes.status === 'fulfilled' ? helloGitHubRes.value : (oldRankings.helloGitHub || []),
    agentSkills: agentSkillsRes.status === 'fulfilled' ? agentSkillsRes.value : (oldRankings.agentSkills || []),
    agentSkillRepos: skillReposRes.status === 'fulfilled' ? skillReposRes.value : (oldRankings.agentSkillRepos || []),
    breakoutWeekly: breakoutRes.status === 'fulfilled' ? breakoutRes.value : (oldRankings.breakoutWeekly || []),
  }

  const stale = COMMUNITY_SOURCES.filter(name => sources[name]?.status !== 'fresh')
  if (stale.length > 0)
    console.log(`⚠ ${stale.length} community layer(s) were not refreshed this run: ${stale.join(', ')}`)

  fs.ensureDirSync(LOCAL_RANKINGS_DIR)
  const published = path.join(LOCAL_RANKINGS_DIR, RANKINGS_KEY)
  fs.writeJsonSync(published, rankings, { spaces: 2 })
  console.log(`✓ Wrote ${published} successfully with fallback guarantees.`)
  return rankings
}
