import { appendJsonLines } from '../src/append-store.js'
import { INGEST_JOURNAL_PREFIX } from '../src/object-keys.js'
import { putObject, r2Target } from './r2-rest.js'

export async function publishHarvest(repos, { target = r2Target('publishHarvest'), put = putObject, now = () => new Date() } = {}) {
  if (!target)
    throw new Error('Harvest metadata publishing requires R2_ACCOUNT_ID, R2_BUCKET and CLOUDFLARE_API_TOKEN. Nothing was recorded.')
  const date = now()
  const entries = repos.map(repo => ({ ...repo, by: 'harvest', ingested_at: date.toISOString() }))
  // Reuse the Worker's key and serialization contract: a harvest is a new journal object,
  // never a replacement of rankings or an index another publisher owns.
  const env = { R2: { put: (key, body, options) => put(target, key, options.httpMetadata.contentType, body) } }
  return appendJsonLines(env, INGEST_JOURNAL_PREFIX, entries, { now: () => date })
}
