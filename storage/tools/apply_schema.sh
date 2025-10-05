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

echo "Applying schema to postgresql://${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}" >&2

export PGPASSWORD="${DB_PASSWORD}"

psql \
  --host="${DB_HOST}" \
  --port="${DB_PORT}" \
  --username="${DB_USER}" \
  --dbname="${DB_NAME}" \
  --file "${SCRIPT_DIR}/sql/001_init.sql" \
  --set ON_ERROR_STOP=1

echo "Schema applied successfully." >&2

