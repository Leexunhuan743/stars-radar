import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { getPlatformProxy, unstable_dev } from 'wrangler'
import { seedLocalR2 } from '../scripts/seed-local-r2.js'
import { DIMS, vectorManifest } from '../src/embeddings.js'

test('the actual Worker serves authenticated research routes and registers usable MCP tools', { timeout: 120000 }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stars-radar-worker-'))
  const config = path.join(directory, 'wrangler.json')
  const state = path.join(directory, 'state')
  const key = 'fixture-integration-read-key'
  const writeKey = 'fixture-integration-write-key'
  fs.writeFileSync(config, JSON.stringify({
    name: 'fixture-research-worker',
    main: path.join(root, 'src', 'index.js'),
    compatibility_date: '2025-04-08',
    compatibility_flags: ['nodejs_compat'],
    vars: { MCP_API_KEY: key, MCP_WRITE_API_KEY: writeKey, GITHUB_TOKEN: '', SILICONFLOW_KEY: '', BRAVE_SEARCH_API_KEY: '', TAVILY_API_KEY: '' },
    r2_buckets: [{ binding: 'R2', bucket_name: 'fixture-research-bucket' }],
  }))
  let proxy
  let worker
  let client
  try {
    proxy = await getPlatformProxy({ configPath: config, envFiles: [], persist: { path: path.join(state, 'v3') }, remoteBindings: false })
    const repos = {
      'fixture/one': { repo: 'fixture/one', description: 'terminal music player', license: 'MIT', reason: 'saved for research' },
      'fixture/two': { repo: 'fixture/two', description: 'markdown notes', license: 'Apache-2.0' },
    }
    const writeArtifact = async (key, content) => fs.writeFileSync(path.join(directory, key), typeof content === 'string' ? content : new Uint8Array(content))
    await writeArtifact('catalog.json', JSON.stringify({ repos, totalRepos: 2, categories: [], generatedAt: '2026-10-03T00:00:00Z' }))
    await writeArtifact('asset-index.json', JSON.stringify({ repos: {}, intent_inverted: {}, totalRepos: 0 }))
    const names = Object.keys(repos)
    const index = new TextEncoder().encode(JSON.stringify(names))
    const binary = new Float32Array(DIMS * names.length)
    binary[0] = 1
    binary[DIMS] = 1
    await writeArtifact('embeddings-index.json', index)
    await writeArtifact('embeddings.bin', binary.buffer)
    await writeArtifact('embeddings-manifest.json', JSON.stringify(await vectorManifest(names, index, binary)))
    fs.mkdirSync(path.join(directory, 'rankings'))
    fs.writeFileSync(path.join(directory, 'rankings', 'rankings.json'), '{}')
    fs.mkdirSync(path.join(directory, 'stars', 'fixture'), { recursive: true })
    fs.writeFileSync(path.join(directory, 'stars', 'fixture', 'one.md'), '# Local README\nVerified terminal music player seed data.')
    assert.equal(await seedLocalR2(proxy.env.R2, directory), 7)
    await proxy.dispose()
    proxy = null
    worker = await unstable_dev(path.join(root, 'src', 'index.js'), {
      config,
      envFiles: [],
      local: true,
      persist: true,
      persistTo: state,
      port: 0,
      inspect: false,
      logLevel: 'none',
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false, showInteractiveDevSession: false },
    })
    const headers = { Authorization: `Bearer ${key}` }
    const writeHeaders = { Authorization: `Bearer ${writeKey}` }
    assert.equal((await worker.fetch('/health')).status, 401)
    const health = await (await worker.fetch('/health', { headers })).json()
    assert.equal(health.ok, true)
    assert.equal(health.data.totalStarred, 2, 'temporary R2 data must be loaded before any candidate lookup')
    assert.equal(health.data.vectorCount, 2)
    const compared = await (await worker.fetch('/api/compare?repos=fixture/one,fixture/two', { headers })).json()
    assert.deepEqual(compared.data.repositories.map(repo => repo.license), ['MIT', 'Apache-2.0'])
    assert.equal((await worker.fetch('/api/compare?repos=fixture/one,FIXTURE/ONE', { headers })).status, 400)
    assert.equal((await worker.fetch('/api/ingest', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'fixture/one' }),
    })).status, 403, 'read credentials must be rejected before any write-side work')
    assert.equal((await worker.fetch('/api/ingest', {
      method: 'POST',
      headers: { ...writeHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'fixture/one', categories: 'incorrect-type' }),
    })).status, 400, 'the write credential reaches validation but malformed metadata is still rejected before upstream work')
    const metadata = await (await worker.fetch('/api/repository?repo=fixture/one', { headers })).json()
    assert.equal('readme' in metadata.data, false)
    const search = await (await worker.fetch('/api/search?q=music%20player&explain=true', { headers })).json()
    assert.equal(search.data[0].repo, 'fixture/one')
    assert.ok(search.data[0].explanation.matched_tokens.includes('music'))
    assert.equal(search.data[0].explanation.readme_evidence.status, 'ok')
    assert.equal(search.data[0].explanation.readme_evidence.source, 'cached_readme')
    assert.match(search.data[0].explanation.readme_evidence.snippets[0].snippet, /terminal music player/)
    client = new Client({ name: 'fixture-research-client', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://${worker.address}:${worker.port}/mcp`), { requestInit: { headers } }))
    const tools = await client.listTools()
    assert.equal(tools.tools.length, 15)
    assert.equal(tools.tools.find(tool => tool.name === 'compare_repositories').annotations.readOnlyHint, true)
    assert.equal(tools.tools.find(tool => tool.name === 'search_github_live').annotations.readOnlyHint, true)
    assert.equal(tools.tools.find(tool => tool.name === 'capture_github_discovery').annotations.readOnlyHint, false)
    const deniedWrite = await client.callTool({ name: 'capture_github_discovery', arguments: { repo: 'acme/tool', query: 'terminal' } })
    assert.equal(deniedWrite.isError, true)
    assert.equal(JSON.parse(deniedWrite.content[0].text).error, 'write_forbidden')

    const result = await client.callTool({ name: 'compare_repositories', arguments: { repos: ['fixture/one', 'fixture/two'] } })
    assert.notEqual(result.isError, true)
    assert.equal(JSON.parse(result.content[0].text).repositories.length, 2)
    const rejected = await client.callTool({ name: 'compare_repositories', arguments: { repos: ['fixture/one', 'FIXTURE/ONE'] } })
    assert.equal(rejected.isError, true)
    const recalled = await client.callTool({ name: 'search_github_stars', arguments: { query: 'music player', explain: true } })
    assert.notEqual(recalled.isError, true)
    assert.equal(JSON.parse(recalled.content[0].text)[0].repo, 'fixture/one')
  }
  finally {
    if (client)
      await client.close()
    if (worker)
      await worker.stop()
    if (proxy)
      await proxy.dispose()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
