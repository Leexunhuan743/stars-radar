// Cache for the R2-backed documents the Worker serves from.
//
// Why this exists as its own module: four loaders used to be copy-pasted, and all four treated
// two very different outcomes as the same thing — "the bucket does not hold this object yet"
// and "reading it failed". Both wrote an empty placeholder into the cache and stamped it with a
// fresh 30-minute TTL, so a single R2 hiccup answered every request with "no matches" for half
// an hour while `/health` still reported `ok`. A wrong answer that looks like a valid empty
// result is worse than an error, so the outcomes are separated here:
//
//   missing     — the object is absent. An empty document is the honest answer and is cached.
//   unavailable — the read failed and nothing was ever cached. The caller must fail loudly.
//   stale       — the read failed but a previous document exists. It is served, the cache is
//                 flagged for an immediate retry, and `/health` reports it.
//   fresh       — a successful read.
//
// A failed read is never cached: the only way the fault can clear is for the next request to
// try again, and the only way a human can see it is for the status to stay visible.

export const DOCUMENT_STATUS = {
  UNKNOWN: 'unknown',
  FRESH: 'fresh',
  MISSING: 'missing',
  STALE: 'stale',
  UNAVAILABLE: 'unavailable',
}

export const DOCUMENT_TTL_MS = 1000 * 60 * 30

export class DocumentUnavailableError extends Error {
  constructor(document, cause) {
    super(
      `Could not read ${document} from R2 and no earlier copy is cached, so the answer would be `
      + `wrong. Retry once the bucket is reachable. Cause: ${cause?.message || String(cause)}`,
    )
    this.name = 'DocumentUnavailableError'
    this.document = document
    this.cause = cause
  }
}

/**
 * @param {object} options
 * @param {string} options.name        Document key, used in error text and status reporting.
 * @param {() => Promise<unknown|null>} options.read  Resolves to the document, or null when the
 *                                                    object does not exist. Must throw on any
 *                                                    other failure — that difference is the
 *                                                    contract this module is built on.
 * @param {() => unknown} options.empty Document to serve while the object is absent.
 * @param {number} [options.ttlMs]     How long a successful read stays fresh.
 * @param {() => number} [options.now] Injectable clock for tests.
 */
export function createDocumentCache({ name, read, empty, ttlMs = DOCUMENT_TTL_MS, now = Date.now }) {
  let value = null
  let loadedAt = 0
  let pending = null
  let status = DOCUMENT_STATUS.UNKNOWN
  // Set after a failed read so the next caller retries instead of waiting out the TTL. Without
  // it a single blip would pin the stale copy for the full 30 minutes.
  let mustRetry = false

  async function attempt(env) {
    try {
      // The reader receives whatever the caller passed to `load` — in the Worker that is the
      // bindings object holding R2. Dropping it here made every read fail with
      // "cannot read properties of undefined", which the cache then correctly reported as
      // `unavailable`: a live Worker answered 503 for every request until this was fixed.
      const document = await read(env)
      if (document === null) {
        value = empty()
        status = DOCUMENT_STATUS.MISSING
      }
      else {
        value = document
        status = DOCUMENT_STATUS.FRESH
      }
      loadedAt = now()
      mustRetry = false
    }
    catch (e) {
      if (value === null) {
        status = DOCUMENT_STATUS.UNAVAILABLE
        throw new DocumentUnavailableError(name, e)
      }
      status = DOCUMENT_STATUS.STALE
      mustRetry = true
      console.error(`[${name}] R2 read failed; serving the last known copy and retrying on the next request:`, e)
    }
    return value
  }

  return {
    async load(env) {
      const expired = now() - loadedAt >= ttlMs
      if (value !== null && !expired && !mustRetry)
        return value
      if (!pending) {
        pending = attempt(env).finally(() => {
          pending = null
        })
      }
      return pending
    },

    /** Last known status, without triggering a read. Used by `/health`. */
    status: () => status,

    /**
     * Installs a document this isolate just wrote, so the writer does not have to wait out the
     * TTL (or re-read the object) to see its own update.
     */
    seed(document) {
      value = document
      loadedAt = now()
      status = DOCUMENT_STATUS.FRESH
      mustRetry = false
    },

    /** Test seam: drops the cached document so the next load reads again. */
    reset: () => {
      value = null
      loadedAt = 0
      status = DOCUMENT_STATUS.UNKNOWN
      mustRetry = false
    },
  }
}
