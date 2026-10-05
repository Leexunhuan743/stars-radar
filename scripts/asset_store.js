// Stars Radar 统一资产库累积器 (Asset Store Accumulator)
//
// 把多个数据源增量合并成单一的资产 JSON 主库：
//   - asset-state.json        → 全量持久化状态 (所有 repo 累积元数据, 跨运行保留)
//   - catalog.json            → tier='starred' (个人 Star, 高信任)
//   - rankings.json           → tier='community' (社区榜单各通道)
//   - state/probe-captures/*.jsonl → tier='discovered' (探针捕获, 仅元数据)
//
// 输出:
//   - asset-index.json        → 热集索引 (starred+curated+community, 载内存)。这是 Worker
//                               运行时唯一读取的资产文件, 由 CI 上传 R2。
//   - asset-meta.json         → 版本/计数摘要。Worker 从不读取, 仅供本地与 CI 核查,
//                               因此不上传 R2。
//
// 增量语义 (依赖 asset-state.json 持久化, 否则跨运行重置):
//   - first_seen_at / last_seen_at 保留与更新
//   - tier 晋升: discovered -> community (跨查询确认) -> curated (用户收割)
//   - trending_count = 不同自然周上榜次数 (跨周累积)
//   - probe_hits / probe_queries 跨运行保留 (跨查询确认晋升依赖)
//   - source_channels 累积
//
// 用法:
//   node scripts/asset_store.js          # 从本地 sources 构建并写 asset-index.json

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import fs from 'fs-extra'
import { ASSET_ROW_FIELDS, HOT_TIERS, hotSetRow, mergeAssetRow } from '../src/asset-row.js'
import { foldIngestEntries, foldJournalFiles } from '../src/ingest-journal.js'
import {
  ASSET_INDEX_KEY,
  ASSET_STATE_KEY,
  CATALOG_KEY,
  INGEST_JOURNAL_PREFIX,
  LOCAL_RANKINGS_DIR,
  PREVIOUS_ASSET_INDEX_FILE,
  PROBE_CAPTURE_PREFIX,
  RANKINGS_KEY,
} from '../src/object-keys.js'
import { termMatcher } from '../src/scoring.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 数据源根路径: 默认项目根; 测试/CI 可用 ASSET_STORE_ROOT 覆盖到隔离目录, 避免污染真实 asset-state.json (G1)
const PROJECT_ROOT = process.env.ASSET_STORE_ROOT
  ? path.resolve(process.env.ASSET_STORE_ROOT)
  : path.resolve(__dirname, '..')

const STATE_PATH = path.resolve(PROJECT_ROOT, ASSET_STATE_KEY)
const INDEX_PATH = path.resolve(PROJECT_ROOT, ASSET_INDEX_KEY)
const META_PATH = path.resolve(PROJECT_ROOT, 'asset-meta.json')
const PREVIOUS_INDEX_PATH = path.resolve(PROJECT_ROOT, PREVIOUS_ASSET_INDEX_FILE)

// 意图词表是 Worker 与管线共用的数据，因此放在 data/ 下：管线按路径读它，读的必须是"数据"
// 而不是"Worker 的源码目录"——后者是分层倒置，也让管线在只拷脚本的环境里跑不起来。
const INTENTS = fs.readJsonSync(path.resolve(PROJECT_ROOT, 'data/intents.json'))
const ALL_INTENT_WORDS = Array.from(new Set(Object.values(INTENTS).flat()))

// 读取探针捕获的 JSONL (Worker 侧写, CI 合并)。桶前缀与本地目录名相同: CI 按同一相对路径下载。
function previousProbeSnapshot() {
  if (!fs.existsSync(PREVIOUS_INDEX_PATH))
    return { keys: [] }
  const snapshot = fs.readJsonSync(PREVIOUS_INDEX_PATH).probe_snapshot || { keys: [] }
  if (!Array.isArray(snapshot.keys))
    throw new Error('previous-asset-index.json has an invalid probe_snapshot.')
  return snapshot
}

