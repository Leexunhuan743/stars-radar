// Explicit R2 REST targets keep journal publication and local restoration on the configured account.

import { Buffer } from 'node:buffer'
import process from 'node:process'
import { $fetch } from 'ofetch'

const REST_SCOPE = 'R2 REST'

/**
 * Resolves the REST target, or `null` when this environment cannot use it.
 *
 * @param {string} caller Name of the operation, so the warning says what was skipped.
 * @returns {{ accountId: string, bucket: string, token: string }|null} the credentials to use, or
 *   `null` when the REST API is not configured in this environment.
 */
export function r2Target(caller) {
  const accountId = process.env.R2_ACCOUNT_ID
  const bucket = process.env.R2_BUCKET
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (accountId && bucket && token)
    return { accountId, bucket, token }

  const missing = [
    !accountId && 'R2_ACCOUNT_ID',
    !bucket && 'R2_BUCKET',
    !token && 'CLOUDFLARE_API_TOKEN',
  ].filter(Boolean)
  console.warn(`[R2] ${caller}: ${REST_SCOPE} is not configured — ${missing.join(', ')} not set. Set all three for journal appends or vector restoration; CI alone publishes vectors via \`aws s3\`.`)
  return null
}

export function r2ObjectUrl({ accountId, bucket }, name) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${name}`
}

/** Writes one object. Throws on any refusal; the caller decides what a partial publish means. */
export async function putObject(target, name, contentType, data) {
  const result = await $fetch(r2ObjectUrl(target, name), {
    method: 'PUT',
    responseType: 'json',
    headers: {
      'Authorization': `Bearer ${target.token}`,
      'Content-Type': contentType,
    },
    body: data,
  })
  if (result?.success !== true)
    throw new Error(`R2 did not acknowledge writing ${name} to ${target.bucket}: ${JSON.stringify(result?.errors || [])}`)
  return result
}

/**
 * Reads one object.
 *
 * @returns {Promise<Buffer>} the object's bytes.
 * @throws when R2 refuses, or when the object is empty — an empty pair half is worse than an absent
 *   one, because it parses as "zero vectors" and would be published as a consistent-looking pair.
 */
export async function readObject(target, name) {
  const data = await $fetch(r2ObjectUrl(target, name), {
    responseType: 'arrayBuffer',
    headers: { Authorization: `Bearer ${target.token}` },
    timeout: 30000,
  })
  if (!data || data.byteLength === 0)
    throw new Error(`${name} in R2 is empty`)
  return Buffer.from(data)
}
