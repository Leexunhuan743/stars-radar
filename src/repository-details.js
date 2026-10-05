import { buildReadmeEvidence, buildRepositoryEvidence, EVIDENCE_TRUST } from './evidence.js'
import { parseFrontmatter } from './frontmatter.js'
import { BadRequestError } from './http.js'
import { readmeBlobKey } from './object-keys.js'

export class RepositoryRequestError extends Error {
  constructor(message, upstreamStatus) {
    super(message)
    this.name = 'RepositoryRequestError'
    this.status = upstreamStatus === 404 ? 404 : upstreamStatus === 429 || upstreamStatus === 403 ? 503 : 502
  }
}

export function repositoryName(value) {
  const name = String(value || '').trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/, '')
  if (!/^[\w.-]+\/[\w.-]+$/.test(name) || name.split('/').some(part => part === '.' || part === '..'))
    throw new BadRequestError('repo', value, 'owner/repo or a GitHub repository URL')
  return name
}

function findRecord(records, name) {
  const key = Object.keys(records).find(key => key.toLowerCase() === name.toLowerCase())
  return key ? { ...records[key], repo: records[key].repo || key } : null
}

function project(record) {
  return {
    repo: record.repo,
    url: record.url || `https://github.com/${record.repo}`,
    description: record.description ?? null,
    stars: record.stars ?? null,
    language: record.language || null,
    license: record.license && record.license !== 'NOASSERTION' ? record.license : null,
    pushed_at: record.pushed_at || record.pushedAt || null,
    created_at: record.created_at || null,
    archived: record.archived ?? null,
    topics: record.topics ?? null,
    categories: record.categories || [],
    reason: record.reason || null,
    summary: record.summary || null,
  }
}

async function githubResponse(repo, suffix, headers, fetcher) {
  try {
    return await fetcher(`https://api.github.com/repos/${repo}${suffix}`, { headers, signal: AbortSignal.timeout(10000) })
  }
  catch (error) {
    throw new RepositoryRequestError(`Could not request GitHub ${repo}${suffix}: ${error.message}`)
  }
}