function readProbeCaptures() {
  const probesDir = path.resolve(PROJECT_ROOT, PROBE_CAPTURE_PREFIX)
  if (!fs.existsSync(probesDir))
    return { captures: [], keys: [] }

  const previousKeys = new Set(previousProbeSnapshot().keys)
  const files = fs.readdirSync(probesDir)
    .filter(name => name.endsWith('.jsonl'))
    .map(name => ({
      key: `${PROBE_CAPTURE_PREFIX}${name}`,
      file: path.join(probesDir, name),
      name,
    }))
  const captures = []

  // Effects of previous keys are already accumulated in asset-state.json. Only parse the raw tail
  // that the previous active generation had not seen; this both bounds work and lets old keys be
  // deleted one generation later without losing discovery history.
  for (const item of files) {
    if (previousKeys.has(item.key))
      continue
    const lines = fs.readFileSync(item.file, 'utf-8').split(/\r?\n/)
    for (const line of lines) {
      if (!line.trim())
        continue
      try {
        captures.push(JSON.parse(line))
      }
      catch (error) {
        throw new Error(`Could not read probe capture ${item.name}: ${error.message}`)
      }
    }
  }
  return { captures, keys: files.map(item => item.key).sort() }
}

function loadStarred(assetMap) {
  const catalogPath = path.resolve(PROJECT_ROOT, CATALOG_KEY)
  if (!fs.existsSync(catalogPath)) {
    console.warn(`[Asset Store] ${CATALOG_KEY} not found; skipping the starred pass and leaving existing tiers untouched.`)
    return null
  }
  const catalog = fs.readJsonSync(catalogPath)
  if (!catalog.repos || Array.isArray(catalog.repos) || typeof catalog.repos !== 'object')
    throw new Error(`Could not read ${CATALOG_KEY}: repos must be an object`)
  const entries = Object.entries(catalog.repos)
  const now = new Date().toISOString()
  const weekKey = isoWeek(new Date())
  const starredNow = new Set()
  for (const [repo, r] of entries) {
    const key = repo.toLowerCase()
    starredNow.add(key)
    assetMap.set(key, mergeAssetRow(assetMap.get(key), {
      repo,
      source: 'github_star',
      tier: 'starred',
      now,
      weekKey,
      fields: {
        name: r.name,
        owner: r.owner,
        url: r.url,
        description: r.description,
        language: r.language,
        stars: r.stars,
        topics: Array.isArray(r.topics) ? r.topics : [],
        categories: Array.isArray(r.categories) ? r.categories : [],
        reason: r.reason,
        summary: r.summary,
        license: r.license,
        created_at: r.created_at,
        // catalog.json names this field `pushedAt`; the asset map keeps the GitHub API's
        // snake_case so it matches what the Worker writes into probe captures and ingested
        // entries. Reading `r.pushed_at` here silently produced an empty string for every
        // one of the 931 starred repos.
        pushed_at: r.pushedAt,
      },
    }))
  }
  return starredNow
}

// starred tier 必须反映「当前」的 star 状态。取消 star 的库会被 scripts/index.js 的
// prune 从 stars/ 与 catalog.json 中剔除, 但 asset-state.json 里的旧记录仍在; 只做 UPSERT
// 会让它永远带着 "⭐ Starred" 徽标出现在检索结果里。降级为 community 而不是删除: 该仓库
// 仍是公开可用的社区资产, 只是不再声称「你点过星」, 社区长尾因此得以保留。
function demoteUnstarred(assetMap, starredNow) {
  let demoted = 0
  for (const [key, r] of assetMap) {
    if (r.tier === 'starred' && !starredNow.has(key)) {
      r.tier = 'community'
      r.is_starred = 0
      demoted++
    }
  }
  return demoted
}

// rankings.json 与入库日志共用同一个 upsert: 两个来源最终写的是同一张资产表, 分成两份实现
// 迟早会让 tier / first_seen / source_channels 的语义出现分歧。
function createUpsert(assetMap) {
  const now = new Date().toISOString()
  const weekKey = isoWeek(new Date())
  return (repo, src, tier, fields = {}) => {
    if (!repo)
      return
    const key = repo.toLowerCase()
    assetMap.set(key, mergeAssetRow(assetMap.get(key), {
      repo,
      source: src,
      tier,
      fields,
      now,
      weekKey,
    }))
  }
}

