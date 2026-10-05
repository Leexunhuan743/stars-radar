import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
// Configuration contract test: keeps `.env.example` and the code that reads
// environment variables in sync in BOTH directions.
//
// Two drift classes have already occurred in this repository:
//   * a variable declared in `.env.example` that no code reads (`CUSTOM_DOMAIN`),
//     which misleads operators into setting something inert;
//   * a variable the code requires that was missing from the example file, so a
//     fresh deployment fails with no hint about what to set.
//
// This is a static contract check, not a style check: it asserts the published
// configuration surface matches the one the code actually consumes.
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Cloudflare bindings are declared in wrangler.jsonc and injected by the platform, so
// they are not environment variables and must not appear in .env.example.
const RUNTIME_BINDINGS = new Set(['R2'])

// Consumed by the CI workflow through the `aws s3` CLI, not by any code in the repo.
const CI_TOOLING_ONLY = new Set(['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'])

// Test-harness overrides that redirect a script's data root at a throwaway directory.
// Deliberately not deployment knobs, so they stay out of .env.example.
const TEST_ONLY = new Set(['ASSET_STORE_ROOT', 'VECTOR_STORE_ROOT'])

function readDeclared() {
  const text = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf-8')
  const declared = new Set()
  for (const line of text.split(/\r?\n/)) {
    // Commented-out entries still document a variable (HTTP_PROXY is shipped commented
    // on purpose), so the leading `#` is tolerated.
    const match = line.match(/^#?\s*([A-Z][A-Z0-9_]*)=/)
    if (match)
      declared.add(match[1])
  }
  return declared
}

function readConsumed() {
  const consumed = new Set()
  const sources = [
    ...fs.readdirSync(path.join(ROOT, 'src')).filter(f => f.endsWith('.js')).map(f => path.join('src', f)),
    ...fs.readdirSync(path.join(ROOT, 'scripts')).filter(f => f.endsWith('.js')).map(f => path.join('scripts', f)),
    ...fs.readdirSync(path.join(ROOT, 'scripts')).filter(f => f.endsWith('.py')).map(f => path.join('scripts', f)),
  ]

  for (const rel of sources) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf-8')
    for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g))
      consumed.add(m[1])
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g))
      consumed.add(m[1])
    for (const m of text.matchAll(/os\.environ(?:\.get\(\s*|\[\s*)["']([A-Z][A-Z0-9_]*)["']/g))
      consumed.add(m[1])
    for (const m of text.matchAll(/os\.getenv\(\s*["']([A-Z][A-Z0-9_]*)["']/g))
      consumed.add(m[1])
  }
  return consumed
}

const declared = readDeclared()
const consumed = readConsumed()

// Secrets the workflows are allowed to reference. A typo here is invisible on a pull
// request — an unset secret expands to an empty string rather than failing — so the only
// symptom is a step that silently does nothing.
const WORKFLOW_SECRETS = new Set([
  'GH_TOKEN', // the star/README token, mapped to GITHUB_TOKEN for the build step
  'SILICONFLOW_KEY',
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'CLOUDFLARE_API_TOKEN',
])

function readWorkflowSecrets() {
  const dir = path.join(ROOT, '.github', 'workflows')
  const found = new Map()
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))) {
    const text = fs.readFileSync(path.join(dir, file), 'utf-8')
    for (const m of text.matchAll(/secrets\.([A-Za-z_]\w*)/g)) {
      if (!found.has(m[1]))
        found.set(m[1], file)
    }
  }
  return found
}

test('every workflow secret reference is a known configuration name', () => {
  const referenced = readWorkflowSecrets()
  // An empty scan would make the assertion below pass by scanning nothing at all.
  assert.ok(referenced.size > 0, 'no workflow secrets were found, so this check proves nothing')
  assert.ok(referenced.has('GH_TOKEN'), 'the star sync token must be referenced by a workflow for this scan to be meaningful')

  const unknown = [...referenced]
    .filter(([name]) => !WORKFLOW_SECRETS.has(name))
    .map(([name, file]) => `${file}: secrets.${name}`)
  assert.deepEqual(
    unknown,
    [],
    `a workflow references a secret that is not part of the documented configuration, which would silently be empty: ${unknown.join(', ')}`,
  )
})

test('every excluded configuration name really belongs to its exclusion category', () => {
  // These three sets are the test's own allow-list, so without evidence they are a way to
  // silence a finding rather than a documented exception. Each entry is checked against
  // where it actually lives.
  const wrangler = fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf-8')
  for (const name of RUNTIME_BINDINGS)
    assert.match(wrangler, new RegExp(`"binding"\\s*:\\s*"${name}"`), `${name} must be declared as a Worker binding`)

  const secrets = readWorkflowSecrets()
  for (const name of CI_TOOLING_ONLY)
    assert.ok(secrets.has(name), `${name} is excluded as CI tooling but no workflow references it`)

  const testSources = fs.readdirSync(path.join(ROOT, 'test'))
    .filter(f => f.endsWith('.mjs'))
    .map(f => fs.readFileSync(path.join(ROOT, 'test', f), 'utf-8'))
    .join('\n')
  for (const name of TEST_ONLY)
    assert.ok(testSources.includes(name), `${name} is excluded as test-only but no test sets it`)
})

test('the Node version is declared once and enforced by tooling', () => {
  // Three files state the required Node version: `.node-version` (what CI and version
  // managers read), `package.json` `engines` (what a package manager refuses to install
  // on), and the README table. Nothing checked that they agreed, so a bump in one place
  // would leave the others silently wrong — and a Node below the floor fails deep inside
  // the test runner rather than at install time.
  const pinned = fs.readFileSync(path.join(ROOT, '.node-version'), 'utf-8').trim()
  const engines = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).engines?.node

  assert.ok(pinned, '.node-version must name a version')
  assert.ok(engines, 'package.json must declare engines.node so a wrong runtime is refused loudly')

  const major = Number(pinned.split('.')[0])
  assert.ok(Number.isInteger(major), `.node-version must start with a major number, got ${JSON.stringify(pinned)}`)

  // A range means "at least this major"; an exact pin means "this major". Either way the
  // floor must be the pinned version — a lower floor lets an older Node install cleanly and
  // then fail deep inside the pipeline, which is the outcome this assertion exists to stop.
  const floor = Number((engines.match(/\d+/) || [])[0])
  assert.ok(Number.isInteger(floor), `engines.node must contain a version number, got ${JSON.stringify(engines)}`)
  assert.equal(floor, major, `engines.node (${engines}) must agree with .node-version (${pinned})`)

  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8')
  // Kept loose on purpose: the README is hand-written prose, so the version may appear in
  // a table cell, as "22" or as "22.x" — only the number itself is the contract.
  assert.match(readme, new RegExp(`Node\\.js[^\\n]{0,16}${major}`), `README must state Node ${major}`)
})

test('the fail-closed variables are still present', () => {
  // MCP_API_KEY has no default by design: the Worker refuses to serve without it.
  for (const name of ['MCP_API_KEY', 'GITHUB_TOKEN', 'SILICONFLOW_KEY']) {
    assert.ok(declared.has(name), `${name} must stay documented in .env.example`)
    assert.ok(consumed.has(name), `${name} must still be read by the code`)
  }
})

test('every environment variable the code reads is documented in .env.example', () => {
  const undocumented = [...consumed].filter(
    name => !declared.has(name) && !RUNTIME_BINDINGS.has(name) && !CI_TOOLING_ONLY.has(name) && !TEST_ONLY.has(name),
  )
  assert.deepEqual(
    undocumented,
    [],
    `these variables are read but not listed in .env.example, so a fresh deployment cannot know about them: ${undocumented.join(', ')}`,
  )
})

test('every variable documented in .env.example is actually consumed', () => {
  const inert = [...declared].filter(
    name => !consumed.has(name) && !CI_TOOLING_ONLY.has(name) && !TEST_ONLY.has(name),
  )
  assert.deepEqual(
    inert,
    [],
    `these variables are documented but nothing reads them: ${inert.join(', ')}`,
  )
})
