#!/usr/bin/env node
// Ingests a test run + tool_calls, then reads them back to validate shapes.

const REST_URL = process.env.SUPABASE_REST_URL || 'http://127.0.0.1:54321';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SERVICE_KEY) {
  console.error('ERROR: SUPABASE_SERVICE_KEY not set. Export it and rerun.');
  process.exit(2);
}

const headers = {
  'apikey': SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation'
};

async function post(path, body) {
  const res = await fetch(`${REST_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`POST ${path} failed: ${res.status} ${res.statusText} - ${t}`);
  }
  return res.json();
}

async function patch(path, body) {
  const res = await fetch(`${REST_URL}${path}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`PATCH ${path} failed: ${res.status} ${res.statusText} - ${t}`);
  }
  return res.json().catch(() => ({}));
}

async function get(path) {
  const res = await fetch(`${REST_URL}${path}`, { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GET ${path} failed: ${res.status} ${res.statusText} - ${t}`);
  }
  return res.json();
}

function randId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main() {
  console.log('=> Creating test run');
  const sessionId = randId('sess');
  const instanceId = sessionId;
  // Ensure session exists due to FK
  await post('/rest/v1/sessions', { session_id: sessionId, user_hash: 'test' });

  const runRows = await post('/rest/v1/runs', {
    status: 'running',
    session_id: sessionId,
    instance_id: instanceId,
    server_version: 'test',
    proto_version: 'v2'
  });
  const run = runRows[0];
  if (!run || !run.run_id) throw new Error('No run_id returned');
  const runId = run.run_id;
  console.log('   run_id:', runId);

  console.log('=> Inserting tool_calls (3)');
  const now = new Date();
  const started = now.toISOString();

  // 1) browser_navigate success
  await post('/rest/v1/tool_calls', {
    run_id: runId,
    seq: 1,
    event_uuid: crypto.randomUUID(),
    tool_name: 'browser_navigate',
    started_at: started,
    ended_at: new Date().toISOString(),
    success: true,
    error_msg: null,
    input_jsonb: { action: 'goto', url: 'https://example.com' },
    output_jsonb: { content: [{ type: 'text', text: 'Navigated to https://example.com' }], isError: false },
    instance_id: instanceId,
    session_id: sessionId,
    tab_id: '123',
    url_at_call: 'https://example.com'
  });

  // 2) browser_execute_js success
  await post('/rest/v1/tool_calls', {
    run_id: runId,
    seq: 2,
    event_uuid: crypto.randomUUID(),
    tool_name: 'browser_execute_js',
    started_at: started,
    ended_at: new Date().toISOString(),
    success: true,
    error_msg: null,
    input_jsonb: { code: 'return 2+2', unsafe: true },
    output_jsonb: { content: [{ type: 'text', text: '4' }], debug: { responseShape: ['result','tabId'] } },
    instance_id: instanceId,
    session_id: sessionId,
    tab_id: '123',
    url_at_call: 'https://example.com'
  });

  // 3) browser_execute_js failure
  await post('/rest/v1/tool_calls', {
    run_id: runId,
    seq: 3,
    event_uuid: crypto.randomUUID(),
    tool_name: 'browser_execute_js',
    started_at: started,
    ended_at: new Date().toISOString(),
    success: false,
    error_msg: 'Simulated failure',
    input_jsonb: { code: 'throw new Error("x")', unsafe: true },
    output_jsonb: { error: 'Simulated failure' },
    instance_id: instanceId,
    session_id: sessionId,
    tab_id: '123',
    url_at_call: 'https://example.com'
  });

  console.log('=> Reading back tool_calls for run');
  const rows = await get(`/rest/v1/tool_calls?run_id=eq.${encodeURIComponent(runId)}&order=seq.asc`);
  if (!Array.isArray(rows) || rows.length !== 3) {
    throw new Error(`Expected 3 tool_calls, got ${rows.length}`);
  }

  // Print concise summary
  const summary = rows.map(r => ({ seq: r.seq, tool: r.tool_name, success: r.success, has_input: !!r.input_jsonb, has_output: !!r.output_jsonb }));
  console.log('   rows:', JSON.stringify(summary, null, 2));

  console.log('=> Marking run as completed');
  await patch(`/rest/v1/runs?run_id=eq.${encodeURIComponent(runId)}`, { status: 'completed', ended_at: new Date().toISOString() });

  // Sanity: read the run
  const runRead = await get(`/rest/v1/runs?run_id=eq.${encodeURIComponent(runId)}&select=run_id,status,started_at,ended_at`);
  console.log('   run:', JSON.stringify(runRead, null, 2));

  console.log('\nOK: Ingestion and readback look good.');
}

main().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
