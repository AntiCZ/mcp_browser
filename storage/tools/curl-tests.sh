#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/.env"
fi

: "${SUPABASE_REST_URL:=http://127.0.0.1:54321}"
: "${SUPABASE_ANON_KEY:=}"
: "${SUPABASE_SERVICE_KEY:=}"

echo "Checking REST service at ${SUPABASE_REST_URL}" >&2
curl -sS "${SUPABASE_REST_URL}/" -H "apikey: ${SUPABASE_ANON_KEY}" | head -c 200 || true
echo -e "\n"

function check_table() {
  local table=$1
  echo "\n=> GET /rest/v1/${table}?limit=1" >&2
  http_code=$(curl -sS -o /dev/null -w "%{http_code}" \
    "${SUPABASE_REST_URL}/rest/v1/${table}?limit=1" \
    -H "apikey: ${SUPABASE_SERVICE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}")
  echo "HTTP ${http_code} (${table})" >&2
}

for t in runs tool_calls artifacts page_signatures element_signatures hints hint_stats; do
  check_table "$t"
done

echo "\nAttempting sample insert into runs (service key)" >&2
resp=$(curl -sS -X POST "${SUPABASE_REST_URL}/rest/v1/runs" \
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  --data '{"status":"running","server_version":"dev","proto_version":"v2"}')
echo "$resp" | jq . || echo "$resp"

