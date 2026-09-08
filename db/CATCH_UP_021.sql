-- ===========================================================================
-- CATCH_UP_021 — the wipe, from inside the app
--
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- RUN THIS **BEFORE** THE DEPLOY. It is the safe order and not a preference,
-- though for once the reason is mild: this file only adds a function, and the
-- live app version never calls it, so running it early is invisible. Deployed
-- first with the file not run, the wipe button raises 42883 the first time
-- somebody reaches the end of a four-step confirmation, which is the worst
-- possible moment to discover a missing function.
--
-- **Nothing below deletes anything when you run it.** It creates a function
-- that can. Read §2 before you run that function for the first time.
--
-- ---------------------------------------------------------------------------
-- What this is for
--
-- J4, ARCHITECTURE §44.5 and §49.5. `db/RESET_TO_CLEAN_SLATE.sql` already
-- empties the app; it is a file run deliberately in another tool, and that
-- friction was doing real work. The client was told so, and answered with a
-- better design than the objection:
--
--   1. Confirm.
--   2. Type "Wipe everything".
--   3. Be offered the full export first — take it or decline it.
--   4. Then wipe.
--
-- Four conscious acts cannot be butter fingers.
--
-- ---------------------------------------------------------------------------
-- Rule 5 says nothing is ever deleted. THIS IS ITS ONE EXCEPTION.
--
-- Named here so it stays an exception rather than becoming a precedent. Every
-- other destructive-looking thing in this app is a void with a reason or a
-- deactivation, and must remain so. If a second `delete` ever appears in a
-- function, the question to ask is why it is not a void.
-- ===========================================================================


-- ===========================================================================
--  1. THE FUNCTION
--
--  It deletes EXACTLY what `db/RESET_TO_CLEAN_SLATE.sql` deletes, in exactly
--  that order, and keeps exactly what that file keeps. The two are meant to
--  stay identical: if one is ever changed, change both, or the app and the
--  SQL file mean different things by "empty".
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
  -- -------------------------------------------------------------------------
  -- Who. `is_owner()` is true for 'owner' and 'builder' (CATCH_UP_019 §4), and
  -- this is one of the six allowlists §46.3 names — written as
  -- `is_owner()` rather than as a role comparison, so a tier invented later
  -- is excluded by default rather than admitted by default.
  -- -------------------------------------------------------------------------
  if not is_owner() then
    raise exception 'Only the owner can clear the records.' using errcode = '42501';
  end if;

  -- -------------------------------------------------------------------------
  -- The phrase, asked for a second time.
  --
  -- The app already makes somebody type this. Asking again here is NOT
  -- security -- the phrase is in the client bundle and anybody reading it can
  -- send it. It is protection against the call being made by ACCIDENT: a
  -- retried request, a stray tap resumed from a queue, a script written
  -- against the schema by somebody who did not read this file. A function
  -- named `wipe_everything` that fires on an empty argument list is one
  -- mistyped line away from an empty database.
  --
  -- Case-sensitive and exact. "wipe everything" does not run it.
  -- -------------------------------------------------------------------------
  if p_confirm is distinct from 'Wipe everything' then
    raise exception 'That is not the confirmation phrase.' using errcode = '22023';
  end if;

  -- -------------------------------------------------------------------------
  -- Counted BEFORE the deletes, because afterwards there is nothing to count.
  --
  -- This is what the screen says happened, and it is the only receipt anybody
  -- gets. `count(*)` over an empty table is 0, so a second run reports four
  -- zeros rather than failing -- the file is idempotent in the way that
  -- matters, which is that running it twice is not a different event from
  -- running it once.
  -- -------------------------------------------------------------------------
  select jsonb_build_object(
           'invoices',       (select count(*) from invoices),
           'sales_invoices', (select count(*) from sales_invoices),
           'suppliers',      (select count(*) from suppliers),
           'customers',      (select count(*) from customers),
           'products',       (select count(*) from products)
         )
    into v_counts;

  -- -------------------------------------------------------------------------
  -- Order matters, and it is not alphabetical: a row cannot be deleted while
  -- another points at it. The two that cascade are named anyway, so anybody
  -- reading this can see they were thought about rather than forgotten.
  --
  -- `activity_log.entity_id` is a plain uuid with no foreign key, so NO
  -- cascade would clear it -- leaving a readable history of invoices that no
  -- longer exist.
  --
  -- One statement block, one transaction. A function is atomic by nature, so
  -- unlike the SQL file there is no `begin`/`commit` to forget: either all of
  -- this happens or none of it does, and there is no half-wiped state.
  -- -------------------------------------------------------------------------
  delete from sales_invoice_lines;      -- explicit, though the cascade covers it
  delete from sales_invoices;
  delete from sales_invoice_counters;

  delete from invoice_notes;            -- explicit, though the cascade covers it
  delete from invoices;
  delete from invoice_ref_counters;

  delete from activity_log;

  delete from products;
  delete from customers;
  delete from suppliers;

  -- -------------------------------------------------------------------------
  -- The one row that survives its own deletion.
  --
  -- §44.2's rule, at its limit: an account that can change money and leaves no
  -- trace makes the audit trail lie. A wipe is the largest thing anybody can
  -- do in this app, and the log it would appear in is one of the things it
  -- destroys -- so the record is written back afterwards, into the empty
  -- table, naming who did it and what was there.
  --
  -- `entity_type` is 'system', and that is what keeps it out of every screen:
  -- `useInvoiceActivity` and `useRecentActivity` both filter
  -- `entity_type = 'invoice'`, so this row is invisible to the bell, to the
  -- panel and to every invoice stream, and no renderer has to learn a word for
  -- it. It exists for whoever opens the database and asks what happened.
  --
  -- `entity_id` is the actor's own profile id. The column is `not null` and
  -- there is no entity; pointing it at the person is the only value that is
  -- true rather than invented.
  --
  -- `activity_log` has a select policy and no insert policy -- migration 007's
  -- rule that the only writer is the trigger, because a log you can write to
  -- by hand is not a log. This insert happens under `security definer`, which
  -- is the same door the trigger uses, and there is still no way to write a
  -- row from a browser.
  -- -------------------------------------------------------------------------
  insert into activity_log (entity_type, entity_id, action, actor_id, detail)
  values ('system', v_actor, 'wiped', v_actor, v_counts);

  return v_counts;
