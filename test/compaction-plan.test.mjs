import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { buildCompactionPlan } from '../scripts/build_compaction_plan.js'

test('compaction deletes only previous snapshotted ingests and probes actually downloaded this run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stars-radar-compaction-'))
  try {
    fs.mkdirSync(path.join(root, 'state', 'probe-captures'), { recursive: true })
    fs.writeFileSync(path.join(root, 'state', 'probe-captures', 'probe-a.jsonl'), '{}\n')
    fs.writeFileSync(path.join(root, 'state', 'probe-captures', 'ignore.txt'), 'x')
    fs.writeFileSync(path.join(root, 'previous-asset-index.json'), JSON.stringify({
      ingest_snapshot: {
        keys: [
          'state/ingest-journal/old-b.jsonl',
          'state/ingest-journal/old-a.jsonl',
          'state/ingest-journal/old-a.jsonl',
        ],
        entries: [],
      },
      probe_snapshot: {
        keys: [
          'state/probe-captures/old-probe.jsonl',
          'state/probe-captures/old-probe.jsonl',
        ],
      },
    }))

    const plan = buildCompactionPlan(root)
    assert.deepEqual(plan, {
      schema: 1,
      ingest_keys: [
        'state/ingest-journal/old-a.jsonl',
        'state/ingest-journal/old-b.jsonl',
      ],
      probe_keys: ['state/probe-captures/old-probe.jsonl'],
    })
    assert.equal(
      plan.probe_keys.includes('state/probe-captures/probe-a.jsonl'),
      false,
      'a probe downloaded in the current build is not deleted until a later generation proves it was folded',
    )
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('compaction refuses a snapshot key outside its owned prefix', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stars-radar-compaction-'))
  try {
    fs.writeFileSync(path.join(root, 'previous-asset-index.json'), JSON.stringify({
      ingest_snapshot: { keys: ['catalog.json'], entries: [] },
    }))
    assert.throws(() => buildCompactionPlan(root), /outside the ingest journal prefix/)
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('compaction refuses a probe snapshot key outside its owned prefix', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stars-radar-compaction-'))
  try {
    fs.writeFileSync(path.join(root, 'previous-asset-index.json'), JSON.stringify({
      ingest_snapshot: { keys: [], entries: [] },
      probe_snapshot: { keys: ['state/ingest-journal/not-a-probe.jsonl'] },
    }))
    assert.throws(() => buildCompactionPlan(root), /outside the probe capture prefix/)
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('compaction can use the oldest retained generation as its recovery horizon', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stars-radar-compaction-'))
  try {
    const horizon = path.join(root, 'retained-horizon.json')
    fs.writeFileSync(horizon, JSON.stringify({
      ingest_snapshot: {
        keys: ['state/ingest-journal/safe-at-horizon.jsonl'],
        entries: [],
      },
      probe_snapshot: {
        keys: ['state/probe-captures/safe-at-horizon.jsonl'],
        entries: [],
      },
    }))

    const plan = buildCompactionPlan(root, horizon)
    assert.deepEqual(plan.ingest_keys, ['state/ingest-journal/safe-at-horizon.jsonl'])
    assert.deepEqual(plan.probe_keys, ['state/probe-captures/safe-at-horizon.jsonl'])
  }
  finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
