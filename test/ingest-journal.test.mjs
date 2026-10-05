import assert from 'node:assert/strict'
// Behaviour of the ingest journal: key generation, the fold rule, and the guarantees the Worker
// relies on (unique keys without a read, order-independent fold, malformed lines isolated).
import { test } from 'node:test'
import {
  buildJournalKey,
  foldIngestEntries,
  foldJournalFiles,
  parseJournalText,
  randomHex,
} from '../src/ingest-journal.js'

const entry = (repo, ingestedAt, extra = {}) => ({ repo, ingested_at: ingestedAt, ...extra })

test('a journal key sorts by time and is unique without a read', () => {
  const early = buildJournalKey(new Date('2026-02-26T10:00:00.000Z'), 'a'.repeat(32))
  const late = buildJournalKey(new Date('2026-02-26T10:00:00.001Z'), 'b'.repeat(32))

  assert.ok(early < late, 'keys must sort chronologically so listing order is meaningful')
  assert.ok(!early.includes(':'), 'the key doubles as a filename when the pipeline downloads the prefix')
  assert.match(early, /^2026-02-26T10-00-00-000Z-[0-9a-f]{32}\.jsonl$/)

  // Two ingests in the same millisecond must be two objects, not one overwrite.
  const a = buildJournalKey(new Date('2026-02-26T10:00:00.000Z'), randomHex())
  const b = buildJournalKey(new Date('2026-02-26T10:00:00.000Z'), randomHex())
  assert.notEqual(a, b, 'same-millisecond ingests collided, which would silently drop one')
})

test('a key without real randomness is refused', () => {
  // A short or missing suffix would make collisions likely, and a collision here means losing an
  // ingest without any error.
  assert.throws(() => buildJournalKey(new Date(), ''), /randomness/)
  assert.throws(() => buildJournalKey(new Date(), 'abcd'), /randomness/)
})

test('folding keeps the latest ingest per repository and ignores order', () => {
  const older = { ...entry('Acme/Tool', '2026-02-20T00:00:00Z', { stars: 10 }), key: 'a' }
  const newer = { ...entry('acme/tool', '2026-02-25T00:00:00Z', { stars: 20 }), key: 'b' }
  const other = { ...entry('Other/Repo', '2026-02-21T00:00:00Z'), key: 'c' }

  const forward = foldIngestEntries([older, newer, other])
  const backward = foldIngestEntries([other, newer, older])

  assert.deepEqual(forward, backward, 'the view must not depend on the order objects were listed in')
  assert.equal(forward.length, 2)
  assert.equal(
    forward.find(e => e.repo.toLowerCase() === 'acme/tool').stars,
    20,
    'the most recent ingest must win, regardless of the casing used',
  )
})

test('folding drops the journal key but keeps the entry payload', () => {
  const [folded] = foldIngestEntries([{ ...entry('Acme/Tool', '2026-02-25T00:00:00Z', { by: 'worker' }), key: 'k' }])
  assert.equal(folded.key, undefined, 'the object key is bookkeeping and must not leak into the view')
  assert.equal(folded.by, 'worker')
  assert.equal(folded.repo, 'Acme/Tool')
})

test('malformed lines are counted, not thrown, and do not hide valid entries', () => {
  const text = `${JSON.stringify(entry('Acme/Tool', '2026-02-25T00:00:00Z'))}\n{ not json\n\n{"noRepo":true}\n`
  const { entries, malformed } = parseJournalText(text)

  assert.equal(entries.length, 1, 'the valid entry must survive')
  assert.equal(malformed, 2, 'both the invalid JSON and the entry without a repo are reported')
})

test('the pipeline fold reports which object carried an unreadable line', () => {
  const files = [
    { key: 'state/ingest-journal/one.jsonl', text: `${JSON.stringify(entry('Acme/Tool', '2026-02-25T00:00:00Z'))}\n` },
    { key: 'state/ingest-journal/two.jsonl', text: 'not json at all\n' },
  ]
  const { harvested, problems } = foldJournalFiles(files)

  assert.equal(harvested.length, 1)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /two\.jsonl/)
})
