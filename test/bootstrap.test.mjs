import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { seedLocalR2 } from '../scripts/seed-local-r2.js'
import { verifyVectorPair } from '../scripts/verify_vector_pair.js'
import { ACTIVE_GENERATION_KEY } from '../src/data-generation.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fixture({ starred = [], graphqlFailure = false, readmeFailure = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stars-radar-bootstrap-'))
  const stub = path.join(directory, 'stub.mjs')
  fs.writeFileSync(stub, `
    const starred = ${JSON.stringify(starred)};
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.includes('/user/starred')) return Response.json(starred);
      if (url.endsWith('/graphql')) return Response.json(${graphqlFailure ? '{ errors: [{ message: "denied" }] }' : '{ data: { viewer: { lists: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }'});
      if (url.endsWith('/readme')) return new Response(${readmeFailure ? '"denied", { status: 403 }' : '"# Fixture README", { headers: { "content-type": "text/plain" } }'});
      if (url.includes('/embeddings')) {
        const body = JSON.parse(init.body || '{}');
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return Response.json({
          data: inputs.map((_, index) => ({ index, embedding: [1, ...Array(1023).fill(0)] })),
        });
      }
      return new Response('Fixture denies external network access', { status: 403 });
    };
  `)
  const env = {
    ...process.env,
    GITHUB_TOKEN: 'fixture-token',
    SILICONFLOW_KEY: 'fixture-key',
    SILICONFLOW_URL: 'https://embedding.example/v1/embeddings',
    VECTOR_STORE_ROOT: directory,
    ASSET_STORE_ROOT: directory,
    R2_ACCOUNT_ID: '',
    R2_BUCKET: '',
    CLOUDFLARE_API_TOKEN: '',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
  }
  return {
    directory,
    run: script => spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, path.join(root, 'scripts', script)], { cwd: directory, env, encoding: 'utf-8', timeout: 30000 }),
    clean: () => fs.rmSync(directory, { recursive: true, force: true }),
  }
}

for (const starred of [[], [{ full_name: 'fixture/tool', name: 'tool', owner: { login: 'fixture' }, stargazers_count: 1, pushed_at: '2026-10-01T00:00:00Z', private: false }]]) {
  test(`a fresh build with ${starred.length} public stars bootstraps all local artifacts`, async () => {
    const setup = fixture({ starred })
    try {
      const result = setup.run('index.js')
      assert.equal(result.status, 0, result.stderr)
      fs.mkdirSync(path.join(setup.directory, 'data'))
      fs.copyFileSync(path.join(root, 'data/intents.json'), path.join(setup.directory, 'data/intents.json'))
      const assets = setup.run('asset_store.js')
      assert.equal(assets.status, 0, assets.stderr)
      assert.ok(await verifyVectorPair(setup.directory))
      const catalogue = JSON.parse(fs.readFileSync(path.join(setup.directory, 'catalog.json')))
      assert.equal(catalogue.totalRepos, starred.length)
      if (starred.length)
        assert.equal(catalogue.categories[0].name, 'everything-else')
      const keys = []
      await seedLocalR2({ put: async (key) => {
        keys.push(key)
      } }, setup.directory)
      assert.ok(keys.includes(ACTIVE_GENERATION_KEY))
      assert.ok(
        keys.some(key => /^generations\/[\w.-]+\/asset-index\.json$/.test(key)),
        'local seed must mirror production and place the asset index under the active generation',
      )
      assert.ok(
        keys.some(key => /^generations\/[\w.-]+\/generation-manifest\.json$/.test(key)),
        'local seed must include the generation manifest used to inspect a staged publication',
      )
      assert.equal(keys.some(key => /^readmes\/[0-9a-f]{64}\.md$/.test(key)), starred.length > 0)
      fs.unlinkSync(path.join(setup.directory, 'asset-index.json'))
      await assert.rejects(seedLocalR2({ put: async () => assert.fail('no partial seed allowed') }, setup.directory), /Generation is missing required documents: asset-index\.json/)
    }
    finally {
      setup.clean()
    }
  })
}

test('a failed Lists read cannot prune an existing corpus or replace the catalogue', () => {
  const setup = fixture({ graphqlFailure: true })
  try {
    fs.mkdirSync(path.join(setup.directory, 'stars', 'fixture'), { recursive: true })
    fs.writeFileSync(path.join(setup.directory, 'stars', 'fixture', 'old.md'), '# Keep me')
    const catalogue = JSON.stringify({ categories: [], repos: { 'fixture/old': {} } })
    fs.writeFileSync(path.join(setup.directory, 'catalog.json'), catalogue)
    const result = setup.run('index.js')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /denied/)
    assert.equal(fs.readFileSync(path.join(setup.directory, 'catalog.json'), 'utf-8'), catalogue)
    assert.equal(fs.readFileSync(path.join(setup.directory, 'stars', 'fixture', 'old.md'), 'utf-8'), '# Keep me')
  }
  finally {
    setup.clean()
  }
})

test('README download failure cannot publish a successful new catalogue', () => {
  const setup = fixture({ starred: [{ full_name: 'fixture/tool', name: 'tool', owner: { login: 'fixture' }, stargazers_count: 1 }], readmeFailure: true })
  try {
    const result = setup.run('index.js')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /refusing to publish a partial corpus/)
    assert.equal(fs.existsSync(path.join(setup.directory, 'catalog.json')), false)
  }
  finally {
    setup.clean()
  }
})
