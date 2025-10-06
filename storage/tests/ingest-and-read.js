#!/usr/bin/env node
// Ingests a test run + tool_calls, then reads them back to validate shapes.
import { createHash } from 'node:crypto';

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

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

async function main() {
  console.log('=> Creating test run');
  const sessionId = randId('sess');
  const instanceId = randId('inst');
  const tabId = randId('tab');
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
    tab_id: tabId,
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
    tab_id: tabId,
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
    tab_id: tabId,
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

  // Populate remaining tables: instances, tabs, signatures, artifacts, hint_stats, hints, dedup_hashes
  console.log('=> Populating instances and tabs');
  await post('/rest/v1/instances', {
    instance_id: instanceId,
    session_id: sessionId,
    extension: 'chrome',
    extension_version: '1.30.13'
  });
  await post('/rest/v1/tabs', {
    tab_id: tabId,
    instance_id: instanceId,
    url_first_seen: 'https://example.com/',
    viewport_w: 1280,
    viewport_h: 800,
    dpr: 1
  });

  console.log('=> Creating page and element signatures');
  const pageRows = await post('/rest/v1/page_signatures', {
    url_norm: 'https://example.com/',
    domain: 'example.com',
    canonical_link_hash: null,
    title_hash: sha256Hex('Example Domain'),
    dom_fingerprint_hash: sha256Hex('<body><div><h1></h1></div></body>')
  });
  const pageSigId = pageRows[0].page_sig_id;
  const elemRows = await post('/rest/v1/element_signatures', {
    page_sig_id: pageSigId,
    selector_norm: 'h1',
    role: 'heading',
    text_hash: sha256Hex('Example Domain'),
    attr_fingerprint_hash: sha256Hex('h1.class=')
  });
  const elemSigId = elemRows[0].elem_sig_id;

  console.log('=> Linking tool_call #2 to page/element signatures');
  await patch(`/rest/v1/tool_calls?run_id=eq.${encodeURIComponent(runId)}&seq=eq.2`, {
    page_sig_id: pageSigId,
    elem_sig_id: elemSigId
  });

  console.log('=> Inserting artifact for tool_call #1');
  const call1 = await get(`/rest/v1/tool_calls?run_id=eq.${encodeURIComponent(runId)}&seq=eq.1&select=call_id`);
  const callId = call1[0].call_id;
  const contentHash = sha256Hex('dummy-image-png');
  await post('/rest/v1/dedup_hashes', { content_hash: contentHash });
  await post('/rest/v1/artifacts', {
    call_id: callId,
    type: 'screenshot',
    content_hash: contentHash,
    size_bytes: 12345,
    storage_path: `screenshots/dev/${contentHash}.png`
  });

  console.log('=> Inserting hint_stats and hints');
  await post('/rest/v1/hint_stats', {
    scope: 'page',
    page_sig_id: pageSigId,
    elem_sig_id: null,
    success_ct: 10,
    error_ct: 2,
    avg_latency: 350,
    last_success_at: new Date().toISOString()
  });
  await post('/rest/v1/hint_stats', {
    scope: 'element',
    page_sig_id: pageSigId,
    elem_sig_id: elemSigId,
    success_ct: 8,
    error_ct: 1,
    avg_latency: 120,
    last_success_at: new Date().toISOString()
  });
  await post('/rest/v1/hints', {
    page_sig_id: pageSigId,
    elem_sig_id: null,
    hint_type: 'wait_condition',
    hint_data: { selector: 'body', condition: 'visible', timeoutMs: 5000 },
    confidence: 0.85,
    version: 1
  });
  await post('/rest/v1/hints', {
    page_sig_id: pageSigId,
    elem_sig_id: elemSigId,
    hint_type: 'best_selector',
    hint_data: { selector: 'h1', alternatives: ['h1.title', 'main h1'] },
    confidence: 0.93,
    version: 1
  });

  // Read back summaries
  console.log('=> Summaries:');
  const pages = await get(`/rest/v1/page_signatures?page_sig_id=eq.${pageSigId}&select=page_sig_id,url_norm,domain,title_hash,dom_fingerprint_hash`);
  const elems = await get(`/rest/v1/element_signatures?elem_sig_id=eq.${elemSigId}&select=elem_sig_id,page_sig_id,selector_norm,role`);
  const arts = await get(`/rest/v1/artifacts?call_id=eq.${encodeURIComponent(callId)}&select=type,content_hash,storage_path,size_bytes`);
  const hstatsPage = await get(`/rest/v1/hint_stats?scope=eq.page&page_sig_id=eq.${pageSigId}&select=success_ct,error_ct,avg_latency`);
  const hstatsElem = await get(`/rest/v1/hint_stats?scope=eq.element&elem_sig_id=eq.${elemSigId}&select=success_ct,error_ct,avg_latency`);
  const hintsPage = await get(`/rest/v1/hints?page_sig_id=eq.${pageSigId}&elem_sig_id=is.null&select=hint_type,confidence,version`);
  const hintsElem = await get(`/rest/v1/hints?page_sig_id=eq.${pageSigId}&elem_sig_id=eq.${elemSigId}&select=hint_type,confidence,version`);
  console.log('   page_signatures:', JSON.stringify(pages, null, 2));
  console.log('   element_signatures:', JSON.stringify(elems, null, 2));
  console.log('   artifacts:', JSON.stringify(arts, null, 2));
  console.log('   hint_stats(page):', JSON.stringify(hstatsPage, null, 2));
  console.log('   hint_stats(element):', JSON.stringify(hstatsElem, null, 2));
  console.log('   hints(page):', JSON.stringify(hintsPage, null, 2));
  console.log('   hints(element):', JSON.stringify(hintsElem, null, 2));

  console.log('\nOK: Ingestion and readback look good.');
}

main().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
