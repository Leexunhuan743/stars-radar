import { spawnSync } from 'node:child_process'
import process from 'node:process'

const result = spawnSync(process.execPath, ['--test', 'test/tool-schemas.test.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, UPDATE_SCHEMAS: '1' },
})
if (result.error)
  throw result.error
process.exit(result.status ?? 1)
