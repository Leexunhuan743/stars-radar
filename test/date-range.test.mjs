import assert from 'node:assert/strict'
// Regression tests for the shared date-window parser.
//
// Guards the contract that malformed windows are REJECTED rather than silently
// coerced into "today": a silently wrong window produces results that look
// valid, which is how an off-by-a-range bug survives to production.
import { test } from 'node:test'
import { parseDateRange } from '../src/date-range.js'

test('relative windows are computed backwards from the upper bound', () => {
  assert.deepEqual(parseDateRange('7d', '2026-09-10'), { sinceStr: '2026-09-03', untilStr: '2026-09-10' })
  assert.deepEqual(parseDateRange('2w', '2026-09-10'), { sinceStr: '2026-08-27', untilStr: '2026-09-10' })
  assert.deepEqual(parseDateRange('1m', '2026-09-10'), { sinceStr: '2026-08-11', untilStr: '2026-09-10' })
})

test('relative windows tolerate surrounding whitespace and unit case', () => {
  assert.deepEqual(parseDateRange(' 7d ', '2026-09-10'), { sinceStr: '2026-09-03', untilStr: '2026-09-10' })
  assert.deepEqual(parseDateRange('7D', '2026-09-10'), { sinceStr: '2026-09-03', untilStr: '2026-09-10' })
  assert.deepEqual(parseDateRange('2W', '2026-09-10'), { sinceStr: '2026-08-27', untilStr: '2026-09-10' })
})

test('malformed relative windows are rejected rather than coerced to a default span', () => {
  // Each of these used to become a plausible-looking span via parseInt(...)||7:
  // "0d" and "fd" silently meant 7 days, "1x0d" silently meant 1 day.
  for (const bad of ['0d', 'fd', '1x0d', 'dd', '-7d', '7dd', 'd']) {
    assert.throws(
      () => parseDateRange(bad, '2026-09-10'),
      RangeError,
      `"${bad}" must be rejected`,
    )
  }
})

test('explicit dates and inline ranges are honoured', () => {
  assert.deepEqual(
    parseDateRange('2026-08-01', '2026-08-31'),
    { sinceStr: '2026-08-01', untilStr: '2026-08-31' },
  )
  // The upper bound embedded in the range wins over the `until` argument.
  assert.deepEqual(
    parseDateRange('2026-08-01..2026-08-31', '2027-01-01'),
    { sinceStr: '2026-08-01', untilStr: '2026-08-31' },
  )
  // Dates are read as UTC midnight, so the window does not move with the runtime's
  // timezone and a real leap day still works.
  assert.deepEqual(
    parseDateRange('2028-02-29..2028-03-01'),
    { sinceStr: '2028-02-29', untilStr: '2028-03-01' },
  )
})

test('dates that are not real calendar days are rejected', () => {
  // `new Date("2026-02-30")` rolls over to 2026-03-02 instead of failing, which used to
  // hand the caller a different window than the one it asked for.
  for (const bad of ['2026-02-30', '2026-04-31', '2027-02-29', '2026-13-01', '2026-00-10']) {
    assert.throws(
      () => parseDateRange(bad, '2026-12-31'),
      (err) => {
        assert.ok(err instanceof RangeError, `expected RangeError for "${bad}"`)
        assert.match(err.message, /not a real calendar date/)
        return true
      },
      `"${bad}" must be rejected`,
    )
  }
})

test('loosely written dates are rejected instead of being offset by the local timezone', () => {
  // "2026-8-1" used to parse as LOCAL midnight, which on a UTC+8 machine becomes
  // 2026-07-31 once formatted back to a UTC date.
  for (const bad of ['2026-8-1', '26-08-01', '20260801', '2026/08/01']) {
    assert.throws(
      () => parseDateRange(bad, '2026-12-31'),
      RangeError,
      `"${bad}" must be rejected`,
    )
  }
})

test('an inline range with a missing or extra end is rejected', () => {
  for (const bad of ['2026-08-01..', '..2026-08-31', '2026-08-01..2026-08-31..2026-09-01', '..']) {
    assert.throws(
      () => parseDateRange(bad, '2026-12-31'),
      RangeError,
      `"${bad}" must be rejected rather than falling back to until/today`,
    )
  }
})

test('a window that ends before it starts is rejected', () => {
  assert.throws(
    () => parseDateRange('2026-08-31', '2026-08-01'),
    (err) => {
      assert.ok(err instanceof RangeError)
      assert.match(err.message, /cannot end before it starts/)
      return true
    },
  )
  assert.throws(() => parseDateRange('2026-08-31..2026-08-01'), RangeError)
})

test('an unparseable window throws a RangeError naming the offending input', () => {
  assert.throws(
    () => parseDateRange('not-a-date', '2026-08-31'),
    (err) => {
      assert.ok(err instanceof RangeError, `expected RangeError, got ${err.constructor.name}`)
      assert.match(err.message, /since="not-a-date"/)
      return true
    },
  )
  assert.throws(
    () => parseDateRange('2026-08-01', 'not-a-date'),
    (err) => {
      assert.ok(err instanceof RangeError)
      assert.match(err.message, /until="not-a-date"/)
      return true
    },
  )
})

test('a missing lower bound is rejected instead of defaulting to today', () => {
  assert.throws(() => parseDateRange(undefined, '2026-08-31'), RangeError)
  assert.throws(() => parseDateRange('', '2026-08-31'), RangeError)
  assert.throws(() => parseDateRange('   ', '2026-08-31'), RangeError)
})
