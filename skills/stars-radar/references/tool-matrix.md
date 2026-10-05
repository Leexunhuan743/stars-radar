# Stars Radar MCP Tool Matrix & Schema Reference

Complete reference for all 15 MCP tools provided by the `Stars Radar` MCP server (served by your own deployment, e.g. `https://stars.example.com`).

---

## 1. Level 1: Curated Core & Vector Search

### `get_radar_status`

- **Description**: Returns the current Stars Radar workspace context: curated star count, vector DB capacity, available community intelligence layers, and search tool selection guidance. Call this first to understand what data the radar currently holds before deciding which search tool to use.
- **Inputs**: None.
- **Output**: Object with `workspace`, `version`, `total_starred`, `vector_db_capacity`, `repo_vector_count`, `readme_chunk_vector_count`, `vector_dimensions`, `vector_model`, `vector_input_profile`, `intent_domains`, `community_layers`, and `search_tool_hint`. `vector_input_profile=repo-metadata-readme-chunks-v3` means the index contains structured repository metadata vectors plus independent README section chunk vectors. Missing or different profiles are rejected and must be rebuilt.
  > Zero capacity can mean an empty installation. An inconsistent generation is a visible document error, or a stale cached view; inspect `/health` and its data-plane status rather than treating every zero as a provider outage.

### `search_github_stars`

- **Description**: Searches personal curated stars and ingested community repositories using 1024-dimensional `BAAI/bge-m3` vectors fused with an 18-domain public ontology via Reciprocal Rank Fusion (RRF, $k=60$).
- **Inputs**:
  - `query` (string, required, max 512 characters): Natural language search terms, tech capabilities, or curator keywords.
  - `explain` (boolean, default: `false`): Include actual matched terms, scoring channels, keyword weight and vector similarity. Vector matches may return `explanation.semantic_evidence` with separate repo similarity and the strongest README chunk heading/snippet/similarity. The top 5 hits also inspect cached R2 README text and may return `explanation.readme_evidence` with literal section snippets. No GitHub request is made for either channel, generated curator headers are excluded, and literal evidence is never fabricated.
  - `category` (string, optional): Exact taxonomy filter against your GitHub Lists categories (e.g. `agent-plugins`, `media-players`). Case-insensitive. Call `list_categories` for all valid slugs. This is the **deployer's own** classification and nothing else: a community board's label is never one of these.
  - `source` (enum, optional): Filter by where a hit came from, independent of `category` — `starred`, `curated`, `archive`, `community`, `ranking`, `trending`, `hellogithub`, `breakout`, `skill`, `skill_repo`. The value matches each result's `source` field, so use it to look only at board discoveries (`source=trending`) or only at the archive long tail (`source=archive`).
  - `scope` (enum: `all` | `starred` | `rankings`, default: `all`): Search personal stars, community intelligence, or both.
  - `limit` (number, default: 5, max: 20): Result limit.
  - `min_score` (number, default: 0.25): Score cutoff threshold (0.0–1.0). See calibration guide below.
- **Output**: Array of repository objects with `relevance_score`, `vector_similarity`, `source`, `source_badge` (`⭐ Starred` | `⚡ Community Ingested`), `reason`, `summary`, `categories`, and `stars`. `categories` lists the deployer's buckets (empty when the hit is not in any of them); `source` says which channel offered it.

---

## Retrieval scores and evaluation

Scores are ranking signals, not correctness probabilities. Vector scores use cosine similarity.
Combined results add a keyword bonus capped at 0.35 and a final ceiling of 0.98; keyword-only scores
use `min(1 - 1/(1 + weight/8), 0.95)`. Relevance is the primary sort key; RRF breaks ties,
with a 1.5 starred boost. `min_score` defaults to 0.25 and changes the cutoff, not a guaranteed accuracy.

`category` selects personal classifications; `source` selects provenance. The 40% non-starred
diversity cap applies only to the default mixed view (`scope=all` without a source filter); explicit
`scope=rankings` or `source=...` requests can fill the requested limit. `explain=true` reports matching evidence. Hyphens, underscores and spaces share
one lexical form, and short words use boundaries.

Repository vectors use input profile `repo-metadata-readme-chunks-v3`. Each repository gets one metadata vector and up to six selected README section vectors. A README chunk can therefore directly recall a repository even when the feature is absent from short GitHub metadata. Under `explain=true`, `semantic_evidence.readme_chunk` identifies the semantic chunk that contributed the strongest vector evidence; cached literal README snippets remain a separate verification channel.

