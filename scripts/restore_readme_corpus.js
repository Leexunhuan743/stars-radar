import fs from 'node:fs'
import process from 'node:process'
import { localReadmePath, readmeBlobKey } from '../src/object-keys.js'

export function readmeRestoreEntries(manifest = {}) {
  return Object.values(manifest.repos || [])
    .filter(ref => ref?.sha256)
    .map((ref) => {
      if (!ref.repo)
        throw new Error('README manifest entries with sha256 must include repo.')
      return {
        key: readmeBlobKey(ref.sha256),
        localPath: localReadmePath(ref.repo),
      }
    })
}

if (process.argv[1]?.endsWith('restore_readme_corpus.js')) {
  const file = process.argv[2]
  if (!file)
    throw new Error('Usage: node scripts/restore_readme_corpus.js <readmes.json>')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const { key, localPath } of readmeRestoreEntries(manifest))
    process.stdout.write(`${key}\t${localPath}\n`)
}
