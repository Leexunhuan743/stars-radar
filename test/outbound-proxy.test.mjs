import assert from 'node:assert/strict'
import process from 'node:process'
// The outbound proxy.
//
// Three scripts used to install a proxy dispatcher *while being imported*, so whether a test or a
// tool ran behind a proxy depended on which module happened to be loaded first — and the test suite
// would quietly inherit the developer's local proxy. The rule now is that the effect is asked for by
// the run's entry point, and the assertions below are behavioural rather than a source scan:
// importing a script must not change the global dispatcher, and asking for the proxy must.
import { afterEach, test } from 'node:test'
import { getGlobalDispatcher } from 'undici'
import { useEnvProxy } from '../scripts/outbound-proxy.js'

const VARS = ['HTTPS_PROXY', 'HTTP_PROXY']
const saved = Object.fromEntries(VARS.map(k => [k, process.env[k]]))
const realWarn = console.warn

afterEach(() => {
  for (const key of VARS) {
    if (saved[key] === undefined)
      delete process.env[key]
    else
      process.env[key] = saved[key]
  }
  console.warn = realWarn
})

test('nothing to proxy means nothing happens', () => {
  for (const key of VARS) delete process.env[key]
  const before = getGlobalDispatcher()
  assert.equal(useEnvProxy(), null)
  assert.equal(getGlobalDispatcher(), before, 'the dispatcher must be left exactly as it was')
})

test('HTTPS_PROXY is installed when it is configured, and reported back', () => {
  delete process.env.HTTP_PROXY
  process.env.HTTPS_PROXY = 'http://127.0.0.1:7897'
  const before = getGlobalDispatcher()
  assert.equal(useEnvProxy(), 'http://127.0.0.1:7897')
  assert.notEqual(getGlobalDispatcher(), before, 'the configured proxy must actually be installed')
})

test('HTTP_PROXY is the fallback, and HTTPS_PROXY wins when both are set', () => {
  delete process.env.HTTPS_PROXY
  process.env.HTTP_PROXY = 'http://127.0.0.1:1111'
  assert.equal(useEnvProxy(), 'http://127.0.0.1:1111')

  process.env.HTTPS_PROXY = 'http://127.0.0.1:2222'
  assert.equal(useEnvProxy(), 'http://127.0.0.1:2222', 'a specific proxy beats the generic one')
})

test('a proxy that cannot be used is reported rather than thrown', () => {
  // A malformed URL must not stop a run that would otherwise work without a proxy — but the calls
  // that follow will fail for a reason nobody can see, so it cannot be silent either.
  const warnings = []
  console.warn = (...args) => warnings.push(args.join(' '))
  process.env.HTTPS_PROXY = 'not a url'
  delete process.env.HTTP_PROXY

  assert.equal(useEnvProxy(), null)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /not a url/)
})

test('importing the pipeline scripts does not install a proxy behind the caller\u2019s back', async () => {
  // This is the defect, stated as a behaviour: with a proxy configured in the environment, loading
  // the offline scripts used to rewrite global networking state as a side effect of the import.
  process.env.HTTPS_PROXY = 'http://127.0.0.1:7897'
  const before = getGlobalDispatcher()

  await import('../scripts/vector_pipeline.js')
  await import('../scripts/fetch_rankings.js')
  await import('../scripts/harvest_and_ingest.js')

  assert.equal(
    getGlobalDispatcher(),
    before,
    'a module that rewrites global networking state on import makes every later caller depend on load order',
  )
})
