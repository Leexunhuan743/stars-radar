import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// Data-plane writer contract.
//
// Three writers once published `rankings.json` to R2 with three different semantics — the
// Worker used a conditional write, the scheduled build replaced the whole object from its
// git copy, and the local harvest script did an unconditional PUT from a laptop. Only the
// first of those can be correct, and the third silently reverted whatever the Worker had
// ingested. These assertions pin the writer set down so it cannot grow back unnoticed.
//
// The baseline test is a real behaviour test rather than a source scan: an unreadable
// `rankings.json` used to be reported and then ignored, which republished every community
// layer as empty and dropped the harvested entries with it.
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('the local pipeline exposes no second publisher for rankings.json', async () => {
  const pipeline = await import('../scripts/vector_pipeline.js')
  assert.ok(
    !('syncRankingsToR2' in pipeline),
    'vector_pipeline.js publishes a rankings document again; only the Worker may write it, because only the Worker can make the write conditional',
  )
  assert.ok(!('syncVectorsToR2' in pipeline), 'CI owns vector publication; the local builder has no R2 publisher')

  const harvest = fs.readFileSync(path.join(ROOT, 'scripts', 'harvest_and_ingest.js'), 'utf-8')
  assert.ok(
    !/writeFileSync|writeJsonSync|syncRankingsToR2|harvested\s*=/.test(harvest),
    'the harvest script replaces documents again; harvesting may only append metadata to the journal',
  )
})

