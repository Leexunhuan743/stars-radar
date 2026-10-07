import fs from 'node:fs'
import process from 'node:process'
import { INGEST_JOURNAL_PREFIX, PROBE_CAPTURE_PREFIX } from '../src/object-keys.js'

const MODES = {
  ingest: { prefix: INGEST_JOURNAL_PREFIX, snapshot: 'ingest_snapshot' },
  probe: { prefix: PROBE_CAPTURE_PREFIX, snapshot: 'probe_snapshot' },
}

export function stateTailKeys({ listing, previousIndex = {}, mode }) {
  const config = MODES[mode]
  if (!config)
    throw new Error(`Unknown state tail mode ${JSON.stringify(mode)}.`)

  const previous = previousIndex?.[config.snapshot] || { keys: [] }
  if (!Array.isArray(previous.keys))
    throw new Error(`previous asset index has invalid ${config.snapshot}.keys`)

  const seen = new Set(previous.keys)
  return (listing?.Contents || [])
    .map(item => item?.Key)
    .filter(key => typeof key === 'string' && key.startsWith(config.prefix) && key.endsWith('.jsonl'))
    .filter(key => !seen.has(key))
    .sort()
}

if (process.argv[1]?.endsWith('state_tail_plan.js')) {
  const [mode, listingFile, previousIndexFile] = process.argv.slice(2)
  if (!mode || !listingFile)
    throw new Error('Usage: node scripts/state_tail_plan.js <ingest|probe> <listing.json> [previous-index-file]')

  const listing = JSON.parse(fs.readFileSync(listingFile, 'utf8'))
  const previousIndex = previousIndexFile && fs.existsSync(previousIndexFile)
    ? JSON.parse(fs.readFileSync(previousIndexFile, 'utf8'))
    : {}

  for (const key of stateTailKeys({ listing, previousIndex, mode }))
    process.stdout.write(`${key}\t${key}\n`)
}
