#!/usr/bin/env python3
"""📡 Stars Radar CLI: Search your GitHub Stars and explore multi-source community intelligence.

Usage:
    python scripts/search_stars_cli.py <query> [--scope all|starred|rankings] [--category <cat>]
    python scripts/search_stars_cli.py --live <query> [--language rust] [--min-stars 20]
    python scripts/search_stars_cli.py --code "daily-cloudcode-pa" [--language js] [--repo owner/repo]
    python scripts/search_stars_cli.py --web "Cloudflare Workers vector Float32Array"
    python scripts/search_stars_cli.py --star "owner/repo" [--reason "Curator note"]
    python scripts/search_stars_cli.py --since 2026-08-28 [--until 2026-09-04] [--topic agent]
    python scripts/search_stars_cli.py --harvest --source skills --days 30 [--limit 10]
    python scripts/search_stars_cli.py --trending [overall_daily|overall_weekly|rust_weekly|...]
    python scripts/search_stars_cli.py --skills [--limit 20]
"""

import sys
import os
import json
import argparse
import urllib.error
import urllib.request
import urllib.parse

sys.stdout.reconfigure(encoding="utf-8")

WORKER_URL = os.environ.get("WORKER_URL")
# NEVER hardcode a fallback key here. The worker is protected by MCP_API_KEY;
# read it from the environment so the key never lands in source control or logs.
API_KEY = os.environ.get("MCP_API_KEY")
HEADERS = {"User-Agent": "Mozilla/5.0"}

def require_api_config():
    if not WORKER_URL:
        sys.stderr.write("[Stars Radar] ERROR: WORKER_URL environment variable is required.\n")
        sys.stderr.write("  Point it at YOUR OWN deployed Worker, e.g. (PowerShell):\n")
        sys.stderr.write("    $env:WORKER_URL=\"https://stars.example.com\"\n")
        sys.stderr.write("  There is deliberately no default: a built-in default would send your\n")
        sys.stderr.write("  MCP_API_KEY to somebody else's server.\n")
        sys.exit(2)
    if not API_KEY:
        sys.stderr.write("[Stars Radar] ERROR: MCP_API_KEY environment variable is required.\n")
        sys.stderr.write("  Set it before running, e.g. (PowerShell): $env:MCP_API_KEY=\"...\" ; python scripts/search_stars_cli.py ...\n")
        sys.exit(2)

class ApiError(Exception):
    """The Worker answered with a failure envelope, or could not be reached at all.

    Raised rather than returned because "the request failed" and "the answer was empty" must not be
    the same value at a call site: every caller here used to receive `None` for both, then print
    "No repositories found" — so a rate-limited or broken lookup looked exactly like an honest empty
    result, on stdout, while the whole process still exited 0.
    """

def fetch_json(endpoint, params=None):
    """Returns the endpoint's payload, or raises ApiError with the reason it could not be read.

    Every endpoint answers with one envelope — `{"ok": true, "data": …}` or
    `{"ok": false, "error": …, "message": …}` — so the unwrapping happens here and the reporting
    happens once, in main().
    """
    require_api_config()
    if params is None:
        params = {}
    url = f"{WORKER_URL}{endpoint}"
    headers = {**HEADERS, "Authorization": f"Bearer {API_KEY}"}
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # An error answer still carries a body; reporting it beats reporting the status alone.
        try:
            failure = json.loads(e.read().decode("utf-8"))
            raise ApiError(f"{endpoint} failed: {failure.get('error')} — {failure.get('message')}")
        except ApiError:
            raise
        except Exception:
            raise ApiError(f"{endpoint} failed with HTTP {e.code}")
    except ApiError:
        raise
    except Exception as e:
        raise ApiError(f"{endpoint} could not be reached: {e}")

    if not payload.get("ok"):
        raise ApiError(f"{endpoint} failed: {payload.get('error')} — {payload.get('message')}")
    return payload.get("data")

