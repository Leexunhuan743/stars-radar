// Shared date-window parser: single source of truth for `since`/`until` ranges.
// Used by the Worker (src/index.js) and harvest pipeline (scripts/harvest_and_ingest.js).
//
// Unparseable input throws a RangeError instead of silently degrading to "today":
// a wrong window produces a wrong answer that looks like a valid one, which is
// worse than a rejected request. Callers surface the message to the client (the
// Worker maps it to HTTP 400 for the REST route, and the MCP tool wrappers return
// it as an isError result).
//
// Accepted forms: `YYYY-MM-DD`, a relative window `7d` / `2w` / `1m`, or an inline
// range `YYYY-MM-DD..YYYY-MM-DD` (passed in `since`).

const RELATIVE_WINDOW = /^(\d+)([dwm])$/i
const ABSOLUTE_DATE = /^\d{4}-\d{2}-\d{2}$/
const UNIT_MS = { d: 24 * 3600 * 1000, w: 7 * 24 * 3600 * 1000, m: 30 * 24 * 3600 * 1000 }

function reject(label, original, detail) {
  throw new RangeError(
    `parseDateRange: cannot parse ${label}=${JSON.stringify(original)}`
    + `${detail ? ` (${detail})` : ''}.`
    + ` Expected YYYY-MM-DD, or a relative window such as 7d / 2w / 1m,`
    + ` or a "YYYY-MM-DD..YYYY-MM-DD" range in since.`,
  )
}

// Explicit dates must be a real calendar day: `new Date("2026-02-30")` silently rolls
// over to March and `new Date("2026-8-1")` shifts by the local offset, so a typo used
// to produce a different window that still looked valid. Parsing as UTC also makes the
// window independent of the runtime's timezone.
function parseAbsoluteDate(value, label, original) {
  if (!ABSOLUTE_DATE.test(value))
    reject(label, original)
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    reject(label, original, `${value} is not a real calendar date`)
  return date
}

function toIsoDate(value, label, original) {
  if (Number.isNaN(value.getTime()))
    reject(label, original)
  return value.toISOString().split('T')[0]
}

export function parseDateRange(since, until) {
  if (typeof since !== 'string' || !since.trim()) {
    throw new RangeError(
      `parseDateRange: \`since\` is required and must be a string; got ${JSON.stringify(since)}.`
      + ` Expected YYYY-MM-DD, a relative window such as 7d / 2w / 1m, or "YYYY-MM-DD..YYYY-MM-DD".`,
    )
  }

  const sinceInput = since.trim()
  const untilInput = until === undefined || until === null ? '' : String(until).trim()
  let untilDate = untilInput ? parseAbsoluteDate(untilInput, 'until', until) : new Date()
  let sinceDate

  if (sinceInput.includes('..')) {
    const parts = sinceInput.split('..')
    // A half-written range used to keep the `until` argument (or today) and silently
    // answer for a different span than the caller asked for.
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim())
      reject('since', since, 'an inline range needs both ends as YYYY-MM-DD..YYYY-MM-DD')
    sinceDate = parseAbsoluteDate(parts[0].trim(), 'since', parts[0].trim())
    untilDate = parseAbsoluteDate(parts[1].trim(), 'until', parts[1].trim())
  }
  else {
    const relative = sinceInput.match(RELATIVE_WINDOW)
    if (relative) {
      // Strict on purpose: `parseInt('0')||7` and `parseInt('1x0')` used to turn
      // malformed windows into a plausible-looking number of days.
      const amount = Number(relative[1])
      if (amount < 1) {
        throw new RangeError(
          `parseDateRange: relative window must be at least 1 unit; got ${JSON.stringify(since)}.`,
        )
      }
      sinceDate = new Date(untilDate.getTime() - amount * UNIT_MS[relative[2].toLowerCase()])
    }
    else {
      sinceDate = parseAbsoluteDate(sinceInput, 'since', since)
    }
  }

  if (sinceDate.getTime() > untilDate.getTime()) {
    throw new RangeError(
      `parseDateRange: a window cannot end before it starts; got`
      + ` since=${JSON.stringify(since)} until=${JSON.stringify(until)}.`,
    )
  }

  return {
    sinceStr: toIsoDate(sinceDate, 'since', since),
    untilStr: toIsoDate(untilDate, 'until', until),
  }
}
