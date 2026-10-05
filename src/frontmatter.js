// Frontmatter for the archived README corpus: the writer's field list and the reader that has to
// understand it.
//
// The writer (`scripts/star_export.js`) and this reader are one contract in two files, and they are
// never run together in a test unless something makes them: a field the writer renames, or a value
// the writer emits unindented, silently changes what `get_repo_readme` returns. The field list
// therefore lives here, next to the parser, and the writer imports it rather than repeating it.
//
// The parser itself understands the small YAML subset the writer emits: flat `key: value` pairs
// plus `key: |-` block scalars whose continuation lines are indented.

/** Field order the writer emits, and the fields a reader may rely on. */
export const README_FRONTMATTER_FIELDS = [
  'project',
  'repo',
  'stars',
  'language',
  'categories',
  'reason',
  'summary',
  'description',
  'url',
  'topics',
]

/**
 * Values the writer may not emit as a plain scalar.
 *
 * A block scalar is only safe while every continuation line stays indented: an unindented one
 * truncates the value and can forge or overwrite a field the writer never set.
 */
export const README_BLOCK_SCALAR_FIELDS = ['reason', 'summary', 'description']

/** JSON-encoded values, so a category list cannot be mistaken for prose. */
export const README_JSON_FIELDS = ['categories', 'topics']

export function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match)
    return { metadata: {}, body: markdown }

  const yamlBlock = match[1]
  const body = match[2]
  const metadata = {}

  const lines = yamlBlock.split(/\r?\n/)
  let currentKey = null
  let currentValue = []

  const flush = () => {
    if (currentKey)
      metadata[currentKey] = currentValue.join(' ').replace(/^\|-\s*/, '').trim()
  }

  for (const line of lines) {
    const colonIdx = line.indexOf(':')
    if (colonIdx > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
      flush()
      currentKey = line.slice(0, colonIdx).trim()
      const rest = line.slice(colonIdx + 1).trim()
      currentValue = rest ? [rest] : []
    }
    else if (currentKey && (line.startsWith(' ') || line.startsWith('\t'))) {
      currentValue.push(line.trim())
    }
  }
  flush()

  return { metadata, body }
}
