Tools for Storage Schema

Contents
- sql/001_init.sql: Core Postgres schema for runs, tool_calls, artifacts, signatures, hints.
- apply_schema.sh: Convenience script to apply schema locally via psql.
- curl-tests.sh: REST API sanity checks against PostgREST (port 54321).
- .env.example: Example environment with local Supabase defaults.

Quick Start
1) Ensure local Supabase is running (default ports):
   - DB: postgresql://postgres:postgres@127.0.0.1:54322/postgres
   - API: http://127.0.0.1:54321 (keys in .env.example)
2) Copy .env.example to .env and adjust as needed.
3) Apply schema: ./apply_schema.sh
4) Smoke test REST: ./curl-tests.sh