def show_live_search(query, language=None, min_stars=15, sort="stars", since=None, until=None, limit=10, persist=False):
    params = {"q": query, "limit": limit, "min_stars": min_stars, "sort": sort}
    if language:
        params["language"] = language
    if since:
        params["since"] = since
    if until:
        params["until"] = until
    if persist:
        params["persist"] = "1"

    data = fetch_json("/api/live", params)
    if not data or not data.get("repos"):
        print(f"No repositories found matching \"{query}\".")
        return

    repos = data.get("repos", [])
    print(f"\n🌐 Live GitHub Repository Search for: \"{query}\" ({len(repos)} hits)\n" + "=" * 70)
    for i, r in enumerate(repos, 1):
        stars = f"⭐ {r.get('stars', 0):,}"
        lang = f"  [{r.get('language')}]" if r.get('language') else ""
        badge = f"  [{r.get('badge')}]"
        print(f"[{i}] {r.get('repo')} {stars}{lang}{badge}")
        if r.get("user_reason"):
            print(f"    💡 Curator Note: {r.get('user_reason')}")
        if r.get("description"):
            print(f"    📝 {r.get('description')[:120]}")
        print(f"    🔗 {r.get('url')}\n")

def show_code_search(query, repo=None, language=None, extension=None, path=None, limit=5):
    params = {"q": query, "limit": limit}
    if repo:
        params["repo"] = repo
    if language:
        params["language"] = language
    if extension:
        params["extension"] = extension
    if path:
        params["path"] = path

    data = fetch_json("/api/code", params)
    if not data:
        print("Code search request failed.")
        return

    if data.get("error"):
        print(f"⚠️  Code Search Warning: {data.get('message')}")
        return

    matches = data.get("matches", [])
    if not matches:
        print(f"No code snippets found matching \"{query}\".")
        return

    print(f"\n💻 Live GitHub Code Search for: \"{query}\" ({len(matches)} matches)\n" + "=" * 70)
    for i, m in enumerate(matches, 1):
        print(f"[{i}] {m.get('repo')} ➡️  {m.get('path')}")
        print(f"    🔗 {m.get('url')}")
        snippet = m.get("snippet", "").strip()
        if snippet:
            print("    " + "\n    ".join(snippet.splitlines()[:12]))
        print()

def show_web_search(query, domain=None, freshness="all", limit=5):
    params = {"q": query, "limit": limit, "freshness": freshness}
    if domain:
        params["domain"] = domain

    data = fetch_json("/api/web", params)
    if not data:
        print("Web search request failed.")
        return

    provider = data.get("provider", "unknown")
    results = data.get("results", [])
    if not results:
        msg = data.get("message") or f"No web results found for \"{query}\"."
        print(f"ℹ️  Web Search: {msg}")
        return

    print(f"\n🔍 Technical Web Search [{provider}] for: \"{query}\" ({len(results)} hits)\n" + "=" * 70)
    for i, r in enumerate(results, 1):
        print(f"[{i}] {r.get('title')}")
        print(f"    🔗 {r.get('url')}")
        if r.get("snippet"):
            print(f"    📝 {r.get('snippet')[:140]}")
        print()

