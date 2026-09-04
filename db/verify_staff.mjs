/**
 * Prove that a venue account is confined to its own venue and never learns
 * about payment.
 *
 * The sibling of `verify_rls.mjs`, which proves the ANONYMOUS key gets
 * nothing. This one signs in as a real staff account and proves the harder
 * thing: that somebody legitimately inside the app is still fenced.
 *
 * ---------------------------------------------------------------------------
 * Why this script has to exist, rather than clicking around
 *
 * `staff_invoices` is a view, and a view runs with its OWNER's rights — it
 * reads `invoices` in full regardless of the caller. Its WHERE clause is the
 * entire boundary. If that clause is wrong, the view does not error: it
 * cheerfully returns every venue's invoices, and the screen looks perfect.
 *
 * That is a failure you cannot see. So it gets measured.
 * ---------------------------------------------------------------------------
 *
 * Run:  node db/verify_staff.mjs
 *
 * Needs, in .env.local (which is gitignored and already holds the keys):
 *   STAFF_EMAIL=...
 *   STAFF_PASSWORD=...
 *
 * Add `--write` to also test that inserting is allowed. OFF BY DEFAULT, because
 * it puts a real invoice into a live ledger that nothing in the app can delete.
 * The refusal tests below need no such thing — a refused insert writes nothing —
 * and they are the ones that matter for security.
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
const email = env.STAFF_EMAIL;
const password = env.STAFF_PASSWORD;

if (!url || !anonKey) {
  console.error('.env.local is missing the Supabase url or anon key.');
  process.exit(1);
}
if (!email || !password) {
  console.error('.env.local needs STAFF_EMAIL and STAFF_PASSWORD for the test account.');
  process.exit(1);
}

const TEST_WRITES = process.argv.includes('--write');

const client = createClient(url, anonKey, { auth: { persistSession: false } });

const failures = [];
function check(description, passed, detail = '') {
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${description}${detail ? `  — ${detail}` : ''}`);
  if (!passed) failures.push(description);
}

/**
 * Refused OR empty both count as fenced here, and that is a weaker bar than
 * `verify_rls.mjs` sets on purpose.
 *
 * Against the anon key, an empty result proves nothing — the table might just
 * be empty. Here the tables are known to have rows in them (the four have been
 * using the app), so "you got zero rows from a table that has rows" IS the
 * refusal. PostgREST returns an empty array rather than an error when RLS
 * hides everything, so insisting on an error code would fail against a
 * correctly locked table.
 */
function fenced(label, { data, error }) {
  const rows = data?.length ?? 0;
  check(label, rows === 0, error ? `refused: ${error.code}` : `${rows} rows`);
}

const { data: auth, error: signInError } = await client.auth.signInWithPassword({
  email,
  password,
});

if (signInError) {
  console.error(`\nCould not sign in as ${email}: ${signInError.message}\n`);
  process.exit(1);
}

console.log(`\nSigned in as ${email}  (${auth.user.id})\n`);

/* ---------------------------------------------------------------- identity */

const { data: me } = await client.from('profiles').select('*');
check('sees exactly one profile — its own', me?.length === 1, `${me?.length ?? 0} rows`);
const venueId = me?.[0]?.business_id ?? null;
check('that profile is staff, with a venue', me?.[0]?.role === 'staff' && venueId !== null,
  `role=${me?.[0]?.role} business_id=${venueId}`);

/* -------------------------------------------------- the base tables, closed */

console.log('\nThe tables a venue must not reach:\n');

fenced('invoices — the base table, with its status columns', await client.from('invoices').select('id, status'));
fenced('activity_log — every payment event, all four venues', await client.from('activity_log').select('id'));
fenced('customers — Deli Delights', await client.from('customers').select('id'));
fenced('sales_invoices — the receivables', await client.from('sales_invoices').select('id'));
fenced('invoice_notes', await client.from('invoice_notes').select('id'));
fenced('invoice_ref_counters', await client.from('invoice_ref_counters').select('business_id'));
fenced('push_targets — other people’s push endpoints', await client.from('push_targets').select('endpoint'));

const otherBusinesses = await client.from('businesses').select('id, code');
check(
  'businesses — only its own venue',
  (otherBusinesses.data?.length ?? 0) === 1 && otherBusinesses.data?.[0]?.id === venueId,
  (otherBusinesses.data ?? []).map((b) => b.code).join(', ') || 'none',
);

