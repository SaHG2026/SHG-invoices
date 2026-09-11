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
--  Row 20 says `info`, not `ok`, because it is a COUNT and not a pass/fail —
--  a permanent "ok" in a column called result is a small lie. Read its
--  `detail`. Row 19 is pass/fail and also names the placeholder supplier.
--
--  THIS FILE EXISTS BECAUSE `RAISE NOTICE` IS INVISIBLE HERE. The Supabase
--  SQL editor shows result grids and errors, and swallows notices — so every
--  `raise notice 'ok'` in a CATCH_UP file has never been read by anybody. A
--  migration that wants to REPORT something has to end in a select, and its
--  checks have to `raise exception` to be felt at all.
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


  -- ---------------------------------------------------------------- 026 ----
  -- `stamp_approval` is a function BODY, so nothing outside the database can
  -- read it — `verify_catchups.mjs` says so and points here. These three are
  -- that half, and each failure is a different wrong behaviour rather than a
  -- missing feature, which is why they are separate rows.
  union all
  select 13, 'CATCH_UP_026', 'stamp_approval asks is_assistant()',
         case when (select pg_get_functiondef(p.oid) from pg_proc p
                      join pg_namespace ns on ns.oid = p.pronamespace
                     where ns.nspname = 'public' and p.proname = 'stamp_approval')
                   like '%is_assistant()%'
              then 'ok' else 'MISSING' end,
         'without it an assistant entry never waits for review'

  union all
  select 14, 'CATCH_UP_026', 'and narrows it with is_placeholder',
         case when (select pg_get_functiondef(p.oid) from pg_proc p
                      join pg_namespace ns on ns.oid = p.pronamespace
                     where ns.nspname = 'public' and p.proname = 'stamp_approval')
                   like '%is_placeholder%'
              then 'ok' else 'MISSING' end,
         'without it EVERY assistant entry queues — CATCH_UP_022 section 5 reversed by accident'

  union all
  select 15, 'CATCH_UP_026', 'and a shop still waits, as before',
         case when (select pg_get_functiondef(p.oid) from pg_proc p
                      join pg_namespace ns on ns.oid = p.pronamespace
                     where ns.nspname = 'public' and p.proname = 'stamp_approval')
                   like '%is_staff()%'
              then 'ok' else 'MISSING' end,
         'CATCH_UP_013 undone if this is missing'

  -- ---------------------------------------------------------------- 027 ----
  union all
  select 16, 'CATCH_UP_027', 'assistant_read on invoices excludes paid',
         case when (select qual from pg_policies
                     where tablename = 'invoices' and policyname = 'assistant_read')
                   like '%paid%'
              then 'ok' else 'MISSING' end,
         'settled money still readable by an assistant if this is missing'

  union all
  select 17, 'CATCH_UP_027', 'the log policy excludes payment_ref',
         case when (select qual from pg_policies
                     where tablename = 'activity_log' and policyname = 'assistant_read')
                   like '%payment_ref%'
              then 'ok' else 'MISSING' end,
         'a corrected payment reference logs as edited and would leak through'

  union all
  select 18, 'CATCH_UP_027', 'find_duplicate_invoices_assistant guarded',
         case when (select pg_get_functiondef(p.oid) from pg_proc p
                      join pg_namespace ns on ns.oid = p.pronamespace
                     where ns.nspname = 'public'
                       and p.proname = 'find_duplicate_invoices_assistant')
                   like '%is_assistant()%'
              then 'ok' else 'MISSING' end,
         'security definer with no guard would read the whole ledger'

  -- ---------------------------------------------------------------- 028 ----
  -- The row itself, and the answer to the question the NOTICEs were supposed
  -- to give and never did: a notice is invisible in the Supabase editor.
  union all
  select 19, 'CATCH_UP_028', 'exactly one active placeholder supplier',
         case (select count(*) from suppliers where is_placeholder and active)
           when 1 then 'ok'
           when 0 then 'MISSING'
           else 'TOO MANY'
         end,
         coalesce(
           'named: ' || (select name from suppliers
                          where is_placeholder and active
                          order by name limit 1),
           'no active placeholder row exists — a shop and an assistant have no way to file an unknown delivery')

  union all
  select 20, 'CATCH_UP_028', 'invoices filed against the placeholder',
         'info',
         'count: ' || (select count(*)::text from invoices i
                        join suppliers s on s.id = i.supplier_id
                       where s.is_placeholder and i.status <> 'void')
         || ' — any that are approved need a real supplier chosen on the invoice screen'

  -- ---------------------------------------------------------------- 029 ----
  union all
  select 21, 'CATCH_UP_029', 'suppliers_keep_placeholder trigger',
         case when exists (select 1 from pg_trigger
                            where tgname = 'suppliers_keep_placeholder'
                              and not tgisinternal)
              then 'ok' else 'MISSING' end,
         'without it the first wipe loses the row again'

  union all
  select 22, 'CATCH_UP_029', 'ensure_placeholder_supplier is security definer',
         case when exists (select 1 from pg_proc p
                             join pg_namespace ns on ns.oid = p.pronamespace
                            where ns.nspname = 'public'
                              and p.proname = 'ensure_placeholder_supplier'
                              and p.prosecdef)
              then 'ok' else 'MISSING' end,
         'as invoker it could not insert during a wipe'

) checks
order by n;
