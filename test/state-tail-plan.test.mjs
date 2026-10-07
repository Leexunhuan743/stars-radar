import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stateTailKeys } from '../scripts/state_tail_plan.js'

test('state tail planning downloads only unseen ingest objects', () => {
  const oldKey = 'state/ingest-journal/old.jsonl'
  const newKey = 'state/ingest-journal/new.jsonl'
  assert.deepEqual(stateTailKeys({
    mode: 'ingest',
    listing: { Contents: [{ Key: oldKey }, { Key: newKey }] },
    previousIndex: { ingest_snapshot: { keys: [oldKey] } },
  }), [newKey])
})

test('probe tail planning is isolated from the ingest snapshot', () => {
  const oldKey = 'state/probe-captures/old.jsonl'
  const newKey = 'state/probe-captures/new.jsonl'
  assert.deepEqual(stateTailKeys({
    mode: 'probe',
    listing: { Contents: [{ Key: oldKey }, { Key: newKey }, { Key: 'state/ingest-journal/other.jsonl' }] },
    previousIndex: { probe_snapshot: { keys: [oldKey] } },
  }), [newKey])
})
