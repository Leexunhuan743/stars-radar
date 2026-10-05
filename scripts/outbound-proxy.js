// Outbound proxying for the commands that run behind one.
//
// The rankings fetcher, the vector pipeline and the harvester each carried the same eight lines, and
// each of them called `setGlobalDispatcher` while being *imported* — a module that rewrites global
// networking state as a side effect of being loaded. That is why importing the pipeline in a test
// could quietly change how the test's own `fetch` behaved, and why the proxy decision was invisible
// at every call site: it had already happened, somewhere, during an import.
//
// So the effect is now asked for, by the entry point that is actually about to make outbound calls.
// Nothing happens unless `useEnvProxy()` is called; CI has no proxy and never calls it.

import process from 'node:process'
import { ProxyAgent, setGlobalDispatcher } from 'undici'

/**
 * Points undici at `HTTPS_PROXY`/`HTTP_PROXY` when one is configured.
 *
 * @returns {string|null} the proxy that was installed, or `null` when there is none to install.
 */
export function useEnvProxy() {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
  if (!proxy)
    return null

  try {
    setGlobalDispatcher(new ProxyAgent(proxy))
    return proxy
  }
  catch (e) {
    // A malformed proxy URL must not stop a run that could still work without it, but it must not
    // pass unnoticed either: the calls that follow will fail for a reason nobody can see.
    console.warn(`Could not use the proxy at ${proxy}: ${e.message}`)
    return null
  }
}
