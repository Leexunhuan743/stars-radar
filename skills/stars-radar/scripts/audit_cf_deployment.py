#!/usr/bin/env python3
"""Cloudflare Workers & R2 Production Deployment Acceptance Verification.

Tests authentication gate, health probe, MCP protocol (14 tools), and live
tool invocations against the deployed Stars Radar instance.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

BASE_URL = os.environ.get("WORKER_URL", "").rstrip("/")
AUTH_TOKEN = os.environ.get("MCP_API_KEY", "")

if not BASE_URL:
    sys.stderr.write("[Stars Radar] ERROR: WORKER_URL environment variable is required.\n")
    sys.stderr.write("  Point it at the deployment you want to verify, e.g.:\n")
    sys.stderr.write("    $env:WORKER_URL=\"https://stars.example.com\"\n")
    sys.stderr.write("  There is deliberately no default: these tests send your MCP_API_KEY\n")
    sys.stderr.write("  and would otherwise verify somebody else's deployment.\n")
    sys.exit(2)

HEADERS_AUTH = {
    "Authorization": f"Bearer {AUTH_TOKEN}",
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) StarsRadarAuditor/1.0",
}


def check_unauthorized():
    print("[Test 1] Security: Unauthorized Access Test (Expecting HTTP 401)...")
    req = urllib.request.Request(
        f"{BASE_URL}/health", headers={"User-Agent": "Mozilla/5.0"}
    )
    try:
        urllib.request.urlopen(req)
        print("  ❌ FAILED: Health endpoint accepted unauthenticated request!")
        return False
    except urllib.error.HTTPError as e:
        if e.code == 401:
            print("  ✅ PASSED: Rejected unauthenticated request with HTTP 401 Unauthorized.")
            return True
        print(f"  ❌ FAILED: Unexpected HTTP status {e.code}")
        return False


def check_health():
    print("\n[Test 2] Health Endpoint (/health)...")
    req = urllib.request.Request(f"{BASE_URL}/health", headers=HEADERS_AUTH)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            payload = json.load(resp)
            # Every endpoint answers with the same envelope: {"ok": true, "data": ...}.
            if not payload.get("ok"):
                print(f"  ❌ FAILED: {payload.get('error')} — {payload.get('message')}")
                return None
            data = payload["data"]
            print(f"  ✅ PASSED (HTTP 200 in {resp.status}):")
            print(f"    • Status: {data.get('status')}")
            print(f"    • Total Starred Repos: {data.get('totalStarred')}")
            print(f"    • Vector Model: {data.get('vectorModel')} ({data.get('vectorDimensions')}D)")
            print(f"    • Data plane: {data.get('dataPlane')}")
            return data
    except Exception as e:
        print(f"  ❌ FAILED health check: {e}")
        return None


def call_mcp(method, params=None):
    body = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params:
        body["params"] = params

    data_bytes = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}/mcp", data=data_bytes, headers=HEADERS_AUTH
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            elapsed = (time.time() - t0) * 1000
            for line in resp.read().decode("utf-8").splitlines():
                if line.startswith("data: "):
                    return json.loads(line[6:]), elapsed
    except Exception as e:
        print(f"  ❌ Error calling MCP {method}: {e}")
        return None, 0
    return None, 0


def check_mcp_tools():
    print("\n[Test 3] MCP Protocol: tools/list Verification...")
    res, elapsed = call_mcp("tools/list")
    if not res or "result" not in res:
        print(f"  ❌ FAILED to get tools list: {res}")
        return False
    tools = res["result"].get("tools", [])
    print(f"  ✅ Received {len(tools)} tools in {elapsed:.1f}ms:")
    tool_names = [t["name"] for t in tools]
    print(f"  • Tools: {', '.join(tool_names)}")
    expected_count = 14
    if len(tools) == expected_count:
        print(f"  ✅ PASSED: Exact tool count matches {expected_count}.")
    else:
        print(f"  ⚠️ Warning: Expected {expected_count} tools, found {len(tools)}")
    return tool_names


def test_tool_calls():
    print("\n[Test 4] Live MCP Tool Invocations...")
    ok = True

    # 4.1 search_github_stars
    print("  Testing 4.1: search_github_stars (18-domain ontology + BGE-M3)...")
    res, elapsed = call_mcp(
        "tools/call",
        {
            "name": "search_github_stars",
            "arguments": {"query": "React 前端组件库", "limit": 2},
        },
    )
    if res and "result" in res:
        text = res["result"]["content"][0]["text"]
        hits = json.loads(text)
        print(f"    • search_github_stars completed in {elapsed:.1f}ms, returned {len(hits)} hits:")
        for h in hits:
            print(f"      - {h.get('repo')} | score: {h.get('relevance_score')} | {h.get('description', '')[:50]}...")
    else:
        print(f"    ❌ search_github_stars returned no result: {res}")
        ok = False

    # 4.2 get_radar_status
    print("  Testing 4.2: get_radar_status...")
    res, elapsed = call_mcp(
        "tools/call", {"name": "get_radar_status", "arguments": {}}
    )
    if res and "result" in res:
        text = res["result"]["content"][0]["text"]
        status_data = json.loads(text)
        print(f"    • get_radar_status completed in {elapsed:.1f}ms:")
        print(f"      - Total starred: {status_data.get('total_starred')}")
        print(f"      - Vector DB capacity: {status_data.get('vector_db_capacity')}")
        print(f"      - Intent domains: {status_data.get('intent_domains')}")
    else:
        print(f"    ❌ get_radar_status returned no result: {res}")
        ok = False

    # 4.3 get_top_skills
    print("  Testing 4.3: get_top_skills...")
    res, elapsed = call_mcp(
        "tools/call", {"name": "get_top_skills", "arguments": {"limit": 2}}
    )
    if res and "result" in res:
        text = res["result"]["content"][0]["text"]
        skills_resp = json.loads(text)
        skills = skills_resp.get("result", {})
        top_s = skills.get("top_skills", []) if isinstance(skills, dict) else skills
        print(f"    • get_top_skills completed in {elapsed:.1f}ms, returned items:")
        for s in (top_s or [])[:2]:
            s_name = s.get("skill") or s.get("repo") or s.get("name")
            print(f"      - {s_name}: {(s.get('description_zh') or s.get('description') or '')[:50]}...")
    else:
        print(f"    ❌ get_top_skills returned no result: {res}")
        ok = False

    # 4.4 get_trending_repos
    print("  Testing 4.4: get_trending_repos...")
    res, elapsed = call_mcp(
        "tools/call",
        {
            "name": "get_trending_repos",
            "arguments": {"category": "overall_daily", "limit": 2},
        },
    )
    if res and "result" in res:
        text = res["result"]["content"][0]["text"]
        trending_data = json.loads(text)
        repos = trending_data.get("repos", [])
        print(f"    • get_trending_repos completed in {elapsed:.1f}ms, returned {len(repos)} repos:")
        for tr in repos:
            print(f"      - {tr.get('repo')}: {(tr.get('description') or '')[:50]}...")
    else:
        print(f"    ❌ get_trending_repos returned no result: {res}")
        ok = False

    return ok


def main():
    print("==================================================================")
    print("  Cloudflare Workers & R2 Production Deployment Verification     ")
    print(f"  Target: {BASE_URL}")
    print(f"  Key:    {'[SET]' if AUTH_TOKEN else '[NOT SET]'}")
    print("==================================================================")

    # Every check's outcome is collected and turned into an exit code at the end. Printing a ❌ and
    # exiting 0 made this look like an acceptance *report* rather than an acceptance *gate*: nothing
    # running it could tell a passed deployment from a broken one.
    results = {"unauthorized gate": check_unauthorized()}
    if not AUTH_TOKEN:
        print("\n❌ MCP_API_KEY is not set, so the authenticated checks could not run.")
        print("  Set it and re-run: export MCP_API_KEY=\"...\"")
        return 1

    results["health"] = bool(check_health())
    results["tools/list"] = bool(check_mcp_tools())
    results["tool calls"] = test_tool_calls()

    failed = [name for name, passed in results.items() if not passed]
    print("\n==================================================================")
    if failed:
        print(f"  {len(failed)} of {len(results)} checks FAILED: {', '.join(failed)}")
        print("==================================================================")
        return 1
    print(f"  All {len(results)} deployment acceptance checks passed.")
    print("==================================================================")
    return 0


if __name__ == "__main__":
    sys.exit(main())
