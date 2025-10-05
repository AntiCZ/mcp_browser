LaskoBOT “Database of Runs” — Comprehensive Design

Summary
- Purpose: Persist all automation telemetry (runs, tool calls, routing context, artifacts) in Supabase and produce low‑latency “hints” that make subsequent runs smarter for the same domains/pages/elements.
- Scope: Schema (Postgres), Storage (artifacts), ingestion strategy, hint generation lifecycle, retrieval API, privacy/cost/ops guardrails, and developer operations.

High‑Level Architecture
- Write path
  - HTTP MCP server middleware wraps every tool call; records routing context (sessionId, instanceId, extension, tabId) and inputs/outputs; uploads large artifacts to Supabase Storage.
  - WS daemon emits navigation/tab/DOM events to the same ingestion endpoint.
  - Browser extensions add client‑side event UUIDs, content hashes, and optional page/element signatures.
- Read path
  - During a tool call, compute/lookup page signature; fetch page‑ and element‑level hints from Postgres (or Redis cache) keyed by URL/domain/structure; merge into tool logic.
- Batch path
  - Scheduled process aggregates historical tool_calls into hints and stats; writes compact JSON hints and heavier hint blobs to Storage; versioned for auditing/rollbacks.

Core Data Model (Postgres)
- runs: Tracks a single automation run.
  - run_id (uuid, PK, default gen_random_uuid())
  - session_id (uuid or text)
  - instance_id (text)
  - status (text: running|completed|failed|partial)
  - root_request_id (text)
  - started_at (timestamptz, default now())
  - ended_at (timestamptz)
  - server_version (text)
  - proto_version (text)
- sessions: Lifecycle across one or more runs.
  - session_id (uuid or text, PK)
  - user_hash (text, PII‑safe)
  - started_at / ended_at (timestamptz)
  - ttl_expires_at (timestamptz)
- instances: Specific agent/extension instance per session.
  - instance_id (text, PK)
  - session_id → sessions
  - extension (text: chrome|firefox)
  - extension_version (text)
  - created_at (timestamptz default now())
- tabs: Browser tab association.
  - tab_id (bigint or text; PK)
  - instance_id → instances
  - url_first_seen (text)
  - viewport_w, viewport_h (int), dpr (numeric)
  - closed_at (timestamptz)
- page_signatures: Deduped page states.
  - page_sig_id (bigserial PK)
  - url_norm (text)
  - domain (text)
  - canonical_link_hash (text)
  - title_hash (text)
  - dom_fingerprint_hash (text)
  - first_seen / last_seen (timestamptz)
- element_signatures: Deduped element identities.
  - elem_sig_id (bigserial PK)
  - page_sig_id → page_signatures
  - selector_norm (text)
  - role (text)
  - text_hash (text)
  - attr_fingerprint_hash (text)
  - first_seen / last_seen (timestamptz)
- tool_calls: Every tool invocation.
  - call_id (uuid PK default gen_random_uuid())
  - run_id → runs, seq (int), event_uuid (uuid) UNIQUE with run
  - tool_name (text), started_at, ended_at, latency_ms (int generated)
  - success (bool), error_msg (text)
  - input_jsonb, output_jsonb (jsonb; sanitized)
  - instance_id, session_id, tab_id (context)
  - url_at_call (text)
  - page_sig_id → page_signatures, elem_sig_id → element_signatures
- artifacts: Metadata for large blobs stored in Storage.
  - artifact_id (uuid PK default gen_random_uuid())
  - call_id → tool_calls
  - type (text: screenshot|dom|har|logs|scaffold)
  - content_hash (text), size_bytes (bigint)
  - storage_path (text), created_at (timestamptz default now())
- hints: Precomputed intelligence for fast retrieval.
  - id (bigserial PK)
  - page_sig_id, elem_sig_id (nullable)
  - hint_type (text: best_selector|wait_condition|recipe|safe_ops)
  - hint_data (jsonb), confidence (numeric), version (int)
  - hint_blob_path (text), last_calculated_at (timestamptz)
- hint_stats: Aggregates for observability and tie‑breakers.
  - id (bigserial PK)
  - scope (text: page|element)
  - success_ct (int), error_ct (int), avg_latency (numeric)
  - last_success_at (timestamptz), updated_at (timestamptz)
- dedup_hashes: Artifact dedup guard.
  - content_hash (text PK), first_seen_at (timestamptz default now())

