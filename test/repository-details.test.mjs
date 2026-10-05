import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareRepositories, getRepositoryDetails, repositoryName, RepositoryRequestError } from '../src/repository-details.js'

const README_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const DOCUMENTS = {
  catalog: { generatedAt: '2026-10-01T00:00:00Z', repos: { 'Acme/Tool': { repo: 'Acme/Tool', stars: 0, language: 'Rust', reason: 'works offline', pushedAt: '2026-09-30T00:00:00Z' } } },
  assetIndex: { generatedAt: '2026-10-02T00:00:00Z', repos: { 'other/tool': { repo: 'Other/Tool', license: 'MIT', description: 'community utility', topics: ['cli'] } } },
  harvested: [],
  readmes: {
    generation: { published_at: '2026-10-02T12:00:00Z' },
    repos: {
      'acme/tool': { repo: 'Acme/Tool', sha256: README_SHA, object_key: `readmes/${README_SHA}.md` },
    },
  },
}

const NO_README = { R2: { get: () => {
  throw new Error('README must not be read')
} } }
const NO_FETCH = { fetcher: () => {
  throw new Error('Network must not be used')
} }

test('compact metadata does not read a README or use the network for known repositories', async () => {
  const result = await getRepositoryDetails(NO_README, DOCUMENTS, 'acme/tool', { ...NO_FETCH, include_readme: false })
  assert.equal(result.repo, 'Acme/Tool')
  assert.equal(result.stars, 0)
  assert.equal(result.license, null)
  assert.equal(result.pushed_at, '2026-09-30T00:00:00Z')
  assert.equal(result.reason, 'works offline')
  assert.equal('readme' in result, false)
  assert.equal(result.evidence[0].kind, 'repository_metadata')
  assert.equal(result.evidence[0].source.kind, 'catalog')
  assert.equal(result.evidence[0].source.snapshot_at, '2026-10-01T00:00:00Z')
  assert.equal(result.provenance.stars, result.evidence[0].id)
  const note = result.evidence.find(item => item.kind === 'personal_note')
  assert.equal(note.source.kind, 'catalog')
  assert.equal(result.provenance.reason, note.id)
})

test('comparison has identical fields, keeps input order and labels unknown facts', async () => {
  const result = await compareRepositories(NO_README, DOCUMENTS, ['Other/Tool', 'acme/tool'], NO_FETCH)
  assert.deepEqual(result.repositories.map(item => item.repo), ['Other/Tool', 'Acme/Tool'])
  assert.deepEqual(Object.keys(result.repositories[0]), Object.keys(result.repositories[1]))
  assert.equal(result.repositories[0].license, 'MIT')
  assert.equal(result.repositories[1].license, null)
  assert.equal(result.repositories[0].evidence[0].source.kind, 'asset_index')
  assert.equal('score' in result.repositories[0], false)
})

test('ingested metadata outranks the accumulated community copy', async () => {
  const documents = { ...DOCUMENTS, harvested: [{ repo: 'Other/Tool', reason: 'selected for research', ingested_at: '2026-10-03T00:00:00Z' }] }
  const result = await getRepositoryDetails(NO_README, documents, 'other/tool', { ...NO_FETCH, include_readme: false })
  assert.equal(result.reason, 'selected for research')
  assert.equal(result.evidence[0].source.kind, 'ingest_journal')
  const note = result.evidence.find(item => item.kind === 'personal_note')
  assert.equal(note.source.kind, 'ingest_journal')
  assert.equal(result.provenance.reason, note.id)
})

test('merged personal fields retain independent source provenance', async () => {
  const documents = {
    ...DOCUMENTS,
    catalog: {
      ...DOCUMENTS.catalog,
      repos: {
        ...DOCUMENTS.catalog.repos,
        'Acme/Tool': {
          ...DOCUMENTS.catalog.repos['Acme/Tool'],
          reason: 'catalog reason',
          summary: 'catalog summary',
        },
      },
    },
    harvested: [{
      repo: 'Acme/Tool',
      reason: 'ingest reason',
      ingested_at: '2026-10-03T00:00:00Z',
    }],
  }
  const result = await getRepositoryDetails(NO_README, documents, 'acme/tool', { ...NO_FETCH, include_readme: false })
  assert.equal(result.reason, 'ingest reason')
  assert.equal(result.summary, 'catalog summary')

  const reasonEvidence = result.evidence.find(item => item.id === result.provenance.reason)
  const summaryEvidence = result.evidence.find(item => item.id === result.provenance.summary)
  assert.equal(reasonEvidence.source.kind, 'ingest_journal')
  assert.equal(reasonEvidence.source.snapshot_at, '2026-10-03T00:00:00Z')
  assert.equal(summaryEvidence.source.kind, 'catalog')
  assert.equal(summaryEvidence.source.snapshot_at, '2026-10-01T00:00:00Z')
})

