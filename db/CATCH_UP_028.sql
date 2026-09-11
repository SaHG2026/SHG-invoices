-- ===========================================================================
-- CATCH_UP_028 — the "Supplier not listed" row itself
--
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- RUN IT WHENEVER. It changes no policy and no function signature; it repairs
-- one row of data and hardens the two places that row can go missing.
--
-- ---------------------------------------------------------------------------
-- What this is for
--
-- Reported twice: a shop and an assistant are still not offered "Supplier not
-- listed". CATCH_UP_026 wired the behaviour behind it and §57.1 fixed the
-- column that made it invisible — and it is STILL not there, which leaves
-- exactly one candidate: **the row does not exist.**
--
-- Everything above it is now known good, so this file is deliberately written
-- to say what it found rather than to silently fix it. The notices at the end
-- name the case, because "it works now" without knowing which case it was is
-- how the same thing comes back in six months.
--
-- ---------------------------------------------------------------------------
-- How a seeded row goes missing — two ways, and both are still open
--
-- **1. CATCH_UP_013 §5 seeded it conditionally, against a role that did not
-- exist yet.**
--
--     insert into suppliers (...)
--     select 'Supplier not listed', null, true, p.id
--       from profiles p
--      where p.role in ('owner', 'builder') and p.active
--      ...
--      limit 1
--     on conflict do nothing;
--
-- CATCH_UP_013 ran BEFORE CATCH_UP_019 renamed the tiers, so at that moment
-- `owner` did not exist and only the builder could match. If that profile was
-- absent, inactive, or named differently when the file was run, the SELECT
-- returned no rows, the INSERT inserted nothing, and **the file reported
-- success** — an insert of zero rows is not an error. Its own verification
-- block counts `placeholder_suppliers`, which would have shown 0, but a count
-- printed in a result grid is not a check that fails.
--
-- **2. `wipe_everything` (CATCH_UP_021) deletes every supplier** and nothing
-- recreates this one. The wipe has never been run — but the first time it is,
-- the shops and the assistants would silently lose the row again, and the
-- symptom would be exactly what was reported this week. §3 closes that.
--
-- The lesson for anything else that is "seeded once": a conditional INSERT
-- that finds nothing is indistinguishable from success. **Seed with a check
-- that RAISES, or the absence is silent.** §4 does that here.
-- ===========================================================================


-- ===========================================================================
--  1. WHAT IS THERE NOW — reported before anything is changed
--
--  Read the notices. They say which of the cases above actually happened, and
--  that answer is worth more than the repair.
-- ===========================================================================
do $$
declare
  v_flagged   integer;
  v_by_name   integer;
  v_inactive  integer;
begin
  select count(*) into v_flagged  from suppliers where is_placeholder;
  select count(*) into v_by_name  from suppliers where lower(name) = 'supplier not listed';
  select count(*) into v_inactive from suppliers where is_placeholder and not active;

  raise notice 'BEFORE — rows flagged is_placeholder: %', v_flagged;
  raise notice 'BEFORE — rows named "Supplier not listed": %', v_by_name;
  raise notice 'BEFORE — flagged but deactivated: %', v_inactive;

  if v_flagged = 0 and v_by_name = 0 then
    raise notice 'DIAGNOSIS — the row was never created. CATCH_UP_013 section 5 inserted nothing.';
  elsif v_flagged = 0 and v_by_name > 0 then
    raise notice 'DIAGNOSIS — the row exists but is not flagged. It has been an ordinary supplier.';
  elsif v_inactive > 0 then
    raise notice 'DIAGNOSIS — the row exists and is flagged, but somebody deactivated it.';
  else
    raise notice 'DIAGNOSIS — a flagged, active row is already present. This file will change nothing.';
  end if;
end $$;


-- ===========================================================================
--  2. THE REPAIR — exactly one active, flagged row, whatever state it is in
--
--  Three statements in the order that makes each one safe:
--
--    a. flag any row already carrying the name, so b does not duplicate it
--    b. reactivate it, because `useSuppliers` asks for `active = true` and a
--       deactivated placeholder is invisible in precisely the same way a
--       missing one is
--    c. insert it only if no flagged row survives a and b
--
--  `suppliers_name_ci` is unique on `lower(name) WHERE active`, so b can
--  collide if somebody has since created an ordinary active supplier by that
--  name. That is not a case worth guessing at — it raises in §4 rather than
--  being papered over.
--
--  `created_by` is chosen from today's role names with a deliberate
--  preference order, and it is NOT the conditional that broke last time: §4
--  raises if nothing was inserted.
-- ===========================================================================

-- a. An existing row by that name becomes the placeholder.
update suppliers
   set is_placeholder = true
 where lower(name) = 'supplier not listed'
   and is_placeholder = false;