Indexes & Performance
- GIN on tool_calls.input_jsonb and tool_calls.output_jsonb.
- page_signatures: (url_norm), (domain, title_hash) btree.
- element_signatures: (selector_norm, role) btree.
- tool_calls: unique (run_id, seq), unique (run_id, event_uuid).
- Partition tool_calls by month on started_at for very large datasets.

Storage (Supabase Storage)
- Private buckets: screenshots/, dom/, scaffolds/, logs/.
- Object keys: project/{type}/{sha256}.{ext}; set correct content‑type; enable lifecycle rules for cost control.

Ingestion Strategy
- HTTP MCP middleware
  - Generates/propagates run_id, seq, event_uuid; wraps tool calls and writes tool_calls.
  - Uploads blobs first; writes artifacts rows with content_hash and storage_path.
  - Computes page/element signatures and upserts signature rows.
- WS daemon
  - Emits navigation/focus/errors with instance_id/tab_id/session_id/url and optional DOM fingerprints.
  - Posts to ingestion endpoint with idempotent keys.
- Extensions
  - Produce event_uuid per event; compute content_hash; upload blobs; include hash references in telemetry. Optional client‑side redaction.

Hint Generation & Retrieval
- Batch (5–15 min)
  - Aggregate tool_calls → success_ct/error_ct/avg_latency/last_success_at by page_sig and elem_sig.
  - Choose best selectors (data-testid > aria > role+text > css; penalize dynamic indices).
  - Produce wait conditions, scroll recipes, and safe‑ops; upsert hints; write large artifacts to Storage with versioned paths.
- Online (<10 ms target)
  - For each active tool call: compute page_sig; fetch page‑level hints and top‑K element‑level hints via indexed queries.
  - Optional Redis cache: key hint:{project}:{page_sig}:{elem_sig} with 1h TTL.

Privacy, Security, Cost
- Client‑side scrubbing of PII; field‑level truncation and hashing of long innerText.
- RLS with project_id (enable later if multi‑tenant); permissive local policies for dev.
- Storage lifecycle: delete failed artifacts after 7 days; 30–90 days hot data; archive beyond.
- Dedup artifacts by content_hash; compress (webp/png, brotli for DOM).

Operational Guidance
- Schema migration via psql or Supabase Studio SQL; tools/apply_schema.sh included with sane defaults for local Supabase.
- Monitoring: ingestion error rates, REST latency, batch job duration, hint hit‑rate.
- Backfills: write to staging, then upsert into prod with ON CONFLICT.

API Surfaces (for internal services)
- Ingestion: POST /internal/ingest/tool_call (server‑side only)
  - Payload: context {run_id, session_id, instance_id, tab_id, url}, tool_name, seq, event_uuid, started_at, ended_at, input_json, output_json, success, artifacts[{type, content_hash, storage_path, size}], page_signature, element_signatures[]
- Hint lookup: POST /hints/lookup
  - Request: {url, title, dom_top_signature?, candidate_elements?}
  - Response: {page_hints[], element_hints[], trace?}

Page & Element Signatures
- Page
  - url_norm: scheme+host+path normalized (lowercase; strip query/fragment; optional path templating :id)
  - title_hash: normalized document.title hash
  - dom_fingerprint_hash: hash of compact top‑of‑body tag+key‑attr sequence
- Element
  - Composite normalized signature: data‑test‑id, aria‑label/role+name, id, text hash, CSS path (stable forms). Store best selector as selector_norm and alternatives within hint_data.

Local Development (Supabase)
- Services (default ports):
  - Studio UI: http://127.0.0.1:54323/project/default
  - REST API: http://127.0.0.1:54321
  - Mailpit: http://127.0.0.1:54324
  - DB: postgresql://postgres:postgres@127.0.0.1:54322/postgres
- Keys (local dev):
  - Anon/Public: sb_publishable_…
  - Service Role: sb_secret_…

Applying the Schema
- Option A (CLI): storage/tools/apply_schema.sh (uses psql)
- Option B (Studio): Paste SQL from storage/tools/sql/001_init.sql into the SQL editor and run.

Smoke Tests
- storage/tests/smoke.sh: Verifies REST endpoints for core tables and performs a sample insert/select using Service Role.

Next Steps (Code Integration)
- Instrument HTTP MCP middleware and WS daemon to emit telemetry.
- Add extensions’ client‑side event UUID, content hashing, and optional signature calculations.
- Implement batch hint aggregator (Edge Function/pg_cron) and /hints/lookup with Redis cache.

