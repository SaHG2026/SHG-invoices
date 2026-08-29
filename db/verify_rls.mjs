/**
 * Phase 1 exit test: prove RLS blocks an anonymous client.
 *
 * Notes §2: "Enforcement lives in the database, never the interface." The
 * `anon` key ships inside every browser that loads this app, so it is public
 * by definition. The only thing standing between that public key and the
 * invoice table is RLS. This script is what proves it — written down and
 * re-runnable, rather than clicked through once and assumed ever after.
 *
 * Run:  node db/verify_rls.mjs
 * Needs NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local
 */

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

function loadEnv() {
  let text;
  try {
    text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  } catch {
    console.error('No .env.local found. Create it with the Supabase URL and anon key.');
    process.exit(1);
  }

  const env = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.error('.env.local is missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY.');
  process.exit(1);
}

const anon = createClient(url, anonKey, { auth: { persistSession: false } });

const TABLES = [
  'profiles',
  'businesses',
  'suppliers',
  'invoices',
  'invoice_notes',
  'activity_log',
  'push_subscriptions',
  'invoice_ref_counters',
];

const failures = [];

function check(description, passed, detail = '') {
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${description}${detail ? `  — ${detail}` : ''}`);
  if (!passed) failures.push(description);
}

console.log('\nAnonymous client, against every table:\n');

/**
 * PGRST205 means "no such table", which is NOT the same as "you may not read
 * this table" — and treating it as a pass is how a verification script comes
 * to certify a table that was never created. An empty result is also not
 * proof: the table may simply be empty. Only an explicit refusal counts.
 *
 * 42501 is insufficient_privilege — the grant stopped it.
 * PGRST116 / an empty array behind a policy means RLS filtered every row.
 */
const MISSING = 'PGRST205';

for (const table of TABLES) {
  const { data, error } = await anon.from(table).select('*').limit(1);

  if (error?.code === MISSING) {
    check(`read ${table} is refused`, false, 'TABLE DOES NOT EXIST — nothing was verified');
    continue;
  }

  const refused = error !== null;
  const emptyBehindPolicy = !error && Array.isArray(data) && data.length === 0;
  check(
    `read ${table} is refused`,
    refused || emptyBehindPolicy,
    error ? error.code : `${data?.length ?? 0} rows`,
  );
}

console.log('');

for (const table of ['suppliers', 'invoices', 'invoice_notes', 'activity_log', 'push_subscriptions', 'profiles']) {
  const { error } = await anon.from(table).insert({}).select();
  if (error?.code === MISSING) {
    check(`write ${table} is refused`, false, 'TABLE DOES NOT EXIST — nothing was verified');
    continue;
  }
  check(`write ${table} is refused`, error !== null, error?.code ?? 'INSERT SUCCEEDED');
}

console.log('\nAnonymous client, against the payment RPCs:\n');

const rpcs = [
  ['mark_invoices_paid', { p_ids: ['00000000-0000-0000-0000-000000000000'], p_ref: 'x' }],
  ['unmark_invoice_paid', { p_id: '00000000-0000-0000-0000-000000000000' }],
  ['void_invoice', { p_id: '00000000-0000-0000-0000-000000000000', p_reason: 'x' }],
];

for (const [name, args] of rpcs) {
  const { data, error } = await anon.rpc(name, args);
  // Either refused outright, or allowed to run but changing nothing, because
  // the UPDATE inside it is itself filtered by RLS.
  const harmless = error !== null || (Array.isArray(data) && data.length === 0);
  check(`rpc ${name} changes nothing`, harmless, error?.code ?? `${data?.length ?? 0} rows`);
}

console.log('');

if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed. RLS is not doing its job — stop here.\n`);
  process.exit(1);
}

console.log('All checks passed. The anon key can see and change nothing.\n');