/* ------------------------------------------------------------- the view */

console.log('\nThe view — the whole boundary:\n');

const view = await client.from('staff_invoices').select('*');
check('staff_invoices is readable', !view.error, view.error ? view.error.message : `${view.data.length} rows`);

if (!view.error) {
  const rows = view.data ?? [];

  const strayVenue = rows.filter((r) => r.business_id !== venueId);
  check('every row belongs to this venue', strayVenue.length === 0,
    strayVenue.length ? `${strayVenue.length} rows from elsewhere` : `${rows.length} rows, all ours`);

  /*
   * The columns are the point. `status` absent is what the whole feature is
   * for, and a widened view would hand it over without any error anywhere.
   */
  const banned = ['status', 'paid_at', 'paid_by', 'payment_ref', 'void_reason'];
  const present = rows.length
    ? banned.filter((c) => c in rows[0])
    : banned.filter(() => false);
  check('no payment columns in the view', present.length === 0,
    rows.length === 0 ? 'no rows to inspect — add one invoice for this venue and re-run'
      : present.length ? `LEAKING: ${present.join(', ')}` : Object.keys(rows[0]).join(', '));

  if (rows.length === 0) {
    console.log('\n  note: this venue has no invoices, so the column check above proved nothing.');
    console.log('        Add one from the app as one of the four, then run this again.\n');
  }
}

/* ------------------------------------------------------------------- RPCs */

console.log('\nThe duplicate lookups:\n');

const membersRpc = await client.rpc('find_duplicate_invoices', {
  p_supplier_id: '00000000-0000-0000-0000-000000000000',
  p_invoice_number: 'x',
  p_lookback_days: 180,
});
check("the members' lookup returns nothing — it would carry status",
  (membersRpc.data?.length ?? 0) === 0,
  membersRpc.error ? `refused: ${membersRpc.error.code}` : `${membersRpc.data?.length ?? 0} rows`);

const staffRpc = await client.rpc('find_duplicate_invoices_staff', {
  p_supplier_id: '00000000-0000-0000-0000-000000000000',
  p_invoice_number: 'x',
  p_lookback_days: 180,
});
check('the staff lookup is callable', !staffRpc.error,
  staffRpc.error ? staffRpc.error.message : 'ok');

/* ----------------------------------------------------------------- writes */

console.log('\nWriting:\n');

const suppliers = await client.from('suppliers').select('id, name').limit(1);
/*
 * Readable is the test, not non-empty. On a fresh ledger there are no
 * suppliers yet, and "you may read a table that happens to hold nothing" is
 * exactly right — a refusal (42501) is the only thing that fails here.
 */
check('can read suppliers, for the type-ahead',
  !suppliers.error,
  suppliers.error ? `refused: ${suppliers.error.code}` : `${suppliers.data?.length ?? 0} rows`);

const sampleSupplier = suppliers.data?.[0]?.id ?? null;
if (sampleSupplier === null) {
  console.log('\n  note: no suppliers exist yet, so the write-policy checks below cannot use a');
  console.log('        real supplier. They still prove the write is REFUSED — just not that');
  console.log('        the policy is the thing refusing it. Add one GMP invoice from the app');
  console.log('        as one of the four, then run this again for the sharper proof.\n');
}

if (suppliers.data?.[0]) {
  const rename = await client
    .from('suppliers')
    .update({ name: `${suppliers.data[0].name} (should not happen)` })
    .eq('id', suppliers.data[0].id)
    .select();
  check('cannot rename a supplier the whole group shares',
    rename.error !== null || (rename.data?.length ?? 0) === 0,
    rename.error ? `refused: ${rename.error.code}` : `${rename.data?.length ?? 0} rows changed`);
}

/*
 * These insert nothing when they pass, so they need no cleanup: a refused
 * write leaves no row.
 *
 * The `42501` / "violates row-level security policy" code is what proves the
 * POLICY did the refusing. A `23503` (foreign key) or `P0001` (trigger) would
 * mean the request tripped over something else first and the policy was never
 * tested — which is the exact false pass that CATCH_UP_012 was written to fix.
 * So each of these uses REAL ids everywhere except the one thing under test.
 */
