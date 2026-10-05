// Renders the enriched README corpus that the Worker reads back through src/frontmatter.js.
//
// Extracted from scripts/index.js so it can be tested without running the sync (which needs
// GitHub credentials and network). The writer and the reader are a cross-module contract, and
// that contract is what is left to guard here: the two export generators that used to live in
// this file (AWESOME_STARS.md, stars.opml) went away with the practice of committing derived
// data, since nothing consumed them once they stopped being published.

import {
  README_BLOCK_SCALAR_FIELDS,
  README_FRONTMATTER_FIELDS,
  README_JSON_FIELDS,
} from '../src/frontmatter.js'

// Inline base64 images bloat the corpus with no retrieval value.
const base64Image = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{100,}/g
// A long changelog adds no signal for search but a lot of bytes.
const changelogSection = /\n#{1,3}\s*(changelog|release notes|releases|update log|历史更新)[\s\S]{1000,}/i

function cleanReadme(readme) {
  if (!readme)
    return ''
  let cleaned = readme.replace(base64Image, '[embedded image]')
  if (cleaned.length > 25000)
    cleaned = cleaned.replace(changelogSection, '\n\n*(Changelog truncated for indexing)*')
  return cleaned
}

// The field list, the block-scalar rule and the JSON rule come from the reader
// (src/frontmatter.js), so a field added here without the reader knowing about it cannot happen
// silently — the contract is one list in one place.
//
// A block scalar is only safe while every continuation line stays indented: an unindented one
// truncates the value and can forge or overwrite a field the writer never set.
function blockScalar(value) {
  return ['|-', ...String(value).split(/\r?\n/).map(line => `  ${line}`)].join('\n')
}

function scalarFor(field, value) {
  if (README_JSON_FIELDS.includes(field))
    return JSON.stringify(value ?? (field === 'categories' ? ['everything-else'] : []))
  if (README_BLOCK_SCALAR_FIELDS.includes(field))
    return blockScalar(value ?? '')
  return String(value ?? '')
}

/** The frontmatter values for a repository, keyed by the field names the reader knows. */
function frontmatterValues(repoInfo) {
  return {
    project: repoInfo.name,
    repo: repoInfo.repo,
    stars: repoInfo.stars,
    language: repoInfo.language || '',
    categories: repoInfo.categories,
    reason: repoInfo.reason,
    summary: repoInfo.summary,
    description: repoInfo.description,
    url: repoInfo.url,
    topics: repoInfo.topics,
  }
}

export function renderEnrichedMarkdown(repoInfo, readmeContent) {
  const values = frontmatterValues(repoInfo)
  // Emitted in the declared order, from the declared list: the reader sees every field it expects
  // and nothing else.
  const frontmatter = README_FRONTMATTER_FIELDS
    .map(field => `${field}: ${scalarFor(field, values[field])}`)
    .join('\n')

  const categories = values.categories || ['everything-else']
  const catBadges = categories.map(c => `\`${c}\``).join(' ')
  const reason = repoInfo.reason || ''
  const summary = repoInfo.summary || ''
  const desc = repoInfo.description || ''

  const header = `---
${frontmatter}
---

# ${repoInfo.repo}

> **分类 (Categories)**: ${catBadges}
> **推荐理由 (Reason)**: ${reason}
> **功能概述 (Summary)**: ${summary}
> **项目简介 (Description)**: ${desc}

---

`
  return header + cleanReadme(readmeContent)
}
