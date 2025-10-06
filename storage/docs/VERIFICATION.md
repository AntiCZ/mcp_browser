LaskoBOT Storage: E2E Verification Report and Ideal Functioning

Purpose
- Demonstrate that the MCP HTTP server records complete, relevant telemetry in Supabase.
- Define the “ideal run” acceptance criteria and how to re-verify quickly.

Test Harness
- DB cleaner: storage/tools/clean_db.sh
- Claude E2E driver: storage/tests/run-claude-e2e.sh
- Hint aggregator (batch): storage/tools/aggregate_hints.js

Environment
- SUPABASE_REST_URL=http://127.0.0.1:54321
- SUPABASE_SERVICE_KEY=sb_secret_...
- Optional toggle: BROWSER_MCP_STORAGE_ENABLED=1 (default: on if keys set)
- Service: browsermcp-http.service (port 3000)

Procedure
1) Clean DB
   - storage/tools/clean_db.sh
2) Run E2E
   - SUPABASE_SERVICE_KEY=... storage/tests/run-claude-e2e.sh
3) Aggregate hints
   - SUPABASE_SERVICE_KEY=... node storage/tools/aggregate_hints.js
4) Verify in Supabase (samples)
   - Runs: GET /rest/v1/runs?order=started_at.desc&limit=3
   - Tool calls (navigate): select=call_id,tool_name,input_jsonb,url_at_call,page_sig_id
   - Page signatures: GET /rest/v1/page_signatures?order=page_sig_id.desc
   - Artifacts: GET /rest/v1/artifacts?order=created_at.desc
   - Hint stats: GET /rest/v1/hint_stats?scope=eq.page&page_sig_id=eq.<id>

Observed Results (reference)
- Runs: new row with Version 1.30.16, proto v2, status running until session close.
- Tool calls: 30–35 rows for the E2E plan with success flags and input/output JSON.
- Screenshots: artifacts row created with content_hash + storage_path + size_bytes.
- Navigate rows: url_at_call populated (e.g., https://example.com/), page_sig_id set.
- Page signatures: url_norm + domain present; first_seen/last_seen filled.
- Hint stats: page-level row updated via aggregator (success_ct, error_ct, avg_latency, last_success_at).

Ideal Run Checklist (acceptance)
- runs
  - [x] run_id set, instance_id present, version/proto recorded, started_at set
- tool_calls
  - [x] One row per tool invocation with seq, success, timing
  - [x] input_jsonb and output_jsonb present (sanitized as needed)
  - [x] url_at_call populated for navigation
  - [x] page_sig_id set for navigation
- artifacts
  - [x] Screenshot rows with content_hash + storage_path + size_bytes linked to call
- page_signatures
  - [x] url_norm + domain present; timestamps correct
- hint_stats
  - [x] Aggregated row present for the visited page after aggregator run

Notes
- The /hints/lookup endpoint exists (POST /hints/lookup) and returns page_sig_id + a simple page-level hint_stats record if present. In dev setups, REST queries may be more convenient.
- Session FK is enabled; HTTP server ensures sessions are inserted before creating runs.

Troubleshooting
- If no records appear: confirm service env contains SUPABASE_* and storage toggle enabled.
- If navigate url/page_sig is missing: re-run; the server populates from args, snapshot text, or window.location as fallback.

