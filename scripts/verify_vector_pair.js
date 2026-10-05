// Publication checks cover both physical content and the complete confirmed corpus.

import fs from 'node:fs'
import process from 'node:process'
import { describePairMismatch, expectedPairBytes, vectorCountFromBytes, verifyVectorManifest } from '../src/embeddings.js'
import { embeddingRepositories, foldJournalFiles } from '../src/ingest-journal.js'
import { CATALOG_KEY, EMBEDDINGS_BIN_KEY, EMBEDDINGS_INDEX_KEY, EMBEDDINGS_MANIFEST_KEY, INGEST_JOURNAL_PREFIX } from '../src/object-keys.js'

export async function verifyVectorPair(root = '.') {
  const indexPath = `${root}/${EMBEDDINGS_INDEX_KEY}`
  const binPath = `${root}/${EMBEDDINGS_BIN_KEY}`
  const hasIndex = fs.existsSync(indexPath)
  const hasBin = fs.existsSync(binPath)
  const catalog = JSON.parse(fs.readFileSync(`${root}/${CATALOG_KEY}`, 'utf-8'))
  const journalDirectory = `${root}/${INGEST_JOURNAL_PREFIX}`
  const journal = fs.existsSync(journalDirectory)
    ? fs.readdirSync(journalDirectory).filter(name => name.endsWith('.jsonl')).map(key => ({ key, text: fs.readFileSync(`${journalDirectory}${key}`, 'utf-8') }))
    : []
  const { harvested, problems } = foldJournalFiles(journal)
  if (problems.length > 0)
    throw new Error(`Could not verify the embedding corpus: ${problems.join('; ')}`)
  const requiredRepos = embeddingRepositories(catalog.repos || {}, harvested)

  if (hasIndex !== hasBin) {
    throw new Error(
      `Vector pair is incomplete: ${EMBEDDINGS_INDEX_KEY}=${hasIndex} ${EMBEDDINGS_BIN_KEY}=${hasBin}. `
      + `Uploading this would leave the Worker unable to score vectors.`,
    )
  }

  if (!hasIndex) {
    const starred = catalog.totalRepos || 0
    if (starred > 0 || requiredRepos.length > 0)
      throw new Error(`No vector pair was produced although ${CATALOG_KEY} lists ${starred} starred repos: semantic search would be silently disabled.`)
    return 'No vector pair and an empty catalogue (fresh install), nothing to verify.'
  }

  const names = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
  const bytes = fs.statSync(binPath).size
  const problem = describePairMismatch({ names, bytes })
  if (problem)
    throw new Error(problem)
  const indexed = new Set(names.map(name => name.toLowerCase()))
  const missing = requiredRepos.filter(repo => !indexed.has(repo.repo.toLowerCase()))
  if (missing.length > 0)
    throw new Error(`Vector corpus is missing confirmed repositories: ${missing.map(repo => repo.repo).join(', ')}`)

  const manifestPath = `${root}/${EMBEDDINGS_MANIFEST_KEY}`
  if (!fs.existsSync(manifestPath))
    throw new Error('Vector manifest is missing; build vectors before publishing.')
  await verifyVectorManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')), names, fs.readFileSync(indexPath), fs.readFileSync(binPath))

  return `${names.length} names * ${expectedPairBytes(1)}B = ${bytes}B (${vectorCountFromBytes(bytes)} vectors)`
}

if (process.argv[1]?.endsWith('verify_vector_pair.js')) {
  try {
    console.log(`✓ Vector pair invariant holds: ${await verifyVectorPair()}`)
  }
  catch (err) {
    console.error(`::error::${err.message}`)
    process.exit(1)
  }
}
