#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/.env"
elif [[ -f "${ROOT_DIR}/.env" ]]; then
  # shellcheck disable=SC1091
  source "${ROOT_DIR}/.env"
fi

: "${DB_HOST:=127.0.0.1}"
: "${DB_PORT:=54322}"
: "${DB_USER:=postgres}"
: "${DB_PASSWORD:=postgres}"
: "${DB_NAME:=postgres}"

export PGPASSWORD="${DB_PASSWORD}"

SQL=$(cat <<'EOSQL'
-- Truncate all telemetry tables but keep schema intact
TRUNCATE TABLE
  artifacts,
  tool_calls,
  hints,
  hint_stats,
  element_signatures,
  page_signatures,
  tabs,
  instances,
  runs,
  sessions,
  dedup_hashes
RESTART IDENTITY CASCADE;
EOSQL
)

echo "Cleaning database contents in ${DB_NAME} (host=${DB_HOST} port=${DB_PORT})" >&2

psql \
  --host="${DB_HOST}" \
  --port="${DB_PORT}" \
  --username="${DB_USER}" \
  --dbname="${DB_NAME}" \
  --set ON_ERROR_STOP=1 \
  --command "${SQL}"

echo "Database cleaned (tables truncated, identities reset)." >&2