def execute_star(repo, reason=None, categories=None):
    require_api_config()
    clean_repo = repo.strip().replace("https://github.com/", "")
    body = json.dumps({
        "repo": clean_repo,
        "reason": reason or f"Starred via Stars Radar CLI",
        "categories": categories or []
    }).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}",
        **HEADERS
    }
    req = urllib.request.Request(
        f"{WORKER_URL}/api/ingest",
        data=body,
        headers=headers
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            failure = json.loads(e.read().decode("utf-8"))
            raise ApiError(f"/api/ingest failed: {failure.get('error')} — {failure.get('message')}")
        except ApiError:
            raise
        except Exception:
            raise ApiError(f"/api/ingest failed with HTTP {e.code}")
    except ApiError:
        raise
    except Exception as e:
        raise ApiError(f"/api/ingest could not be reached: {e}")

    result = data.get("data") or {}
    if result.get("success"):
        print(f"\n✨ Success! Starred and Staged: {clean_repo}")
        print(f"   Badge: {result.get('badge')}")
        print(f"   Stars: {result.get('details', {}).get('stars', 0):,}")
        print(f"   URL:   {result.get('details', {}).get('url')}")
        print(f"   Note:  {result.get('message')}\n")
        return
    raise ApiError(f"Could not stage {clean_repo}: {json.dumps(result)}")

def show_by_date(since, until=None, query=None, language=None, min_stars=20, limit=15):
    params = {"since": since, "limit": limit, "min_stars": min_stars}
    if until:
        params["until"] = until
    if query:
        params["q"] = query
    if language:
        params["language"] = language

    data = fetch_json("/api/live", params)
    if not data or not data.get("repos"):
        print(f"No repositories found for date window [{since}..{until or 'now'}].")
        return

    date_range = data.get("date_range", since)
    repos = data.get("repos", [])
    q_info = f" | Filter: \"{query}\"" if query else ""
    l_info = f" | Lang: {language}" if language else ""

    print(f"\n🚀 Breakout & Rising Repos [{date_range}]{q_info}{l_info} (Found {len(repos)})\n" + "=" * 70)
    for i, r in enumerate(repos[:limit], 1):
        stars = f"⭐ {r.get('stars', 0):,}"
        lang = f"  [{r.get('language')}]" if r.get('language') else ""
        badge = f"  [{r.get('badge')}]"
        created = f"  (Created: {r.get('created_at', '')[:10]})" if r.get("created_at") else ""

        print(f"[{i}] {r.get('repo')} {stars}{lang}{badge}{created}")
        if r.get("user_reason"):
            print(f"    💡 Curator Note: {r.get('user_reason')}")
        if r.get("description"):
            print(f"    📝 {r.get('description')[:120]}")
        print(f"    🔗 {r.get('url')}\n")

def show_trending(category, limit):
    data = fetch_json("/api/trending", {"category": category})
    if not data:
        print("No trending data available.")
        return
    print(f"\n📈 GitHub Trending [{category}] (Top {min(len(data), limit)})\n" + "=" * 70)
    for i, r in enumerate(data[:limit], 1):
        gain = f"  ({r.get('starsGain')})" if r.get('starsGain') else ""
        lang = f"  [{r.get('language')}]" if r.get('language') else ""
        stars = f"⭐ {r.get('stars', 0):,}" if r.get('stars') else ""
        badge = f"  [{r.get('badge')}]" if r.get('badge') else ""
        print(f"[{i}] {r.get('repo')} {stars}{lang}{gain}{badge}")
        if r.get('description'):
            print(f"    📝 {r.get('description')}")
        print(f"    🔗 {r.get('url')}\n")

def show_skills(limit, skill_type="skills"):
    endpoint = "/api/skills"
    params = {"limit": limit}
    if skill_type == "repos":
        params["type"] = "repos"

    data = fetch_json(endpoint, params)
    if not data:
        print("No skills data available.")
        return

    if skill_type == "repos":
        print(f"\n⚡ Top Agent Skill Open-Source Repos (Born in Past 60 Days) (Top {len(data)})\n" + "=" * 70)
        for i, r in enumerate(data, 1):
            stars = f"⭐ {r.get('stars', 0):,}"
            lang = f"  [{r.get('language')}]" if r.get('language') else ""
            print(f"[{i}] {r.get('repo')} {stars}{lang}")
            if r.get('description'):
                print(f"    📝 {r.get('description')[:120]}")
            print(f"    🔗 {r.get('url')}\n")
    else:
        print(f"\n⚡ Top Agent Skills Leaderboard (Top {len(data)})\n" + "=" * 70)
        for s in data:
            installs = f"  |  ⬇️ {s['installs']:,} installs" if s.get('installs') else ""
            desc = s.get('description_zh') or s.get('description') or ""
            tags = f"  [{', '.join(s.get('tags', []))}]" if s.get('tags') else ""
            print(f"#{s.get('rank')} {s.get('skill')} ({s.get('vendor') or 'Community'}){installs}{tags}")
            if desc:
                print(f"    📝 {desc[:120]}")
            if s.get('url'):
                print(f"    🔗 {s.get('url')}\n")

def show_hellogithub(category, limit):
    require_api_config()
    body = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "get_hellogithub_picks",
            "arguments": {"category": category, "limit": limit}
        }
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{WORKER_URL}/mcp",
        data=body,
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "User-Agent": "Mozilla/5.0"}
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            for line in resp.read().decode("utf-8", errors="replace").splitlines():
                if line.startswith("data: "):
                    res = json.loads(line[6:])
                    data = json.loads(res["result"]["content"][0]["text"])
                    picks = data.get("picks", [])
                    print(f"\n📖 HelloGitHub Curated Picks ({len(picks)})\n" + "=" * 70)
                    for i, p in enumerate(picks, 1):
                        print(f"[{i}] {p.get('name')} [{p.get('category')}] ({p.get('issue')})")
                        print(f"    📝 {p.get('description_zh')}")
                        print(f"    🔗 {p.get('url')}\n")
                    return
    except Exception as e:
        print(f"HelloGitHub request failed: {e}")

