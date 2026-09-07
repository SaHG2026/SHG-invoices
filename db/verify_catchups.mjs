/**
 * Which CATCH_UP files have actually been run.
 *
 * The migrations go in by hand through the Supabase SQL editor, so nothing in
 * the repo knows what the database has actually got. This asks it.
 *
 * Run:  node db/verify_catchups.mjs
 * Needs NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local
 *
 * ---------------------------------------------------------------------------
 * What this can and cannot see, stated plainly
 *
 * It signs in as nobody — the anon key, the same one every phone carries — so
 * RLS hides every row from it. That is the point of RLS and it is not a
 * limitation to work around: the service-role key would see everything and it
 * is never going to exist in this project (ARCHITECTURE §1).
 *
 * What survives that is the SHAPE of the schema, because PostgREST resolves a
 * table or function name BEFORE any policy runs. A missing table answers
 * PGRST205; a missing function answers PGRST202; anything else — including a
 * flat refusal — means the thing is there. So:
 *
 *   provable here      tables, views, functions and COLUMNS exist
 *   NOT provable here  indexes, constraints, nullability, row contents
 *
 * The column check was added by the Round I audit. Without it this file
 * covered 001-005 of eighteen migrations, and every CATCH_UP after 005 mostly
 * adds columns to tables that already exist — so `relation()` answered "ok"
 * whether the migration had been run or not. It was reporting on a fifth of
 * the schema and reading as though it had checked all of it.
 *
 * db/verify_catchups.sql covers the rest. It is read-only and goes in the
 * Supabase SQL editor, where it runs as a real session and can see rows.
 * ---------------------------------------------------------------------------
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

/** PostgREST's "there is no such table or view in the schema". */
const NO_RELATION = 'PGRST205';
/** PostgREST's "there is no such function". */
const NO_FUNCTION = 'PGRST202';

const missing = [];

function report(label, present, detail) {
  console.log(`${present ? '  ok    ' : ' MISSING'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!present) missing.push(label);
}

/**
 * A relation exists if asking for it produces anything other than "no such
 * relation". A refusal (42501) is a yes: you cannot be refused access to
 * something that is not there.
 */
async function relation(label, name) {
  const { error } = await anon.from(name).select('*').limit(1);
  const present = error?.code !== NO_RELATION;
  report(label, present, present ? (error ? `exists, refused (${error.code})` : 'exists') : 'not in the schema');
}

/**
 * Same idea for a function. Every call below is deliberately a no-op — an
 * empty id array or an id that cannot match — so that probing for the
 * function can never change a row even if the grant let it through.
 */
async function fn(label, name, args) {
  const { error } = await anon.rpc(name, args);
  const present = error?.code !== NO_FUNCTION;
  report(label, present, present ? (error ? `exists, refused (${error.code})` : 'exists') : 'no such function');
}

/**
 * A COLUMN exists if asking for it by name produces anything other than
 * "column does not exist" (42703).
 *
 * This is the check the file was missing, and it is the one that matters for
 * every CATCH_UP after 005: most of them add a column to a table that already
 * exists, so `relation()` says "ok" whether the migration ran or not.
 */
async function column(label, table, name) {
  const { error } = await anon.from(table).select(name).limit(1);
  const present = error?.code !== '42703' && error?.code !== NO_RELATION;
  report(
    label,
    present,
    present ? (error ? `exists, refused (${error.code})` : 'exists') : `${table}.${name} is not there`,
  );
}

const NO_SUCH_ID = '00000000-0000-0000-0000-000000000000';

console.log('\nCATCH_UP_001 — notification setting and push tables\n');
await relation('push_subscriptions table', 'push_subscriptions');
await relation('push_targets view', 'push_targets');

console.log('\nCATCH_UP_004 — customers\n');
await relation('customers table', 'customers');

console.log('\nCATCH_UP_005 — sales invoices\n');
await relation('sales_invoices table', 'sales_invoices');
await fn('mark_sales_received', 'mark_sales_received', { p_ids: [], p_ref: null });
await fn('unmark_sales_received', 'unmark_sales_received', { p_id: NO_SUCH_ID });

console.log('\nCATCH_UP_006 — only Mani hears about payments\n');
await column('profiles.notify_on_payment', 'profiles', 'notify_on_payment');

console.log('\nCATCH_UP_010 — venue staff accounts\n');
await relation('staff_invoices view', 'staff_invoices');
await fn('is_staff', 'is_staff', {});
await fn('staff_venue', 'staff_venue', {});
await fn('find_duplicate_invoices_staff', 'find_duplicate_invoices_staff', {
  p_supplier_id: NO_SUCH_ID,
  p_invoice_number: 'x',
  p_lookback_days: 1,
});

console.log('\nCATCH_UP_013 — a shop entry waits to be approved\n');
await column('invoices.approved_at', 'invoices', 'approved_at');
await column('invoices.approved_by', 'invoices', 'approved_by');

console.log('\nCATCH_UP_014 — a daily reminder at a time each person chooses\n');
await column('profiles.reminder_time', 'profiles', 'reminder_time');
await column('profiles.reminder_last_sent_on', 'profiles', 'reminder_last_sent_on');

console.log('\nCATCH_UP_015 — Deli products, line items and numbering\n');
await relation('products table', 'products');
await relation('sales_invoice_lines table', 'sales_invoice_lines');
await relation('sales_invoice_counters table', 'sales_invoice_counters');
await fn('create_sales_invoice', 'create_sales_invoice', { p_invoice: {}, p_lines: [] });

console.log('\nCATCH_UP_017 — a sales invoice may have no due date\n');
console.log('  ?      sales_invoices.due_date is nullable  — needs a session; see the SQL file');

console.log('\nCATCH_UP_018 — a shop is only offered Edit on its own entries\n');
await column('staff_invoices.is_mine', 'staff_invoices', 'is_mine');

console.log('\nNot checkable from here — run db/verify_catchups.sql in Supabase:\n');
console.log('  ?     CATCH_UP_002  the unique index on invoices.internal_ref');
console.log('  ?     CATCH_UP_003  accents stored as person-1..4 rather than hex');
console.log('  ?     profiles.notify_on_new_invoice and the column grant');

console.log('');

if (missing.length > 0) {
  console.error(`${missing.length} thing(s) missing. The matching CATCH_UP file has not been run.\n`);
  process.exit(1);
}

console.log('Every table, view and function the CATCH_UP files add is present.\n');