test('missing compact metadata is fetched from GitHub with provenance but without README calls', async () => {
  const calls = []
  const result = await getRepositoryDetails(NO_README, DOCUMENTS, 'fresh/project', {
    include_readme: false,
    now: () => new Date('2026-10-03T00:00:00Z'),
    fetcher: async (url) => {
      calls.push(url)
      return Response.json({ full_name: 'Fresh/Project', html_url: 'https://github.com/Fresh/Project', stargazers_count: 10, archived: false, license: { spdx_id: 'NOASSERTION' } })
    },
  })
  assert.deepEqual(calls, ['https://api.github.com/repos/fresh/project'])
  assert.equal(result.archived, false)
  assert.equal(result.license, null)
  assert.equal(result.evidence[0].source.kind, 'github')
  assert.equal(result.evidence[0].source.fetched_at, '2026-10-03T00:00:00.000Z')
})

test('archived README is wrapped and capped while metadata comes from the catalogue', async () => {
  const env = { R2: { get: async (key) => {
    assert.equal(key, `readmes/${README_SHA}.md`)
    return { text: async () => `# Tool\n${'x'.repeat(51000)}` }
  } } }
  const result = await getRepositoryDetails(env, DOCUMENTS, 'acme/tool', NO_FETCH)
  assert.equal(result.truncated, true)
  assert.equal(result.readme_source, 'generation')
  const readmeEvidence = result.evidence.find(item => item.kind === 'readme_document')
  assert.ok(readmeEvidence)
  assert.equal(readmeEvidence.content.readme_sha256, README_SHA)
  assert.equal(result.provenance.readme, readmeEvidence.id)
  assert.ok(result.readme.startsWith('<untrusted_content'))
  assert.ok(result.readme.endsWith('</untrusted_content>'))
})

test('a missing archive falls back to GitHub README without reusing archived content identity', async () => {
  const env = { R2: { get: async () => null } }
  const success = await getRepositoryDetails(env, DOCUMENTS, 'acme/tool', {
    now: () => new Date('2026-10-03T00:00:00Z'),
    fetcher: async () => new Response('# Live README'),
  })
  assert.equal(success.readme_source, 'github')
  const evidence = success.evidence.find(item => item.kind === 'readme_document')
  assert.match(evidence.content.readme_sha256, /^[0-9a-f]{64}$/)
  assert.notEqual(evidence.content.readme_sha256, README_SHA)
  assert.equal(evidence.content.object_key, null)
  assert.equal(evidence.generation, null)
  assert.equal(evidence.source.fetched_at, '2026-10-03T00:00:00.000Z')

  const absent = await getRepositoryDetails(env, DOCUMENTS, 'acme/tool', { fetcher: async () => new Response(null, { status: 404 }) })
  assert.equal(absent.readme_available, false)
  assert.equal(absent.readme, null)
})

test('generation README absence is returned as absence without loading or refetching fake content', async () => {
  const documents = {
    ...DOCUMENTS,
    readmes: {
      generation: {
        id: '20261005T080000Z-ceaa138fd814-777',
        commit: 'ceaa138fd814f70ff2a194cf050a789e7e77cf95',
        published_at: '2026-10-05T08:00:00.000Z',
      },
      repos: {
        'acme/tool': {
          repo: 'Acme/Tool',
          sha256: null,
          object_key: null,
          status: 'absent',
          source_pushed_at: '2026-10-01T00:00:00Z',
        },
      },
    },
  }
  const env = { R2: { get: async () => assert.fail('absent README must not read a blob') } }
  const result = await getRepositoryDetails(env, documents, 'acme/tool', {
    fetcher: async () => assert.fail('unchanged absent README must not be refetched'),
  })
  assert.equal(result.readme_available, false)
  assert.equal(result.readme_source, 'generation')
  assert.equal(result.readme_status, 'absent')
  const evidence = result.evidence.find(item => item.kind === 'readme_document')
  assert.equal(evidence.content.readme_sha256, null)
  assert.equal(evidence.content.object_key, null)
  assert.equal(evidence.content.status, 'absent')
})

