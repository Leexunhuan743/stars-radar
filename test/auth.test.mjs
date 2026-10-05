import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AuthConfigError, authorizeCredential } from '../src/auth.js'

test('v2 requires both read and write credentials', () => {
  assert.throws(() => authorizeCredential('x', {}), AuthConfigError)
  assert.throws(() => authorizeCredential('x', { MCP_API_KEY: 'read' }), AuthConfigError)
  assert.throws(() => authorizeCredential('x', { MCP_WRITE_API_KEY: 'write' }), AuthConfigError)
})

test('read and write credentials must be distinct', () => {
  assert.throws(
    () => authorizeCredential('same', { MCP_API_KEY: 'same', MCP_WRITE_API_KEY: 'same' }),
    /must be different/,
  )
})

test('the read key never gains mutation authority', () => {
  assert.deepEqual(
    authorizeCredential('read', { MCP_API_KEY: 'read', MCP_WRITE_API_KEY: 'write' }),
    { role: 'read', canRead: true, canWrite: false },
  )
})

test('the write key can read and mutate while unknown keys are rejected', () => {
  const env = { MCP_API_KEY: 'read', MCP_WRITE_API_KEY: 'write' }
  assert.deepEqual(authorizeCredential('write', env), { role: 'write', canRead: true, canWrite: true })
  assert.deepEqual(authorizeCredential('unknown', env), { role: 'invalid', canRead: false, canWrite: false })
})
