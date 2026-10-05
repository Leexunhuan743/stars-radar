# Stars Radar

[简体中文](README.md) · [Developer guide (Chinese)](docs/DEVELOPMENT.md)

Stars Radar is a self-hosted research assistant for open-source projects. Connect your GitHub stars, community recommendations and live searches to an AI assistant to find saved tools, discover projects, compare candidates and keep notes about why you saved them.

Example requests:

> Find a Markdown note-taking tool in my GitHub stars.
>
> Find Rust command-line projects created in the last two weeks.
>
> Compare these three repositories by license, maintenance dates and purpose. Show where the information came from.
>
> Star this repository and save why I want to use it.

The project is in development and intended for personal deployments. It provides an MCP service and a command-line client. There is no standalone graphical interface. Your AI client must support **Streamable HTTP MCP** and custom authentication headers.

## Features

- Search your own stars by keywords, purpose or natural-language descriptions. Categories come from your GitHub Lists.
- Explore GitHub Trending, recent repositories, HelloGitHub picks and Agent Skills boards, or search GitHub live.
- Compare 2–5 repositories using metadata, personal notes, source labels and snapshot dates. Unknown fields remain unknown.
- Read repository details, READMEs and code snippets. Request matching evidence for search results.
- Star a repository and record a reason. Metadata becomes available to lexical search first; semantic vectors arrive with the next successful data build.

Search scores rank candidates; they are not quality ratings or correctness probabilities. Community sources can be unavailable or stale. Check source dates and repository evidence before making a decision.

## Deploy your instance

A fresh clone contains source code, not the maintainer's collection. You need a GitHub account and personal access token, a Cloudflare account with Workers and R2, a SiliconFlow API key, **Node.js 22.19.0** or newer, and **pnpm 10**. Python 3.8+ is optional for the CLI. Provider charges and quotas depend on their current terms.

### 1. Fork and install

Fork this repository on GitHub, clone your fork and run:

```sh
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm exec wrangler r2 bucket create your-radar-bucket
```

Choose your own bucket name. Edit `wrangler.jsonc`: set `name` to your Worker name and `r2_buckets[0].bucket_name` to your bucket. Keep the binding name `R2`.

### 2. Build your data

Add these Repository secrets in your fork's **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `GH_TOKEN` | Your personal GitHub token |
| `SILICONFLOW_KEY` | SiliconFlow API key |
| `R2_ACCOUNT_ID` | Cloudflare Account ID |
| `R2_BUCKET` | Your bucket name |
| `R2_ACCESS_KEY_ID` | R2 S3 access key ID |
| `R2_SECRET_ACCESS_KEY` | R2 S3 secret access key |

The S3 credentials need read/write access to that bucket. The workflow maps `GH_TOKEN` to `GITHUB_TOKEN`; GitHub's automatic workflow token is not your personal star-sync token.

Enable workflows in **Actions** and manually run **Update Repos Info**. The first run builds your catalogue, README archive and retrieval index. Subsequent runs are scheduled every six hours. A failed run does not guarantee new vectors were published; retry it after addressing the failure.

### 3. Configure and deploy the Worker

Set Worker secrets separately from Actions secrets:

```sh
pnpm exec wrangler secret put MCP_API_KEY
# Required: mutations use a separate key
pnpm exec wrangler secret put MCP_WRITE_API_KEY
pnpm exec wrangler secret put GITHUB_TOKEN
pnpm exec wrangler secret put SILICONFLOW_KEY
pnpm deploy
```

Both `MCP_API_KEY` and `MCP_WRITE_API_KEY` are required and must be different random values. The read key can search/read only; the write key may also capture discoveries and star/ingest repositories. Use your personal GitHub token for `GITHUB_TOKEN`. Wrangler prints the deployed URL.

`wrangler.jsonc` also declares two Cloudflare Rate Limiting bindings: expensive search/probe work defaults to 60 calls per minute and write operations to 20 calls per minute, keyed by the authenticated credential at the current Cloudflare location. These are protective budgets, not exact accounting. If the example `namespace_id` values are already used in your Cloudflare account, replace both with unused positive integers before deployment.

`MCP_TOOLSET` controls the **MCP-visible tool surface**. The default is `research`, which exposes all read-only research tools but hides capture and star/ingest. `core` keeps only personal-library retrieval/comparison/status tools. Write tools are exposed only when `all` is selected explicitly. REST routes are unchanged; invalid values fail MCP initialization.

To deploy automatically after a data update, also set the Actions secret `CLOUDFLARE_API_TOKEN` with Worker deployment permission for the account. Without it, the workflow only publishes R2 data. Configuration details are listed in [.env.example](.env.example) and the [developer guide](docs/DEVELOPMENT.md).

## Connect an AI assistant

Add a remote MCP server with:

| Setting | Value |
| --- | --- |
| Name | `stars-radar` |
| URL | `https://your-worker.example/mcp` |
| Transport | Streamable HTTP |
| Header | `Authorization: Bearer YOUR_MCP_API_KEY` |

For clients accepting `mcpServers`, `url` and `headers`, this configuration is an example:

```json
{
  "mcpServers": {
    "stars-radar": {
      "url": "https://stars.example.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_MCP_API_KEY" }
    }
  }
}
```

Replace the placeholders. Client formats vary. The service uses Bearer-key authentication and does not provide OAuth login. Start by asking the assistant to check the radar's data status. Explicitly authorize a star operation and provide the repository and note.

## Command-line client

The client uses only the Python standard library. Set `WORKER_URL` and `MCP_API_KEY` in your shell; it does not load `.env` automatically. Set `MCP_WRITE_API_KEY` before `--capture` or `--star` commands.

PowerShell:

```powershell
$env:WORKER_URL = "https://stars.example.com"
$env:MCP_API_KEY = "YOUR_MCP_API_KEY"
python scripts/search_stars_cli.py "Markdown notes" --scope starred
```

Bash / zsh:

```sh
export WORKER_URL="https://stars.example.com"
export MCP_API_KEY="YOUR_MCP_API_KEY"
python scripts/search_stars_cli.py "Markdown notes" --scope starred
```

```sh
python scripts/search_stars_cli.py --live "markdown notes" --min-stars 50
python scripts/search_stars_cli.py --trending overall_weekly
# Writes a GitHub star and a radar ingest record:
python scripts/search_stars_cli.py --star owner/repo --reason "For my personal knowledge base"
python scripts/search_stars_cli.py --help
```

## Things to know

Stars saved through the service become lexically searchable after journal refresh, normally within a minute on other instances. Semantic search follows the next successful CI build. Stars made directly on GitHub require the next successful star sync.

Your categories are your own GitHub Lists, with no fixed count. Uncategorized public stars use `everything-else`. Ingest tags stay in the radar and do not modify GitHub Lists.

Generated data lives in your R2 bucket and is not committed to Git. The sync excludes private repositories. Keep the bucket private and share the service key only with trusted clients. This is a single-account service: all clients with the same key share its data and permissions.

For connection or data problems, check `/health` and the [troubleshooting guide](docs/DEVELOPMENT.md#排查问题). Full API, architecture, local-development and release instructions are in the same guide. The optional agent skill is in [skills/stars-radar](skills/stars-radar/SKILL.md).

## Contributing and license

Issue reports should include steps to reproduce, expected and actual behavior, and environment details. Remove credentials and personal notes before sharing logs.

Source code is licensed under [Apache License 2.0](LICENSE). Third-party repositories and README content retain their own licenses.
