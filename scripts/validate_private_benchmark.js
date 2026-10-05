import fs from 'node:fs'
import process from 'node:process'

export const CLOSURE_QUERY_CLASSES = Object.freeze([
  'exact_identity',
  'personal_note',
  'readme_only',
  'multi_facet',
  'multilingual',
  'negative',
  'community',
])

function classesForCase(item) {
  if (Array.isArray(item.classes))
    return item.classes
  return item.class ? [item.class] : []
}

export function validateClosureBenchmark(fixture) {
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture))
    throw new Error('Private retrieval benchmark must be an object.')
  if (!Array.isArray(fixture.cases) || fixture.cases.length === 0)
    throw new Error('Private retrieval benchmark must contain non-empty cases.')

  const classes = new Set()
  for (const [index, item] of fixture.cases.entries()) {
    if (!item?.id || !item?.query)
      throw new Error(`Private benchmark case ${index} needs id and query.`)
    for (const name of classesForCase(item))
      classes.add(name)
  }

  const missing = CLOSURE_QUERY_CLASSES.filter(name => !classes.has(name))
  if (missing.length > 0)
    throw new Error(`Private retrieval benchmark is missing closure query classes: ${missing.join(', ')}.`)

  const hybrid = fixture.thresholds?.hybrid_bge_m3
  if (!hybrid || typeof hybrid !== 'object' || Array.isArray(hybrid))
    throw new Error('Private retrieval benchmark needs hybrid_bge_m3 thresholds.')

  const classThresholds = hybrid.classes
  if (!classThresholds || typeof classThresholds !== 'object' || Array.isArray(classThresholds))
    throw new Error('Private retrieval benchmark needs class-level hybrid_bge_m3 thresholds.')

  const gatedClasses = ['readme_only', 'multi_facet', 'multilingual', 'negative', 'community']
  const ungated = gatedClasses.filter(name => !classThresholds[name])
  if (ungated.length > 0)
    throw new Error(`Private retrieval benchmark is missing class-level thresholds for: ${ungated.join(', ')}.`)

  return {
    cases: fixture.cases.length,
    classes: [...classes].sort(),
    recommended_case_count_met: fixture.cases.length >= 60,
  }
}

export function main() {
  const file = process.argv[2]
  if (!file)
    throw new Error('Usage: node scripts/validate_private_benchmark.js <fixture.json>')
  const fixture = JSON.parse(fs.readFileSync(file, 'utf8'))
  const report = validateClosureBenchmark(fixture)
  if (!report.recommended_case_count_met)
    console.warn(`[Private Benchmark] ${report.cases} cases; 60–120 real queries remain the recommended closure range.`)
  console.log(`[Private Benchmark] validated ${report.cases} cases across ${report.classes.join(', ')}.`)
}

if (process.argv[1]?.endsWith('validate_private_benchmark.js')) {
  try {
    main()
  }
  catch (error) {
    console.error(error.message || String(error))
    process.exitCode = 1
  }
}
