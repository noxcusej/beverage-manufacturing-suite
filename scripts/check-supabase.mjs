#!/usr/bin/env node
//
// Verify this deployment's Supabase instance is set up for the procurement
// dashboard, the client portal and review deadlines.
//
//   node scripts/check-supabase.mjs
//   npm run check:supabase
//
// Reads .env / .env.local if present, otherwise the process environment.
// Key VALUES are never printed — only whether each one is set.
//
// It checks three things:
//   1. the service key can reach every table the migrations create;
//   2. the anon key CANNOT read the portal tables (this is the boundary the
//      client portal depends on — see supabase/migrations/003);
//   3. the anon key cannot write to them either (--probe-write).

import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// ── Environment ─────────────────────────────────────────────────────────────

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key]) continue; // a real env var always wins
    process.env[key] = raw.trim().replace(/^["']|["']$/g, '');
  }
}
loadEnvFile('.env');
loadEnvFile('.env.local');

const URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const PROBE_WRITE = process.argv.includes('--probe-write');

// Tables the suite already had, and the ones the new migrations add.
const SUITE_TABLES = ['app_data', 'formulas', 'inventory'];
const PORTAL_TABLES = ['portal_links', 'procurement_comments'];
const DEADLINE_TABLES = ['review_deadlines', 'review_deadline_events', 'bill_decisions'];
const RESTRICTED = [...PORTAL_TABLES, ...DEADLINE_TABLES];

const MIGRATION_FOR = {
  portal_links: '003_create_portal_tables.sql',
  procurement_comments: '003_create_portal_tables.sql',
  review_deadlines: '004_create_review_deadlines.sql',
  review_deadline_events: '004_create_review_deadlines.sql',
  bill_decisions: '004_create_review_deadlines.sql',
};

let failures = 0;
let warnings = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { failures += 1; console.log(`  ✗ ${m}`); };
const warn = (m) => { warnings += 1; console.log(`  ! ${m}`); };

console.log('\nSupabase check\n' + '='.repeat(60));

console.log('\nCredentials');
if (!URL) { bad('No SUPABASE_URL / VITE_SUPABASE_URL set.'); }
else ok(`URL set (${new global.URL(URL).host})`);
if (!SERVICE_KEY) {
  bad('No SUPABASE_SERVICE_KEY set. The portal and deadline tables are '
    + 'service-key only, so the anon key cannot substitute — copy it from '
    + 'Supabase → Project Settings → API → service_role.');
} else ok('SUPABASE_SERVICE_KEY set');
if (!ANON_KEY) warn('No anon key set — skipping the isolation checks below.');
else ok('anon key set');

if (!URL || !SERVICE_KEY) {
  console.log('\nCannot continue without a URL and a service key.\n');
  process.exit(1);
}

const service = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
const anon = ANON_KEY ? createClient(URL, ANON_KEY, { auth: { persistSession: false } }) : null;

/** @returns {'ok'|'missing'|'error'} */
async function probe(client, table) {
  const { error } = await client.from(table).select('*').limit(1);
  if (!error) return 'ok';
  // 42P01 = undefined_table; PostgREST also reports it as PGRST205.
  if (error.code === '42P01' || error.code === 'PGRST205' || /does not exist/i.test(error.message)) {
    return 'missing';
  }
  return `error: ${error.message}`;
}

// ── 1. Every table reachable with the service key ───────────────────────────

console.log('\nTables (service key)');
const missing = [];
for (const table of [...SUITE_TABLES, ...RESTRICTED]) {
  const result = await probe(service, table);
  if (result === 'ok') ok(table);
  else if (result === 'missing') {
    missing.push(table);
    const migration = MIGRATION_FOR[table];
    bad(`${table} is missing${migration ? ` — run supabase/migrations/${migration}` : ''}`);
  } else bad(`${table} — ${result}`);
}

// ── 2. The anon key must not be able to READ the restricted tables ──────────

if (anon) {
  console.log('\nIsolation (anon key must not reach the portal tables)');

  // Sanity: the anon key does still work for the suite's own data. If this
  // fails, the anon key is wrong and the checks below would pass for the
  // wrong reason.
  const suiteRead = await probe(anon, 'app_data');
  if (suiteRead === 'ok') ok('anon can still read app_data (the suite is unaffected)');
  else warn(`anon could not read app_data (${suiteRead}) — the anon key may be wrong, `
    + 'which would make the checks below meaningless');

  for (const table of RESTRICTED) {
    if (missing.includes(table)) continue;
    const { data, error } = await anon.from(table).select('*').limit(1);
    if (error) {
      // Blocked outright — even stronger than the expected empty result.
      ok(`${table}: anon blocked (${error.code || 'error'})`);
    } else if (Array.isArray(data) && data.length === 0) {
      ok(`${table}: anon reads 0 rows — RLS on with no anon policy`);
    } else {
      bad(`${table}: ANON CAN READ THIS TABLE. RLS is not doing its job — the `
        + 'client portal depends on this boundary. Check that the migration ran '
        + 'and that no permissive policy was added.');
    }
  }

  // ── 3. …nor WRITE to them ──
  if (PROBE_WRITE) {
    console.log('\nIsolation (anon write probe)');
    const canary = `__anon_write_probe_${Date.now()}`;
    const { error } = await anon.from('portal_links').insert({
      id: canary,
      client_name: canary,
      token_hash: canary,
      token_prefix: 'probe',
    });
    if (error) ok(`portal_links: anon insert refused (${error.code || 'error'})`);
    else {
      bad('portal_links: ANON CAN INSERT. Anyone with the public key could mint '
        + 'a portal link to any client. Fix before sharing any link.');
      await service.from('portal_links').delete().eq('id', canary);
      console.log('    (the probe row was removed with the service key)');
    }
  } else {
    console.log('\n  Run with --probe-write to also test that anon cannot INSERT.');
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
if (failures) {
  console.log(`${failures} problem${failures === 1 ? '' : 's'} found`
    + (warnings ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : '') + '\n');
  process.exit(1);
}
console.log(`All checks passed${warnings ? ` (${warnings} warning${warnings === 1 ? '' : 's'})` : ''}\n`);
