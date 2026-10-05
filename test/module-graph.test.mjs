import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
// Module graph integrity: every relative import inside src/ and scripts/ must resolve to
// a file that exists, and the JSON the Worker imports must be present.
//
// This is the cheapest way to catch a typo'd or stale import path. The Worker bundle
// check in ci.yaml would also catch it, but only after a full CI round trip, and only
// if wrangler can resolve the graph — whereas a broken relative import is a plain
// file-system fact. Nothing else in the suite reads the import graph: the module
// contract checks import individual modules by name.
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIRS = ['src', 'scripts'].map(name => path.join(ROOT, name))

function jsFilesIn(dir) {
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.js'))
    .map(name => path.join(dir, name))
}

function relativeSpecifiers(source) {
  return [...source.matchAll(/(?:^|\s)(?:import|export)[^'"]*?from\s+['"](\.[^'"]+)['"]/g)].map(m => m[1])
}

test('every relative import in src/ and scripts/ resolves to an existing file', () => {
  const files = DIRS.flatMap(jsFilesIn)
  assert.ok(files.length > 10, 'the scan must actually find the source modules')

  const broken = []
  for (const file of files) {
    for (const specifier of relativeSpecifiers(fs.readFileSync(file, 'utf-8'))) {
      const resolved = path.resolve(path.dirname(file), specifier)
      if (!fs.existsSync(resolved))
        broken.push(`${path.relative(ROOT, file)} -> ${specifier}`)
    }
  }

  assert.deepEqual(broken, [], `these imports point at files that do not exist: ${broken.join(', ')}`)
})

test('the shared modules are actually reached from both sides of the project', () => {
  // src/date-range.js is imported by the Worker and by the pipeline; the parsers and
  // exporters are imported by the pipeline. A module that nothing imports is dead weight.
  const importers = new Map()
  for (const file of DIRS.flatMap(jsFilesIn)) {
    for (const specifier of relativeSpecifiers(fs.readFileSync(file, 'utf-8'))) {
      const resolved = path.relative(ROOT, path.resolve(path.dirname(file), specifier)).replace(/\\/g, '/')
      importers.set(resolved, [...(importers.get(resolved) || []), path.relative(ROOT, file).replace(/\\/g, '/')])
    }
  }
  for (const module of ['src/date-range.js', 'scripts/rankings_parsers.js', 'scripts/star_export.js', 'src/ranking.js']) {
    assert.ok(importers.has(module), `${module} is not imported by anything`)
  }
  assert.equal(
    importers.get('src/date-range.js').length,
    3,
    'date-range.js is shared by the Worker and two pipeline entry points',
  )

  // The fold of the ingest journal and the shape of the community document are contracts between
  // the Worker and the pipeline. If either stops being imported from both sides, the two sides
  // have started disagreeing about what the journal or the document means.
  for (const shared of ['src/ingest-journal.js', 'src/rankings-document.js']) {
    const from = importers.get(shared) || []
    assert.ok(
      from.some(file => file.startsWith('src/')),
      `${shared} is no longer imported by the Worker: ${from.join(', ')}`,
    )
    assert.ok(
      from.some(file => file.startsWith('scripts/')),
      `${shared} is no longer imported by the pipeline: ${from.join(', ')}`,
    )
  }
})

test('a script reads shared data, never the Worker\u2019s source tree', () => {
  // The pipeline read `src/intents.json` by path — data that both sides use, addressed through the
  // Worker's source directory. That is a layering inversion with a concrete cost: the pipeline could
  // not run anywhere the Worker's sources were not also copied, and "which file is data" stopped
  // being answerable from the layout. Shared data lives in data/; both sides import or read it there.
  const offenders = []
  for (const file of jsFilesIn(path.join(ROOT, 'scripts'))) {
    const source = fs.readFileSync(file, 'utf-8')
    for (const [index, line] of source.split('\n').entries()) {
      if (line.trim().startsWith('//') || line.trim().startsWith('*'))
        continue
      if (/['"`]src\/|resolve\([^)]*['"]src['"]/.test(line))
        offenders.push(`${path.relative(ROOT, file)}:${index + 1} reaches into src/ by path: ${line.trim()}`)
    }
  }
  assert.deepEqual(offenders, [], 'scripts may import shared modules, but must not read files out of src/ by path')
})

test('the intent tables are where both sides expect them', () => {
  const dataPath = path.join(ROOT, 'data', 'intents.json')
  assert.ok(fs.existsSync(dataPath), 'data/intents.json is the shared intent table')
  assert.equal(fs.existsSync(path.join(ROOT, 'src', 'intents.json')), false, 'it must not also live under src/')

  const intents = JSON.parse(fs.readFileSync(dataPath, 'utf-8'))
  assert.ok(Object.keys(intents).length >= 18, 'the ontology is documented as 18 domains')
})

test('the json import that the worker relies on is present', () => {
  // src/index.js imports the intent tables; a missing file breaks the bundle for a reason that is
  // invisible to eslint. The specifier may leave src/ — the tables are shared with the pipeline and
  // live in data/ rather than inside the Worker's source tree.
  const src = path.join(ROOT, 'src')
  const worker = fs.readFileSync(path.join(src, 'index.js'), 'utf-8')
  const jsonImports = [...worker.matchAll(/from\s+['"](\.\.?\/[^'"]+\.json)['"]/g)].map(m => m[1])
  assert.ok(jsonImports.length > 0, 'the worker is expected to import at least one JSON file')
  for (const specifier of jsonImports) {
    assert.ok(
      fs.existsSync(path.resolve(src, specifier)),
      `${specifier} is imported by the worker but does not exist`,
    )
  }
})
