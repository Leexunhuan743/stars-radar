// Parsers for the community-ranking sources.
//
// These read third-party HTML, markdown and CSV whose shape we do not control, and every
// one of them fails *softly*: fetch_rankings.js catches the error and keeps yesterday's
// cached list, so a markup change degrades silently instead of breaking the build. That
// makes them worth testing directly, which is why they live here rather than inline in the
// fetching code that cannot be exercised without network access.

// GitHub renders these as entities even in plain descriptions, and the caller writes the
// description straight into rankings.json, so an undecoded `&amp;` reaches the client.
// Everything else on the page is UTF-8, so a complete entity table would be dead weight.
const HTML_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', '\''],
  ['#39', '\''],
  ['nbsp', ' '],
])

function decodeHtmlEntities(text) {
  return text.replace(/&(#?\w+);/g, (entity, name) => HTML_ENTITIES.get(name) ?? entity)
}

/** GitHub Trending page -> repos. */
export function parseTrendingHtml(html) {
  const articles = html.match(/<article class="Box-row">[\s\S]*?<\/article>/g) || []
  const repos = []

  for (const art of articles) {
    const mH2 = art.match(/<h2[^>]*>[\s\S]*?href="\/([^"/]+\/[^"/]+)"/)
    if (!mH2)
      continue
    const repo = mH2[1].trim()

    // Tags first, entities second: `&lt;div&gt;` is escaped text, not markup to strip.
    const mDesc = art.match(/<p class="[^"]*col-9[^"]*">([\s\S]*?)<\/p>/)
    const desc = mDesc ? decodeHtmlEntities(mDesc[1].replace(/<[^>]+>/g, '')).trim() : ''

    const mLang = art.match(/itemprop="programmingLanguage">([^<]+)</)
    const lang = mLang ? mLang[1].trim() : ''

    const mStars = art.match(/(\d[\d,]*)\s*stars (today|this week|this month)/)
    const starsGain = mStars ? `+${mStars[1]} ${mStars[2]}` : ''

    const mTotal = art.match(/href="\/[^"/]+\/[^"/]+\/stargazers"[^>]*>([\s\S]*?)<\/a>/)
    let starsTotal = 0
    if (mTotal) {
      const cleanText = mTotal[1].replace(/<[^>]+>/g, '').trim()
      const numMatch = cleanText.match(/[\d,]+/)
      if (numMatch)
        starsTotal = Number(numMatch[0].replace(/,/g, ''))
    }

    repos.push({
      repo,
      url: `https://github.com/${repo}`,
      description: desc,
      language: lang,
      stars: starsTotal,
      starsGain,
    })
  }

  return repos
}

/**
 * HelloGitHub issue markdown -> curated picks.
 *
 * Entries look like `1、[Name](url): 中文描述` grouped under `### 分类项目` headings, and
 * the link is usually a tracked redirect carrying the real repository in `?target=`.
 */
export function parseHelloGitHubMarkdown(rawContent, issueName) {
  const picks = []
  // Entries before the first `### ` heading belong to no named section.
  let currentCategory = 'General'

  for (const line of rawContent.split(/\r?\n/)) {
    if (line.startsWith('### ')) {
      currentCategory = line.replace(/^###\s*/, '').replace(/项目$/, '').trim()
      continue
    }
    if (!/^\d+、\[[^\]]+\]\([^)]+\)[:：]/.test(line))
      continue

    const m = line.match(/^\d+、\[([^\]]+)\]\(([^)]+)\)[:：](.*)/)
    const targetUrl = m[2]
    const descZh = m[3].trim()

    let repoUrl = targetUrl
    const targetIdx = targetUrl.indexOf('target=')
    if (targetIdx > 0) {
      const rawTarget = targetUrl.slice(targetIdx + 7).split('&')[0]
      repoUrl = decodeURIComponent(rawTarget)
    }

    const mRepo = repoUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)/)
    if (mRepo) {
      picks.push({
        repo: mRepo[1],
        url: mRepo[0],
        name: m[1],
        description_zh: descZh,
        category: currentCategory,
        issue: issueName.replace(/\.md$/, ''),
      })
    }
  }

  return picks
}

const CSV_COLUMNS = ['rank', 'skill', 'vendor', 'url', 'description', 'description_zh']

/**
 * One LinklyAI leaderboard CSV -> skill rows tagged with the board it came from.
 *
 * Installs are read from whichever of the two install columns the board happens to
 * publish, and every cell is unquoted because the upstream files quote inconsistently.
 * `rank` is left undefined when the board omits the column: the caller numbers such rows
 * by its merged-set size, which is state this per-file parser cannot know.
 */
export function parseSkillsCsv(csvText, tag) {
  const lines = csvText.split(/\r?\n/)
  const header = lines[0]?.split(',') || []
  const idx = Object.fromEntries(CSV_COLUMNS.map(name => [name, header.indexOf(name)]))
  idx.installs = header.includes('installs_skillssh') ? header.indexOf('installs_skillssh') : header.indexOf('downloads_skillhub_cn')

  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim()
    if (!line)
      continue
    // Split on commas that are not inside a quoted cell.
    const cols = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/)
    const name = cols[idx.skill]?.replace(/^"|"$/g, '').trim()
    if (!name)
      continue

    rows.push({
      rank: Number(cols[idx.rank]) || undefined,
      skill: name,
      vendor: cols[idx.vendor]?.replace(/^"|"$/g, '').trim() || '',
      url: cols[idx.url]?.replace(/^"|"$/g, '').trim() || '',
      description: cols[idx.description]?.replace(/^"|"$/g, '').trim() || '',
      description_zh: cols[idx.description_zh]?.replace(/^"|"$/g, '').trim() || '',
      installs: Number(cols[idx.installs]?.replace(/\D/g, '')) || undefined,
      tags: [tag],
    })
  }

  return rows
}
