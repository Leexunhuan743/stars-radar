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

test('toolsets are nested capability profiles and all remains the backward-compatible default', () => {
  const core = resolveToolset('core')
  const research = resolveToolset('research')
  const all = resolveToolset()
  assert.equal(DEFAULT_TOOLSET, 'all')
  assert.equal(core.tools.size, 7)
  assert.equal(research.tools.size, 13)
  assert.equal(all.tools.size, Object.keys(TOOL_DEFINITIONS).length)
  for (const name of core.tools)
    assert.ok(research.tools.has(name))
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

test('core keeps personal retrieval tools and omits open-world probes', () => {
  const core = resolveToolset('core')
  for (const name of ['search_github_stars', 'get_repo_readme', 'compare_repositories', 'get_radar_status'])
    assert.ok(core.tools.has(name))
  for (const name of ['search_github_live', 'search_github_code', 'search_web_tech'])
    assert.equal(core.tools.has(name), false)
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