// 从 rankings.json 提取社区资产 (增量 upsert, 保留 first_seen)
function loadRankings(assetMap) {
  const rankingsPath = path.resolve(PROJECT_ROOT, LOCAL_RANKINGS_DIR, RANKINGS_KEY)
  if (!fs.existsSync(rankingsPath))
    return
  const rankings = fs.readJsonSync(rankingsPath)
  const upsert = createUpsert(assetMap)

  // Trending
  for (const [catName, list] of Object.entries(rankings.trending || {})) {
    for (const tr of list || []) {
      upsert(tr.repo, `trending:${catName}`, 'community', {
        description: tr.description,
        language: tr.language,
        stars: tr.stars,
        url: tr.url,
      })
    }
  }
  // Top Starred
  for (const [lang, list] of Object.entries(rankings.topStarred || {})) {
    for (const tr of list || []) {
      upsert(tr.repo, `topstarred:${lang}`, 'community', {
        description: tr.description,
        language: tr.language,
        stars: tr.stars,
        url: tr.url,
        topics: tr.topics,
      })
    }
  }
  // HelloGitHub
  for (const hg of rankings.helloGitHub || []) {
    // No `categories`: the section it was published under is HelloGitHub's own classification, not
    // one the deployer assigned. Writing it here made `?category=<section>` return repositories that
    // are in none of the deployer's lists, and put a source's label in the same field their own
    // taxonomy lives in.
    upsert(hg.repo, 'hellogithub', 'community', {
      description: hg.description_zh,
      url: hg.url,
    })
  }
  // Agent Skill Repos
  for (const sr of rankings.agentSkillRepos || []) {
    upsert(sr.repo, 'skills_repo', 'community', {
      description: sr.description,
      language: sr.language,
      stars: sr.stars,
      topics: sr.topics,
      created_at: sr.created_at,
      url: sr.url,
    })
  }
  // Breakout
  for (const br of rankings.breakoutWeekly || []) {
    upsert(br.repo, 'breakout', 'community', {
      description: br.description,
      language: br.language,
      stars: br.stars,
      topics: br.topics,
      created_at: br.created_at,
      url: br.url,
    })
  }
}

// 用户入库的仓库来自追加日志 state/ingest-journal/**, 不再来自 rankings.json。
//
// rankings.json 每轮被 CI 整体替换, 把"不能丢的东西"放进去等于让多个写者互相覆盖 —— 这正是
// 入库条目被抹掉的原因。日志由 CI 下载到本地目录后在这里 fold; 与 Worker 侧共用
// src/ingest-journal.js, 所以两边看到的集合必然一致。
function previousIngestSnapshot() {
  if (!fs.existsSync(PREVIOUS_INDEX_PATH))
    return { keys: [], entries: [] }

  const index = fs.readJsonSync(PREVIOUS_INDEX_PATH)
  const snapshot = index.ingest_snapshot || { keys: [], entries: [] }
  if (!Array.isArray(snapshot.keys) || !Array.isArray(snapshot.entries))
    throw new Error(`${PREVIOUS_ASSET_INDEX_FILE} has an invalid ingest_snapshot.`)
  return snapshot
}

