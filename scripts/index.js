import process from 'node:process'
import fs from 'fs-extra'
import { embeddingRepositories, foldJournalFiles } from '../src/ingest-journal.js'
import { CATALOG_KEY, INGEST_JOURNAL_PREFIX, LOCAL_STARS_DIR, localReadmePath, README_SYNC_STATUS_FILE } from '../src/object-keys.js'
import { needsReadmeDownload } from './download-plan.js'
import { collectAllRankings } from './fetch_rankings.js'
import { fetchUserLists, summarizeCategories } from './github-lists.js'
import { fetchReadme, getAllStarredRepos, mapLimit } from './github_stars.js'
import { useEnvProxy } from './outbound-proxy.js'
import { renderEnrichedMarkdown } from './star_export.js'
import { buildRepositoryVectors } from './vector_pipeline.js'

const CONCURRENCY = 10

if (!process.env.GITHUB_TOKEN) {
  throw new Error('GITHUB_TOKEN is not set')
}

const TOKEN = process.env.GITHUB_TOKEN

async function main() {
  // The run's outbound calls (GitHub, the rankings sources, SiliconFlow, R2 over REST) all go
  // through undici, so the proxy is installed once here rather than as an import-time side effect of
  // whichever module happened to be loaded first.
  useEnvProxy()

  try {
    fs.ensureDirSync(LOCAL_STARS_DIR)
    let oldCatalog = { categories: [], repos: {} }
    if (fs.existsSync(CATALOG_KEY)) {
      try {
        oldCatalog = fs.readJsonSync(CATALOG_KEY)
      }
      catch (e) {
        // Unreadable is not the same as absent. Starting fresh from a corrupt catalogue would
        // re-download all 900+ READMEs and, worse, publish a catalogue that has lost every
        // cached category and reason.
        throw new Error(`Could not read ${CATALOG_KEY}: ${e.message}. Fix or remove the file before syncing.`)
      }
    }

    console.log('Fetching live starred repositories list from GitHub...')
    const liveStarred = await getAllStarredRepos(TOKEN)
    console.log(`Live stars count: ${liveStarred.length}`)

    const liveNames = new Set(liveStarred.map(r => r.full_name))

    // 1.5. Fetch live GitHub User Lists memberships as definitive categorization authority
    const liveCloud = await fetchUserLists(TOKEN)
    const liveMemberships = liveCloud.repoToCategories
    const liveCategories = liveCloud.categoriesList

    // 1. Remove deleted or unstarred repos from disk
    const existingDirs = fs.readdirSync('stars')
    let pruned = 0
    for (const owner of existingDirs) {
      const ownerPath = `stars/${owner}`
      if (!fs.statSync(ownerPath).isDirectory())
        continue
      for (const file of fs.readdirSync(ownerPath)) {
        if (!file.endsWith('.md'))
          continue
        const repoName = `${owner}/${file.replace(/\.md$/, '')}`
        if (!liveNames.has(repoName)) {
          fs.removeSync(`${ownerPath}/${file}`)
          pruned++
        }
      }
      if (fs.readdirSync(ownerPath).length === 0) {
        fs.removeSync(ownerPath)
      }
    }
    if (pruned > 0) {
      console.log(`Pruned ${pruned} unstarred repositories from local stars/`)
    }

    // 2. Identify new or modified repositories
    const toDownload = []
    const updatedCatalogRepos = {}
    const readmeSync = {
      generated_at: new Date().toISOString(),
      active_generation: process.env.ACTIVE_GENERATION_ID || null,
      repos: {},
    }

    for (const repo of liveStarred) {
      const name = repo.full_name
      const cached = oldCatalog.repos?.[name]
      const targetFilePath = localReadmePath(name)
      const fileExists = fs.existsSync(targetFilePath)

      // Retain or initialize metadata (prioritizing live cloud lists over stale cache)
      const categories = liveMemberships[name] || ['everything-else']

      const repoInfo = {
        repo: name,
        name: repo.name,
        owner: repo.owner.login,
        url: repo.html_url || `https://github.com/${name}`,
        stars: repo.stargazers_count,
        license: repo.license?.spdx_id || null,
        created_at: repo.created_at,
        archived: repo.archived,
        description: repo.description || cached?.description || '',
        categories,
        reason: cached?.reason || '',
        summary: cached?.summary || '',
        language: repo.language || cached?.language || '',
        topics: repo.topics || cached?.topics || [],
        primaryFunction: cached?.primaryFunction || null,
        platforms: cached?.platforms || [],
        facets: cached?.facets || [],
        pushedAt: repo.pushed_at,
        readmePushedAt: cached?.readmePushedAt || cached?.pushedAt || null,
        starredAt: repo.starred_at || cached?.starredAt,
      }

      updatedCatalogRepos[name] = repoInfo

      const needsDownload = needsReadmeDownload({
        fileExists,
        cachedEntry: cached,
        pushedAt: repo.pushed_at,
      })

      if (needsDownload) {
        toDownload.push(repoInfo)
      }
      else if (fileExists) {
        readmeSync.repos[name.toLowerCase()] = {
          repo: name,
          status: 'reused',
          upstream_pushed_at: repoInfo.pushedAt || null,
          source_pushed_at: repoInfo.readmePushedAt || null,
          preserved_from_generation: process.env.ACTIVE_GENERATION_ID || null,
        }
      }
    }

    console.log(`Repos needing README download: ${toDownload.length} / ${liveStarred.length}`)

    // README refreshes degrade independently from repository metadata. A transient failure keeps an
    // existing README blob as stale evidence and preserves its own readmePushedAt clock; a new
    // repository with no cached README is marked unavailable. Either state retries on the next run,
    // while vector/generation integrity failures later in the pipeline still stop publication.
    let readmeFailures = []
    if (toDownload.length > 0) {
      const run = await mapLimit(toDownload, CONCURRENCY, async (repoInfo) => {
        const readme = await fetchReadme(TOKEN, repoInfo.repo)
        const content = renderEnrichedMarkdown(repoInfo, readme || '')
        const ownerDir = `${LOCAL_STARS_DIR}/${repoInfo.owner}`
        fs.ensureDirSync(ownerDir)
        fs.writeFileSync(`stars/${repoInfo.repo}.md`, content, 'utf-8')
        repoInfo.readmePushedAt = repoInfo.pushedAt
        readmeSync.repos[repoInfo.repo.toLowerCase()] = {
          repo: repoInfo.repo,
          status: readme === null ? 'absent' : 'fresh',
          fetched_at: new Date().toISOString(),
          upstream_pushed_at: repoInfo.pushedAt || null,
          source_pushed_at: repoInfo.readmePushedAt || null,
          preserved_from_generation: null,
        }
      })
      readmeFailures = run.failures
      if (readmeFailures.length > 0) {
        for (const failure of readmeFailures) {
          const target = localReadmePath(failure.item.repo)
          const staleAvailable = fs.existsSync(target)
          readmeSync.repos[failure.item.repo.toLowerCase()] = {
            repo: failure.item.repo,
            status: staleAvailable ? 'stale' : 'unavailable',
            upstream_pushed_at: failure.item.pushedAt || null,
            source_pushed_at: failure.item.readmePushedAt || null,
            preserved_from_generation: staleAvailable ? (process.env.ACTIVE_GENERATION_ID || null) : null,
            error: failure.error?.message || String(failure.error),
          }
        }
        const named = readmeFailures.slice(0, 10).map(f => f.item.repo).join(', ')
        console.warn(
          `Could not refresh ${readmeFailures.length} README(s); stale cached blobs are preserved when available, `
          + `otherwise the repository is published without README evidence and retried next run: `
          + `${named}${readmeFailures.length > 10 ? ', …' : ''}`,
        )
      }
    }

    fs.writeJsonSync(README_SYNC_STATUS_FILE, readmeSync, { spaces: 2 })

    const categoriesList = summarizeCategories(liveCategories, updatedCatalogRepos)

    const newCatalog = {
      version: '1.0',
      generatedAt: new Date().toISOString(),
      totalRepos: Object.keys(updatedCatalogRepos).length,
      categories: categoriesList,
      repos: updatedCatalogRepos,
    }

    // 3.5 Auto-embed any new starred repositories into Vector DB.
    // Deliberately NOT wrapped in try/catch: a swallowed embedding failure leaves the
    // vector pair stale while the export artifacts move ahead, which silently costs
    // every newly starred repo its semantic search. The vector pipeline refuses to
    // write or upload a pair whose bin and index disagree, so failing here stops the
    // run instead of shipping a false success. (Note: the bin and index are two
    // separate writes, so an interruption between them can leave a mismatched pair
    // on disk — the next run detects that and rebuilds rather than propagating it.)
    const journalFiles = fs.existsSync(INGEST_JOURNAL_PREFIX)
      ? fs.readdirSync(INGEST_JOURNAL_PREFIX).filter(name => name.endsWith('.jsonl')).map(name => ({ key: name, text: fs.readFileSync(`${INGEST_JOURNAL_PREFIX}${name}`, 'utf-8') }))
      : []
    const { harvested, problems } = foldJournalFiles(journalFiles)
    if (problems.length > 0)
      throw new Error(`Could not read the ingest journal for embedding: ${problems.join('; ')}`)
    await buildRepositoryVectors(embeddingRepositories(updatedCatalogRepos, harvested))

    // catalog.json is written only once the vector stage has succeeded: failing after
    // it used to leave a half-updated product set on disk.
    fs.writeJsonSync(CATALOG_KEY, newCatalog, { spaces: 2 })
    console.log(`Saved updated ${CATALOG_KEY}`)

    // 5. Collect and update community rankings.
    // Not wrapped in try/catch: the per-source fetches inside already degrade softly via
    // Promise.allSettled, so anything thrown here is the baseline read or the write — i.e.
    // the run would publish an empty community layer and drop harvested entries.
    console.log('Refreshing community rankings...')
    await collectAllRankings()

    console.log(
      `Incremental sync complete: ${toDownload.length - readmeFailures.length} downloaded, `
      + `${readmeFailures.length} failed, ${pruned} pruned, ${liveStarred.length} total.`,
    )
  }
  catch (e) {
    console.error(`Fatal sync error: ${e}`, e?.response, e?.response?.headers)
    process.exit(1)
  }
}

await main()