Run `pnpm eval:retrieval` for the synthetic labeled regression corpus. Its deterministic vector
fixtures test channel behavior; they do not measure real BGE-M3 or production precision/recall. Use
`pnpm eval:retrieval:real` with a private labeled fixture for real-corpus lexical-vs-hybrid metrics.

### `get_repo_readme`

- **Description**: Reads metadata and optional README from snapshots or GitHub; README text is capped at 50,000 characters.
- **Inputs**:
  - `repo` (string, required): `owner/repo` format.
  - `include_readme` (boolean, default: `true`): Use `false` for compact metadata without reading README objects. Unknown repositories use GitHub metadata; missing archives use GitHub README when requested.
  - `refresh` (boolean, default: `false`): Fetch current GitHub metadata while preserving personal notes. README may still come from the archive; `readme_source` identifies its origin.
- **Output**: Uniform metadata and `evidence` with source, timestamp and URL. README mode also includes `readme_available`, `readme_source`, `readme` and `truncated`.

### `compare_repositories`

- **Inputs**: `repos`, an array of 2–5 distinct `owner/repo` names or GitHub repository URLs.
- **Optional**: `refresh=true` obtains current GitHub metadata for all candidates, preserving personal notes.
- **Output**: `repositories` with identical fields, `dimensions`, and a note explaining snapshot limitations. Each repository carries `evidence.source`, `evidence.fetched_at`, `evidence.snapshot_at`, and its URL. A snapshot timestamp is not an upstream fetch timestamp; unknown fetch times and facts are `null`.
- Use this after candidate discovery. Compare license, language, maintenance dates, topics and personal reasons; read selected READMEs separately for technical claims. The comparison does not generate a quality score.

### `list_categories`

- **Description**: Returns your GitHub Lists categories, descriptions, counts, and top representative projects.
- **Inputs**: None.
- **Output**: Array of category objects, each containing:
  - `name` (string): Category slug (e.g. `agent-plugins`, `dev-tools`, `self-hosted`).
  - `description` (string): Curator definition and scope of the bucket.
  - `count` (number): Total personal repositories filed in this category.
  - `top_repos` (array of strings): Top 3 representative projects by stargazers, formatted as `"<owner>/<repo> (⭐ <stars>)"`.

### `get_category_repos`

- **Description**: Lists all repositories belonging to a specific taxonomy category, sorted by star count.
- **Inputs**:
  - `category` (string, required): Taxonomy category name.
  - `limit` (number, default: 25, max: 50).

### `list_starred_repos`

- **Description**: Paginated cursor-based access to the complete archive of cached repositories.
- **Inputs**:
  - `limit` (number, default: 20, max: 50).
  - `cursor` (string, optional): Pagination token.

---

## 2. Level 2: Community Intelligence Radar

### `get_trending_repos`

- **Description**: Live GitHub trending repositories across languages and periods.
- **Inputs**:
  - `category` (enum, default: `overall_daily`):
    - `overall_daily`, `overall_weekly`
    - `rust_weekly`, `python_weekly`, `typescript_weekly`, `go_weekly`, `cpp_weekly`, `csharp_weekly`
    - `breakout_weekly` (14-day breakout window)
  - `limit` (number, default: 10, max: 30).

### `get_top_skills`

- **Description**: Multi-board Agent Skills leaderboard (LinklyAI 300+ skills) and recent open-source skill repositories (160+ repos). Both counts grow with each scheduled sync — read the live figures from the tool response rather than assuming a fixed number.
- **Inputs**:
  - `type` (enum, default: `all`): `all` | `skills` | `repos` | `rising` | `trending`.
  - `limit` (number, default: 20, max: 100).

### `get_hellogithub_picks`

- **Description**: Monthly curated open-source recommendations from HelloGitHub issues with Chinese analysis.
- **Inputs**:
  - `category` (string, optional): Filter by category (e.g. `Python`, `Go`, `机器学习`).
  - `limit` (number, default: 10, max: 30).

---

## 3. Level 3: Active Probes & Ingestion Loop

### `search_github_live`

- **Description**: Real-time global GitHub repository explorer. Automatically filters forks and archived projects, cross-referencing returned items against personal stars.
- **Inputs**:
  - `query` (string, required, max 512 characters): Search query or topic.
  - `language` (string, optional): Language filter.
  - `min_stars` (number, default: 15): Star threshold.
  - `sort` (enum: `stars` | `updated` | `forks`, default: `stars`).
  - `order` (enum: `desc` | `asc`, default: `desc`).
  - `since` (string, optional): Start date (`YYYY-MM-DD`, `7d`, `30d`, or `YYYY-MM-DD..YYYY-MM-DD`).
  - `until` (string, optional): End date (`YYYY-MM-DD`).
  - `limit` (number, default: 10, max: 30).
