# Stars Radar CLI Recipes & Usage Dictionary

Reference guide for operating Stars Radar via local command-line tools.

---

## 1. Quick Search Recipes (`search_stars_cli.py`)

### Environment Setup (Required)

Before running CLI commands, export your master API key and the URL of **your own** deployed Worker:

```bash
# Windows PowerShell
$env:MCP_API_KEY="your_secret_key"
$env:WORKER_URL="https://stars.example.com"  # required — your own deployment; there is deliberately no default

# Linux / macOS / Git Bash
export MCP_API_KEY="your_secret_key"
export WORKER_URL="https://stars.example.com"  # required — your own deployment; there is deliberately no default
```

Replace `https://stars.example.com` with your custom domain or `<worker-name>.<subdomain>.workers.dev`. Both variables are mandatory: with `WORKER_URL` unset the scripts exit with a configuration error, so a missing value can never send your `MCP_API_KEY` to a third-party host.

### Hybrid Vector & Keyword Search

```bash
# General search across personal stars and community breakout projects
python skills/stars-radar/scripts/search_stars_cli.py "antigravity 反代"
python skills/stars-radar/scripts/search_stars_cli.py "fastpotify"
python skills/stars-radar/scripts/search_stars_cli.py "rust terminal music player"

# Restrict strictly to personal stars
python skills/stars-radar/scripts/search_stars_cli.py "deepseek harness" --scope starred

# Filter by taxonomy category
python skills/stars-radar/scripts/search_stars_cli.py "proxy" --category agent-plugins
```

### Live Global Exploration (Level 3 Probes)

```bash
# Search live GitHub repositories globally with collision detection
python skills/stars-radar/scripts/search_stars_cli.py --live "antigravity reverse proxy" --limit 5

# Capture qualifying live discoveries into the continuously-growing asset database
# (stars>=50, non-empty description, top-3 by stars -> staged for next CI asset-database merge)
python skills/stars-radar/scripts/search_stars_cli.py --live "mcp rust server" --limit 5 --persist

# Search real-world code snippets across GitHub
python skills/stars-radar/scripts/search_stars_cli.py --code "daily-cloudcode-pa" --language js
python skills/stars-radar/scripts/search_stars_cli.py --code "thoughtSignature" --repo "balakumardev/antigravity-reverseproxy-api"

# Search technical web documentation
python skills/stars-radar/scripts/search_stars_cli.py --web "Cloudflare Workers vector Float32Array performance"

# One-click star on GitHub and stage into Stars Radar
python skills/stars-radar/scripts/search_stars_cli.py --star "dinobot22/antigravity-ssh-proxy" --reason "Antigravity SSH reverse proxy"
```

### Community Rankings & Intelligence

```bash
# Trending daily and weekly
python skills/stars-radar/scripts/search_stars_cli.py --trending overall_daily
python skills/stars-radar/scripts/search_stars_cli.py --trending rust_weekly
python skills/stars-radar/scripts/search_stars_cli.py --trending breakout_weekly

# Agent Skills leaderboard and 60-day open-source skill repos
python skills/stars-radar/scripts/search_stars_cli.py --skills --limit 10
python skills/stars-radar/scripts/search_stars_cli.py --skill-repos --limit 10

# HelloGitHub curated picks
python skills/stars-radar/scripts/search_stars_cli.py --hellogithub --category Python
```

---

## 2. On-Demand Harvest & Ingestion (`--harvest`)

Harvests repositories across custom date windows, prints a report and appends metadata to the R2 ingest journal. The next successful CI build computes and publishes 1024D `BAAI/bge-m3` vectors. Harvesting requires the R2 REST trio, but no local embedding key.

```bash
# Harvest top 10 Agent Skills from past 30 days into vector database
python skills/stars-radar/scripts/search_stars_cli.py --harvest --source skills --days 30 --limit 10

# Harvest top 15 breakout projects from past 14 days into vector database
python skills/stars-radar/scripts/search_stars_cli.py --harvest --source breakout --days 14 --limit 15

# Harvest from exact historical date range
python skills/stars-radar/scripts/search_stars_cli.py --harvest --source all --since 2026-08-01 --until 2026-08-31 --limit 20
```

---

## 3. Direct Node.js Harvest Engine (`harvest_and_ingest.js`)

Direct execution for CI or headless environments:

```bash
cd github-stars-mcp
node scripts/harvest_and_ingest.js --source skills --since 30d --limit 10
node scripts/harvest_and_ingest.js --source breakout --since 14d --limit 15
node scripts/harvest_and_ingest.js --source all --since 2026-08-01 --until 2026-08-31 --limit 20
```

---

## 4. Automated Deployment Verification (`audit_cf_deployment.py`)

Runs complete end-to-end acceptance tests against the live Cloudflare Worker deployment (verifies 401 gate, `/health`, all 14 MCP tools, and live vector search):

```bash
python skills/stars-radar/scripts/audit_cf_deployment.py
```
