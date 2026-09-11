-- ===========================================================================
-- CATCH_UP_030 — the wipe, and the ten deletes with no WHERE
--
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- It deletes NOTHING. It replaces one function and then reports what is
-- currently in the tables. Read the table it returns at the end.
--
-- ---------------------------------------------------------------------------
-- What happened
--
-- The wipe was run for the first time and came back saying a WHERE clause was
-- missing or required.
--
-- `wipe_everything` (CATCH_UP_021) clears ten tables with bare statements —
-- `delete from invoices;` and nine more. That is ordinary SQL and it is what
-- the function is FOR. But Supabase can run with the **safeupdate** library
-- preloaded for the session (`ALTER ROLE authenticator SET
-- session_preload_libraries = 'safeupdate'`), and that library exists to
-- refuse exactly this:
--
--     ERROR: DELETE requires a WHERE clause
--
-- It is a guard against a mistyped ad-hoc statement emptying a table, and it
-- is a good guard. It cannot tell the difference between that and a function
-- whose entire purpose is to empty ten tables — and `SECURITY DEFINER` does
-- not exempt it, because the library is loaded per SESSION, by the role the
-- app connects as, not per function.
--
-- **The remedy is to say `where true`.** It changes nothing about what is
-- deleted; it states the intent explicitly, which is all the guard is asking
-- for. Every delete below is otherwise character-for-character what
-- CATCH_UP_021 shipped.
--
-- ---------------------------------------------------------------------------
-- "It only wiped some part" — almost certainly not, and §1 settles it
--
-- A plpgsql function is one transaction. If a delete raised, every delete
-- before it was rolled back with it, and the honest expectation is that
-- **nothing was deleted at all**. CATCH_UP_021 says so in its own comment:
-- "either all of this happens or none of it does, and there is no half-wiped
-- state."
--
-- What can look like a partial wipe: the app clears its own cached data and
-- the on-disk queue, and a screen that has emptied on the phone is very
-- convincing. That clearing only runs on SUCCESS (`lib/queries/wipe.ts`), so
-- it should not have happened either — but a refresh, a sign-out, or simply
-- being on a screen whose query returned nothing all read the same way.
--
-- §1 does not argue about it. It counts the rows and shows them.
--
-- If the counts come back mixed — some tables empty, some not — then this was
-- NOT the app's wipe and something ran statements by hand, one at a time,
-- where each commits on its own. Say so and do not run anything else; a
-- half-empty ledger is a different problem from this one and wants looking at
-- rather than patching.
-- ===========================================================================


