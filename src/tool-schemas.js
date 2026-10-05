// Single source of truth for all Stars Radar MCP tool schemas.
//
// Why this file exists: tool input schemas must be importable as pure data so
// that (a) the worker registers them by reference and (b) a schema snapshot
// test (`test/tool-schemas.test.mjs`) can detect accidental drift that would
// silently break MCP clients. Never inline new schemas in index.js — edit here.
//
// NOTE: this module is intentionally dependency-light (zod only) so tests can
// import it without pulling in the Cloudflare worker runtime.

import { z } from 'zod'
import { PROBE_CAPTURE_PREFIX } from './object-keys.js'
import { RESULT_SOURCES } from './result-compiler.js'

/**
 * The category an ingest lands in when the caller names none.
 *
 * Declared here rather than in the handler because the tool's schema is the contract a client reads:
 * the default it advertises and the default the code applies have to be the same value, and they
 * were two literals in two files.
 */
export const DEFAULT_INGEST_CATEGORIES = []

/**
 * Central registry: one entry per MCP tool exposed by Stars Radar.
 * `name` is the MCP tool name; `description` feeds the AI client's tool
 * selection; `inputSchema` is the zod object used at registration time.
 */
export const TOOL_DEFINITIONS = {
  // ---- Level 1: curated core & vector search ----
  search_github_stars: {
    name: 'search_github_stars',
    readOnly: true,
    description: 'Search your curated personal GitHub stars (size depends on the deployment) and ingested community tools using BAAI/bge-m3 vector semantics + domain intent. Results include provenance and optional scoring evidence. For open-world discovery of new or unstarred tools across GitHub, use search_github_live instead.',
    inputSchema: {
      query: z.string().max(512).describe('Search query, feature description, or keywords (max 512 characters; e.g. "antigravity 反代", "fast spotify client", "capcut open source")'),
      explain: z.boolean().optional().default(false).describe('Include actual matched tokens, subjects, intent terms and scoring channels. Semantic-only matches carry no invented literal evidence.'),
      category: z.string().optional().describe('Optional exact taxonomy filter against your GitHub Lists categories (e.g. "agent-plugins", "terminal", "media-players"). Case-insensitive. Call list_categories to inspect valid bucket slugs.'),
      source: z.enum(RESULT_SOURCES).optional().describe('Optional filter on where a hit came from, independent of the taxonomy above: "starred" (your own stars), "curated" (staged through star_and_ingest_repo), "trending"/"hellogithub"/"breakout"/"skill"/"skill_repo" (a community board), "archive" (the historical long tail), "community" or "ranking". The value matches the `source` field of each result.'),
      scope: z.enum(['all', 'starred', 'rankings']).optional().default('all').describe('Search scope: "all" (personal stars + community breakout rankings, default), "starred" (personal stars only), or "rankings" (rankings only)'),
      limit: z.number().int().min(1).max(20).optional().default(5).describe('Maximum number of results to return (default: 5)'),
      min_score: z.number().min(0).max(1).optional().default(0.25).describe('Ranking cutoff (0.0–1.0, default: 0.25). Higher cutoffs discard more candidates; precision and recall depend on the corpus. Use explain and evaluation fixtures to inspect behavior. Scores are not correctness probabilities.'),
    },
  },

  get_repo_readme: {
    name: 'get_repo_readme',
    readOnly: true,
    description: 'Read repository metadata and optionally its README, using cached evidence or GitHub when not archived. Set include_readme=false for compact research context. README is capped at 50,000 characters.',
    inputSchema: {
      repo: z.string().describe('Repository full name in "owner/repo" format (e.g. "GoldenPotato137/PotatoVN")'),
      include_readme: z.boolean().optional().default(true).describe('Include README text; false returns only compact metadata and its provenance without reading a README object.'),
      refresh: z.boolean().optional().default(false).describe('Fetch current GitHub metadata even for cached repositories, keeping personal categories and notes.'),
    },
  },

  compare_repositories: {
    name: 'compare_repositories',
    readOnly: true,
    description: 'Compare 2–5 distinct repositories using compact evidence: license, maintenance dates, language, topics, stars and personal notes. Missing fields are null; snapshot dates and sources are included. Does not invent a quality score or read READMEs.',
    inputSchema: {
      repos: z.array(z.string()).min(2).max(5).describe('Distinct owner/repo names or GitHub repository URLs in the desired comparison order.'),
      refresh: z.boolean().optional().default(false).describe('Fetch current GitHub metadata for all candidates while keeping personal notes. Otherwise use available snapshots.'),
    },
  },

  // ---- Level 2: community intelligence radar ----
  get_trending_repos: {
    name: 'get_trending_repos',
    readOnly: true,
    description: 'Read cached GitHub Trending snapshots across languages and periods (overall daily/weekly, rust, python, typescript, go, cpp, csharp, breakout_weekly).',
    inputSchema: {
      category: z.enum(['overall_daily', 'overall_weekly', 'rust_weekly', 'python_weekly', 'typescript_weekly', 'go_weekly', 'cpp_weekly', 'csharp_weekly', 'breakout_weekly'])
        .optional()
        .default('overall_daily')
        .describe('Trending category / language / period'),
      limit: z.number().int().min(1).max(30).optional().default(10).describe('Maximum repos to return (default: 10)'),
    },
  },

  // ---- Level 3: active probes ----
  search_github_live: {
    name: 'search_github_live',
    readOnly: true,
    description: 'Open-world live GitHub repository explorer. Searches public repositories across GitHub for new tools, libraries, and capabilities. This tool is read-only; use capture_github_discovery to explicitly persist a selected discovery.',
    inputSchema: {
      query: z.string().max(512).describe('Search query, capability keywords, or framework names (max 512 characters; e.g. "antigravity cf worker", "mcp rust", "deepseek")'),
      language: z.string().optional().describe('Filter by programming language (e.g. "rust", "typescript", "python", "go")'),
      min_stars: z.number().int().min(0).optional().default(15).describe('Minimum stargazers threshold (default: 15 to filter noise)'),
      sort: z.enum(['stars', 'updated', 'forks']).optional().default('stars').describe('Sort criterion'),
      order: z.enum(['desc', 'asc']).optional().default('desc').describe('Sort order'),
      since: z.string().optional().describe('Filter by creation date (e.g. "7d", "30d", "2026-08-01", or "2026-08-01..2026-08-31")'),
      until: z.string().optional().describe('End date filter (YYYY-MM-DD)'),
      limit: z.number().int().min(1).max(30).optional().default(10).describe('Maximum results to return (default: 10)'),
    },
  },

  capture_github_discovery: {
    name: 'capture_github_discovery',
    readOnly: false,
    description: `Persist one user-selected live GitHub discovery into R2 ${PROBE_CAPTURE_PREFIX}. The server re-fetches repository metadata from GitHub and applies the capture threshold before writing, so client-supplied stars or descriptions are never trusted.`,
    inputSchema: {
      repo: z.string().describe('Repository full name in "owner/repo" format or a GitHub repository URL.'),
      query: z.string().min(1).max(512).describe('The originating discovery query, used to count independent observations during later promotion.'),
    },
  },

  search_github_code: {
    name: 'search_github_code',
    readOnly: true,
    description: 'Search public repository code across GitHub for concrete API usage, configuration recipes, and syntax implementations. Extracts contextual syntax snippets with exact file URLs.',
    inputSchema: {
      query: z.string().max(256).describe('Exact code term, method name, or syntax string to search (max 256 characters; e.g. "thoughtSignature", "daily-cloudcode-pa"). Must contain at least one non-qualifier keyword.'),
      repo: z.string().optional().describe('Scope search to a specific repository ("owner/repo")'),
      language: z.string().optional().describe('Target programming language (e.g. "typescript", "rust", "go", "python")'),
      extension: z.string().optional().describe('Target file extension without dot (e.g. "jsonc", "toml", "rs", "tsx")'),
      path: z.string().optional().describe('Path substring filter (e.g. "src/workers", ".github/workflows")'),
      limit: z.number().int().min(1).max(15).optional().default(5).describe('Maximum code matches to return (default: 5, max 15)'),
    },
  },

  search_web_tech: {
    name: 'search_web_tech',
    readOnly: true,
    description: 'Search the broader technical web for official documentation, framework changelogs, StackOverflow error discussions, and technical teardowns. Multi-provider with zero-key fallback.',
    inputSchema: {
      query: z.string().max(512).describe('Technical search query (max 512 characters; e.g. "Cloudflare Workers vector dot product Float32Array performance")'),
      domain: z.string().optional().describe('Optional domain filter to restrict search (e.g. "developers.cloudflare.com", "stackoverflow.com")'),
      freshness: z.enum(['day', 'week', 'month', 'year', 'all']).optional().default('all').describe('Filter by content recency'),
      limit: z.number().int().min(1).max(10).optional().default(5).describe('Number of web results to return (default: 5)'),
    },
  },

  star_and_ingest_repo: {
    name: 'star_and_ingest_repo',
    readOnly: false,
    description: 'One-click star a discovered repository on GitHub under your account and stage it into the ingest journal. It is counted right away, search_github_live badges it as ingested immediately, and becomes lexically searchable after journal refresh. The next successful scheduled build publishes its semantic vectors (scheduled every 6 hours).',
    inputSchema: {
      repo: z.string().describe('Repository full name in "owner/repo" format (e.g. "balakumardev/antigravity-reverseproxy-api")'),
      reason: z.string().optional().describe('Optional curator note or reason for starring'),
      categories: z.array(z.string()).optional().default(DEFAULT_INGEST_CATEGORIES).describe('Taxonomy category tags (e.g. ["agent-plugins"])'),
    },
  },

  get_top_skills: {
    name: 'get_top_skills',
    readOnly: true,
    description: 'Get top-ranked Agent Skills and open-source skill repositories from LinklyAI leaderboards and past 60-day GitHub breakouts.',
    inputSchema: {
      type: z.enum(['all', 'skills', 'repos', 'rising', 'trending']).optional().default('all').describe('Filter by skill type: "skills" (all registered skills), "repos" (open-source skill repos), "rising" (rising stars), "trending" (7d trend), or "all"'),
      limit: z.number().int().min(1).max(100).optional().default(20).describe('Number of skills/repos to return (default: 20)'),
    },
  },

  get_hellogithub_picks: {
    name: 'get_hellogithub_picks',
    readOnly: true,
    description: 'Get curated open-source recommendations from HelloGitHub monthly issues with high-quality Chinese descriptions.',
    inputSchema: {
      category: z.string().optional().describe('Optional category filter (e.g. "C#", "Python", "Go", "机器学习", "工具")'),
      limit: z.number().int().min(1).max(30).optional().default(10).describe('Maximum items to return (default: 10)'),
    },
  },

  list_categories: {
    name: 'list_categories',
    readOnly: true,
    description: 'List your GitHub Lists categories, repository counts, and representative projects.',
    inputSchema: {},
  },

  get_category_repos: {
    name: 'get_category_repos',
    readOnly: true,
    description: 'List all repositories belonging to a specific category, sorted by star count.',
    inputSchema: {
      category: z.string().describe('Category name (e.g. "agent-plugins", "media-players", "windows-tools")'),
      limit: z.number().int().min(1).max(50).optional().default(25).describe('Maximum repos to return (default: 25)'),
    },
  },

  list_starred_repos: {
    name: 'list_starred_repos',
    readOnly: true,
    description: 'List starred repositories currently cached in the archive with pagination.',
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional().default(20).describe('Number of repos to list (default: 20, max: 50)'),
      cursor: z.string().optional().describe('Pagination cursor from previous request'),
    },
  },

  get_radar_status: {
    name: 'get_radar_status',
    readOnly: true,
    description: 'Get the current Stars Radar workspace context: curated star count, vector DB capacity, available community intelligence layers, and which search tool fits. Call this first to understand what data the radar currently holds before deciding which search tool to use.',
    inputSchema: {},
  },
}
