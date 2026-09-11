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

console.log('\nCATCH_UP_019 — three real tiers: owner, manager, staff\n');
/*
 * The rename is the check, and this one line asks its question backwards from
 * every other line in this file: `is_member()` answering PGRST202 is not a
 * failure, it is the proof that CATCH_UP_019 §2 ran.
 */
{
  const { error } = await anon.rpc('is_member', {});
  report(
    'is_member() is gone',
    error?.code === NO_FUNCTION,
    error?.code === NO_FUNCTION ? 'renamed' : 'still there, §2 did not run',
  );
}
await fn('is_manager_or_above', 'is_manager_or_above', {});
await fn('is_owner', 'is_owner', {});
await fn('set_user_role', 'set_user_role', { p_profile_id: NO_SUCH_ID, p_role: 'manager' });
/*
 * The owner guard inside the four payment RPCs cannot be seen from here. The
 * anon key is refused by the table grants underneath them long before
 * `is_owner()` is reached, and from outside a missing permission and a working
 * refusal are both 42501 — HANDOFF §6, the fence with no proven gate. The DO
 * block at the bottom of CATCH_UP_019 counts the guard from `prosrc` instead.
 */
console.log('  ?      the is_owner() guard in the 4 payment RPCs  — see §7 of CATCH_UP_019');
console.log('  ?      nobody left on the old role name            — see §7 of CATCH_UP_019');

console.log('\nCATCH_UP_020 — what is printed on a Deli invoice\n');
await column('businesses.contact_block', 'businesses', 'contact_block');
await column('businesses.bank_details',  'businesses', 'bank_details');
await fn('set_business_document', 'set_business_document', {
  p_business_id: NO_SUCH_ID,
  p_contact_block: null,
  p_bank_details: null,
});
/*
 * The thing this file must NOT have done is invisible from out here: an
 * UPDATE policy appearing on `businesses` would let somebody rename a
 * business from a browser, and every internal ref is built from `code`.
 * Absence of a policy cannot be probed with the anon key — it is refused
 * either way — so §3 of the SQL file raises on it instead.
 */
console.log('  ?      businesses still has no update policy  — see §3 of CATCH_UP_020');

console.log('\nCATCH_UP_021 — the wipe, from inside the app\n');
/*
 * Probed with a DELIBERATELY WRONG phrase.
 *
 * The anon key makes `auth.uid()` null, so `is_owner()` is false and the
 * function refuses with 42501 before it looks at anything else -- which is
 * already a safe probe. The wrong phrase is the second lock, so that even in
 * an impossible world where the first check passed, this call still cannot
 * delete a row. Every probe in this file is a no-op on purpose, and for this
 * one function that discipline is the difference between a check and an
 * accident.
 */
await fn('wipe_everything', 'wipe_everything', { p_confirm: 'not the phrase' });
/*
 * Not probable from out here, and both matter:
 *   - that it is SECURITY DEFINER (without it the deletes silently do nothing,
 *     because RLS hides the rows and `delete` does not complain)
 *   - that `activity_log` still has no INSERT policy
 * §3 of the SQL file raises on both instead.
 */
console.log('  ?      wipe_everything is security definer     — see §3 of CATCH_UP_021');
console.log('  ?      activity_log still has no insert policy — see §3 of CATCH_UP_021');

console.log('\nCATCH_UP_022 — a fourth tier: assistant\n');
/*
 * Probed against an id that cannot match, like every other function here, so
 * finding out whether it exists can never change a row.
 */
await fn('is_assistant', 'is_assistant', {});
/*
 * `set_user_role` is re-probed with the NEW value. It existed before 022 and
 * refused 'assistant' with 22023; after 022 it refuses an anonymous caller
 * with 42501 first. Both are a refusal, so this line proves the function is
 * there and not which version it is -- the role constraint below is what
 * separates them, and it needs a session.
 */
await fn('set_user_role', 'set_user_role', { p_profile_id: NO_SUCH_ID, p_role: 'assistant' });
/*
 * Not probable from out here, and each matters:
 *   - the check constraint actually allows 'assistant'
 *   - six assistant_read policies and two assistant_insert, and NO assistant
 *     policy that can UPDATE or DELETE — the absence is the whole tier
 *   - `is_manager_or_above()` still does NOT mention assistant, or every
 *     `for all` policy in the database has silently included it
 * §8 of the SQL file raises on all of them.
 */
console.log('  ?      profiles_role_valid allows assistant     — see §8 of CATCH_UP_022');
console.log('  ?      8 assistant policies, none that write    — see §8 of CATCH_UP_022');
console.log('  ?      is_manager_or_above() excludes assistant — see §8 of CATCH_UP_022');

console.log('\nCATCH_UP_023 — J5: discounts and refunds\n');
await relation('sales_invoice_adjustments', 'sales_invoice_adjustments');
/*
 * Both probes are no-ops twice over. `is_manager_or_above()` is checked before
 * anything else in each function, and the anon key makes `auth.uid()` null, so
 * they refuse with 42501 before reading a row -- and the ids passed cannot
 * match anything anyway.
 */
