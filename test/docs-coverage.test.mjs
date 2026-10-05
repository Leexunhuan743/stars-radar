import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { TOOL_DEFINITIONS } from '../src/tool-schemas.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const guide = fs.readFileSync(path.join(ROOT, 'docs/DEVELOPMENT.md'), 'utf-8')
const workerSource = fs.readFileSync(path.join(ROOT, 'src/index.js'), 'utf-8')

test('the developer guide covers every MCP tool and REST route', () => {
  const routes = [...new Set([...workerSource.matchAll(/url\.pathname === '([^']+)'/g)].map(match => match[1]))]
  assert.ok(routes.length >= 10)
  const missing = [...Object.keys(TOOL_DEFINITIONS), ...routes].filter(name => !guide.includes(name))
  assert.deepEqual(missing, [], `undocumented interfaces: ${missing.join(', ')}`)
})

test('both user READMEs link to the technical guide and explain connection prerequisites', () => {
  for (const file of ['README.md', 'README.en.md']) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf-8')
    for (const required of ['docs/DEVELOPMENT.md', 'Streamable HTTP', '/mcp', 'MCP_API_KEY', 'GH_TOKEN', 'R2_BUCKET'])
      assert.ok(text.includes(required), `${file} is missing ${required}`)
  }
})

test('published documentation has no broken relative file links', () => {
  const files = ['README.md', 'README.en.md', 'docs/DEVELOPMENT.md', 'skills/stars-radar/SKILL.md', ...fs.readdirSync(path.join(ROOT, 'skills/stars-radar/references')).map(file => `skills/stars-radar/references/${file}`)]
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf-8').replace(/```[\s\S]*?```/g, '')
    for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0]
      if (!target || /^[a-z]+:/i.test(target))
        continue
      assert.ok(fs.existsSync(path.resolve(ROOT, path.dirname(file), target)), `${file} links to missing ${target}`)
    }
  }
})
