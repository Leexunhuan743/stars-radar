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
    }))

    assert.deepEqual(buildCompactionPlan(root), {
      schema: 1,
      ingest_keys: [
        'state/ingest-journal/old-a.jsonl',
        'state/ingest-journal/old-b.jsonl',
      ],
      probe_keys: ['state/probe-captures/probe-a.jsonl'],
    })
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