test('a missing baseline starts empty, an unreadable one fails', async () => {
  // The distinction is the whole point: absent means "first run" now that the document lives on
  // R2, while unreadable means "corrupt" — and rebuilding from an empty baseline in that case
  // would republish every community layer as empty.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stars-radar-baseline-'))
  const { readRankingsBaseline } = await import('../scripts/fetch_rankings.js')

  try {
    const empty = readRankingsBaseline(path.join(tmp, 'rankings.json'))
    assert.equal(empty.trending && typeof empty.trending === 'object', true, 'a first run starts from the documented shape')

    const corrupt = path.join(tmp, 'corrupt.json')
    fs.writeFileSync(corrupt, '{ "trending": ', 'utf-8')
    assert.throws(
      () => readRankingsBaseline(corrupt),
      /Could not read .*corrupt\.json/,
      'a corrupt baseline must fail rather than silently emptying every layer',
    )
  }
  finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('generation staging refuses a run that produced no asset index', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yaml'), 'utf-8')
  const prepare = fs.readFileSync(path.join(ROOT, 'scripts', 'prepare_data_generation.js'), 'utf-8')

  assert.match(workflow, /node scripts\/prepare_data_generation\.js/)
  assert.match(prepare, /ASSET_INDEX_KEY/)
  assert.match(
    prepare,
    /Generation is missing required documents/,
    'a build that failed to produce asset-index.json must stop before any generation can activate',
  )
})

test('the data plane is not committed, and no job commits it', () => {
  // While these files were in git, the checkout was the scheduled build's input — which is how a
  // stale copy could overwrite what the Worker had just published. The guard has two halves: the
  // files must stay untracked (a `.gitignore` entry does nothing for a file already tracked), and
  // no workflow may recreate the commit-and-push step that published them.
  const build = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yaml'), 'utf-8')
  const commitStep = build.match(/git add[^\n]*/g) || []
  assert.deepEqual(commitStep, [], `build.yaml stages files again, which turns git back into a data channel: ${commitStep.join(', ')}`)

  const dataFiles = [
    'catalog.json',
    'rankings/rankings.json',
    'asset-state.json',
    'embeddings-index.json',
    'AWESOME_STARS.md',
    'stars.opml',
  ]
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf-8')
  for (const file of dataFiles)
    assert.ok(gitignore.includes(file), `${file} is no longer ignored, so the next run would commit it again`)
})

test('the publishing job cannot write to the repository', () => {
  // Two separate reasons to keep this true. Least privilege, and the reason the commit-and-push
  // step was removable at all: a job that can write to git can publish its outputs through git,
  // which is how a stale checkout came to overwrite what the Worker had just served. The token it
  // needs is for R2 and the Worker, not for the repository that defines what it runs.
  const build = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yaml'), 'utf-8')
  // Comments are dropped first: explaining the change means naming the old value, and a scan that
  // cannot tell prose from configuration would forbid the explanation.
  const configuration = build.split('\n').filter(line => !line.trim().startsWith('#')).join('\n')

  const permissions = configuration.match(/permissions:[\s\S]{0,120}/)
  assert.ok(permissions, 'build.yaml no longer declares permissions for the publishing job')
  assert.match(permissions[0], /contents: read/, 'the publishing job no longer declares read-only access')
  assert.ok(
    !/contents: write/.test(configuration),
    'the publishing job regained repository write access, which is the channel the data plane was moved out of',
  )
})

test('the README sweep is guarded and immutable generation uploads are read back before activation', () => {
  const build = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yaml'), 'utf-8')

  const emptyCorpusGuard = build.match(/local_readmes[\s\S]{0,400}?exit 1/)
  assert.ok(emptyCorpusGuard, 'the README sweep is no longer gated on a non-empty corpus')
  assert.ok(
    build.indexOf('local_readmes') < build.indexOf('aws s3 sync stars/'),
    'the corpus check must precede the sync that uses --delete',
  )
  assert.match(build, /--exclude "generations\/\*"/)
  assert.match(build, /--exclude "active-generation\.json"/)

  const dollar = String.fromCharCode(36)
  const readback = 'aws s3 cp "s3://' + dollar + '{R2_BUCKET}/generations/'
    + dollar + '{GENERATION_ID}/' + dollar + '{rel}"'
  const exactCompare = 'cmp -s ".generation-stage/' + dollar + '{rel}" "'
    + dollar + '{verify_dir}/' + dollar + '{rel}"'
  assert.ok(build.includes(readback), 'every staged generation object must be read back from R2')
  assert.ok(build.includes(exactCompare), 'every staged generation object must be compared byte-for-byte')
  assert.ok(
    build.indexOf(readback) < build.indexOf(exactCompare),
    'the remote object must be downloaded before its exact-content comparison',
  )
  assert.ok(
    build.indexOf('Verify immutable generation in R2') < build.indexOf('Activate verified data generation'),
    'active-generation.json must move only after immutable object verification',
  )

  assert.match(
    build,
    /aws s3 sync "s3:\/\/\$\{R2_BUCKET\}\/" stars\/[\s\S]{0,200}--include "\*\/\*\.md"/,
    'the README corpus must be restored from R2 before the incremental sync',
  )
  assert.ok(
    build.indexOf('Download the README corpus from R2') < build.indexOf('Fetch starred repos and READMEs'),
    'the corpus restore must happen before the sync that decides what to fetch',
  )
})

test('every http answer goes through the envelope helper', () => {
  // The envelope only helps if it is not optional: one endpoint answering with a bare body is the
  // shape mismatch this replaced. OPTIONS carries no body by definition, so it is the only
  // exception.
  const worker = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf-8')
  const rawResponses = worker.match(/return new Response\([^\n]*/g) || []
  assert.deepEqual(
    rawResponses.map(line => line.trim()).filter(line => !line.includes('status: 204')),
    [],
    'every answer except the CORS preflight must be built by src/http.js',
  )
  assert.ok(
    !/jsonResponse\(/.test(worker),
    'routes must use okResponse/errorResponse; jsonResponse is the low-level builder behind them',
  )
})

test('no workflow recursively deletes Worker-owned state prefixes', () => {
  // Root corpus sweeps must exclude state, and compaction may delete only exact keys from the
  // generated plan. Recursive deletion of a state prefix would race with Worker appends.
  const workflows = fs.readdirSync(path.join(ROOT, '.github', 'workflows'))
    .filter(name => name.endsWith('.yaml') || name.endsWith('.yml'))
    .map(name => ({ name, text: fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf-8') }))

  const build = workflows.find(w => w.name === 'build.yaml')
  assert.ok(build, 'build.yaml must exist for this check to mean anything')

  // Specifically the sync whose destination is the bucket root: the other `s3 sync` calls only
  // read state prefixes into the workspace.
  const sync = build.text.match(/aws s3 sync stars\/ "s3:\/\/\$\{R2_BUCKET\}\/"[\s\S]*?cli-connect-timeout \d+/)
  assert.ok(sync, 'the bucket-root sync is expected to exist')
  assert.match(sync[0], /--exclude "state\/\*"/, 'the state prefix must be excluded from the corpus sync')

  // `--delete` is passed through the guarded array rather than spelled out in the sync command,
  // so the way to check that the sweep is still gated is to check where the flag is built.
  // (`--delete` also appears in the comment above the guard, so match the assignment itself.)
  const deleteFlag = build.text.match(/sweep=\(--delete\)/)
  assert.ok(deleteFlag, 'the corpus sweep disappeared, or it is no longer passed through the guard; stale READMEs would accumulate forever')
  assert.ok(
    build.text.indexOf('local_readmes') < build.text.indexOf('sweep=(--delete)'),
    'the corpus check must run before the sweep flag is built',
  )

  for (const { name, text } of workflows) {
    const destructive = text.match(/aws s3 rm[^\n]*state\/[^\n]*/g) || []
    assert.deepEqual(destructive, [], `${name} deletes objects under state/, which has no backup: ${destructive.join(', ')}`)
  }
})
