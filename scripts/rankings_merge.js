// Merging for the community board sources.
//
// The fetchers are network-bound and fail softly (a failed board is replaced by yesterday's
// cache), so the decisions worth testing are the pure ones: how several boards collapse into
// one list, and which upstream files count as "recent". Both live here so they can be
// exercised without network access.

/** How many recent HelloGitHub issues the picks are taken from. */
const HELLOGITHUB_ISSUES = 2

/**
 * The newest HelloGitHub issue files, newest first.
 *
 * Names are `HelloGitHub<number>.md`, so ordering is numeric — a plain string sort would put
 * issue 9 after issue 10.
 */
export function selectRecentIssues(files, count = HELLOGITHUB_ISSUES) {
  return (files || [])
    .filter(f => /^HelloGitHub\d+\.md$/.test(f?.name || ''))
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
    .slice(0, count)
}

/**
 * Collapse the per-board skill rows into one list keyed by skill name.
 *
 * A board that omits the rank column leaves `rank` undefined, and the numbering then depends
 * on how many skills were already known — state a per-file parser cannot know, which is why it
 * is filled in here, in board order. Later boards contribute their tag to the skill they share
 * rather than a second entry.
 *
 * Tags are de-duplicated per row and across rows: an upstream board lists the same skill more
 * than once, and the stored data shipped 8 entries with a repeated tag before this. The Worker
 * only ever asks "is this tag present", so de-duplication changes no query result — it just
 * stops the duplicates from being written in the first place.
 */
export function mergeBoardSkills(rowsByBoard = []) {
  const merged = new Map()
  let nextRank = 1

  for (const rows of rowsByBoard) {
    for (const row of rows || []) {
      const key = row.skill
      if (!key)
        continue

      const tags = [...new Set(row.tags || [])]
      const existing = merged.get(key)
      if (!existing) {
        merged.set(key, { ...row, tags })
        // A ranked row consumes its number so the next unranked one continues the sequence.
        if (row.rank !== undefined)
          nextRank = Math.max(nextRank, row.rank + 1)
        continue
      }

      for (const tag of tags) {
        if (!existing.tags.includes(tag))
          existing.tags.push(tag)
      }
      if (existing.rank === undefined && row.rank !== undefined) {
        existing.rank = row.rank
        nextRank = Math.max(nextRank, row.rank + 1)
      }
    }
  }

  for (const row of merged.values()) {
    if (row.rank === undefined)
      row.rank = nextRank++
  }

  return [...merged.values()]
}
