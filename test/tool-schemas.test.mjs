// Schema snapshot test: guards MCP tool input schemas against silent drift.
//
// How it works (mirrors the toolsnaps pattern used by github-mcp-server):
//   1. Serializes every tool schema from src/tool-schemas.js into a stable JSON
//      fingerprint using zod's OFFICIAL toJSONSchema() (zod v4). We only strip
//      prose fields (title/description/$schema) so that rewording a .describe()
//      does NOT invalidate the snapshot — only real shape changes do.
//   2. Compares against the committed snapshot in ./__snapshots__/.
//      - Missing snapshot in CI  => FAIL (snapshot must be committed)
//      - Snapshot mismatch       => FAIL with a readable diff of what changed
//   3. After an intended shape change, run `pnpm test:schema:update` on any platform
//      and review the generated snapshot before committing.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { TOOL_DEFINITIONS } from '../src/tool-schemas.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SNAP_DIR = path.join(__dirname, '__snapshots__')
const UPDATE = process.env.UPDATE_SCHEMAS === '1'
const CI = process.env.GITHUB_ACTIONS === 'true'

/** Recursively remove prose-only keys so wording changes never trip the snapshot. */
function stripProse(value) {
  if (Array.isArray(value))
    return value.map(stripProse)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (k === 'description' || k === 'title' || k === '$schema')
        continue
      out[k] = stripProse(v)
    }
    return out
  }
  return value
}

/** Build the complete stable fingerprint document for all tools. */
function buildFingerprint() {
  const doc = {}
  for (const [toolName, def] of Object.entries(TOOL_DEFINITIONS)) {
    const schemaObject = z.object(def.inputSchema)
    const raw = z.toJSONSchema(schemaObject, { name: def.name })
    doc[toolName] = {
      name: def.name,
      readOnly: def.readOnly ?? true,
      schema: stripProse(raw),
    }
  }
  return doc
}

const fp = buildFingerprint()
const serialized = `${JSON.stringify(fp, null, 2)}\n`

test('tool schemas: snapshot registry consistency', () => {
  const toolNames = Object.keys(fp)
  assert.ok(toolNames.length >= 13, `expected >=13 tools, got ${toolNames.length}`)
  for (const [k, v] of Object.entries(fp)) {
    assert.equal(v.name, k, `definition key "${k}" must match its name field`)
    assert.ok(v.schema.type === 'object', `tool "${k}" schema must be an object`)
  }
})

test('tool schemas: no accidental drift from committed snapshots', () => {
  fs.mkdirSync(SNAP_DIR, { recursive: true })
  const snapPath = path.join(SNAP_DIR, 'tool-schemas.snap.json')

  if (UPDATE) {
    fs.writeFileSync(snapPath, serialized)
    return // regenerate mode: test passes and writes new snapshot
  }

  if (!fs.existsSync(snapPath)) {
    if (CI) {
      assert.fail('schema snapshot missing in CI. Run `pnpm test:schema:update` locally and commit the snapshot.')
    }
    // local first run: adopt the snapshot automatically
    fs.writeFileSync(snapPath, serialized)
    return
  }

  const existing = fs.readFileSync(snapPath, 'utf-8').replace(/\r\n/g, '\n')
  assert.equal(
    serialized,
    existing,
    `Tool schema drift detected! Run \`pnpm test:schema:update\` to accept the new shape, then review the diff in ${snapPath.replace(process.cwd(), '.')} before committing.`,
  )
})
