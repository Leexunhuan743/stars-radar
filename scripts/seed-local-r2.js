import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { ACTIVE_GENERATION_KEY, generationKey } from '../src/data-generation.js'
import { README_BLOB_PREFIX } from '../src/object-keys.js'
import {
  GENERATION_MANIFEST_KEY,
  GENERATION_STAGE_DIR,
  prepareDataGeneration,
  README_CONTENT_STAGE_DIR,
} from './prepare_data_generation.js'
import { verifyVectorPair } from './verify_vector_pair.js'

const LOCAL_GENERATION_ID = '20261005T000000Z-0000000-0'
const LOCAL_GENERATION_COMMIT = '0000000000000000000000000000000000000000'
const LOCAL_GENERATION_AT = '2026-10-05T00:00:00.000Z'

async function stagedFiles(root) {
  const stage = path.join(root, GENERATION_STAGE_DIR)
  const names = await fs.readdir(stage, { withFileTypes: true })
  return names
    .filter(entry => entry.isFile())
    .map(entry => [entry.name, path.join(GENERATION_STAGE_DIR, entry.name)])
}

export async function seedLocalR2(bucket, root) {
  await verifyVectorPair(root)
  const { pointer } = prepareDataGeneration({
    root,
    generationId: LOCAL_GENERATION_ID,
    commit: LOCAL_GENERATION_COMMIT,
    publishedAt: LOCAL_GENERATION_AT,
  })

  const objects = [
    [ACTIVE_GENERATION_KEY, ACTIVE_GENERATION_KEY],
    ...(await stagedFiles(root)).map(([key, file]) => [generationKey(pointer.id, key), file]),
  ]

  // generation-manifest.json is staged beside the logical data objects and is intentionally part of
  // the seed even though the Worker does not read it; local R2 should mirror production layout.
  if (!objects.some(([key]) => key.endsWith(`/${GENERATION_MANIFEST_KEY}`)))
    throw new Error('Local generation staging did not produce generation-manifest.json.')

  const readmeStage = path.join(root, README_CONTENT_STAGE_DIR)
  for (const file of await fs.readdir(readmeStage, { withFileTypes: true })) {
    if (file.isFile() && file.name.endsWith('.md'))
      objects.push([`${README_BLOB_PREFIX}${file.name}`, path.join(README_CONTENT_STAGE_DIR, file.name)])
  }

  const payloads = await Promise.all(objects.map(async ([key, file]) => ({
    key,
    data: await fs.readFile(path.join(root, file)),
  })))
  for (const { key, data } of payloads)
    await bucket.put(key, data)
  return payloads.length
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const { getPlatformProxy } = await import('wrangler')
  const proxy = await getPlatformProxy({
    configPath: path.join(root, 'wrangler.jsonc'),
    envFiles: [],
    persist: { path: path.join(root, '.wrangler', 'state', 'v3') },
    remoteBindings: false,
  })
  try {
    console.log(`Loaded ${await seedLocalR2(proxy.env.R2, root)} objects into local R2. Run pnpm dev:mcp.`)
  }
  finally {
    await proxy.dispose()
  }
}
