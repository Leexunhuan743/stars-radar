export const DATA_GENERATION_SCHEMA = 1
export const ACTIVE_GENERATION_KEY = 'active-generation.json'
export const GENERATION_PREFIX = 'generations/'

const GENERATION_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{7,40}-\d+$/

export function validateGenerationId(value) {
  if (typeof value !== 'string' || !GENERATION_ID_RE.test(value))
    throw new Error(`Invalid data generation id ${JSON.stringify(value)}.`)
  return value
}

export function generationKey(generationId, logicalKey) {
  const id = validateGenerationId(generationId)
  if (typeof logicalKey !== 'string' || !logicalKey || logicalKey.startsWith('/') || logicalKey.includes('..'))
    throw new Error(`Invalid generation logical key ${JSON.stringify(logicalKey)}.`)
  return `${GENERATION_PREFIX}${id}/${logicalKey}`
}

export function generationPrefix(generationId) {
  return `${GENERATION_PREFIX}${validateGenerationId(generationId)}/`
}

export function parseGenerationPointer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Active data generation pointer must be an object.')
  if (value.schema !== DATA_GENERATION_SCHEMA)
    throw new Error(`Unsupported data generation pointer schema ${JSON.stringify(value.schema)}.`)
  const id = validateGenerationId(value.id)
  if (typeof value.published_at !== 'string' || !Number.isFinite(Date.parse(value.published_at)))
    throw new Error('Active data generation pointer is missing a valid published_at timestamp.')
  if (typeof value.commit !== 'string' || !/^[0-9a-f]{40}$/.test(value.commit))
    throw new Error('Active data generation pointer is missing a full commit SHA.')
  return {
    schema: DATA_GENERATION_SCHEMA,
    id,
    published_at: value.published_at,
    commit: value.commit,
  }
}

export function createGenerationPointer(id, commit, publishedAt = new Date().toISOString()) {
  return parseGenerationPointer({
    schema: DATA_GENERATION_SCHEMA,
    id,
    published_at: publishedAt,
    commit,
  })
}
