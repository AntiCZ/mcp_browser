#!/usr/bin/env node
import { createHash } from 'node:crypto';

const REST_URL = process.env.SUPABASE_REST_URL || 'http://127.0.0.1:54321';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SERVICE_KEY) {
  console.error('SUPABASE_SERVICE_KEY is required');
  process.exit(2);
}

async function get(path) {
  const res = await fetch(`${REST_URL}${path}`, { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}
async function post(path, body) {
  const res = await fetch(`${REST_URL}${path}`, { method: 'POST', headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  return res.json();
}
async function patch(path, body) {
  const res = await fetch(`${REST_URL}${path}`, { method: 'PATCH', headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`PATCH ${path} -> ${res.status}`);
  try { return await res.json(); } catch { return {}; }
}

function msBetween(a, b) {
  try { return Math.max(0, new Date(b) - new Date(a)); } catch { return null; }
}

async function run() {
  // Fetch tool_calls (limit to recent 500 for dev)
  const calls = await get(`/rest/v1/tool_calls?order=started_at.desc&limit=500`);
  const byPage = new Map();
  for (const c of calls) {
    if (!c.page_sig_id) continue;
    const key = c.page_sig_id;
    let agg = byPage.get(key);
    if (!agg) { agg = { page_sig_id: key, success_ct: 0, error_ct: 0, latencies: [], last_success_at: null }; byPage.set(key, agg); }
    if (c.success) {
      agg.success_ct += 1;
      agg.last_success_at = c.ended_at || c.started_at || agg.last_success_at;
    } else {
      agg.error_ct += 1;
    }
    const d = msBetween(c.started_at, c.ended_at);
    if (d != null) agg.latencies.push(d);
  }

  for (const agg of byPage.values()) {
    const avg = agg.latencies.length ? Math.round(agg.latencies.reduce((a,b)=>a+b,0)/agg.latencies.length) : null;
    // Upsert: check existing
    const existing = await get(`/rest/v1/hint_stats?scope=eq.page&page_sig_id=eq.${agg.page_sig_id}&limit=1`);
    const payload = { scope: 'page', page_sig_id: agg.page_sig_id, elem_sig_id: null, success_ct: agg.success_ct, error_ct: agg.error_ct, avg_latency: avg, last_success_at: agg.last_success_at, updated_at: new Date().toISOString() };
    if (existing && existing.length) {
      await patch(`/rest/v1/hint_stats?id=eq.${existing[0].id}`, payload);
    } else {
      await post(`/rest/v1/hint_stats`, payload);
    }
  }
  console.log(`Aggregated pages: ${byPage.size}`);
}

run().catch(err => { console.error('Aggregator failed:', err.message); process.exit(1); });