function loadIngestJournal(assetMap) {
  const previous = previousIngestSnapshot()
  const previousKeys = new Set(previous.keys)
  const journalDir = path.resolve(PROJECT_ROOT, INGEST_JOURNAL_PREFIX)
  const files = fs.existsSync(journalDir)
    ? fs.readdirSync(journalDir)
        .filter(name => name.endsWith('.jsonl'))
        .map(name => ({
          key: `${INGEST_JOURNAL_PREFIX}${name}`,
          text: fs.readFileSync(path.join(journalDir, name), 'utf-8'),
        }))
    : []

  // Previous entries are already folded and authoritative. Only parse raw objects that were not
  // represented by the previous active generation; replaying every historical object defeats
  // compaction and makes one malformed old file able to poison all future builds.
  const tailFiles = files.filter(file => !previousKeys.has(file.key))
  const { snapshot: tail, problems } = foldJournalFiles(tailFiles)
  if (problems.length > 0)
    throw new Error(`Could not read ingest journal tail: ${problems.join('; ')}`)

  const entries = foldIngestEntries(
    [...previous.entries, ...tail.entries],
    { includeKeys: true },
  )
  const harvested = foldIngestEntries(entries)

  const upsert = createUpsert(assetMap)
  for (const h of harvested) {
    upsert(h.repo, 'user_ingest', 'curated', {
      description: h.description,
      language: h.language,
      stars: h.stars,
      topics: h.topics,
      url: h.url,
      categories: h.categories,
      reason: h.reason,
      license: h.license,
      created_at: h.created_at,
      pushed_at: h.pushed_at,
    })
  }

  // keys only tracks raw objects that still exist in R2/local staging. Entries are the durable
  // compacted truth and remain after those objects are safely deleted one generation later.
  return {
    keys: files.map(file => file.key).sort(),
    entries,
  }
}

// 从探针 JSONL 捕获 discovered (仅元数据, 需跨查询确认晋升)
function loadProbes(assetMap) {
  const { captures, keys } = readProbeCaptures()
  const now = new Date().toISOString()
  const weekKey = isoWeek(new Date())
  for (const c of captures) {
    if (!c.repo)
      continue
    const key = c.repo.toLowerCase()
    const existing = assetMap.get(key)
    // probe_hits 仅在"同一 repo 出现在不同探针查询"时累加
    const queryId = c.query || c.channel || 'probe'
    const prevQueries = existing?.probe_queries || []
    const isNewQuery = prevQueries.length === 0 || !prevQueries.includes(queryId)
    const probeHits = isNewQuery ? (existing?.probe_hits || 0) + 1 : (existing?.probe_hits || 0)
    const newQueries = isNewQuery ? [...prevQueries, queryId].slice(-20) : prevQueries

    assetMap.set(key, mergeAssetRow(existing, {
      repo: c.repo,
      source: 'probe',
      tier: 'discovered',
      now,
      weekKey,
      fields: {
        url: c.url,
        description: c.description,
        language: c.language,
        stars: c.stars,
        topics: c.topics,
        created_at: c.created_at,
        pushed_at: c.pushed_at,
        probe_hits: probeHits,
        probe_queries: newQueries,
      },
    }))
  }
  return { keys }
}

// 跨查询确认晋升: discovered -> community
function promoteDiscovered(assetMap) {
  for (const r of assetMap.values()) {
    if (r.tier === 'discovered' && r.probe_hits >= 2 && r.stars >= 100 && isRecent(r.pushed_at, 90)) {
      r.tier = 'community'
    }
  }
}

// 清理 >30d 且 probe_hits<2 的孤儿 discovered
function pruneDiscovered(assetMap) {
  for (const [_key, r] of assetMap) {
    if (r.tier === 'discovered' && r.probe_hits < 2 && !isRecent(r.last_seen_at, 30)) {
      assetMap.delete(_key)
    }
  }
}

// 构建意图词倒排 (includes 语义)
function buildIntentInverted(assetMap) {
  const inverted = {}
  const hotTiers = new Set(['starred', 'curated', 'community'])
  for (const [, r] of assetMap) {
    if (!hotTiers.has(r.tier))
      continue
    const pool = `${r.repo} ${r.name || ''} ${r.description || ''} ${(r.topics || []).join(' ')}`.toLowerCase()
    const matches = termMatcher(pool)
    for (const w of ALL_INTENT_WORDS) {
      if (matches(w)) {
        // 键统一小写, 与查询端 assetInverted[wl] 对齐, 否则 LLM/API/SQL 等大写意图词漏检
        const key = w.toLowerCase()
        ;(inverted[key] ||= []).push(r.repo)
      }
    }
  }
  return inverted
}

