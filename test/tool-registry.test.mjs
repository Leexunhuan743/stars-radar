import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
// Registry wiring test.
//
// test/tool-schemas.test.mjs guards the SHAPE of the schema registry, but nothing
// checked that the Worker actually wires every entry into an MCP tool: deleting a
// registerTool block left the suite green while the tool silently disappeared from
// every client. src/index.js cannot be imported here (it resolves the `cloudflare:`
// scheme), so the wiring is asserted against the source text.
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { TOOL_DEFINITIONS } from '../src/tool-schemas.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workerSource = fs.readFileSync(path.join(ROOT, 'src/index.js'), 'utf-8')

/** name + config-object source of every registerTool call, in file order. */
function registrations() {
  return [...workerSource.matchAll(/registerTool\(\s*TOOL_DEFINITIONS\.(\w+)\.name,\s*\{([\s\S]*?)\},/g)]
    .map(m => [m[0], m[1], m[2]])
}

test('every registered tool definition is actually registered with the MCP server', () => {
  const wired = [...workerSource.matchAll(/registerTool\(\s*TOOL_DEFINITIONS\.(\w+)\.name/g)].map(m => m[1])
  const declared = Object.keys(TOOL_DEFINITIONS)

  const missing = declared.filter(name => !wired.includes(name))
  assert.deepEqual(
    missing,
    [],
    `these tools are declared in tool-schemas.js but never registered, so clients cannot see them: ${missing.join(', ')}`,
  )

  const unknown = wired.filter(name => !declared.includes(name))
  assert.deepEqual(
    unknown,
    [],
    `these registerTool calls reference a definition that does not exist: ${unknown.join(', ')}`,
  )
})

test('registration wrapper is called once per declared tool', () => {
  const wired = [...workerSource.matchAll(/registerTool\(\s*TOOL_DEFINITIONS\.(\w+)\.name/g)]
  assert.equal(
    wired.length,
    Object.keys(TOOL_DEFINITIONS).length,
    'one conditional wrapper call per declared tool keeps toolset filtering on the single registry',
  )
  assert.match(
    workerSource,
    /const registerTool = \(name, config, handler\) => \{[\s\S]*?activeToolset\.tools\.has\(name\)[\s\S]*?server\.registerTool\(name, config, handler\)/,
    'the wrapper must gate the real MCP registration through the active toolset',
  )
})

test('every tool passes its OWN schema by reference, never inline or borrowed', () => {
  // An inline { description, inputSchema } literal — or one tool wired to another's
  // schema — would silently bypass the snapshot test in test/tool-schemas.test.mjs,
  // so the registry would stop being authoritative. Both cases must be checked on the
  // SECOND argument, which is where the schema actually lives; checking only the first
  // argument cannot detect either.
  for (const [, name, config] of registrations()) {
    assert.match(
      config,
      new RegExp(`TOOL_DEFINITIONS\\.${name}\\.description`),
      `tool "${name}" does not take its description from its own registry entry: ${config.trim()}`,
    )
    assert.match(
      config,
      new RegExp(`TOOL_DEFINITIONS\\.${name}\\.inputSchema`),
      `tool "${name}" does not take its input schema from its own registry entry: ${config.trim()}`,
    )
    assert.match(config, new RegExp(`readOnlyHint: TOOL_DEFINITIONS\\.${name}\\.readOnly`), 'the public annotation must use the tool\'s own declared mutability')
  }
})

test('the extraction above parses every tool-definition wrapper call', () => {
  // The wrapper itself delegates once to server.registerTool; only calls carrying a TOOL_DEFINITIONS
  // entry represent public tools and therefore belong in this registry accounting.
  const calls = [...workerSource.matchAll(/registerTool\(\s*TOOL_DEFINITIONS\./g)].length
  assert.equal(
    registrations().length,
    calls,
    'every public tool wrapper call must be parseable by this test',
  )
})
