// The ingest journal: the append-only record of repositories the user staged into Stars Radar.
//
// Why a journal instead of a field in rankings.json:
//
// `rankings.json` is replaced wholesale by every scheduled build, so a Worker-side ingest had to
// be a conditional read-modify-write against a document another writer owns. Reading the ETag
// immediately before writing narrows the race but cannot close it, and losing that race lost the
// ingest silently. An append-only log has no such race: the Worker only ever *creates* a new key,
// the scheduled build only ever *reads* the prefix, and two writers can never touch the same
// object. Concurrent ingests therefore cannot conflict at all — they simply produce two entries
// that fold into one view.
//
// The module is deliberately dependency-free and pure: the Worker reads journal objects from R2,
// the pipeline reads downloaded files, and both fold them with the same code.

/**
 * A key that sorts by time and cannot collide.
 *
 * The Worker creates one object per ingest, so the key must be unique without a read: the
 * timestamp gives the ordering the fold relies on, and the random suffix makes two ingests in
 * the same millisecond two distinct objects instead of one silent overwrite.
 *
 * @param {Date} date
 * @param {string} randomHex at least 16 hex characters, from `crypto.getRandomValues`
 */
export function buildJournalKey(date, randomHex) {
  if (!/^[0-9a-f]{16,}$/i.test(randomHex || ''))
    throw new Error(`buildJournalKey needs at least 16 hex characters of randomness, got ${JSON.stringify(randomHex)}`)
  // Colons are legal in R2 keys but make the objects awkward to handle as filenames, and the
  // pipeline downloads this prefix to disk.
  return `${date.toISOString().replace(/[:.]/g, '-')}-${randomHex.toLowerCase()}.jsonl`
}

/** Reads a 16-byte hex string from the platform CSPRNG (Workers and Node both expose it). */
export function randomHex(bytes = 16) {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return [...buffer].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Parses one journal object. Malformed lines are returned rather than thrown so the caller can
 * report them: an unreadable line is a bug to fix, but it must not hide the valid entries
 * beside it.
 *
 * @returns {{ entries: object[], malformed: number }} parsed entries and the count of lines that
 *   could not be read, so the caller can report them without losing the valid ones.
 */
export function parseJournalText(text) {
  const entries = []
  let malformed = 0
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim())
      continue
    try {
      const entry = JSON.parse(line)
      if (entry?.repo)
        entries.push(entry)
      else
        malformed++
    }
    catch {
      malformed++
    }
  }
  return { entries, malformed }
}

/**
 * Folds journal entries into the current view of what the user staged.
 *
 * Ordering rule: later ingest wins, tie-broken by key so the result does not depend on the order
 * the caller happened to list objects in. `entry.key` is the journal key the entry came from;
 * entries without one are folded after keyed entries.
 */
export function foldIngestEntries(entries, { includeKeys = false } = {}) {
  const byRepo = new Map()
  const ordered = [...entries].sort((a, b) => {
    const at = Date.parse(a?.ingested_at || '') || 0
    const bt = Date.parse(b?.ingested_at || '') || 0
    if (at !== bt)
      return at - bt
    return String(a?.key || '').localeCompare(String(b?.key || ''))
  })

  for (const entry of ordered) {
    if (!entry?.repo)
      continue
    const { key, ...rest } = entry
    byRepo.set(entry.repo.toLowerCase(), includeKeys ? entry : rest)
  }
  // Stable, human-readable order: newest ingest first, which is also the order the UI lists.
  return [...byRepo.values()].sort((a, b) => (Date.parse(b.ingested_at || '') || 0) - (Date.parse(a.ingested_at || '') || 0))
}

/** Convenience for the pipeline: fold every `*.jsonl` file under a journal directory. */
export function foldJournalFiles(files) {
  const entries = []
  const problems = []
  for (const { key, text } of files) {
    const { entries: parsed, malformed } = parseJournalText(text)
    if (malformed > 0)
      problems.push(`${key}: ${malformed} unreadable line(s)`)
    for (const entry of parsed)
      entries.push({ ...entry, key })
  }
  return {
    harvested: foldIngestEntries(entries),
    problems,
    snapshot: { keys: files.map(file => file.key), entries: foldIngestEntries(entries, { includeKeys: true }) },
  }
}

/** CI embeds confirmed ingests even when they are absent from the user's GitHub star list. */
export function embeddingRepositories(catalogRepos, harvested) {
  // Historical ingest rows may contain `summary` copied from GitHub description. That text is
  // already represented by `description`; carrying it as a personal summary both duplicates the
  // semantic signal and crosses the trust boundary.
  const inputs = new Map(harvested.map(repo => [repo.repo.toLowerCase(), { ...repo, summary: '' }]))
  for (const repo of Object.values(catalogRepos)) {
    const ingested = inputs.get(repo.repo.toLowerCase())
    inputs.set(repo.repo.toLowerCase(), {
      ...ingested,
      ...repo,
      reason: ingested?.reason || repo.reason,
      summary: repo.summary || '',
    })
  }
  return [...inputs.values()]
}