test('upstream failure is not returned as empty metadata or an absent README', async () => {
  const fetcher = async () => new Response(null, { status: 503 })
  await assert.rejects(getRepositoryDetails(NO_README, DOCUMENTS, 'missing/repo', { include_readme: false, fetcher }), /missing\/repo.*HTTP 503/)
  await assert.rejects(getRepositoryDetails({ R2: { get: async () => null } }, DOCUMENTS, 'acme/tool', { fetcher }), /README.*Acme\/Tool.*HTTP 503/)
})

test('invalid or duplicate comparison input fails before any I/O', async () => {
  for (const repos of [[], ['one/repo'], ['Acme/Tool', 'acme/tool'], ['../bad', 'good/repo']])
    await assert.rejects(compareRepositories(NO_README, DOCUMENTS, repos, NO_FETCH), /Invalid value/)
  assert.equal(repositoryName('https://github.com/Acme/Tool.git/'), 'Acme/Tool')
})

test('refresh compares current GitHub facts without losing personal reasons', async () => {
  const calls = []
  const result = await compareRepositories(NO_README, DOCUMENTS, ['acme/tool', 'other/tool'], {
    refresh: true,
    fetcher: async (url) => {
      calls.push(url)
      return Response.json({ full_name: url.split('/repos/')[1], license: { spdx_id: 'Apache-2.0' }, stargazers_count: 200 })
    },
  })
  assert.equal(calls.length, 2)
  assert.equal(result.repositories[0].stars, 200)
  assert.equal(result.repositories[0].license, 'Apache-2.0')
  assert.equal(result.repositories[0].reason, 'works offline')
  assert.equal(result.repositories[0].evidence[0].source.kind, 'github')
})

test('frontmatter metadata survives when only a README archive knows the repository', async () => {
  const env = { R2: { get: async (key) => {
    assert.equal(key, `readmes/${README_SHA}.md`)
    return { text: async () => '---\nstars: 42\nlanguage: Go\nreason: useful offline\ncategories: ["research"]\n---\n# Archive' }
  } } }
  const documents = {
    ...DOCUMENTS,
    readmes: {
      generation: { published_at: '2026-10-02T12:00:00Z' },
      repos: {
        'archive/only': { repo: 'archive/only', sha256: README_SHA, object_key: `readmes/${README_SHA}.md` },
      },
    },
  }
  const result = await getRepositoryDetails(env, documents, 'archive/only', NO_FETCH)
  assert.equal(result.stars, 42)
  assert.equal(result.reason, 'useful offline')
  assert.deepEqual(result.categories, ['research'])
  assert.equal(result.evidence[0].source.kind, 'readme_generation')
  assert.equal(result.evidence[0].source.fetched_at, null)
  const note = result.evidence.find(item => item.kind === 'personal_note')
  assert.equal(note.source.kind, 'readme_generation')
  assert.equal(result.provenance.reason, note.id)
})

test('repository lookup errors distinguish missing projects, rate limits and transport failures', async () => {
  for (const [upstream, expected] of [[404, 404], [429, 503], [503, 502]]) {
    await assert.rejects(getRepositoryDetails(NO_README, DOCUMENTS, 'missing/project', {
      include_readme: false,
      fetcher: async () => new Response(null, { status: upstream }),
    }), error => error instanceof RepositoryRequestError && error.status === expected)
  }
  await assert.rejects(getRepositoryDetails(NO_README, DOCUMENTS, 'missing/project', {
    include_readme: false,
    fetcher: async () => { throw new Error('offline') },
  }), /missing\/project.*offline/)
  await assert.rejects(getRepositoryDetails(NO_README, DOCUMENTS, 'missing/project', {
    include_readme: false,
    fetcher: async () => Response.json({}),
  }), /invalid repository metadata.*missing\/project/)
})

test('malformed upstream JSON reports the repository operation instead of returning incomplete facts', async () => {
  await assert.rejects(getRepositoryDetails(NO_README, DOCUMENTS, 'missing/project', {
    include_readme: false,
    fetcher: async () => new Response('<html>upstream error</html>'),
  }), error => error instanceof RepositoryRequestError && error.status === 502 && /metadata for missing\/project/.test(error.message))
})
