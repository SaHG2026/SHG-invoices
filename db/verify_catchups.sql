-- ============================================================================
--  VERIFY — which CATCH_UP files this database has actually had run.
--
--  Supabase SQL editor -> New query -> paste all of this -> Run.
--  Send me the result table.
--
--  This READS ONLY. There is no insert, update, delete, create or drop in it
--  anywhere, so it is safe to run at any time, twice, or on a live database
--  while somebody is using the app.
--
--  Expected result: every row says "ok". Anything saying MISSING names the
--  file that has not been run.
--
--  Why this file exists at all: the migrations go in by hand, so nothing on my
--  side knows what the database has got. `node db/verify_catchups.mjs` can see
--  which TABLES exist from outside, but not indexes, grants or row contents —
--  RLS correctly hides those from the anon key. This runs as a real session,
--  so it can see the rest.
-- ============================================================================

select * from (

  -- ---------------------------------------------------------------- 001 ----
  select 1 as n, 'CATCH_UP_001' as file, 'profiles.notify_on_new_invoice' as thing,
         case when exists (
           select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'profiles'
              and column_name = 'notify_on_new_invoice'
         ) then 'ok' else 'MISSING' end as result,
         'the per-person notification setting' as detail

  union all
  -- The grant is a separate mechanism from the policy and does a different
  -- job: the policy decides which ROW you may touch, the grant decides which
  -- COLUMN you may set. Without it a person could rename themselves or make
  -- themselves owner. ARCHITECTURE §8.1.
  select 2, 'CATCH_UP_001', 'update grant on that one column',
         case when exists (
           select 1 from information_schema.column_privileges
            where table_schema = 'public' and table_name = 'profiles'
              and column_name = 'notify_on_new_invoice'
              and grantee = 'authenticated' and privilege_type = 'UPDATE'
         ) then 'ok' else 'MISSING' end,
         'so people can change their own setting and nothing else'

  union all
  select 3, 'CATCH_UP_001', 'push_subscriptions table',
         case when to_regclass('public.push_subscriptions') is null
              then 'MISSING' else 'ok' end,
         'empty until Phase 7 — one row per person per device'

  union all
  select 4, 'CATCH_UP_001', 'push_targets view',
         case when to_regclass('public.push_targets') is null
              then 'MISSING' else 'ok' end,
         'who gets told when an invoice is added'

  -- ---------------------------------------------------------------- 002 ----
  -- The unique index is the real defence, not the function fix. The generator
  -- is correct as far as I can reason about it, but so was the last version.
  union all
  select 5, 'CATCH_UP_002', 'unique index on invoices.internal_ref',
         case when exists (
           select 1 from pg_indexes
            where schemaname = 'public' and tablename = 'invoices'
              and indexdef ilike '%unique%' and indexdef ilike '%internal_ref%'
         ) then 'ok' else 'MISSING' end,
         'two invoices can never claim the same reference'

  union all
  -- Proof in the data rather than in the schema: if the old truncating version
  -- ever ran at volume, this finds what it left behind.
  select 6, 'CATCH_UP_002', 'no duplicate references in the data',
         case when (
           select count(*) from (
             select internal_ref from invoices
              group by internal_ref having count(*) > 1
           ) dupes
         ) = 0 then 'ok' else 'FOUND DUPLICATES' end,
         'checks every invoice row, not just the schema'

  -- ---------------------------------------------------------------- 003 ----
  union all
  -- Accents became slot names so that hex lives only in app/globals.css. The
  -- app tolerates the old hex values, so a MISSING here is not urgent — it
  -- means the attribution chips fall back to a slot derived from the id.
  select 7, 'CATCH_UP_003', 'accents stored as person-1..4, not hex',
         case when (
           select count(*) from profiles where accent not like 'person-%'
         ) = 0 then 'ok' else 'MISSING' end,
         (select coalesce(string_agg(display_name || '=' || accent, ', '
                                     order by display_name), 'all four converted')
            from profiles where accent not like 'person-%')

  -- ---------------------------------------------------------------- 004 ----
  union all
  select 8, 'CATCH_UP_004', 'customers table',
         case when to_regclass('public.customers') is null
              then 'MISSING' else 'ok' end,
         'without it the Customers screen cannot load at all'

  union all
  select 9, 'CATCH_UP_004', 'RLS switched on for customers',
         case when coalesce(
           (select relrowsecurity from pg_class
             where oid = to_regclass('public.customers')), false)
         then 'ok' else 'MISSING' end,
         'a table without RLS is readable by the anon key in every phone'

  -- ---------------------------------------------------------------- 005 ----
  union all
  select 10, 'CATCH_UP_005', 'sales_invoices table',
         case when to_regclass('public.sales_invoices') is null
              then 'MISSING' else 'ok' end,
         'what customers owe — until it exists every receivable reads zero'

  union all
  select 11, 'CATCH_UP_005', 'RLS switched on for sales_invoices',
         case when coalesce(
           (select relrowsecurity from pg_class
             where oid = to_regclass('public.sales_invoices')), false)
         then 'ok' else 'MISSING' end,
         'same reason as customers'

  union all
  select 12, 'CATCH_UP_005', 'mark_sales_received / unmark_sales_received',
         case when (
           select count(*) from pg_proc p
             join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public'
              and p.proname in ('mark_sales_received', 'unmark_sales_received')
         ) = 2 then 'ok' else 'MISSING' end,
         'recording that a customer has paid'

) checks
order by n;
