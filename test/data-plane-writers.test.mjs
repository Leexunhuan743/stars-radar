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

test('the upload step refuses a run that produced no asset index', async () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yaml'), 'utf-8')
  assert.ok(
    !/was not produced by this run and is not being uploaded/.test(workflow),
    'the silent warning branch is back: an object that this run was supposed to produce would be skipped while the job still succeeds',
  )
  assert.match(
    workflow,
    /::error::asset-index\.json was not produced by this run[\s\S]{0,200}?\n\s*exit 1/,
    'asset-index.json must be fatal when missing: scripts/asset_store.js writes it unconditionally, so its absence means R2 keeps serving a stale index',
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

test('the sweep is gated on a non-empty corpus, and every upload is read back', () => {
  // Two guards that exist because the bucket is now the only copy:
  //   * `sync --delete` with an empty stars/ deletes the whole README corpus while reporting
  //     success, so the sweep must be refused when there is nothing to sweep with;
  //   * an upload that silently truncated would leave the Worker serving the previous revision
  //     of a document this job claims to have published, so each document is read back.
  const build = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yaml'), 'utf-8')

  const emptyCorpusGuard = build.match(/local_readmes[\s\S]{0,400}?exit 1/)
  assert.ok(emptyCorpusGuard, 'the sweep is no longer gated on a non-empty corpus')
  assert.ok(
    build.indexOf('local_readmes') < build.indexOf('aws s3 sync stars/'),
    'the corpus check must precede the sync that uses --delete',
  )

  assert.match(build, /head-object --bucket "\$\{R2_BUCKET\}" --key "\$\{key\}"[\s\S]{0,200}ContentLength/, 'uploaded documents must be read back and sized')
  assert.match(build, /BEFORE_INGEST_OBJECTS/, 'the run must record the ingest journal size it started with')
  assert.match(
    build,
    /ingests were destroyed/,
    'the read-back step must fail when the journal shrank during the run',
  )

  // Prefix counts decide whether a prefix is empty or unreadable, and the first version of this
  // got both halves wrong in ways only a live run exposed:
  //   * `aws s3 ls` exits non-zero for an absent prefix, so a first run looked like a credentials
  //     failure and the job stopped;
  //   * `--query KeyCount` prints the literal "None" for an empty listing, and "None" compared as
  //     a string against a number meant the zero-backup guard never fired.
  // Match the quoted form commands use; the comment above the helper names the query on purpose.
  assert.ok(!/--query\s+['"]KeyCount['"]/.test(build), '--query KeyCount returns "None" for an empty prefix; count the JSON listing instead')
  assert.match(build, /count_objects\(\) \{[\s\S]{0,400}?\|\| return 1/, 'the counting helper must fail only when the request itself failed')
  // Each step runs in its own shell, so the helper must be defined in every step that calls it —
  // using it without the definition failed a live run with `command not found`. One definition per
  // step that counts, and one call site per count (the read-back loop counts both prefixes from a
  // single call).
  assert.equal((build.match(/count_objects\(\) \{/g) || []).length, 4, 'the counting helper must be defined in every step that uses it')
  assert.equal((build.match(/count_objects "/g) || []).length, 4, 'every prefix count must go through the helper')

  // The corpus has to come back from R2 before the sync runs, otherwise every repository looks new
  // and all ~930 READMEs are re-fetched from GitHub on every run — the incrementality the
  // pipeline's own predicate implements never gets a chance to apply.
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

test('no workflow ever deletes or sweeps the Worker-owned state prefixes', () => {
  // Two independent hazards, both silent:
  //   * the bucket-root `sync --delete` would remove any prefix it does not explicitly exclude,
  //     so one schedule tick could delete every ingest and probe capture;
  //   * the merge step used to `s3 rm --recursive` the probe prefix afterwards, which raced with
  //     the Worker appending new captures and — with no snapshots — destroyed the only copy.
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
