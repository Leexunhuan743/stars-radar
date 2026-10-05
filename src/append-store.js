// Appending to the Worker-owned state prefixes.
//
// Both state prefixes (the ingest journal and the probe captures) are append-only logs of one
// object per write. That is not a stylistic choice: `rankings.json` is replaced wholesale by the
// scheduled build, so a Worker-side update to it had to be a conditional read-modify-write, and
// losing that race dropped the write silently. Creating a brand-new key has no race to lose —
// two writers never touch the same object — which is why neither prefix needs a precondition.
//
// Kept out of src/index.js — which cannot be imported outside the worker runtime — so the write
// contract is covered by tests.

import { buildJournalKey, randomHex } from './ingest-journal.js'
import { INGEST_JOURNAL_PREFIX } from './object-keys.js'

/**
 * Appends one object holding `entries` as JSON lines under `prefix`.
 *
 * @param {{ R2: { put: Function } }} env
 * @param {string} prefix Key prefix; must end with `/`.
 * @param {object[]} entries Entries to serialise, one JSON object per line.
 * @param {object} [options] Test seams for the clock and the key suffix.
 * @param {() => Date} [options.now] Clock used for the key.
 * @param {() => string} [options.random] Hex randomness for the key suffix.
 * @returns {Promise<string>} the key that was created.
 */
export async function appendJsonLines(env, prefix, entries, { now = () => new Date(), random = randomHex } = {}) {
  if (!prefix?.endsWith('/'))
    throw new Error(`appendJsonLines needs a key prefix ending in "/", got ${JSON.stringify(prefix)}`)
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error('appendJsonLines needs at least one entry; an empty object would record nothing')

  const key = `${prefix}${buildJournalKey(now(), random())}`
  // One JSON object per line, newline-terminated: the container can be appended to later without
  // having to rewrite it, and a torn read of a half-written object is impossible because each
  // object is written exactly once.
  const body = `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`

  await env.R2.put(key, body, { httpMetadata: { contentType: 'application/x-ndjson' } })
  return key
}

/**
 * Appends one repository to the ingest journal.
 *
 * @param {{ R2: { put: Function } }} env
 * @param {object} entry Repository metadata; must carry a `repo`.
 * @param {object} [options] Test seams, forwarded to {@link appendJsonLines}.
 * @returns {Promise<string>} the key that was created.
 */
export async function appendIngest(env, entry, options = {}) {
  if (!entry?.repo)
    throw new Error(`appendIngest needs an entry with a repo name, got ${JSON.stringify(entry)}`)

  const timestamp = (options.now || (() => new Date()))()
  return appendJsonLines(env, INGEST_JOURNAL_PREFIX, [{
    ...entry,
    by: entry.by || 'worker',
    // The fold orders by this field, so it is filled in here rather than trusted to every caller.
    ingested_at: entry.ingested_at || timestamp.toISOString(),
  }], { ...options, now: () => timestamp })
}
