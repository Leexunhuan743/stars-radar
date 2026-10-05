import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { ASSET_INDEX_KEY, CATALOG_KEY, EMBEDDINGS_BIN_KEY, EMBEDDINGS_INDEX_KEY, EMBEDDINGS_MANIFEST_KEY, isReadmeKey, LOCAL_RANKINGS_DIR, LOCAL_STARS_DIR, RANKINGS_KEY } from '../src/object-keys.js'
import { verifyVectorPair } from './verify_vector_pair.js'

export async function seedLocalR2(bucket, root) {
  await verifyVectorPair(root)
  const objects = [
    [CATALOG_KEY, CATALOG_KEY],
    [ASSET_INDEX_KEY, ASSET_INDEX_KEY],
    [RANKINGS_KEY, `${LOCAL_RANKINGS_DIR}/${RANKINGS_KEY}`],
    [EMBEDDINGS_BIN_KEY, EMBEDDINGS_BIN_KEY],
    [EMBEDDINGS_INDEX_KEY, EMBEDDINGS_INDEX_KEY],
    [EMBEDDINGS_MANIFEST_KEY, EMBEDDINGS_MANIFEST_KEY],
  ]
  const stars = path.join(root, LOCAL_STARS_DIR)
  for (const owner of await fs.readdir(stars, { withFileTypes: true })) {
    if (!owner.isDirectory())
      continue
    for (const file of await fs.readdir(path.join(stars, owner.name), { withFileTypes: true })) {
      if (file.isFile() && isReadmeKey(file.name))
        objects.push([`${owner.name}/${file.name}`, `${LOCAL_STARS_DIR}/${owner.name}/${file.name}`])
    }
  }
  // Read every input before the first write so a missing artifact cannot leave a partial seed.
  const payloads = await Promise.all(objects.map(async ([key, file]) => ({ key, data: await fs.readFile(path.join(root, file)) })))
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