const RLS = (e) =>
  e !== null && (e.code === '42501' || /row-level security/i.test(e.message ?? ''));

if (sampleSupplier) {
  // Cannot mark it paid on the way in. Everything real except the status.
  const paidInject = await client.from('invoices').insert({
    business_id: venueId,
    supplier_id: sampleSupplier,
    invoice_date: '2026-01-01',
    due_date: '2026-01-15',
    amount_cents: 1,
    created_by: auth.user.id,
    status: 'paid',
    paid_at: new Date().toISOString(),
    paid_by: auth.user.id,
  });
  check('cannot enter an invoice already marked paid — the policy, not an FK',
    RLS(paidInject.error),
    paidInject.error ? `refused: ${paidInject.error.code}` : 'IT WAS ACCEPTED');

  // Cannot forge who entered it. Everything real except created_by.
  const forged = await client.from('invoices').insert({
    business_id: venueId,
    supplier_id: sampleSupplier,
    invoice_date: '2026-01-01',
    due_date: '2026-01-15',
    amount_cents: 1,
    created_by: '2da43dcf-8b0f-4229-bf5c-e5af68210045', // a real member (Rabindra)
  });
  check('cannot attribute an invoice to someone else — the policy, not an FK',
    RLS(forged.error),
    forged.error ? `refused: ${forged.error.code}` : 'IT WAS ACCEPTED');
} else {
  check('cannot enter an invoice already marked paid — the policy, not an FK', false,
    'SKIPPED — no supplier to build a valid row with; add one GMP invoice and re-run');
  check('cannot attribute an invoice to someone else — the policy, not an FK', false,
    'SKIPPED — no supplier to build a valid row with; add one GMP invoice and re-run');
}

/*
 * Filing against another venue. Even a non-existent business is blocked (the
 * ref trigger raises before the policy), so this passes on any id — but with a
 * real supplier the ONLY thing wrong is the venue, so a `42501` here proves the
 * policy specifically. Without a supplier it still proves the write is refused.
 */
const otherVenue = await client.from('invoices').insert({
  business_id: '00000000-0000-0000-0000-000000000000',
  supplier_id: sampleSupplier ?? '00000000-0000-0000-0000-000000000000',
  invoice_date: '2026-01-01',
  due_date: '2026-01-15',
  amount_cents: 1,
  created_by: auth.user.id,
});
check('cannot file an invoice against another venue',
  otherVenue.error !== null,
  otherVenue.error ? `refused: ${otherVenue.error.code}` : 'IT WAS ACCEPTED');

if (TEST_WRITES) {
  console.log('\n  --write given: putting one real invoice into the ledger.\n');
  const id = crypto.randomUUID();
  const insert = await client.from('invoices').insert({
    id,
    business_id: venueId,
    supplier_id: suppliers.data[0].id,
    invoice_number: 'VERIFY-DELETE-ME',
    invoice_date: '2026-01-01',
    due_date: '2026-01-15',
    amount_cents: 1,
    created_by: auth.user.id,
  });
  check('can add an invoice to its own venue', !insert.error,
    insert.error ? insert.error.message : id);

  if (!insert.error) {
    const bump = await client
      .from('invoices')
      .update({ created_at: new Date(Date.now() + 3600_000).toISOString(), amount_cents: 2 })
      .eq('id', id);
    check('correcting inside the window is allowed', !bump.error,
      bump.error ? bump.error.message : 'ok');

    const after = await client.from('staff_invoices').select('created_at').eq('id', id);
    const moved = after.data?.[0]?.created_at;
    check('created_at cannot be pushed forward to extend the window',
      moved !== undefined && new Date(moved).getTime() < Date.now() + 60_000,
      String(moved));

    console.log(`\n  Remove it when you are done:`);
    console.log(`  delete from invoices where id = '${id}';\n`);
  }
}

/* ------------------------------------------------------------------ result */

await client.auth.signOut();

console.log('');
if (failures.length === 0) {
  console.log('All checks passed. A venue account is fenced to its own venue and');
  console.log('cannot learn whether anything has been paid.\n');
  process.exit(0);
}
console.log(`${failures.length} FAILED:`);
for (const f of failures) console.log(`  - ${f}`);
console.log('\nDo not create the real accounts until these pass.\n');
process.exit(1);
