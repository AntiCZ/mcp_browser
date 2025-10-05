-- LaskoBOT Storage Schema (v0)
-- Requires: pgcrypto for gen_random_uuid()

create extension if not exists pgcrypto;

-- Sessions
create table if not exists sessions (
  session_id text primary key,
  user_hash text,
  started_at timestamptz default now(),
  ended_at timestamptz,
  ttl_expires_at timestamptz
);

-- Runs
create table if not exists runs (
  run_id uuid primary key default gen_random_uuid(),
  session_id text references sessions(session_id) on delete set null,
  instance_id text,
  root_request_id text,
  status text check (status in ('running','completed','failed','partial')),
  server_version text,
  proto_version text,
  started_at timestamptz default now(),
  ended_at timestamptz
);

-- Instances
create table if not exists instances (
  instance_id text primary key,
  session_id text references sessions(session_id) on delete set null,
  extension text check (extension in ('chrome','firefox')),
  extension_version text,
  created_at timestamptz default now()
);

-- Tabs
create table if not exists tabs (
  tab_id text primary key,
  instance_id text references instances(instance_id) on delete cascade,
  url_first_seen text,
  viewport_w int,
  viewport_h int,
  dpr numeric,
  closed_at timestamptz
);

-- Page Signatures
create table if not exists page_signatures (
  page_sig_id bigserial primary key,
  url_norm text not null,
  domain text not null,
  canonical_link_hash text,
  title_hash text,
  dom_fingerprint_hash text,
  first_seen timestamptz default now(),
  last_seen timestamptz default now()
);
create index if not exists idx_page_sig_url_norm on page_signatures(url_norm);
create index if not exists idx_page_sig_domain_title on page_signatures(domain, title_hash);

-- Element Signatures
create table if not exists element_signatures (
  elem_sig_id bigserial primary key,
  page_sig_id bigint references page_signatures(page_sig_id) on delete cascade,
  selector_norm text,
  role text,
  text_hash text,
  attr_fingerprint_hash text,
  first_seen timestamptz default now(),
  last_seen timestamptz default now()
);
create index if not exists idx_elem_sig_selector_role on element_signatures(selector_norm, role);

-- Tool Calls
create table if not exists tool_calls (
  call_id uuid primary key default gen_random_uuid(),
  run_id uuid references runs(run_id) on delete cascade,
  seq int not null default 0,
  event_uuid uuid,
  tool_name text not null,
  started_at timestamptz default now(),
  ended_at timestamptz,
  latency_ms int,
  success boolean,
  error_msg text,
  input_jsonb jsonb,
  output_jsonb jsonb,
  instance_id text,
  session_id text,
  tab_id text,
  url_at_call text,
  page_sig_id bigint references page_signatures(page_sig_id) on delete set null,
  elem_sig_id bigint references element_signatures(elem_sig_id) on delete set null
);
create unique index if not exists idx_tool_calls_run_seq on tool_calls(run_id, seq);
create unique index if not exists idx_tool_calls_event_uuid on tool_calls(run_id, event_uuid) where event_uuid is not null;
create index if not exists idx_tool_calls_input_jsonb on tool_calls using gin (input_jsonb);
create index if not exists idx_tool_calls_output_jsonb on tool_calls using gin (output_jsonb);

-- Artifacts
create table if not exists artifacts (
  artifact_id uuid primary key default gen_random_uuid(),
  call_id uuid references tool_calls(call_id) on delete cascade,
  type text check (type in ('screenshot','dom','har','logs','scaffold')) not null,
  content_hash text not null,
  size_bytes bigint,
  storage_path text not null,
  created_at timestamptz default now()
);
create index if not exists idx_artifacts_call on artifacts(call_id);
create unique index if not exists idx_artifacts_content_hash on artifacts(content_hash);

-- Dedup Hashes
create table if not exists dedup_hashes (
  content_hash text primary key,
  first_seen_at timestamptz default now()
);

-- Hints
create table if not exists hints (
  id bigserial primary key,
  page_sig_id bigint references page_signatures(page_sig_id) on delete cascade,
  elem_sig_id bigint references element_signatures(elem_sig_id) on delete cascade,
  hint_type text not null,
  hint_data jsonb not null,
  confidence numeric,
  version int default 1,
  hint_blob_path text,
  last_calculated_at timestamptz default now()
);
create index if not exists idx_hints_page_elem on hints(page_sig_id, elem_sig_id);
create index if not exists idx_hints_type on hints(hint_type);

-- Hint Stats
create table if not exists hint_stats (
  id bigserial primary key,
  scope text check (scope in ('page','element')) not null,
  page_sig_id bigint references page_signatures(page_sig_id) on delete cascade,
  elem_sig_id bigint references element_signatures(elem_sig_id) on delete cascade,
  success_ct int default 0,
  error_ct int default 0,
  avg_latency numeric,
  last_success_at timestamptz,
  updated_at timestamptz default now()
);
create index if not exists idx_hint_stats_scope_page on hint_stats(scope, page_sig_id);

-- Grants & RLS (dev‑friendly: open policies; tighten for prod)
do $$ begin
  perform 1;
exception when others then null; end $$;

alter table sessions enable row level security;
alter table runs enable row level security;
alter table instances enable row level security;
alter table tabs enable row level security;
alter table page_signatures enable row level security;
alter table element_signatures enable row level security;
alter table tool_calls enable row level security;
alter table artifacts enable row level security;
alter table hints enable row level security;
alter table hint_stats enable row level security;
alter table dedup_hashes enable row level security;

-- permissive dev policies (allow anon/authenticated/service_role to read/write)
drop policy if exists sessions_rw on sessions;
create policy sessions_rw on sessions for all using (true) with check (true);

drop policy if exists runs_rw on runs;
create policy runs_rw on runs for all using (true) with check (true);

drop policy if exists instances_rw on instances;
create policy instances_rw on instances for all using (true) with check (true);

drop policy if exists tabs_rw on tabs;
create policy tabs_rw on tabs for all using (true) with check (true);

drop policy if exists page_signatures_rw on page_signatures;
create policy page_signatures_rw on page_signatures for all using (true) with check (true);

drop policy if exists element_signatures_rw on element_signatures;
create policy element_signatures_rw on element_signatures for all using (true) with check (true);

drop policy if exists tool_calls_rw on tool_calls;
create policy tool_calls_rw on tool_calls for all using (true) with check (true);

drop policy if exists artifacts_rw on artifacts;
create policy artifacts_rw on artifacts for all using (true) with check (true);

drop policy if exists hints_rw on hints;
create policy hints_rw on hints for all using (true) with check (true);

drop policy if exists hint_stats_rw on hint_stats;
create policy hint_stats_rw on hint_stats for all using (true) with check (true);

drop policy if exists dedup_hashes_rw on dedup_hashes;
create policy dedup_hashes_rw on dedup_hashes for all using (true) with check (true);

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated, service_role;

-- Done
