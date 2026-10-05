import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { parseGenerationPointer, validateGenerationId } from '../src/data-generation.js'

function required(name) {
  const value = process.env[name]
  if (!value)
    throw new Error(`${name} is required.`)
  return value
}

function aws(args, { encoding = 'utf8' } = {}) {
  return execFileSync('aws', args, {
    encoding,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function target() {
  const account = required('R2_ACCOUNT_ID')
  const bucket = required('R2_BUCKET')
  required('AWS_ACCESS_KEY_ID')
  required('AWS_SECRET_ACCESS_KEY')
  return {
    bucket,
    endpoint: `https://${account}.r2.cloudflarestorage.com`,
  }
}

function s3(target, ...args) {
  return aws([...args, '--endpoint-url', target.endpoint])
}

export function listGenerations() {
  const t = target()
  const raw = s3(
    t,
    's3api', 'list-objects-v2',
    '--bucket', t.bucket,
    '--prefix', 'generations/',
    '--delimiter', '/',
    '--output', 'json',
  )
  const payload = JSON.parse(raw)
  return (payload.CommonPrefixes || [])
    .map(item => item.Prefix?.replace(/^generations\//, '').replace(/\/$/, ''))
    .filter(Boolean)
    .sort()
    .reverse()
}

function readGenerationJson(t, generationId, name) {
  const text = s3(t, 's3', 'cp', `s3://${t.bucket}/generations/${generationId}/${name}`, '-')
  return JSON.parse(text)
}

export function validateRollbackTarget(generationId) {
  const id = validateGenerationId(generationId)
  const t = target()
  const manifest = readGenerationJson(t, id, 'generation-manifest.json')
  if (manifest?.generation?.id !== id)
    throw new Error(`generation-manifest.json belongs to ${manifest?.generation?.id || 'unknown'}, not ${id}.`)

  const requiredFiles = ['catalog.json', 'rankings.json', 'asset-index.json', 'asset-state.json', 'readmes.json']
  for (const name of requiredFiles) {
    if (!manifest.files?.[name])
      throw new Error(`Generation ${id} is missing ${name} in its manifest.`)
    s3(
      t,
      's3api', 'head-object',
      '--bucket', t.bucket,
      '--key', `generations/${id}/${name}`,
      '--output', 'json',
    )
  }
  return parseGenerationPointer(manifest.generation)
}

export function rollbackDataGeneration(generationId) {
  const pointer = validateRollbackTarget(generationId)
  const t = target()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stars-radar-rollback-'))
  try {
    const local = path.join(dir, 'active-generation.json')
    fs.writeFileSync(local, `${JSON.stringify(pointer, null, 2)}\n`)
    s3(t, 's3', 'cp', local, `s3://${t.bucket}/active-generation.json`)
    const remote = s3(t, 's3', 'cp', `s3://${t.bucket}/active-generation.json`, '-')
    const confirmed = parseGenerationPointer(JSON.parse(remote))
    if (confirmed.id !== pointer.id)
      throw new Error(`Rollback verification failed: active generation is ${confirmed.id}.`)
    return confirmed
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--list')) {
    for (const id of listGenerations())
      console.log(id)
    return
  }

  const at = args.indexOf('--to')
  if (at < 0 || !args[at + 1])
    throw new Error('Usage: node scripts/rollback_data_generation.js --list | --to <generation-id>')

  const pointer = rollbackDataGeneration(args[at + 1])
  console.log(`Active generation rolled back to ${pointer.id} (${pointer.commit}).`)
}

main().catch((error) => {
  console.error(error.message || String(error))
  process.exitCode = 1
})
