import { TOOL_DEFINITIONS } from './tool-schemas.js'

export const DEFAULT_TOOLSET = 'all'

const CORE_TOOLS = [
  'search_github_stars',
  'get_repo_readme',
  'compare_repositories',
  'list_categories',
  'get_category_repos',
  'list_starred_repos',
  'get_radar_status',
]

const RESEARCH_TOOLS = [
  ...CORE_TOOLS,
  'get_trending_repos',
  'search_github_live',
  'search_github_code',
  'search_web_tech',
  'get_top_skills',
  'get_hellogithub_picks',
]

const TOOLSETS = {
  core: CORE_TOOLS,
  research: RESEARCH_TOOLS,
  all: Object.keys(TOOL_DEFINITIONS),
}

export class ToolsetConfigError extends Error {
  constructor(value) {
    super(`Invalid MCP_TOOLSET ${JSON.stringify(value)}. Expected one of: core, research, all.`)
    this.name = 'ToolsetConfigError'
  }
}

export function resolveToolset(value) {
  const name = String(value || DEFAULT_TOOLSET).trim().toLowerCase()
  const tools = TOOLSETS[name]
  if (!tools)
    throw new ToolsetConfigError(value)
  return { name, tools: new Set(tools) }
}

export function toolsetStatus(value) {
  try {
    const resolved = resolveToolset(value)
    return {
      name: resolved.name,
      valid: true,
      tool_count: resolved.tools.size,
      write_tools_exposed: resolved.tools.has('capture_github_discovery') || resolved.tools.has('star_and_ingest_repo'),
    }
  }
  catch {
    return {
      name: String(value || DEFAULT_TOOLSET),
      valid: false,
      tool_count: 0,
      write_tools_exposed: false,
    }
  }
}

export function validateToolsetCoverage() {
  const known = new Set(Object.keys(TOOL_DEFINITIONS))
  const problems = []

  for (const [name, tools] of Object.entries(TOOLSETS)) {
    for (const tool of tools) {
      if (!known.has(tool))
        problems.push(`${name} references unknown tool ${tool}`)
    }
  }

  for (const tool of known) {
    if (!TOOLSETS.all.includes(tool))
      problems.push(`all omits declared tool ${tool}`)
  }

  return problems
}
