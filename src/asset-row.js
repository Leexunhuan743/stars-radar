// The asset row: one record per repository, written by every source, read by the Worker.
//
// Three writers built this object by hand — the catalogue pass (personal stars), the community and
// ingest pass (`createUpsert`), and the probe pass — and each wrote a slightly different shape. The
// drift was not theoretical: the probe pass never wrote `description_zh`, so a repository discovered
// by a probe and later promoted to the hot set carried no Chinese description, while the same
// repository arriving through rankings did. Nothing compared the three, so nothing failed.
//
// Two kinds of field live in a row:
//   * derived from the source's own metadata (`description`, `stars`, …), where a *newer* value
//     replaces an older one but a missing one must not erase what an earlier source contributed;
//   * accumulated across runs (`first_seen_at`, `trending_count`, `probe_hits`), where the previous
//     value is the input and the source only decides whether to advance it.
//
// The tier rule is the subtle one and is stated here once: the strongest statement about a
// repository wins, whatever order the sources happen to be read in — the user's star, then the
// ingest they confirmed, then a board's sighting, then an unconfirmed probe guess. Only
// `demoteUnstarred` may take the `starred` tier away again.

/** Every field a row carries. Emitted in this order, so two documents of the same map look alike. */
export const ASSET_ROW_FIELDS = [
  'repo',
  'name',
  'owner',
  'url',
  'description',
  'description_zh',
  'language',
  'stars',
  'topics',
  'categories',
  'reason',
  'summary',
  'license',
  'created_at',
  'pushed_at',
  'tier',
  'is_starred',
  'first_seen_at',
  'last_seen_at',
  'source_channels',
  'trending_count',
  'last_trending_week',
  'probe_hits',
  'probe_queries',
]

/** The tiers the Worker serves from; `discovered` is deliberately not one of them. */
export const HOT_TIERS = ['starred', 'curated', 'community']

/**
 * Which tier survives when two sources describe the same repository.
 *
 * The rule used to be "the tier the first source named is kept", which made the answer depend on
 * the order the accumulator happens to read its sources in — and it reads the community boards
 * first and the ingest journal last. A repository the user had ingested themselves was therefore
 * published as an anonymous board listing (`🏛️ Historical Archive`) whenever a board carried it
 * too, and no test noticed because the fixture's ingested repository was in no board.
 *
 * Ranking the tiers instead makes the strongest statement win whoever spoke first. `curated`
 * outranking `community` is also what makes an ingest permanent: the journal it comes from is
 * append-only and never cleaned, so a repository the user staged stays described as theirs even
 * after a board picks it up, or after they un-star it.
 */
const TIER_PRECEDENCE = { discovered: 0, community: 1, curated: 2, starred: 3 }

/** The stronger of the tier a row carries and the one a source proposes. */
function strongerTier(carried, proposed) {
  if (!carried)
    return proposed
  return (TIER_PRECEDENCE[proposed] ?? 0) > (TIER_PRECEDENCE[carried] ?? 0) ? proposed : carried
}

const SOURCE_STARRED = 'github_star'

/**
 * Merges one sighting into the previous row.
 *
 * @param {object|undefined} existing The row as the last run left it.
 * @param {object} sighting
 * @param {string} sighting.repo `owner/name` as the source spelled it.
 * @param {string} sighting.source Channel name, e.g. `trending:overall_daily`, `github_star`.
 * @param {string} sighting.tier Tier this source proposes; it wins only against a weaker one.
 * @param {object} [sighting.fields] Metadata this source brought.
 * @param {string} sighting.now ISO timestamp of this run.
 * @param {number|string} sighting.weekKey ISO week, for the once-per-week trending count.
 * @returns {object} a row holding exactly {@link ASSET_ROW_FIELDS}.
 */
export function mergeAssetRow(existing, { repo, source, tier, fields = {}, now, weekKey }) {
  const isStarSource = source === SOURCE_STARRED
  const carried = existing || {}

  // A source that reports no star count keeps the one a previous source published: most channels
  // carry stars, and a listing that omits them would otherwise reset the count to zero.
  const stars = fields.stars || carried.stars || 0

  // Only a `trending:*` channel may advance the counter, and only once per ISO week — the guard
  // exists because a starred repository that is also trending was counted on every run.
  const isTrending = source.startsWith('trending')
  const trendingCount = isTrending && carried.last_trending_week !== weekKey
    ? (carried.trending_count || 0) + 1
    : (carried.trending_count || 0)

  return {
    repo,
    name: fields.name || carried.name || repo.split('/')[1] || '',
    owner: fields.owner || carried.owner || repo.split('/')[0] || '',
    url: fields.url || carried.url || `https://github.com/${repo}`,
    description: sanitize(fields.description || carried.description || ''),
    description_zh: sanitize(fields.description_zh || carried.description_zh || ''),
    language: fields.language || carried.language || '',
    stars,
    topics: fields.topics || carried.topics || [],
    categories: fields.categories || carried.categories || [],
    reason: fields.reason || carried.reason || '',
    summary: fields.summary || carried.summary || '',
    license: fields.license || carried.license || '',
    created_at: fields.created_at || carried.created_at || '',
    pushed_at: fields.pushed_at || carried.pushed_at || '',
    tier: strongerTier(carried.tier, tier),
    is_starred: isStarSource ? 1 : (carried.is_starred || 0),
    first_seen_at: carried.first_seen_at || now,
    last_seen_at: now,
    source_channels: mergeChannels(carried.source_channels, [source]),
    trending_count: trendingCount,
    last_trending_week: isTrending ? weekKey : carried.last_trending_week,
    probe_hits: fields.probe_hits ?? carried.probe_hits ?? 0,
    probe_queries: fields.probe_queries ?? carried.probe_queries ?? [],
  }
}

/** Keeps the last ten channels, so a long-lived row cannot grow without bound. */
function mergeChannels(existing, add) {
  const set = new Set(Array.isArray(existing) ? existing : [])
  for (const channel of add)
    set.add(channel)
  return Array.from(set).slice(-10)
}

/**
 * The two description fields come from other people's repositories, so they are the only free text
 * a row carries: control characters are stripped and the value is capped, in one place, because
 * every writer owes the same treatment — the starred pass used to clean `description` but not
 * `description_zh`, so a Chinese description reached the Worker with whatever a listing contained.
 */
function sanitize(value) {
  if (!value)
    return ''
  let out = ''
  for (const ch of String(value)) {
    const code = ch.codePointAt(0)
    if (code <= 31 || code === 127)
      continue
    out += ch
  }
  return out.slice(0, 500)
}

/**
 * The row as the hot-set document publishes it.
 *
 * `probe_queries` and `last_trending_week` are inputs to the next run's counters, not facts about
 * the repository, so the network-facing document drops them — it is the document the Worker holds
 * in memory, and it is read by anything the client is.
 */
export function hotSetRow(row) {
  const { probe_queries, last_trending_week, ...published } = row
  return published
}
