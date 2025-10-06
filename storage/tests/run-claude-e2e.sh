#!/usr/bin/env bash
set -euo pipefail

PROMPT_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/CLAUDE_MCP_TEST_PROMPT.txt"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "Missing prompt file: $PROMPT_FILE" >&2
  exit 1
fi

echo "[1/4] Cleaning DB (truncate tables)" >&2
"$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tools/clean_db.sh"

echo "[2/4] Running Claude MCP E2E test" >&2
/usr/bin/claude -p "$(cat "$PROMPT_FILE")" \
  --dangerously-skip-permissions \
  --mcp-config "$HOME/.claude/mcp_servers.json"

echo "[3/4] Fetching Supabase summaries" >&2
: "${SUPABASE_REST_URL:=http://127.0.0.1:54321}"
: "${SUPABASE_SERVICE_KEY:?SUPABASE_SERVICE_KEY is required}"

echo "\nRuns (latest):" >&2
curl -sS "$SUPABASE_REST_URL/rest/v1/runs?order=started_at.desc&limit=5" \
  -H "apikey: $SUPABASE_SERVICE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" | jq .

echo "\nTool calls (latest):" >&2
curl -sS "$SUPABASE_REST_URL/rest/v1/tool_calls?select=run_id,seq,tool_name,success,started_at&order=started_at.desc&limit=20" \
  -H "apikey: $SUPABASE_SERVICE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" | jq .

echo "\nArtifacts (latest):" >&2
curl -sS "$SUPABASE_REST_URL/rest/v1/artifacts?order=created_at.desc&limit=5" \
  -H "apikey: $SUPABASE_SERVICE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" | jq .

echo "\n[4/4] Done." >&2

