import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { prepareDataGeneration } from '../scripts/prepare_data_generation.js'

const ID = '20261005T080000Z-ceaa138fd814-777'
const SHA = 'ceaa138fd814f70ff2a194cf050a789e7e77cf95'

function seedRequired(root) {
  fs.mkdirSync(path.join(root, 'rankings'), { recursive: true })
  fs.writeFileSync(path.join(root, 'catalog.json'), '{}')
  fs.writeFileSync(path.join(root, 'rankings', 'rankings.json'), '{}')
  fs.writeFileSync(path.join(root, 'asset-index.json'), '{}')
  fs.writeFileSync(path.join(root, 'asset-state.json'), '{}')
}

test('a generation is staged under logical keys and the pointer is written separately', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stars-radar-generation-'))
  try {
    seedRequired(root)
    const { pointer, manifest, stage } = prepareDataGeneration({
      root,
      generationId: ID,
      commit: SHA,
      publishedAt: '2026-10-05T08:00:00.000Z',
    })

    assert.equal(pointer.id, ID)
    assert.deepEqual(Object.keys(manifest.files).sort(), [
      'asset-index.json',
      'asset-state.json',
      'catalog.json',
      'rankings.json',
      'readmes.json',
    ])
    assert.equal(fs.existsSync(path.join(stage, 'catalog.json')), true)
    assert.equal(fs.existsSync(path.join(stage, 'generation-manifest.json')), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'active-generation.json'))), pointer)
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a partial vector generation is refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stars-radar-generation-'))
  try {
    seedRequired(root)
    fs.writeFileSync(path.join(root, 'embeddings.bin'), 'partial')
    assert.throws(
      () => prepareDataGeneration({ root, generationId: ID, commit: SHA }),
      /partial vector set/,
    )
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('README manifest preserves stale and unavailable evidence state without blocking a generation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stars-radar-generation-'))
  try {
    seedRequired(root)
    fs.mkdirSync(path.join(root, 'stars', 'acme'), { recursive: true })
    fs.writeFileSync(path.join(root, 'stars', 'acme', 'cached.md'), '# Cached README')
    fs.writeFileSync(path.join(root, '.readme-sync-status.json'), JSON.stringify({
      repos: {
        'acme/cached': {
          repo: 'acme/cached',
          status: 'stale',
          upstream_pushed_at: '2026-10-05T07:00:00Z',
          source_pushed_at: '2026-10-04T07:00:00Z',
          preserved_from_generation: '20261004T080000Z-ceaa138fd814-1',
        },
        'acme/absent': {
          repo: 'acme/absent',
          status: 'absent',
          upstream_pushed_at: '2026-10-05T07:00:00Z',
          source_pushed_at: '2026-10-05T07:00:00Z',
        },
        'acme/unavailable': {
          repo: 'acme/unavailable',
          status: 'unavailable',
        },
      },
    }))

    const { stage, manifest } = prepareDataGeneration({
      root,
      generationId: ID,
      commit: SHA,
      publishedAt: '2026-10-05T08:00:00.000Z',
    })
    const readmes = JSON.parse(fs.readFileSync(path.join(stage, 'readmes.json'), 'utf8'))
    assert.equal(readmes.schema, 2)
    assert.equal(readmes.repos['acme/cached'].status, 'stale')
    assert.equal(readmes.repos['acme/cached'].preserved_from_generation, '20261004T080000Z-ceaa138fd814-1')
    assert.equal(readmes.repos['acme/cached'].upstream_pushed_at, '2026-10-05T07:00:00Z')
    assert.equal(readmes.repos['acme/cached'].source_pushed_at, '2026-10-04T07:00:00Z')
    assert.match(readmes.repos['acme/cached'].sha256, /^[0-9a-f]{64}$/)
    assert.equal(readmes.repos['acme/absent'].status, 'absent')
    assert.equal(readmes.repos['acme/absent'].sha256, null)
    assert.equal(readmes.repos['acme/absent'].object_key, null)
    assert.equal(readmes.repos['acme/unavailable'].status, 'unavailable')
    assert.equal(readmes.repos['acme/unavailable'].sha256, null)
    assert.equal(manifest.readme_blobs, 1)
    assert.equal(manifest.readme_absent, 1)
    assert.equal(manifest.readme_unavailable, 1)
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