- **Mutability**: read-only. Searching never writes discovery state.
- **Output**: Repositories badged with `⭐ Starred`, `⚡ Community Ingested`, or `🌐 Global Discovery`, plus `community_sources` when several independent community feeds observed the same repository.

### `capture_github_discovery`

- **Description**: Explicitly records one user-selected live discovery for later cross-query promotion.
- **Mutability**: write.
- **Inputs**:
  - `repo`: owner/repo or GitHub repository URL.
  - `query`: the originating search query (1–512 characters).
- **Safety contract**: the Worker re-fetches repository metadata from GitHub and applies the capture threshold itself. Client-supplied stars/description are never trusted.
- **Output**: `captured=1` plus the R2 capture key, or `captured=0` with a skip reason when the repository does not satisfy the capture rule.

### `search_github_code`

- **Description**: Searches public repository code on GitHub. Extracts syntax snippets with language code fences and exact blob URLs.
- **Inputs**:
  - `query` (string, required, max 256 characters): Code term or method name. Must contain at least one non-qualifier keyword.
  - `repo` (string, optional): Target repository (`owner/repo`).
  - `language` (string, optional): Target language.
  - `extension` (string, optional): Target file extension without dot.
  - `path` (string, optional): Target path substring.
  - `limit` (number, default: 5, max: 15).
- **Output**: Array of matches with `repo`, `path`, `url`, `language`, and syntax-fenced `snippet`.

### `search_web_tech`

- **Description**: Searches technical documentation, framework changelogs, error discussions, and technical teardowns with multi-provider routing (Brave / Tavily / keyless DuckDuckGo fallback). Enforces timeout protection (8s for API providers, 6s for DuckDuckGo) to prevent Worker hanging.
- **Inputs**:
  - `query` (string, required, max 512 characters): Technical query.
  - `domain` (string, optional): Target domain filter (e.g. `developers.cloudflare.com`).
  - `freshness` (enum: `day` | `week` | `month` | `year` | `all`, default: `all`).
  - `limit` (number, default: 5, max: 10).
- **Output**: Object with `provider`, `query`, `count`, `results` and `freshness_applied`. Each result has `title`, `url`, and `snippet`. Brave/Tavily apply requested freshness; the keyless fallback reports `freshness_applied=false`.
- **Failures**: Exhausted providers or an unparseable keyless page produce MCP `isError` / REST 503. A valid empty result list is successful. Repository and code probes also report upstream failures explicitly; GitHub rate-limit hints are returned as `retry_after_seconds` when known.

### `star_and_ingest_repo`

- **Description**: One-click star a repository on GitHub under the user's account and stage it immediately into Stars Radar so it becomes searchable via hybrid search and vector pipelines.
- **Inputs**:
  - `repo` (string, required): `owner/repo` format. The value is first normalised (a leading `https://github.com/` prefix, a trailing `.git` and a trailing slash are stripped), then validated against `/^[\w.-]+\/[\w.-]+$/`.
  - `reason` (string, optional): Curator reason note.
  - `categories` (array of strings, optional, default: `[]`): Personal tags supplied by the user; no category is assigned automatically.
- **Output**: Confirmation with `starred_on_github: true`, `staged_in_radar: true`, and `badge: "⚡ Community Ingested"`.

## Retrieval quality evaluation

`pnpm eval:retrieval` is a deterministic regression suite; it proves ranking rules but not production search quality.

For real quality measurement, copy `test/fixtures/retrieval-benchmark.example.json` to the ignored `data/retrieval-benchmark.private.json`, label real queries against the deployer's own corpus, then run:

```sh
pnpm eval:retrieval:real -- --fixture data/retrieval-benchmark.private.json --k 10
```

The report compares lexical and real BGE-M3 hybrid retrieval and includes Recall@K, Precision@K, MRR, NDCG@K, forbidden hits, and P50/P95 latency.

## Authentication and write boundaries

`MCP_API_KEY` and `MCP_WRITE_API_KEY` are both required. The read key can search and inspect data but cannot call
`capture_github_discovery` or `star_and_ingest_repo`; those mutations require the write key.
The write key can also read. REST write endpoints follow the same rule and return
`403 write_forbidden` for a read credential.

The default MCP exposure profile is `research`, which automatically exposes every tool declared read-only and hides write tools. `core` narrows further to personal-library retrieval, while `all` must be selected explicitly to expose mutation tools.