async function sha256Text(text) {
  const bytes = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function getRepositoryDetails(env, { catalog, assetIndex, harvested, readmes = { repos: {} } }, repo, { include_readme = true, refresh = false, fetcher = fetch, now = () => new Date() } = {}) {
  const name = repositoryName(repo)
  const starred = findRecord(catalog.repos || {}, name)
  const asset = findRecord(assetIndex.repos || {}, name)
  const ingest = harvested.find(item => item.repo.toLowerCase() === name.toLowerCase())
  let record = starred || ingest || asset
  if (starred && ingest)
    record = { ...starred, reason: ingest.reason || starred.reason, summary: ingest.summary || starred.summary }
  let source = starred ? 'catalog' : ingest ? 'ingest_journal' : 'asset_index'
  let snapshotAt = starred ? catalog.generatedAt : ingest ? ingest.ingested_at : assetIndex.generatedAt
  let fetchedAt = record?.metadata_fetched_at || null
  let body = null
  let readmeSource = null
  let readmeStatus = null
  let readmePreservedFromGeneration = null
  let readmeFetchedAt = null
  let readmeLiveSha256 = null
  let readmeRef = null
  if (include_readme) {
    const ref = readmes.repos?.[(record?.repo || name).toLowerCase()]
    readmeRef = ref || null
    readmeStatus = ref?.status || null
    readmePreservedFromGeneration = ref?.preserved_from_generation || null
    if (ref?.status === 'absent') {
      readmeSource = 'generation'
    }
    else {
      const object = ref?.sha256 ? await env.R2.get(readmeBlobKey(ref.sha256)) : null
      if (object) {
        const parsed = parseFrontmatter(await object.text())
        body = parsed.body
        readmeSource = 'generation'
        if (!record) {
          record = {
            ...parsed.metadata,
            repo: name,
            stars: parsed.metadata.stars === undefined ? null : Number(parsed.metadata.stars),
            categories: parsed.metadata.categories ? JSON.parse(parsed.metadata.categories) : [],
            topics: parsed.metadata.topics ? JSON.parse(parsed.metadata.topics) : null,
          }
          source = 'readme_generation'
          snapshotAt = readmes.generation?.published_at || null
        }
      }
    }
  }
  // Unknown projects require metadata from GitHub; the compact mode never reads a README object.
  const headers = { 'User-Agent': 'Stars-Radar-MCP', 'Accept': 'application/vnd.github+json' }
  if (env.GITHUB_TOKEN)
    headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`
  if (!record || refresh) {
    const response = await githubResponse(name, '', headers, fetcher)
    if (!response.ok)
      throw new RepositoryRequestError(`Could not fetch repository ${name}: GitHub returned HTTP ${response.status}`, response.status)
    let data
    try {
      data = await response.json()
    }
    catch (error) {
      throw new RepositoryRequestError(`Could not parse GitHub repository metadata for ${name}: ${error.message}`)
    }
    if (typeof data.full_name !== 'string')
      throw new RepositoryRequestError(`GitHub returned invalid repository metadata for ${name}: full_name is missing`)
    record = {
      categories: record?.categories,
      reason: record?.reason,
      summary: record?.summary,
      repo: data.full_name,
      url: data.html_url,
      description: data.description,
      stars: data.stargazers_count,
      language: data.language,
      license: data.license?.spdx_id,
      pushed_at: data.pushed_at,
      created_at: data.created_at,
      archived: data.archived,
      topics: data.topics,
    }
    source = 'github'
    fetchedAt = now().toISOString()
    snapshotAt = null
  }
  if (include_readme && body === null && (refresh || readmeStatus !== 'absent')) {
    const response = await githubResponse(record.repo, '/readme', { ...headers, Accept: 'application/vnd.github.raw+json' }, fetcher)
    if (response.status !== 404 && !response.ok)
      throw new RepositoryRequestError(`Could not fetch README for ${record.repo}: GitHub returned HTTP ${response.status}`, response.status)
    readmeFetchedAt = now().toISOString()
    if (response.ok) {
      body = await response.text()
      readmeLiveSha256 = await sha256Text(body)
      readmeSource = 'github'
      readmeStatus = 'live'
      readmePreservedFromGeneration = null
    }
    else if (response.status === 404) {
      readmeStatus = 'absent'
      readmePreservedFromGeneration = null
    }
  }
  const projected = project(record)
  const personalFieldSource = (field) => {
    if (ingest?.[field])
      return { source: 'ingest_journal', snapshotAt: ingest.ingested_at || null, generation: null }
    if (starred?.[field])
      return { source: 'catalog', snapshotAt: catalog.generatedAt || null, generation: null }
    if (asset?.[field])
      return { source: 'asset_index', snapshotAt: assetIndex.generatedAt || null, generation: null }
    if (source === 'readme_generation' && projected[field])
      return { source: 'readme_generation', snapshotAt: readmes.generation?.published_at || null, generation: readmes.generation }
    if (projected[field])
      return { source, snapshotAt, generation: source === 'readme_generation' ? readmes.generation : null }
    return null
  }
  const categorySource = starred
    ? 'github_lists'
    : (ingest?.categories?.length
        ? 'ingest_journal'
        : asset?.categories?.length
          ? 'asset_index'
          : source === 'readme_generation' ? 'readme_generation' : null)
  const metadataFields = ['stars', 'language', 'license', 'pushed_at', 'created_at', 'archived', 'topics']
    .filter(field => projected[field] !== null && projected[field] !== undefined)
  const evidenceChain = []
  const fieldProvenance = {}
  if (metadataFields.length > 0) {
    const metadataEvidence = buildRepositoryEvidence({
      kind: 'repository_metadata',
      repo: record.repo,
      source,
      fetchedAt,
      snapshotAt,
      generation: source === 'readme_generation' ? readmes.generation : null,
      trust: EVIDENCE_TRUST.EXTERNAL_STRUCTURED,
      fields: metadataFields,
    })
    evidenceChain.push(metadataEvidence)
    for (const field of metadataFields)
      fieldProvenance[field] = metadataEvidence.id
  }

  if (projected.description) {
    const descriptionEvidence = buildRepositoryEvidence({
      kind: 'repository_description',
      repo: record.repo,
      source,
      fetchedAt,
      snapshotAt,
      generation: source === 'readme_generation' ? readmes.generation : null,
      trust: EVIDENCE_TRUST.EXTERNAL_UNTRUSTED,
      fields: ['description'],
    })
    evidenceChain.push(descriptionEvidence)
    fieldProvenance.description = descriptionEvidence.id
  }

  const personalFields = ['reason', 'summary'].filter(field => projected[field] !== null && projected[field] !== undefined)
  for (const field of personalFields) {
    const origin = personalFieldSource(field)
    const personalEvidence = buildRepositoryEvidence({
      kind: 'personal_note',
      repo: record.repo,
      source: origin?.source || source,
      trust: EVIDENCE_TRUST.USER_TRUSTED,
      snapshotAt: origin?.snapshotAt || null,
      generation: origin?.generation || null,
      identity: `${field}:${origin?.source || source}:${origin?.snapshotAt || 'live'}`,
      fields: [field],
    })
    evidenceChain.push(personalEvidence)
    fieldProvenance[field] = personalEvidence.id
  }

  if (projected.categories.length > 0) {
    const categoryEvidence = buildRepositoryEvidence({
      kind: 'user_taxonomy',
      repo: record.repo,
      source: categorySource || source,
      trust: EVIDENCE_TRUST.USER_TRUSTED,
      snapshotAt,
      generation: source === 'readme_generation' ? readmes.generation : null,
      fields: ['categories'],
    })
    evidenceChain.push(categoryEvidence)
    fieldProvenance.categories = categoryEvidence.id
  }

  if (include_readme && (body !== null || readmeStatus)) {
    const generationRef = readmeSource === 'generation' ? readmeRef : null
    const readmeEvidence = buildReadmeEvidence({
      kind: 'readme_document',
      repo: record.repo,
      ref: generationRef,
      generation: readmeSource === 'generation' ? readmes.generation : null,
      readmeSha256: readmeSource === 'generation' ? readmeRef?.sha256 || null : readmeLiveSha256,
      fetchedAt: readmeFetchedAt,
    })
    evidenceChain.push(readmeEvidence)
    fieldProvenance.readme = readmeEvidence.id
    fieldProvenance.readme_status = readmeEvidence.id
  }

  const result = {
    ...projected,
    provenance: fieldProvenance,
    evidence: evidenceChain,
  }
  if (include_readme) {
    result.readme_available = body !== null
    result.readme_source = readmeSource
    result.readme_status = readmeStatus || (body !== null ? 'unknown' : 'missing')
    result.readme_preserved_from_generation = readmePreservedFromGeneration
    result.readme_trust = body !== null ? EVIDENCE_TRUST.EXTERNAL_UNTRUSTED : null
    result.truncated = body !== null && body.length > 50000
    result.readme = body === null ? null : `<untrusted_content source="github_readme">\n${body.trim().slice(0, 50000)}\n</untrusted_content>`
  }
  return result
}

export async function compareRepositories(env, documents, repos, options = {}) {
  if (!Array.isArray(repos) || repos.length < 2 || repos.length > 5)
    throw new BadRequestError('repos', repos, '2 to 5 distinct repository names')
  const names = repos.map(repositoryName)
  if (new Set(names.map(name => name.toLowerCase())).size !== names.length)
    throw new BadRequestError('repos', repos, 'distinct repository names')
  const repositories = await Promise.all(names.map(repo => getRepositoryDetails(env, documents, repo, { ...options, include_readme: false })))
  return {
    repositories,
    dimensions: ['description', 'stars', 'language', 'license', 'pushed_at', 'created_at', 'archived', 'topics', 'categories', 'reason'],
    note: 'Snapshot evidence is not a live maintenance audit. Null means unknown. Stars and recency are facts, not a quality score.',
  }
}
