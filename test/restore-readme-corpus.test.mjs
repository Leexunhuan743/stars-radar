import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readmeRestoreEntries } from '../scripts/restore_readme_corpus.js'

const SHA = 'a'.repeat(64)

test('README restore entries derive canonical blob keys from sha256', () => {
  assert.deepEqual(readmeRestoreEntries({
    repos: {
      'acme/tool': { repo: 'Acme/Tool', sha256: SHA, status: 'ok' },
      'acme/absent': { repo: 'Acme/Absent', sha256: null, status: 'absent' },
    },
  }), [{
    key: `readmes/${SHA}.md`,
    localPath: 'stars/Acme/Tool.md',
  }])
})