def main():
    parser = argparse.ArgumentParser(description="📡 Stars Radar CLI: Search your GitHub Stars and explore multi-source community intelligence")
    parser.add_argument("query", nargs="?", help="Search keyword or query")
    parser.add_argument("--scope", "-s", choices=["starred", "all", "rankings"], default="all", help="Search scope (default: all)")
    parser.add_argument("--category", "-c", help="Filter by category")
    parser.add_argument("--limit", "-l", type=int, default=8, help="Number of results to display")
    parser.add_argument("--trending", "-t", nargs="?", const="overall_daily", help="Show trending repos (overall_daily, overall_weekly, rust_weekly, etc.)")
    parser.add_argument("--skills", action="store_true", help="Show top Agent Skills leaderboard")
    parser.add_argument("--skill-repos", action="store_true", help="Show top open-source Agent Skill repos born in past 60 days")
    parser.add_argument("--hellogithub", action="store_true", help="Show HelloGitHub monthly curated picks")
    parser.add_argument("--harvest", action="store_true", help="Harvest repository metadata; CI builds vectors in the next run")
    parser.add_argument("--source", choices=["all", "skills", "breakout"], default="all", help="Community source to harvest (default: all)")

    # Level 3 Active Probes
    parser.add_argument("--live", "-L", nargs="?", const="", help="Search live GitHub repositories globally beyond local stars")
    parser.add_argument("--code", "-C", help="Search real-world open-source code snippets and implementations on GitHub")
    parser.add_argument("--web", "-W", help="Search technical web documentation, blogs, and forums")
    parser.add_argument("--star", help="One-click star a repository on GitHub and stage it into Stars Radar")
    parser.add_argument("--reason", help="Optional curator note when starring a repo")
    parser.add_argument("--repo", help="Target repository for code search (owner/repo)")
    parser.add_argument("--ext", help="Target file extension for code search (without dot)")
    parser.add_argument("--path", help="Target path filter for code search")

    # Date-based intelligence queries
    parser.add_argument("--since", help="Start date (YYYY-MM-DD or 7d, 14d, 30d)")
    parser.add_argument("--until", help="End date (YYYY-MM-DD, defaults to today)")
    parser.add_argument("--days", type=int, help="Relative days window (e.g. --days 7 for past week)")
    parser.add_argument("--topic", help="Topic or keyword filter for date-based retrieval")
    parser.add_argument("--language", "--lang", help="Programming language filter for date-based retrieval")
    parser.add_argument("--min-stars", type=int, default=15, help="Minimum stars threshold for live search (default: 15)")
    parser.add_argument("--persist", action="store_true", help="Capture qualifying live discoveries into the asset database (probes JSONL for CI accumulation)")

    args = parser.parse_args()

    # Priority 0: Star and Ingest
    if args.star:
        execute_star(args.star, args.reason)
        return 0

    # Priority 1: GitHub Code Search
    if args.code:
        show_code_search(
            query=args.code,
            repo=args.repo,
            language=args.language,
            extension=args.ext,
            path=args.path,
            limit=args.limit
        )
        return 0

    # Priority 2: Technical Web Search
    if args.web:
        show_web_search(
            query=args.web,
            limit=args.limit
        )
        return 0

    # Priority 3: Live GitHub Repository Search
    if args.live is not None:
        live_q = args.live or args.query or ""
        show_live_search(
            query=live_q,
            language=args.language,
            min_stars=args.min_stars,
            since=args.since or (f"{args.days}d" if args.days else None),
            until=args.until,
            limit=args.limit,
            persist=args.persist
        )
        return 0

    # Priority 4: Harvest specified date/source and queue vector generation in CI
    if args.harvest:
        import subprocess
        since_val = f"{args.days}d" if args.days else (args.since or "14d")
        # Resolve relative to THIS file so the command works from any working
        # directory and never depends on the checkout's folder name.
        script_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "harvest_and_ingest.js")
        if not os.path.exists(script_path):
            sys.stderr.write(f"[Stars Radar] ERROR: cannot find {script_path}; run --harvest from a full checkout.\n")
            return 2

        cmd = [
            "node",
            script_path,
            "--source", args.source,
            "--since", since_val,
            "--limit", str(args.limit)
        ]
        if args.until:
            cmd.extend(["--until", args.until])
        if args.topic or args.query:
            cmd.extend(["--topic", args.topic or args.query])
        if args.language:
            cmd.extend(["--language", args.language])

        # The node harvest appends metadata to the R2 ingest journal and fails loudly if it
        # cannot, so propagate its exit code instead of reporting success.
        return subprocess.run(cmd).returncode

    # Priority 5: Date Window Query
    if args.since or args.days:
        since_val = f"{args.days}d" if args.days else args.since
        show_by_date(
            since=since_val,
            until=args.until,
            query=args.topic or args.query,
            language=args.language,
            min_stars=args.min_stars,
            limit=args.limit
        )
        return 0

    if args.trending:
        show_trending(args.trending, args.limit)
        return 0

    if args.skills or args.skill_repos:
        show_skills(args.limit, skill_type="repos" if args.skill_repos else "skills")
        return 0

    if args.hellogithub:
        show_hellogithub(args.category or "", args.limit)
        return 0

    if not args.query:
        parser.print_help()
        return 0

    params = {
        "q": args.query,
        "scope": args.scope,
        "limit": args.limit,
    }
    if args.category:
        params["category"] = args.category

    results = fetch_json("/api/search", params)
    if not results:
        print(f"No repositories found matching \"{args.query}\".")
        return 0

    print(f"\n🔍 Search results for: \"{args.query}\" [Scope: {args.scope}] ({len(results)} hits)\n" + "=" * 70)
    for i, r in enumerate(results, 1):
        repo = r.get("repo")
        stars = f"⭐ {r.get('stars'):,}" if r.get('stars') is not None else ""
        badge = r.get("source_badge") or ("⭐ Starred" if r.get("source") == "starred" else "🌐 Public")
        cats = ", ".join(r.get("categories", []))
        reason = r.get("reason")
        desc = r.get("description") or ""
        url = r.get("url")

        print(f"[{i}] {repo} {stars}  [{badge}]")
        if cats:
            print(f"    🏷️  Category: {cats}")
        if reason:
            print(f"    💡 Reason: {reason}")
        elif desc:
            print(f"    📝 Desc: {desc[:100]}")
        print(f"    🔗 {url}\n")

    return 0

if __name__ == "__main__":
    # A failed lookup is reported once, on stderr, and exits non-zero: any script or CI job that
    # runs this CLI can then tell "the search failed" from "the search found nothing", which it
    # could not do while every branch returned 0.
    try:
        sys.exit(main())
    except ApiError as error:
        sys.stderr.write(f"[Stars Radar] {error}\n")
        sys.exit(1)
