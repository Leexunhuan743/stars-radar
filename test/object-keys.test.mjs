import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
// The bucket's key space.
//
// Two layouts coexist — flat documents at the root, `owner/repo.md` for the corpus, and directory-like
// `state/...` prefixes for the Worker's append-only logs — and the scheduled build maps between the
// local staging tree and the bucket. Getting the mapping wrong is either a missing README or an
// object written to a key nobody reads, so the derivations are tested rather than trusted.
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ASSET_INDEX_KEY,
  ASSET_STATE_KEY,
  bucketKeyForLocalReadme,
  CATALOG_KEY,
  EMBEDDINGS_BIN_KEY,
  EMBEDDINGS_INDEX_KEY,
  INGEST_JOURNAL_PREFIX,
  isReadmeKey,
  localReadmePath,
  PROBE_CAPTURE_PREFIX,
  RANKINGS_KEY,
  readmeKey,
  repoFromReadmeKey,
} from '../src/object-keys.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('the corpus key round-trips, preserving the owner casing GitHub returned', () => {
  const key = readmeKey('Acme/PlayMaster')
  assert.equal(key, 'Acme/PlayMaster.md')
  assert.equal(repoFromReadmeKey(key), 'Acme/PlayMaster')
  assert.equal(isReadmeKey(key), true)
})

test('only README objects are recognised as READMEs', () => {
  // The archive lister pages past the JSON documents and the state prefixes, so this predicate is
  // what decides whether an object counts as a repository.
  for (const key of [CATALOG_KEY, RANKINGS_KEY, ASSET_INDEX_KEY, ASSET_STATE_KEY, EMBEDDINGS_INDEX_KEY, EMBEDDINGS_BIN_KEY])
    assert.equal(isReadmeKey(key), false, `${key} is a document, not a README`)
  for (const key of [`${INGEST_JOURNAL_PREFIX}2026-09-15T00-00-00-000Z-abc.jsonl`, `${PROBE_CAPTURE_PREFIX}2026-09-15T00-00-00-000Z-abc.jsonl`])
    assert.equal(isReadmeKey(key), false, `${key} is a state object, not a README`)
  assert.equal(repoFromReadmeKey(CATALOG_KEY), null)
  assert.equal(isReadmeKey(undefined), false)
})

test('a repository name is required, so a missing one cannot produce a key like "undefined.md"', () => {
  assert.throws(() => readmeKey(''), /needs a repository name/)
  assert.throws(() => readmeKey(undefined), /needs a repository name/)
})

test('the local staging path mirrors the bucket key under stars/', () => {
  assert.equal(localReadmePath('Acme/Tool'), 'stars/Acme/Tool.md')
  assert.equal(bucketKeyForLocalReadme('stars/Acme/Tool.md'), 'Acme/Tool.md', 'the upload strips the local prefix')
  assert.equal(bucketKeyForLocalReadme(localReadmePath('a/b')), readmeKey('a/b'), 'staging and upload agree by construction')
})

test('a path outside the staging tree is refused rather than uploaded to a guessed key', () => {
  assert.throws(() => bucketKeyForLocalReadme('README.md'), /is not under stars\//)
  assert.throws(() => bucketKeyForLocalReadme('rankings/rankings.json'), /is not under stars\//)
})

test('the document keys are the ones the pipeline and the Worker already use', () => {
  // Pinned because these names are also written by CI's upload command and read by the Worker's
  // loaders; a rename has to be deliberate on both sides.
  assert.deepEqual(
    [CATALOG_KEY, RANKINGS_KEY, ASSET_INDEX_KEY, ASSET_STATE_KEY, EMBEDDINGS_INDEX_KEY, EMBEDDINGS_BIN_KEY],
    ['catalog.json', 'rankings.json', 'asset-index.json', 'asset-state.json', 'embeddings-index.json', 'embeddings.bin'],
  )
  assert.equal(INGEST_JOURNAL_PREFIX, 'state/ingest-journal/')
  assert.equal(PROBE_CAPTURE_PREFIX, 'state/probe-captures/')
})

test('no module outside object-keys.js spells a bucket key', () => {
  // The point of declaring the key space once is that it stays declared once. A literal that comes
  // back — a new loader, a copied upload list — is invisible until the day one of them is renamed,
  // so the scan is made here rather than trusted to review.
  //
  // Comment lines are skipped: the bucket layout is worth explaining in prose, and prose does not
  // write objects. Code lines mentioning a key only through an imported constant are the goal.
  const KEYS = [CATALOG_KEY, RANKINGS_KEY, ASSET_INDEX_KEY, ASSET_STATE_KEY, EMBEDDINGS_INDEX_KEY, EMBEDDINGS_BIN_KEY, INGEST_JOURNAL_PREFIX, PROBE_CAPTURE_PREFIX]

  const sources = []
  for (const dir of ['src', 'scripts']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (name.endsWith('.js') && name !== 'object-keys.js')
        sources.push({ path: `${dir}/${name}`, text: fs.readFileSync(path.join(ROOT, dir, name), 'utf-8') })
    }
  }
  assert.ok(sources.length > 10, 'the scan found no modules to check, so it would pass vacuously')

  const offenders = []
  for (const { path: file, text } of sources) {
    for (const [index, line] of text.split('\n').entries()) {
      const code = line.trim()
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*'))
        continue
      const bare = line.replace(/\/\/.*$/, '')
      for (const key of KEYS) {
        if (bare.includes(key))
          offenders.push(`${file}:${index + 1} spells ${key} instead of importing it`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})
