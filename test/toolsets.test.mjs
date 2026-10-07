import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TOOL_DEFINITIONS } from '../src/tool-schemas.js'
import {
  DEFAULT_TOOLSET,
  resolveToolset,
  ToolsetConfigError,
  toolsetStatus,
  validateToolsetCoverage,
} from '../src/toolsets.js'

test('research is the safe default and all is the explicit write-capable profile', () => {
  const research = resolveToolset()
  const all = resolveToolset('all')
  assert.equal(DEFAULT_TOOLSET, 'research')
  assert.equal(research.tools.size, 13)
  assert.equal(all.tools.size, Object.keys(TOOL_DEFINITIONS).length)
  for (const name of research.tools)
    assert.ok(all.tools.has(name))
})

test('research hides mutation tools while all exposes them', () => {
  const research = resolveToolset('research')
  assert.equal(research.tools.has('capture_github_discovery'), false)
  assert.equal(research.tools.has('star_and_ingest_repo'), false)

  const all = resolveToolset('all')
  assert.equal(all.tools.has('capture_github_discovery'), true)
  assert.equal(all.tools.has('star_and_ingest_repo'), true)
})

test('invalid toolsets fail configuration rather than silently widening access', () => {
  assert.throws(() => resolveToolset('everything'), ToolsetConfigError)
  assert.deepEqual(toolsetStatus('everything'), {
    name: 'everything',
    valid: false,
    tool_count: 0,
    write_tools_exposed: false,
  })
})

test('every toolset only references declared tools', () => {
  assert.deepEqual(validateToolsetCoverage(), [])
})

test('research automatically exposes every declared read-only tool and no write tool', () => {
  const research = resolveToolset('research')
  for (const [name, definition] of Object.entries(TOOL_DEFINITIONS))
    assert.equal(research.tools.has(name), definition.readOnly !== false, `research mutability mismatch for ${name}`)
})