// 输出热集资产索引 (只含 starred/curated/community, discovered 不进热集)
function buildAssetIndex(assetMap) {
  const repos = {}
  const hotTiers = new Set(HOT_TIERS)
  for (const [key, r] of assetMap) {
    if (!hotTiers.has(r.tier))
      continue
    repos[key] = hotSetRow(r)
  }
  const intentInverted = buildIntentInverted(assetMap)
  const starredCount = Object.values(repos).filter(r => r.tier === 'starred').length
  return {
    generatedAt: new Date().toISOString(),
    starredCount,
    totalRepos: Object.keys(repos).length,
    repos,
    intent_inverted: intentInverted,
  }
}

// 全量状态 (含 discovered, 持久化跨运行)
function buildFullState(assetMap) {
  const repos = {}
  for (const [key, r] of assetMap) {
    repos[key] = r
  }
  return {
    updatedAt: new Date().toISOString(),
    repos,
  }
}

// ---- helpers ----
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7)
}

function isRecent(dateStr, days) {
  if (!dateStr)
    return false
  return (Date.now() - new Date(dateStr).getTime()) / 86400000 <= days
}

// ---- 主流程 ----
function loadPersistedState() {
  if (fs.existsSync(STATE_PATH)) {
    try {
      const state = fs.readJsonSync(STATE_PATH)
      if (!state.repos || Array.isArray(state.repos) || typeof state.repos !== 'object')
        throw new Error('repos must be an object')
      const map = new Map()
      for (const [key, r] of Object.entries(state.repos)) {
        // Rows are re-projected onto the declared shape on the way in: this document accumulated
        // fields that no reader ever asked for (`untrusted`, a document `version`), and one that
        // is loaded verbatim is one that gets written back verbatim.
        const row = {}
        for (const field of ASSET_ROW_FIELDS) {
          if (r[field] !== undefined)
            row[field] = r[field]
        }
        map.set(key.toLowerCase(), row)
      }
      return map
    }
    catch (e) {
      throw new Error(`Could not read ${ASSET_STATE_KEY}: ${e.message}. Refusing to overwrite persisted asset history.`)
    }
  }
  return new Map()
}

export function accumulateAssets() {
  // 1. 先读上一轮全量状态 (持久化, 跨运行保留累积元数据)
  const assetMap = loadPersistedState()

  // 2. 合并本轮数据源 (existing 来自 state, 故 first_seen/trending/probe_hits 跨运行保留)
  const starredNow = loadStarred(assetMap)
  // catalog.json 缺席时无法判定当前 star 状态, 跳过降级而不是清空私藏库
  const demoted = starredNow ? demoteUnstarred(assetMap, starredNow) : 0
  loadRankings(assetMap)
  const ingestSnapshot = loadIngestJournal(assetMap)
  const probeSnapshot = loadProbes(assetMap)
  promoteDiscovered(assetMap)
  pruneDiscovered(assetMap)

  // 3. 写全量状态 (含 discovered, 长尾历史不丢)
  const state = buildFullState(assetMap)
  fs.writeJsonSync(STATE_PATH, state, { spaces: 2 })

  // 4. 派生热集索引 (Worker 载内存)
  const index = {
    ...buildAssetIndex(assetMap),
    ingest_snapshot: ingestSnapshot,
    probe_snapshot: probeSnapshot,
  }
  fs.writeJsonSync(INDEX_PATH, index, { spaces: 2 })

  // 5. 元数据
  const meta = {
    generatedAt: index.generatedAt,
    totalRepos: Object.keys(state.repos).length,
    hotRepos: index.totalRepos,
    starredCount: index.starredCount,
    discoveredCount: Object.values(state.repos).filter(r => r.tier === 'discovered').length,
    intentWords: ALL_INTENT_WORDS.length,
  }
  fs.writeJsonSync(META_PATH, meta, { spaces: 2 })

  console.log(`[Asset Store] ${meta.totalRepos} total (${meta.hotRepos} hot: ${meta.starredCount} starred), ${meta.discoveredCount} discovered, ${meta.intentWords} intent words.`)
  if (demoted > 0)
    console.log(`[Asset Store] Demoted ${demoted} previously-starred repos to community (no longer in ${CATALOG_KEY}).`)
  return { index, meta, state }
}

if (process.argv[1]?.endsWith('asset_store.js')) {
  accumulateAssets()
}