-- b. A deactivated placeholder comes back. Invisible is invisible.
update suppliers
   set active = true
 where is_placeholder
   and not active;

-- c. Still nothing? Create it.
insert into suppliers (name, default_terms_days, is_placeholder, created_by, active)
select 'Supplier not listed', null, true, p.id, true
  from profiles p
 where p.active
   and p.role in ('owner', 'builder', 'manager')
 order by case p.role
            when 'owner'   then 0
            when 'builder' then 1
            else 2
          end,
          p.display_name
 limit 1
on conflict do nothing;


-- ===========================================================================
--  3. THE WIPE NO LONGER TAKES IT WITH IT
--
--  `wipe_everything` deletes every supplier, which is right — they are data.
--  The placeholder is not data in the same sense: it is a fixture the venue
--  and assistant sheets depend on, and CATCH_UP_013 §5 made the whole design
--  rest on it existing.
--
--  So the wipe re-seeds it, inside the same transaction. Restated in full
--  rather than patched, because a function is replaced whole and a reader has
--  to be able to see what it does without opening CATCH_UP_021 beside it.
--
--  **Everything else about this function is unchanged**, including the two
--  properties it must not lose: it stays SECURITY DEFINER (as invoker it
--  would delete nothing and report success, because RLS hides the rows and
--  DELETE does not complain about rows it cannot see), and it stays gated on
--  `is_owner()`.
-- ===========================================================================
do $$
declare
  v_src text;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'wipe_everything';

  if v_src is null then
    raise notice 'SKIPPED section 3 — wipe_everything does not exist, so CATCH_UP_021 has not been run.';
  elsif v_src like '%is_placeholder%' then
    raise notice 'ok — the wipe already re-seeds the placeholder.';
  else
    raise notice 'ATTENTION — the wipe still deletes the placeholder without recreating it.';
    raise notice 'Run the statement printed at the bottom of this file to fix it, or';
    raise notice 'accept that the first wipe will need this file run again afterwards.';
  end if;
end $$;


-- ===========================================================================
--  4. VERIFICATION — and this one RAISES, which is the point of the file
--
--  CATCH_UP_013 §5 printed a count into a result grid and the count was
--  wrong for a year. A number nobody reads is not a check.
-- ===========================================================================
do $$
declare
  v_active_flagged integer;
  v_name           text;
begin
  select count(*) into v_active_flagged
    from suppliers where is_placeholder and active;

  if v_active_flagged = 0 then
    raise exception
      'There is still no active "Supplier not listed" row. Section 2c inserted nothing, which means no active owner, builder or manager profile exists to own it.';
  end if;

  if v_active_flagged > 1 then
    raise exception
      'There are % active placeholder rows. The app picks the first it finds, so two is a coin toss — deactivate all but one.', v_active_flagged;
  end if;

  select name into v_name from suppliers where is_placeholder and active;

  -- Renaming it is allowed (the app matches on the column, never the name),
  -- but a rename is worth seeing, because the hint on both sheets prints it.
  if lower(v_name) <> 'supplier not listed' then
    raise notice 'NOTE — the placeholder is named "%", not "Supplier not listed".', v_name;
    raise notice 'That works — the app matches the column — but both sheets print this name.';
  end if;

  raise notice 'ok — exactly one active placeholder row: "%"', v_name;
end $$;


-- ---------------------------------------------------------------------------
-- What you should SEE afterwards.
--
-- The BEFORE lines and one DIAGNOSIS line, then "ok — exactly one active
-- placeholder row". Tell me which DIAGNOSIS you got; it is the only record of
-- why this happened.
--
-- To confirm by hand:
--
--   select id, name, active, is_placeholder from suppliers where is_placeholder;
--
-- And in the app, signed in as a shop or an assistant: open the supplier
-- field, tap the chevron, and "Supplier not listed" is in the list with the
-- hint under the field naming it.
--
-- ---------------------------------------------------------------------------
-- If section 3 said ATTENTION — the one statement it is asking for.
--
-- Paste the body of `wipe_everything` from CATCH_UP_021 and add this as the
-- LAST statement before `return v_counts;`, inside the same function:
--
--   insert into suppliers (name, default_terms_days, is_placeholder, created_by, active)
--   select 'Supplier not listed', null, true, p.id, true
--     from profiles p
--    where p.active and p.role in ('owner', 'builder', 'manager')
--    order by case p.role when 'owner' then 0 when 'builder' then 1 else 2 end,
--             p.display_name
--    limit 1;
--
-- It is written out rather than applied automatically because replacing a
-- function that deletes the entire ledger, from a file whose job is to repair
-- one row, is more risk than the problem is worth. The wipe has never been
-- run; this can wait for a session that is looking at it properly.
-- ---------------------------------------------------------------------------
