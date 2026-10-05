import antfu from '@antfu/eslint-config'

// `test/**` is deliberately NOT ignored: the test suite is source code and had
// gone unchecked by lint, the pre-commit hook, and CI alike.
export default antfu({
  formatters: true,
  ignores: ['stars/**', 'catalog.json', 'asset-index.json', 'asset-meta.json', 'asset-state.json', '*.md', '*.opml'],
}, {
  name: 'stars-radar/node-test-runner',
  files: ['test/**/*.mjs'],
  rules: {
    // The preset prefers vitest. This project intentionally uses Node's built-in
    // runner so the suite needs no test framework dependency and the Worker's
    // pure modules stay importable under plain `node --test` (see src/relevance.js).
    // Only the framework-preference rule is switched off; every other rule applies.
    'test/no-import-node-test': 'off',
  },
})
