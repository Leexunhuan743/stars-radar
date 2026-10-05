import assert from 'node:assert/strict'
// The append-only write paths: one object per write, created and never replaced.
//
// This replaces the tests for the conditional read-modify-write of rankings.json. That design's
// whole failure surface — a lost ETag race, three retry shapes, "nothing was staged" — is gone
// because a create against a fresh key cannot conflict. What is left to assert is that the entry
// lands intact, that the container is append-shaped (so a later append cannot corrupt it), and
// that the key carries real randomness (a collision here would silently overwrite a write).
//
// Both state prefixes go through the same appender: the ingest journal and the probe captures.
// They were once separate mechanisms, and the probe one was a non-atomic read-modify-write of a
// per-day object — two isolates capturing in the same second overwrote each other.
import { test } from 'node:test'
import { appendIngest, appendJsonLines } from '../src/append-store.js'
import { parseJournalText } from '../src/ingest-journal.js'
import { INGEST_JOURNAL_PREFIX } from '../src/object-keys.js'
import { emptyRankings } from '../src/rankings-document.js'

const ITEM = { repo: 'acme/tool', url: 'https://github.com/acme/tool', stars: 10 }

function makeEnv({ onPut } = {}) {
  const puts = []
  return {
    puts,
    R2: {
      async put(key, body, options) {
        puts.push({ key, body, options })
        if (onPut)
          return onPut({ key, body })
        return { key }
      },
    },
  }
}

const clock = () => new Date('2026-02-26T10:00:00.000Z')

test('an ingest creates one journal object under the state prefix', async () => {
  const env = makeEnv()
  const key = await appendIngest(env, ITEM, { now: clock, random: () => 'a'.repeat(32) })

  assert.equal(key, `${INGEST_JOURNAL_PREFIX}2026-02-26T10-00-00-000Z-${'a'.repeat(32)}.jsonl`)
  assert.equal(env.puts.length, 1)
  assert.equal(env.puts[0].key, key)
  assert.equal(
    env.puts[0].options?.onlyIf,
    undefined,
    'creating a unique key needs no precondition; adding one would reintroduce a race that cannot exist',
  )
  assert.equal(env.puts[0].options.httpMetadata.contentType, 'application/x-ndjson')
})

test('the entry is written as one complete JSON line with its provenance', async () => {
  const env = makeEnv()
  await appendIngest(env, ITEM, { now: clock, random: () => 'b'.repeat(32) })

  const body = env.puts[0].body
  assert.ok(body.endsWith('\n'), 'a journal object is newline-terminated so it stays append-shaped')
  const { entries, malformed } = parseJournalText(body)
  assert.equal(malformed, 0)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].repo, ITEM.repo)
  assert.equal(entries[0].by, 'worker', 'the fold needs to know which writer produced the entry')
  assert.equal(entries[0].ingested_at, '2026-02-26T10:00:00.000Z', 'the fold orders by this field, so it must always be set')
})

test('two ingests in the same millisecond produce two objects', async () => {
  const env = makeEnv()
  const first = await appendIngest(env, ITEM, { now: clock, random: () => '1'.repeat(32) })
  const second = await appendIngest(env, { ...ITEM, repo: 'acme/other' }, { now: clock, random: () => '2'.repeat(32) })

  assert.notEqual(first, second)
  assert.equal(new Set(env.puts.map(p => p.key)).size, 2)
})

test('an entry without a repo is refused instead of creating an unfindable object', async () => {
  const env = makeEnv()
  await assert.rejects(() => appendIngest(env, { stars: 5 }, { now: clock }), /needs an entry with a repo/)
  assert.equal(env.puts.length, 0, 'nothing may be written for an unusable entry')
})

test('a write failure propagates so the caller can report a failed ingest', async () => {
  const env = makeEnv({
    onPut: () => {
      throw new Error('R2 is unavailable')
    },
  })
  await assert.rejects(() => appendIngest(env, ITEM, { now: clock }), /R2 is unavailable/)
})

test('the document shape the pipeline publishes carries no harvested field', () => {
  // The dual authority is what made an ingest losable: as long as this document has a
  // `harvested` key, some writer will eventually merge into it.
  assert.deepEqual(Object.keys(emptyRankings()).sort(), [
    'agentSkillRepos',
    'agentSkills',
    'breakoutWeekly',
    'helloGitHub',
    'topStarred',
    'trending',
  ])
})

test('probe captures append one object per response, never into a shared per-day key', async () => {
  const env = makeEnv()
  const captures = [{ repo: 'seen/one', query: 'q1' }, { repo: 'seen/two', query: 'q1' }]

  const first = await appendJsonLines(env, 'state/probe-captures/', captures, { now: clock, random: () => 'c'.repeat(32) })
  const second = await appendJsonLines(env, 'state/probe-captures/', [{ repo: 'seen/one', query: 'q2' }], { now: clock, random: () => 'd'.repeat(32) })

  assert.notEqual(first, second, 'two captures must be two objects: a shared per-day key made concurrent writes overwrite each other')
  assert.ok(first.startsWith('state/probe-captures/'))
  const { entries, malformed } = parseJournalText(env.puts[0].body)
  assert.equal(malformed, 0)
  assert.equal(entries.length, 2, 'every capture in the response is written in the same object')
  assert.equal(entries[0].repo, 'seen/one')
})

test('the appender refuses an empty batch or a prefix that is not a directory-like path', async () => {
  const env = makeEnv()
  await assert.rejects(() => appendJsonLines(env, 'state/probe-captures/', [], { now: clock }), /at least one entry/)
  await assert.rejects(() => appendJsonLines(env, 'state/probe-captures', [{ repo: 'a/b' }], { now: clock }), /ending in "\/"/)
  assert.equal(env.puts.length, 0)
})