await fn('add_sales_adjustment', 'add_sales_adjustment', {
  p_id: NO_SUCH_ID,
  p_invoice_id: NO_SUCH_ID,
  p_kind: 'discount',
  p_amount_cents: 1,
  p_reason: 'probe',
});
await fn('void_sales_adjustment', 'void_sales_adjustment', {
  p_id: NO_SUCH_ID,
  p_reason: 'probe',
});
/*
 * Not probable from out here, and the first is the whole guarantee:
 *   - the table has NO insert, update or delete policy, so the two functions
 *     above are its only writers and an adjustment cannot be rewritten later
 *   - profiles.accent no longer holds hex (§5 of the file)
 * §6 of the SQL file raises on both.
 */
console.log('  ?      no write policy on the adjustments  — see §5 of CATCH_UP_023');
console.log('  ?      no profile still holds a hex accent — see §3 of CATCH_UP_024');

console.log('\nCATCH_UP_025 — suspending an account\n');
/*
 * A no-op twice over, like every probe here. `is_owner()` is checked before
 * anything else and the anon key makes `auth.uid()` null, so it refuses with
 * 42501 before reading a row -- and the id cannot match anything anyway.
 */
await fn('set_user_active', 'set_user_active', { p_profile_id: NO_SUCH_ID, p_active: true });
/*
 * Not probable from out here, and the second is the one that would make every
 * refusal in the function decorative:
 *   - it is SECURITY DEFINER, or it could not write at all
 *   - `authenticated` still has NO update grant on profiles.active, so the
 *     function is the only door
 * §3 of the SQL file raises on both.
 */
console.log('  ?      set_user_active is security definer      — see §3 of CATCH_UP_025');
console.log('  ?      profiles.active is still not grantable   — see §3 of CATCH_UP_025');

console.log('\nCATCH_UP_026 — an assistant on "Supplier not listed" waits for review\n');
/*
 * Nothing new to probe, and that is the honest report rather than a gap.
 *
 * This file adds no table, no view and no function — it REPLACES the body of
 * `stamp_approval`, which has existed since CATCH_UP_013. A probe from out
 * here can only find out that a function exists, and it existed before; it
 * cannot read a body, and `pg_get_functiondef` is not reachable with the anon
 * key. So a green line here would be a claim, not a check — which is exactly
 * what §43.2 caught this file doing across five migrations.
 *
 * The three facts that actually matter are all read out of the function's
 * source by §3 of the SQL file, which raises on each:
 *   - it asks `is_assistant()` at all, or the file did not apply
 *   - it looks at `is_placeholder`, or it holds back EVERY assistant entry
 *     and CATCH_UP_022 §5's decision is silently reversed
 *   - it still holds a shop back, or CATCH_UP_013 has been undone
 */
console.log('  ?      stamp_approval asks is_assistant()       — see §3 of CATCH_UP_026');
console.log('  ?      ...and narrows it with is_placeholder    — see §3 of CATCH_UP_026');
console.log('  ?      ...and a shop still waits, as before     — see §3 of CATCH_UP_026');
console.log('  ?      nothing stranded on the placeholder      — see §5 of CATCH_UP_026');

console.log("\nCATCH_UP_027 — settled money is none of an assistant's business\n");
/*
 * Existence only, and this one answers DIFFERENTLY from every other probe in
 * this file. Read the line before assuming it is wrong.
 *
 * `find_duplicate_invoices_staff` comes back "exists, refused (42501)".
 * This one comes back a plain "exists" — no error, no rows — and the
 * difference is evaluation order, not permissions:
 *
 *   the staff version compares `i.business_id = staff_venue()`, so
 *   `staff_venue()` MUST be evaluated to make the comparison, and it refuses
 *
 *   this one carries `is_assistant()` as its own conjunct, and the probe
 *   passes an id that matches nothing — so the planner satisfies the WHERE
 *   on the id alone and never has to evaluate the guard
 *
 * **That is not a hole, and the reasoning is the point.** For any row to be
 * RETURNED every conjunct must be true, so `is_assistant()` is evaluated the
 * moment it could matter — and it is false for anon, for a venue and for a
 * manager. The only case it is skipped is the case that returns nothing
 * anyway. Zero rows either way.
 *
 * So this line proves the function is there and nothing else. That the guard
 * is IN it is read out of the function source by §5 of the SQL file, which is
 * the half that has to be run in Supabase.
 *
 * Why the function exists at all: narrowing the assistant SELECT policy would
 * otherwise have narrowed the duplicate check with it, because
 * `find_duplicate_invoices` is security invoker over `setof invoices` — an
 * assistant would simply stop being warned about an invoice already paid.
 * CATCH_UP_010 §5 hit the same wall for the shops.
 */
await fn('find_duplicate_invoices_assistant', 'find_duplicate_invoices_assistant', {
  p_supplier_id: NO_SUCH_ID,
  p_invoice_number: 'probe',
  p_lookback_days: 1,
});
console.log('  ?      assistant_read on invoices excludes paid          — see §5 of CATCH_UP_027');
console.log('  ?      ...and the log excludes payment_ref too           — see §5 of CATCH_UP_027');
console.log('  ?      the duplicate function has an is_assistant() guard — see §5 of CATCH_UP_027');

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
