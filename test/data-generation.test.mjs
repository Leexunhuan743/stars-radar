import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ACTIVE_GENERATION_KEY,
  createGenerationPointer,
  DATA_GENERATION_SCHEMA,
  GENERATION_READY_KEY,
  generationKey,
  generationPrefix,
  parseGenerationPointer,
} from '../src/data-generation.js'

const ID = '20261005T071500Z-ceaa138fd814-12345'
const SHA = 'ceaa138fd814f70ff2a194cf050a789e7e77cf95'

test('generation ids are immutable sortable publication namespaces', () => {
  assert.equal(ACTIVE_GENERATION_KEY, 'active-generation.json')
  assert.equal(GENERATION_READY_KEY, 'ready.json')
  assert.equal(generationPrefix(ID), `generations/${ID}/`)
  assert.equal(generationKey(ID, 'catalog.json'), `generations/${ID}/catalog.json`)
  assert.throws(() => generationKey('latest', 'catalog.json'), /Invalid data generation id/)
  assert.throws(() => generationKey(ID, '../catalog.json'), /Invalid generation logical key/)
})

test('the active pointer is a strict schema with a full commit identity', () => {
  const pointer = createGenerationPointer(ID, SHA, '2026-10-05T07:15:00.000Z')
  assert.deepEqual(pointer, {
    schema: DATA_GENERATION_SCHEMA,
    id: ID,
    published_at: '2026-10-05T07:15:00.000Z',
    commit: SHA,
  })
  assert.deepEqual(parseGenerationPointer(pointer), pointer)
  assert.throws(() => parseGenerationPointer({ ...pointer, schema: 2 }), /Unsupported/)
  assert.throws(() => parseGenerationPointer({ ...pointer, commit: 'short' }), /full commit SHA/)
})
