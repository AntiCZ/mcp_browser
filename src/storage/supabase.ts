// Minimal Supabase REST client for storage ingestion via PostgREST

type FetchLike = typeof fetch;

function getConfig() {
  const REST_URL = process.env.SUPABASE_REST_URL || process.env.BROWSER_MCP_SUPABASE_REST_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.BROWSER_MCP_SUPABASE_SERVICE_KEY;
  return { REST_URL, SERVICE_KEY } as const;
}

function enabled(): boolean {
  const { REST_URL, SERVICE_KEY } = getConfig();
  return Boolean(REST_URL && SERVICE_KEY);
}

async function postJson<T>(path: string, body: unknown, fetchImpl: FetchLike = fetch): Promise<T> {
  const { REST_URL, SERVICE_KEY } = getConfig();
  if (!REST_URL || !SERVICE_KEY) throw new Error("Supabase REST not configured");
  const url = `${REST_URL.replace(/\/$/, '')}${path}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    let msg: any;
    try { msg = await res.json(); } catch { msg = await res.text(); }
    throw new Error(`Supabase POST ${path} failed: ${res.status} ${res.statusText} - ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return res.json() as Promise<T>;
}

export async function createRun(params: {
  session_id?: string;
  instance_id?: string;
  server_version?: string;
  proto_version?: string;
}, fetchImpl?: FetchLike): Promise<string | undefined> {
  if (!enabled()) return undefined;
  const payload: any = {
    status: 'running',
    session_id: params.session_id ?? null,
    instance_id: params.instance_id ?? null,
    server_version: params.server_version ?? null,
    proto_version: params.proto_version ?? null
  };
  const rows = await postJson<any[]>(`/rest/v1/runs`, payload, fetchImpl);
  const run = rows && rows[0];
  return run?.run_id as string | undefined;
}

export async function ensureSession(params: { session_id: string; user_hash?: string | null }, fetchImpl?: FetchLike): Promise<void> {
  if (!enabled()) return;
  const { REST_URL, SERVICE_KEY } = getConfig();
  const url = `${(REST_URL as string).replace(/\/$/, '')}/rest/v1/sessions?on_conflict=session_id`;
  const res = await (fetchImpl || fetch)(url, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_KEY as string,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=ignore-duplicates,return=minimal'
    },
    body: JSON.stringify({ session_id: params.session_id, user_hash: params.user_hash ?? null })
  });
  if (!res.ok) {
    try { console.warn('[Storage] ensureSession failed', await res.text()); } catch {}
  }
}

export async function finishRun(runId?: string, status: 'completed'|'failed'|'partial'='completed', fetchImpl?: FetchLike): Promise<void> {
  if (!enabled() || !runId) return;
  // Use upsert via RPC-less: PostgREST PATCH to a primary key needs /rest/v1/runs?run_id=eq.<id>
  const { REST_URL, SERVICE_KEY } = getConfig();
  const url = `${(REST_URL as string).replace(/\/$/, '')}/rest/v1/runs?run_id=eq.${encodeURIComponent(runId)}`;
  const res = await (fetchImpl || fetch)(url, {
    method: 'PATCH',
    headers: {
      'apikey': SERVICE_KEY as string,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ status, ended_at: new Date().toISOString() })
  });
  if (!res.ok) {
    // Non-fatal
    try { console.warn('[Storage] finishRun failed', await res.text()); } catch {}
  }
}

export async function insertToolCall(params: {
  run_id?: string;
  seq?: number;
  event_uuid?: string;
  tool_name: string;
  started_at?: string;
  ended_at?: string;
  success?: boolean;
  error_msg?: string | null;
  input_jsonb?: unknown;
  output_jsonb?: unknown;
  instance_id?: string;
  session_id?: string;
  tab_id?: string;
  url_at_call?: string | null;
  page_sig_id?: number | null;
  elem_sig_id?: number | null;
}, fetchImpl?: FetchLike): Promise<string | undefined> {
  if (!enabled()) return;
  const payload = {
    run_id: params.run_id ?? null,
    seq: params.seq ?? 0,
    event_uuid: params.event_uuid ?? null,
    tool_name: params.tool_name,
    started_at: params.started_at ?? new Date().toISOString(),
    ended_at: params.ended_at ?? new Date().toISOString(),
    success: params.success ?? null,
    error_msg: params.error_msg ?? null,
    input_jsonb: params.input_jsonb ?? null,
    output_jsonb: params.output_jsonb ?? null,
    instance_id: params.instance_id ?? null,
    session_id: params.session_id ?? null,
    tab_id: params.tab_id ?? null,
    url_at_call: params.url_at_call ?? null,
    page_sig_id: params.page_sig_id ?? null,
    elem_sig_id: params.elem_sig_id ?? null
  };
  try {
    const rows = await postJson<any[]>(`/rest/v1/tool_calls`, payload, fetchImpl);
    const row = rows && rows[0];
    return row?.call_id as string | undefined;
  } catch (e) {
    // Non-fatal for the tool path; log and continue
    console.warn('[Storage] insertToolCall failed:', (e as Error).message);
  }
}

export function storageEnabled() { return enabled(); }

export async function insertArtifact(params: {
  call_id: string;
  type: 'screenshot'|'dom'|'har'|'logs'|'scaffold';
  content_hash: string;
  size_bytes?: number;
  storage_path: string;
}, fetchImpl?: FetchLike): Promise<void> {
  if (!enabled()) return;
  const payload = {
    call_id: params.call_id,
    type: params.type,
    content_hash: params.content_hash,
    size_bytes: params.size_bytes ?? null,
    storage_path: params.storage_path,
  };
  try {
    await postJson(`/rest/v1/artifacts`, payload, fetchImpl);
  } catch (e) {
    console.warn('[Storage] insertArtifact failed:', (e as Error).message);
  }
}
