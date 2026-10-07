import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../src/version.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('package and runtime publish one version authority', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
  assert.equal(VERSION, '2.0.0')
  assert.equal(pkg.version, VERSION)

  const worker = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf-8')
  assert.doesNotMatch(worker, /version:\s*['"]\d+\.\d+\.\d+['"]/)
  assert.match(worker, /version:\s*VERSION/)
})
