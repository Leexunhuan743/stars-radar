import assert from 'node:assert/strict'
// Tests for the community-ranking parsers.
//
// These read third-party HTML, markdown and CSV whose shape we do not control, and every
// one of them fails *softly* in fetch_rankings.js: the error is caught and yesterday's
// cached list is retained, so a markup change degrades silently. That is exactly the kind
// of code that needs its own tests, and the fixtures below are modelled on the real shapes.
import { test } from 'node:test'
import { parseHelloGitHubMarkdown, parseSkillsCsv, parseTrendingHtml } from '../scripts/rankings_parsers.js'

const TRENDING_HTML = `
<div>
<article class="Box-row">
  <h2 class="h3 lh-condensed">
    <a href="/acme/rocket">
      <span>acme / rocket</span>
    </a>
  </h2>
  <p class="col-9 color-fg-muted my-1 pr-4">A rocket &amp; a <em>bicycle</em></p>
  <span itemprop="programmingLanguage">Rust</span>
  <a href="/acme/rocket/stargazers">12,345</a>
  <span class="d-inline-block float-sm-right">1,234 stars today</span>
</article>
<article class="Box-row">
  <h2 class="h3 lh-condensed"><a href="/other/tool"><span>other / tool</span></a></h2>
  <p class="col-9 color-fg-muted my-1 pr-4">No language, no star count</p>
  <span class="d-inline-block float-sm-right">99 stars this week</span>
</article>
<article class="Box-row">
  <span>no repository link at all</span>
</article>
</div>
`

test('trending markup yields one entry per repository row', () => {
  const repos = parseTrendingHtml(TRENDING_HTML)
  assert.equal(repos.length, 2, 'the row without a repository link is skipped')
  assert.deepEqual(repos.map(r => r.repo), ['acme/rocket', 'other/tool'])
})

test('trending markup extracts description, language, total stars and the gain', () => {
  const [first] = parseTrendingHtml(TRENDING_HTML)
  assert.equal(first.url, 'https://github.com/acme/rocket')
  assert.equal(first.description, 'A rocket & a bicycle', 'inline tags are stripped and entities are decoded')
  assert.equal(first.language, 'Rust')
  assert.equal(first.stars, 12345, 'the thousands separator must not truncate the number')
  assert.equal(first.starsGain, '+1,234 today', 'the gain is the count plus the period the page stated')
})

test('trending markup decodes the entities GitHub leaves in descriptions', () => {
  const html = `<article class="Box-row">
    <h2><a href="/acme/rocket">acme / rocket</a></h2>
    <p class="col-9">Tom &amp; Jerry &lt;3 &quot;quoted&quot; &#39;apos&#39; a&nbsp;b &copy; 2024</p>
  </article>`
  const [first] = parseTrendingHtml(html)

  // The description reaches rankings.json verbatim, so an escaped ampersand would be shown
  // to the client as `&amp;`. An entity with no mapping is left alone rather than mangled.
  assert.equal(first.description, 'Tom & Jerry <3 "quoted" \'apos\' a b &copy; 2024')
})

test('trending markup decodes entities after stripping tags', () => {
  const html = `<article class="Box-row">
    <h2><a href="/acme/rocket">acme / rocket</a></h2>
    <p class="col-9">use &lt;div&gt; here<br>and here</p>
  </article>`
  const [first] = parseTrendingHtml(html)

  assert.equal(first.description, 'use <div> hereand here', 'escaped markup is text; the real <br> is stripped')
})

test('trending markup degrades to empty fields rather than failing', () => {
  const [, second] = parseTrendingHtml(TRENDING_HTML)
  assert.equal(second.language, '')
  assert.equal(second.stars, 0)
  assert.equal(second.description, 'No language, no star count')
  assert.equal(second.starsGain, '+99 this week')
})

test('trending markup with no rows returns an empty list', () => {
  assert.deepEqual(parseTrendingHtml('<html><body>nothing here</body></html>'), [])
})

