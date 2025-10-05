Schema Smoke Tests

This folder contains basic tests to verify that:
- The schema exists and PostgREST exposes the tables.
- A simple write via REST works (using the Service Role key locally).

Run:
- storage/tools/apply_schema.sh
- storage/tools/curl-tests.sh