-- ===========================================================================
--  1. THE FUNCTION, RESTATED WITH `where true`
--
--  Restated whole because that is the only way a function can be changed, and
--  CATCH_UP_029 §"A trigger, NOT an edit to wipe_everything" said plainly that
--  restating this one is the risk it wanted to avoid. It is being taken
--  deliberately now, because the function is broken and the alternative is a
--  wipe nobody can run.
--
--  **Every line below is CATCH_UP_021's, unchanged, except the ten `where
--  true` additions.** Diff it against that file before running if you want to
--  satisfy yourself — that is a reasonable thing to want.
--
--  The two properties it must not lose, restated so they can be checked by
--  eye: it is still `security definer` (as invoker it would delete nothing and
--  report success, because RLS hides the rows and DELETE does not complain
--  about rows it cannot see), and it is still gated on `is_owner()`.
-- ===========================================================================

create or replace function wipe_everything(p_confirm text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor   uuid := auth.uid();
  v_counts  jsonb;
begin
  -- Who. `is_owner()` is true for 'owner' and 'builder' (CATCH_UP_019 §4).
  if not is_owner() then
    raise exception 'Only the owner can clear the records.' using errcode = '42501';
  end if;

  -- The phrase, asked a second time. Not security — the phrase is in the
  -- client bundle. Protection against the call being made by ACCIDENT.
  if p_confirm is distinct from 'Wipe everything' then
    raise exception 'That is not the confirmation phrase.' using errcode = '22023';
  end if;

  -- Counted BEFORE the deletes, because afterwards there is nothing to count.
  select jsonb_build_object(
           'invoices',       (select count(*) from invoices),
           'sales_invoices', (select count(*) from sales_invoices),
           'suppliers',      (select count(*) from suppliers),
           'customers',      (select count(*) from customers),
           'products',       (select count(*) from products)
         )
    into v_counts;

  -- -------------------------------------------------------------------------
  -- Order matters and is not alphabetical: a row cannot be deleted while
  -- another points at it.
  --
  -- `where true` on every one of them. It selects the same rows a bare delete
  -- does — all of them — and it is the difference between this function
  -- working and this function raising under the safeupdate guard. The header
  -- has the full account.
  -- -------------------------------------------------------------------------
  delete from sales_invoice_lines    where true;  -- explicit, though the cascade covers it
  delete from sales_invoices         where true;
  delete from sales_invoice_counters where true;

  delete from invoice_notes          where true;  -- explicit, though the cascade covers it
  delete from invoices               where true;
  delete from invoice_ref_counters   where true;

  delete from activity_log           where true;

  delete from products               where true;
  delete from customers              where true;
  delete from suppliers              where true;

  -- -------------------------------------------------------------------------
  -- The one row that survives its own deletion. §44.2 at its limit: a wipe is
  -- the largest thing anybody can do, and the log it would appear in is one of
  -- the things it destroys — so the record is written back afterwards, naming
  -- who did it and what was there.
  --
  -- `entity_type` is 'system', which is what keeps it out of every screen:
  -- `useInvoiceActivity` and `useRecentActivity` both filter on 'invoice'.
  -- -------------------------------------------------------------------------
  insert into activity_log (entity_type, entity_id, action, actor_id, detail)
  values ('system', v_actor, 'wiped', v_actor, v_counts);

  return v_counts;
end;
$fn$;


-- ===========================================================================
--  2. VERIFICATION — raises, because a notice is invisible here (§59)
-- ===========================================================================
do $$
declare
  v_src text;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'wipe_everything';

  if v_src is null then
    raise exception 'wipe_everything is gone — CATCH_UP_021 has not been run';
  end if;

  /*
   * No bare delete survives anywhere in the body.
   *
   * Asked as "is there a delete with no WHERE" rather than "are there ten
   * `where true`s", and the difference is not pedantry — the first version of
   * this check counted the string and would have refused its own file,
   * because `pg_get_functiondef` returns the COMMENTS too and the one above
   * the deletes says `where true` in prose. Counting a string that appears in
   * both code and commentary is counting the wrong thing.
   *
   * This tests the property that matters: a `delete from <table>;` with
   * nothing between the table and the semicolon is the shape the guard
   * refuses, and there must not be one.
   */
  if v_src ~* 'delete\s+from\s+[a-z_][a-z0-9_]*\s*;' then
    raise exception
      'wipe_everything still contains a bare delete — the safeupdate guard would refuse it';
  end if;

  -- And all ten tables are still cleared. A `where true` that arrived by
  -- deleting a delete would pass the check above and empty nothing.
  if (length(lower(v_src)) - length(replace(lower(v_src), 'delete from', '')))
     / length('delete from') <> 10 then
    raise exception
      'wipe_everything no longer clears exactly ten tables — CATCH_UP_021 cleared ten';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'wipe_everything' and p.prosecdef
  ) then
    raise exception 'wipe_everything is no longer SECURITY DEFINER — it would delete nothing and report success';
  end if;

  if v_src not like '%is_owner()%' then
    raise exception 'wipe_everything is no longer gated on is_owner()';
  end if;

  if v_src not like '%Wipe everything%' then
    raise exception 'wipe_everything no longer asks for the confirmation phrase';
  end if;
end $$;


-- ===========================================================================
--  3. WHAT IS ACTUALLY IN THE TABLES
--
--  A select, not a notice — §59: the Supabase editor shows grids and errors
--  and swallows everything else.
--
--  Read `rows`. If they are all non-zero, nothing was wiped and the
--  transaction rolled back exactly as it should have. If they are all zero,
--  the wipe ran. **If they are mixed, stop** — that is a half-empty ledger and
--  it did not come from this function.
-- ===========================================================================
select 1 as n, 'invoices'              as table_name, count(*) as rows from invoices
union all
select 2, 'invoice_notes',        count(*) from invoice_notes
union all
select 3, 'invoice_ref_counters', count(*) from invoice_ref_counters
union all
select 4, 'sales_invoices',       count(*) from sales_invoices
union all
select 5, 'sales_invoice_lines',  count(*) from sales_invoice_lines
union all
select 6, 'sales_invoice_counters', count(*) from sales_invoice_counters
union all
select 7, 'suppliers',            count(*) from suppliers
union all
select 8, 'customers',            count(*) from customers
union all
select 9, 'products',             count(*) from products
union all
select 10, 'activity_log',        count(*) from activity_log
union all
select 11, 'profiles (never wiped)', count(*) from profiles
union all
select 12, 'businesses (never wiped)', count(*) from businesses
order by n;


-- ---------------------------------------------------------------------------
-- Afterwards
--
-- Send me the table. Then, if you still want the ledger empty, run the wipe
-- from Settings again — it is four acts and the phrase, exactly as before, and
-- it should now complete and return its receipt.
--
-- The placeholder supplier comes back on its own: CATCH_UP_029's trigger fires
-- on the `delete from suppliers` above and re-seeds "Supplier not listed"
-- inside the same transaction. That is the first time that trigger will have
-- done its job for real, and row 19 of `verify_catchups.sql` is how to confirm
-- it did.
-- ---------------------------------------------------------------------------