end;
$fn$;

comment on function wipe_everything(text) is
  'Rule 5''s one exception. Empties the ledger, keeps the logins, businesses, '
  'push subscriptions and uploaded artwork. Owner only. ARCHITECTURE §49.5.';

-- CATCH_UP_011's default, applied here too: nothing anonymous may reach this.
revoke execute on function wipe_everything(text) from public, anon;
grant  execute on function wipe_everything(text) to   authenticated;


-- ===========================================================================
--  2. BEFORE ANYBODY RUNS THE WIPE — the thing that actually matters
--
--  This is `RESET_TO_CLEAN_SLATE.sql` §1 repeated, because it is now reachable
--  from a phone by somebody who has not read a SQL file.
--
--  Every phone with the app installed can hold WORK THAT HAS NOT BEEN SENT.
--  That is the offline queue and it is the whole point of it: an invoice typed
--  in a cold room with no signal is kept and sent later.
--
--  A queued invoice does not know the wipe happened. If somebody has unsent
--  work and opens the app afterwards, it will be sent, and there will be one
--  invoice in an otherwise empty ledger.
--
--  So, on EVERY phone that has the app, before the wipe:
--
--    1. Open the app with signal.
--    2. Look at the wifi symbol in the top bar. A number beside it is how many
--       things are still waiting. Wait until the number is gone.
--    3. Then leave it alone until the wipe is done.
--
--  Afterwards everyone should close the app completely and reopen it. It
--  remembers the last screen it drew, so for a few seconds it shows invoices
--  that no longer exist. That is a stale picture, not a failed wipe.
--
--  The app says all of this in the confirmation, and the device that runs the
--  wipe clears its own queue and cache. **It cannot reach anybody else's.**
-- ===========================================================================


-- ===========================================================================
--  3. CHECK IT WORKED
--
--  Raises rather than returning rows, so a failure cannot be scrolled past.
--  None of this calls the function.
-- ===========================================================================

do $$
declare
  v_fn  int;
  v_pol int;
begin
  select count(*) into v_fn from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'wipe_everything';

  if v_fn <> 1 then
    raise exception 'wipe_everything is missing';
  end if;

  -- It must be SECURITY DEFINER, or it deletes nothing and reports success:
  -- RLS would refuse most of the rows and `delete` does not complain about
  -- rows it cannot see.
  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'wipe_everything' and p.prosecdef
  ) then
    raise exception 'wipe_everything is not security definer — it would silently do nothing';
  end if;

  -- The thing this file must NOT have done. `activity_log` gaining an insert
  -- policy would mean a log somebody can write to by hand, which is not a log.
  select count(*) into v_pol
    from pg_policies
   where schemaname = 'public' and tablename = 'activity_log'
     and cmd in ('INSERT', 'ALL');

  if v_pol <> 0 then
    raise exception 'activity_log has gained an insert policy — that is wrong';
  end if;

  raise notice 'ok — the wipe exists, is owner-only, and nothing has been deleted';
end $$;

-- ---------------------------------------------------------------------------
-- What you should SEE afterwards. Signed in as Milan or Sujan, this must be
-- REFUSED with 42501, and must delete nothing:
--
--   select wipe_everything('Wipe everything');
--
-- And signed in as the owner, this must be refused with 22023 — also
-- deleting nothing, which is the point of testing it this way round:
--
--   select wipe_everything('wipe everything');
-- ---------------------------------------------------------------------------