const HELLOGITHUB_MD = `
# HelloGitHub 第 100 期

### C 项目

1、[curl](https://github.com/curl/curl): 命令行工具与库
2、[redis](https://github.com/redirect?target=https%3A%2F%2Fgithub.com%2Fredis%2Fredis&utm=hello): 内存数据库
3、[not-github](https://example.com/thing): 不在 GitHub 上

### Python 项目

1、[rich](https://github.com/Textualize/rich): 终端富文本
`

test('HelloGitHub markdown yields one pick per numbered GitHub entry', () => {
  const picks = parseHelloGitHubMarkdown(HELLOGITHUB_MD, 'HelloGitHub100.md')
  assert.deepEqual(picks.map(p => p.repo), ['curl/curl', 'redis/redis', 'Textualize/rich'])
  assert.equal(picks.length, 3, 'the non-GitHub link is skipped')
})

test('HelloGitHub markdown unwraps the tracked redirect to the real repository', () => {
  const [, redis] = parseHelloGitHubMarkdown(HELLOGITHUB_MD, 'HelloGitHub100.md')
  assert.equal(redis.repo, 'redis/redis')
  assert.equal(redis.url, 'https://github.com/redis/redis')
})

test('HelloGitHub markdown tracks the category heading and the issue name', () => {
  const picks = parseHelloGitHubMarkdown(HELLOGITHUB_MD, 'HelloGitHub100.md')
  assert.deepEqual(picks.map(p => p.category), ['C', 'C', 'Python'], 'the trailing 项目 is stripped from the heading')
  assert.ok(picks.every(p => p.issue === 'HelloGitHub100'))
  assert.equal(picks[0].name, 'curl')
  assert.equal(picks[0].description_zh, '命令行工具与库')
})

test('HelloGitHub markdown before any heading falls back to a General category', () => {
  const picks = parseHelloGitHubMarkdown('1、[a](https://github.com/a/b): x\n', 'HelloGitHub1.md')
  assert.equal(picks[0].category, 'General')
})

const SKILLS_CSV = [
  'rank,skill,vendor,url,description,description_zh,installs_skillssh',
  '1,"multi-search-engine",acme,https://example.com/a,"Federated, multi-engine search",多引擎搜索,"312,972"',
  '2,plain-skill,,https://example.com/b,No vendor,,',
  '3,,ghost,https://example.com/c,Row without a skill name,,',
  '',
].join('\n')

test('skills CSV yields one row per named entry', () => {
  const rows = parseSkillsCsv(SKILLS_CSV, 'best')
  assert.deepEqual(rows.map(r => r.skill), ['multi-search-engine', 'plain-skill'], 'a row with no skill name is skipped')
  assert.deepEqual(rows.map(r => r.rank), [1, 2])
  assert.deepEqual(rows.map(r => r.tags), [['best'], ['best']])
})

test('skills CSV keeps commas that sit inside a quoted cell', () => {
  const [first] = parseSkillsCsv(SKILLS_CSV, 'best')
  assert.equal(first.description, 'Federated, multi-engine search')
  assert.equal(first.description_zh, '多引擎搜索')
  assert.equal(first.vendor, 'acme', 'the quoted name does not shift the later columns')
})

test('skills CSV reads installs from either published column and drops separators', () => {
  const [first] = parseSkillsCsv(SKILLS_CSV, 'best')
  assert.equal(first.installs, 312972)
  const [viaOther] = parseSkillsCsv('rank,skill,downloads_skillhub_cn\n1,x,1234\n', 'rising')
  assert.equal(viaOther.installs, 1234)
})

test('skills CSV leaves the rank undefined when the board omits the column', () => {
  // The caller numbers such rows by its merged-set size, so the parser must not invent one.
  const rows = parseSkillsCsv('skill,vendor\nfirst,v\nsecond,v\n', 'official')
  assert.deepEqual(rows.map(r => r.rank), [undefined, undefined])
  assert.deepEqual(rows.map(r => r.skill), ['first', 'second'])
})

test('skills CSV tolerates an empty body and a missing installs column', () => {
  assert.deepEqual(parseSkillsCsv('rank,skill\n', 'best'), [])
  const [row] = parseSkillsCsv('rank,skill\n1,x\n', 'best')
  assert.equal(row.installs, undefined)
  assert.equal(row.vendor, '')
})
