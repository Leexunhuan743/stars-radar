import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import fs from 'fs-extra'
import { INGEST_JOURNAL_PREFIX, PREVIOUS_ASSET_INDEX_FILE, PROBE_CAPTURE_PREFIX } from '../src/object-keys.js'

const ROOT = process.env.ASSET_STORE_ROOT
  ? path.resolve(process.env.ASSET_STORE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const COMPACTION_PLAN_FILE = '.data-compaction-plan.json'

export function buildCompactionPlan(root = ROOT, indexPath = path.resolve(root, PREVIOUS_ASSET_INDEX_FILE)) {
  const previousIndexPath = indexPath
  let ingestKeys = []
  let probeKeys = []

  if (fs.existsSync(previousIndexPath)) {
    const previous = fs.readJsonSync(previousIndexPath)
    const ingestSnapshot = previous.ingest_snapshot || { keys: [] }
    const probeSnapshot = previous.probe_snapshot || { keys: [] }

    if (!Array.isArray(ingestSnapshot.keys))
      throw new Error(`${PREVIOUS_ASSET_INDEX_FILE} has an invalid ingest_snapshot.keys.`)
    if (!Array.isArray(probeSnapshot.keys))
      throw new Error(`${PREVIOUS_ASSET_INDEX_FILE} has an invalid probe_snapshot.keys.`)

    ingestKeys = [...new Set(ingestSnapshot.keys)].sort()
    probeKeys = [...new Set(probeSnapshot.keys)].sort()
  }

  if (ingestKeys.some(key => !key.startsWith(INGEST_JOURNAL_PREFIX) || !key.endsWith('.jsonl')))
    throw new Error('Refusing compaction: previous ingest snapshot contains a key outside the ingest journal prefix.')
  if (probeKeys.some(key => !key.startsWith(PROBE_CAPTURE_PREFIX) || !key.endsWith('.jsonl')))
    throw new Error('Refusing compaction: previous probe snapshot contains a key outside the probe capture prefix.')

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
  const at = process.argv.indexOf('--index')
  const indexPath = at >= 0 ? process.argv[at + 1] : undefined
  if (at >= 0 && !indexPath)
    throw new Error('Usage: node scripts/build_compaction_plan.js [--index <index-file>]')
  const plan = buildCompactionPlan(ROOT, indexPath ? path.resolve(indexPath) : undefined)
  fs.writeJsonSync(path.resolve(ROOT, COMPACTION_PLAN_FILE), plan, { spaces: 2 })
  console.log(`[Compaction] planned ${plan.ingest_keys.length} ingest deletion(s) and ${plan.probe_keys.length} probe deletion(s).`)
}
