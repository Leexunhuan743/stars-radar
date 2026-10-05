import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import fs from 'fs-extra'
import { INGEST_JOURNAL_PREFIX, PREVIOUS_ASSET_INDEX_FILE, PROBE_CAPTURE_PREFIX } from '../src/object-keys.js'

const ROOT = process.env.ASSET_STORE_ROOT
  ? path.resolve(process.env.ASSET_STORE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const COMPACTION_PLAN_FILE = '.data-compaction-plan.json'

function exactPrefixKeys(directory, prefix) {
  if (!fs.existsSync(directory))
    return []
  return fs.readdirSync(directory)
    .filter(name => name.endsWith('.jsonl'))
    .map(name => `${prefix}${name}`)
    .sort()
}

export function buildCompactionPlan(root = ROOT) {
  const previousIndexPath = path.resolve(root, PREVIOUS_ASSET_INDEX_FILE)
  let ingestKeys = []
  if (fs.existsSync(previousIndexPath)) {
    const snapshot = fs.readJsonSync(previousIndexPath).ingest_snapshot || { keys: [] }
    if (!Array.isArray(snapshot.keys))
      throw new Error(`${PREVIOUS_ASSET_INDEX_FILE} has an invalid ingest_snapshot.keys.`)
    ingestKeys = [...new Set(snapshot.keys)].sort()
  }

  if (ingestKeys.some(key => !key.startsWith(INGEST_JOURNAL_PREFIX) || !key.endsWith('.jsonl')))
    throw new Error('Refusing compaction: previous ingest snapshot contains a key outside the ingest journal prefix.')

  const probeKeys = exactPrefixKeys(path.resolve(root, PROBE_CAPTURE_PREFIX), PROBE_CAPTURE_PREFIX)
  return {
    schema: 1,
    ingest_keys: ingestKeys,
    probe_keys: probeKeys,
  }
}

export function writeCompactionPlan(root = ROOT) {
  const plan = buildCompactionPlan(root)
  fs.writeJsonSync(path.resolve(root, COMPACTION_PLAN_FILE), plan, { spaces: 2 })
  return plan
}

if (process.argv[1]?.endsWith('build_compaction_plan.js')) {
  const plan = writeCompactionPlan()
  console.log(`[Compaction] planned ${plan.ingest_keys.length} ingest deletion(s) and ${plan.probe_keys.length} probe deletion(s).`)
}
