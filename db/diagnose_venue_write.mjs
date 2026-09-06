/**
 * Why can a shop not save an invoice?
 *
 * Reported 6 September 2026: a GMP account gets "Couldn't save that invoice.
 * Nothing was written" for every invoice, existing supplier or new. Two passes
 * of reading the code did not find it, and the toast names nothing useful even
 * now that it appends a code — one line on a phone is not an error report.
 *
 * ---------------------------------------------------------------------------
 * What this does that the app cannot
 *
 * It signs in as the shop, builds the SAME payload the sheet builds, sends it,
 * and prints the WHOLE error — `message`, `code`, `details` and `hint`.
 * PostgREST's own documentation is explicit that `hint` is usually the most
 * useful field and that for a permission refusal it contains the literal SQL
 * that would fix the problem. The app has never shown it and never should;
 * this is where it belongs.
 *
 * ---------------------------------------------------------------------------
 * IT WRITES, IF IT CAN. That is the point.
 *
 * A refusal writes nothing, and a refusal is the expected outcome. If it
 * SUCCEEDS then the database is fine and the bug is in the browser — which is
 * itself the answer, and worth one row to learn.
 *
 * The row it would leave is one cent, marked DIAGNOSTIC, and it lands in the
 * Review queue unapproved (CATCH_UP_013), so one tap of Reject in the app
 * disposes of it properly. The script prints that instruction if it gets that
 * far.
 * ---------------------------------------------------------------------------
 *
 * Run:  node db/diagnose_venue_write.mjs
 *
 * Needs STAFF_EMAIL and STAFF_PASSWORD in .env.local. Take them out again
 * afterwards.
 */

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

function loadEnv() {
  let text;
  try {
    text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  } catch {
    console.error('No .env.local found.');
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
  console.error('.env.local is missing the Supabase url or anon key.');
  process.exit(1);
}
if (!env.STAFF_EMAIL || !env.STAFF_PASSWORD) {
  console.error('\n.env.local needs STAFF_EMAIL and STAFF_PASSWORD (the shop login).');
  console.error('Add them, run this, then take them out again.\n');
  process.exit(1);
}

const client = createClient(url, anonKey, { auth: { persistSession: false } });

/** Everything Postgres said, not just the first line of it. */
function report(label, error) {
  if (!error) {
    console.log(`  ok    ${label}`);
    return false;
  }
  console.log(`  FAIL  ${label}`);
  console.log(`        code:    ${error.code || '(none)'}`);
  console.log(`        message: ${error.message || '(none)'}`);
  if (error.details) console.log(`        details: ${error.details}`);
  if (error.hint) console.log(`        hint:    ${error.hint}`);
  return true;
}

const { data: auth, error: signInError } = await client.auth.signInWithPassword({
  email: env.STAFF_EMAIL,
  password: env.STAFF_PASSWORD,
});

if (signInError) {
  console.error(`\nCould not sign in as ${env.STAFF_EMAIL}: ${signInError.message}\n`);
  process.exit(1);
}

console.log(`\nSigned in as ${env.STAFF_EMAIL}  (${auth.user.id})\n`);

const { data: me } = await client.from('profiles').select('id, role, business_id');
const venueId = me?.[0]?.business_id ?? null;
console.log(`Venue: ${venueId ?? 'NONE — this account is not staff'}\n`);

if (!venueId) process.exit(1);

/* ------------------------------------------------------------- a supplier */

const { data: suppliers, error: supplierError } = await client
  .from('suppliers')
  .select('id, name, is_placeholder')
  .eq('active', true)
  .limit(50);

if (supplierError) {
  console.log('Could not even read suppliers:');
  report('read suppliers', supplierError);
  process.exit(1);
}

const real = suppliers.find((s) => !s.is_placeholder) ?? suppliers[0];
if (!real) {
  console.log('No suppliers exist, so there is nothing to file against.');
  process.exit(1);
}
console.log(`Filing against: ${real.name}\n`);

/* ------------------------------------------- exactly what the sheet sends */

const id = crypto.randomUUID();

/*
 * `buildInvoicePayload`'s output, field for field. Nothing extra, nothing
 * missing — a payload that differs from the app's would answer a question
 * nobody asked.
 */
const payload = {
  id,
  business_id: venueId,
  supplier_id: real.id,
  invoice_number: 'DIAGNOSTIC',
  invoice_date: '2026-09-06',
  due_date: '2026-09-20',
  amount_cents: 1,
  created_by: auth.user.id,
};

console.log('The insert the sheet makes:\n');
console.log(JSON.stringify(payload, null, 2).replace(/^/gm, '  '));
console.log('');

const insert = await client
  .from('invoices')
  .upsert(payload, { onConflict: 'id', ignoreDuplicates: true });

const failed = report('venue inserts an invoice into its own venue', insert.error);

/* --------------------------------------------------------------- the note */

if (!failed) {
  console.log('');
  const note = await client.from('invoice_notes').insert({
    invoice_id: id,
    author_id: auth.user.id,
    body: 'DIAGNOSTIC — safe to ignore',
  });
  // CATCH_UP_016 is what this proves. Before it, the policy's own EXISTS read
  // `invoices` as the caller and could never be true.
  report('venue writes a note on that invoice (CATCH_UP_016)', note.error);
}

await client.auth.signOut();

console.log('');
if (failed) {
  console.log('The database refused it. The code and hint above are the answer —');
  console.log('send me that block and nothing else is needed.\n');
} else {
  console.log('IT SAVED. So the database is fine and the bug is in the browser.');
  console.log('That is the useful half of the answer.\n');
  console.log('Dispose of the row properly: open Review in the app, find the');
  console.log(`DIAGNOSTIC entry for $0.01, and tap Reject.\n`);
  console.log(`  (its id is ${id})\n`);
}
