// The R2 key space, declared once.
//
// The bucket layout is a contract between the Worker, the offline pipeline and the scheduled build,
// and it was written down in five places — a template literal in the Worker's README tool, a
// `endsWith('.md')` in the archive lister, four local path joins in the asset store, the upload
// command in CI, and a paragraph of prose in each. A prefix that moves, or a key that gains a
// directory level, therefore has to be found in all of them; the archive lister's comment says as
// much, which is the shape of a convention that lives only in comments.
//
// Two layouts coexist here and are easily confused:
//   * the bucket is FLAT for documents (`rankings.json` sits at the root) while the corpus is
//     `owner/repo.md` — which is why the scheduled build maps `stars/owner/repo.md` to
//     `s3://bucket/owner/repo.md`;
//   * the two Worker-owned state prefixes ARE directory-like (`state/ingest-journal/<key>.jsonl`).
// Everything that needs to know which is which imports it from here.

/** Reference documents, at the bucket root. */
export const CATALOG_KEY = 'catalog.json'
export const RANKINGS_KEY = 'rankings.json'
export const ASSET_INDEX_KEY = 'asset-index.json'
export const ASSET_STATE_KEY = 'asset-state.json'
export const EMBEDDINGS_INDEX_KEY = 'embeddings-index.json'
export const EMBEDDINGS_FINGERPRINTS_KEY = 'embeddings-fingerprints.json'
export const EMBEDDINGS_MANIFEST_KEY = 'embeddings-manifest.json'
export const EMBEDDINGS_BIN_KEY = 'embeddings.bin'
export const READMES_MANIFEST_KEY = 'readmes.json'
export const README_BLOB_PREFIX = 'readmes/'

/** Worker-owned append-only prefixes; builds fold them and later compact only exact snapshotted keys. */
export const INGEST_JOURNAL_PREFIX = 'state/ingest-journal/'
export const PROBE_CAPTURE_PREFIX = 'state/probe-captures/'

/** Content-addressed README blobs plus the local corpus staging suffix. */
export const README_SUFFIX = '.md'

/** Local staging directories the pipeline reads and writes before syncing to the bucket. */
export const LOCAL_STARS_DIR = 'stars'
export const LOCAL_RANKINGS_DIR = 'rankings'
export const PREVIOUS_ASSET_INDEX_FILE = `previous-${ASSET_INDEX_KEY}`

export function isReadmeKey(key) {
  return typeof key === 'string' && key.endsWith(README_SUFFIX)
}

/** `Acme/Tool` → `Acme/Tool.md`; the bucket key for that repository's README. */
export function readmeKey(repo) {
  if (!repo)
    throw new Error(`readmeKey needs a repository name, got ${JSON.stringify(repo)}`)
  return `${repo}${README_SUFFIX}`
}

/** `Acme/Tool.md` → `Acme/Tool`; null for anything that is not a README object. */
export function repoFromReadmeKey(key) {
  return isReadmeKey(key) ? key.slice(0, -README_SUFFIX.length) : null
}

/** `Acme/Tool` → `stars/Acme/Tool.md`; where the pipeline stages that README locally. */
export function localReadmePath(repo) {
  return `${LOCAL_STARS_DIR}/${readmeKey(repo)}`
}

/** The bucket key for a staged local path, so the two layouts cannot drift apart in the build. */
export function bucketKeyForLocalReadme(relativePath) {
  const prefix = `${LOCAL_STARS_DIR}/`
  if (!relativePath.startsWith(prefix))
    throw new Error(`${relativePath} is not under ${prefix}`)
  return relativePath.slice(prefix.length)
}

export function readmeBlobKey(sha256) {
  if (!/^[0-9a-f]{64}$/.test(sha256 || ''))
    throw new Error('README blob keys require a lowercase SHA-256 digest.')
  return `${README_BLOB_PREFIX}${sha256}${README_SUFFIX}`
}
