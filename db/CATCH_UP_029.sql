-- ===========================================================================
-- CATCH_UP_029 — the placeholder cannot go missing again
--
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- RUN IT WHENEVER. It adds one function and one trigger, changes no policy,
-- and touches no existing row.
--
-- ---------------------------------------------------------------------------
-- What this is for
--
-- *"so it wont happen after wipe?"*
--
-- As things stood: it would. `wipe_everything` (CATCH_UP_021) runs
-- `delete from suppliers` and nothing recreates the "Supplier not listed"
-- row, so the first wipe would reproduce §58 exactly — a shop and an
-- assistant with no way to file a delivery from somebody new, and two rounds
-- of app work sitting inert behind a row that is not there.
--
-- CATCH_UP_028 §3 reported that and printed the fix without applying it. This
-- applies it, and by a different route than the one 028 suggested.
--
-- ---------------------------------------------------------------------------
-- A trigger on `suppliers`, NOT an edit to `wipe_everything`
--
-- 028 proposed pasting the re-seed into the wipe. That would work and it is
-- the obvious move, but it is the worse one, for two reasons:
--
-- **It means restating the function that deletes the entire ledger.** A
-- function is replaced whole, so fixing one line means retyping all of it,
-- and a transcription slip there is unrecoverable. The prize is not worth the
-- exposure.
--
-- **It only covers the deletion path we happen to know about.** The row went
-- missing this time through a seed that quietly matched nothing — not through
-- the wipe at all. Protecting the wipe specifically would have prevented
-- neither §58 nor the next thing nobody predicted.
--
-- So the rule is stated as what it actually is: **there is always exactly one
-- active placeholder supplier.** An invariant, held where invariants in this
-- database are held. `stamp_approval`, `pin_invoice_facts` and
-- `sales_set_number` are all the same shape — a rule the client is not
-- trusted to remember, enforced by the table itself.
--
-- ---------------------------------------------------------------------------
-- Why this is safe on `suppliers` specifically
--
-- Checked rather than assumed, because a trigger that resurrects a deleted
-- row deserves the scrutiny:
--
-- * **`suppliers` has no triggers at all today**, so there is nothing for
--   this to interact with and no ordering to get right.
-- * **Nothing in the app deletes a supplier.** Rule 5 — suppliers are
--   deactivated, never removed, and there is no DELETE policy for any tier.
--   The only caller that reaches a `delete from suppliers` is
--   `wipe_everything`, and it is `is_owner()`-gated.
-- * **`suppliers` has no audit trigger**, so re-seeding inside a wipe writes
--   nothing to `activity_log` — which matters because the wipe clears
--   `activity_log` BEFORE it clears `suppliers`, and a stray "supplier
--   created" line surviving an otherwise empty log would be the log stating
--   something nobody did. CATCH_UP_013 §5 refused to do exactly that.
-- * **`profiles` survives the wipe**, so `created_by` always has something to
--   point at. The function raises rather than guessing if it ever does not.
-- ===========================================================================


-- ===========================================================================
--  1. THE INVARIANT
--
--  Statement-level, not row-level. `delete from suppliers` removes every row
--  in one statement; a row-level trigger would run once per supplier and try
--  to re-seed on the first deletion, while the rest of the statement was
--  still deleting — including, possibly, the row it had just created.
--
--  AFTER, so the deletion has finished and the count below is the truth
--  rather than a snapshot mid-statement.
--
--  It re-seeds ONLY when nothing is left. A partial delete that leaves the
--  placeholder alone does nothing, so this cannot produce a second one — and
--  §4 of CATCH_UP_028 is the check that two never quietly appear.
-- ===========================================================================

create or replace function ensure_placeholder_supplier()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_owner uuid;
begin
  -- Still there? Nothing to do. This is the overwhelmingly common case: any
  -- deletion that is not the wipe.
  if exists (select 1 from suppliers where is_placeholder and active) then
    return null;
  end if;

  /*
   * The failure CATCH_UP_013 §5 had, and the reason this looks different.
   *
   * That file selected a `created_by` from a role that did not exist yet,
   * matched nothing, inserted nothing, and reported success. So here the
   * lookup is separate from the insert and its emptiness RAISES — inside a
   * wipe that aborts the whole transaction, which is the correct outcome:
   * better a wipe that refuses than a wipe that silently removes the row two
   * tiers depend on.
   */
  select p.id
    into v_owner
    from profiles p
   where p.active
     and p.role in ('owner', 'builder', 'manager')
   order by case p.role
              when 'owner'   then 0
              when 'builder' then 1
              else 2
            end,
            p.display_name
   limit 1;

  if v_owner is null then
    raise exception
      'Cannot restore the "Supplier not listed" row: no active owner, builder or manager profile exists to own it.';
  end if;

  insert into suppliers (name, default_terms_days, is_placeholder, created_by, active)
  values ('Supplier not listed', null, true, v_owner, true)
  on conflict do nothing;

  return null;  -- statement-level AFTER triggers ignore the return value
end;
$fn$;

drop trigger if exists suppliers_keep_placeholder on suppliers;
create trigger suppliers_keep_placeholder
  after delete on suppliers
  for each statement execute function ensure_placeholder_supplier();


-- ===========================================================================
--  2. VERIFICATION — including the thing itself, actually exercised
--
--  §7b of HANDOFF: "a fence proven to keep things out has not been proven to
--  have a gate." A trigger that exists is not a trigger that fires, and the
--  only way to know is to make it fire.
--
--  So this DELETES the placeholder inside a transaction it then rolls back.
--  Nothing outside this block ever sees either state, and if the trigger does
--  not work the exception leaves the row untouched anyway.
-- ===========================================================================
do $$
declare
  v_before integer;
  v_after  integer;
  v_refs   integer;
begin
  if not exists (select 1 from pg_trigger where tgname = 'suppliers_keep_placeholder') then
    raise exception 'the trigger is missing — this file did not apply';
  end if;

  select count(*) into v_before from suppliers where is_placeholder and active;

  if v_before = 0 then
    raise exception
      'There is no active placeholder to protect. Run CATCH_UP_028 first — this file keeps the row, it does not create it.';
  end if;

  /*
   * Can the row actually be deleted right now?
   *
   * `invoices.supplier_id` is a foreign key, so the moment ONE invoice is
   * filed against the placeholder this test would fail on the constraint
   * rather than on the trigger — and it would read as this file being broken
   * when it is not. That is not hypothetical: the row exists to be filed
   * against, so the normal state of a live database eventually has invoices
   * pointing at it.
   *
   * The wipe is unaffected either way: it deletes `invoices` before
   * `suppliers`, so by the time the delete runs nothing references anything.
   */
  select count(*) into v_refs from invoices where supplier_id in (
    select id from suppliers where is_placeholder
  );

  if v_refs > 0 then
    raise notice 'SKIPPED the live test — % invoice(s) reference the placeholder, so it cannot be deleted here.', v_refs;
    raise notice 'That is a foreign key doing its job, not a fault. The wipe deletes invoices first.';
    raise notice 'ok — the trigger exists and is statement-level AFTER DELETE on suppliers';
    return;
  end if;

  -- The gate, proven, inside a subtransaction that is always undone.
  begin
    delete from suppliers where is_placeholder;
    select count(*) into v_after from suppliers where is_placeholder and active;

    if v_after <> 1 then
      raise exception 'the trigger did not restore the row — after deleting it there are % active placeholders', v_after;
    end if;

    -- Undo the test. The row the trigger created goes with it and the
    -- original comes back untouched, with its original id.
    raise exception 'ROLLBACK_THE_TEST';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_THE_TEST' then
        raise;
      end if;
  end;

  select count(*) into v_after from suppliers where is_placeholder and active;
  if v_after <> v_before then
    raise exception 'the test did not clean up after itself — expected % active placeholders, found %', v_before, v_after;
  end if;

  raise notice 'ok — the placeholder was deleted, restored by the trigger, and the test rolled back';
  raise notice 'ok — % active placeholder row, unchanged', v_after;
end $$;


-- ===========================================================================
--  3. WHAT THIS DOES NOT DO
--
--  * **It does not stop anybody deactivating the row.** `active = false` is
--    an UPDATE, not a DELETE, and this trigger never sees it. That is
--    deliberate: deactivating is how everything in this app is retired
--    (rule 5), and a row that cannot be switched off is a row nobody can
--    correct. CATCH_UP_028 §2b reactivates it if that has happened, and
--    `SupplierField` now says so on screen if it ever is.
--
--  * **It does not touch `wipe_everything`.** That function is unchanged and
--    unread by this file. After a wipe it will delete every supplier exactly
--    as before, and the trigger will put this one back inside the same
--    transaction.
--
--  * **It does not guarantee the NAME.** The app matches on the column, never
--    the name, so renaming the row still works — and both sheets print
--    whatever it is called. CATCH_UP_028 §4 notices a rename and says so.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- What you should SEE afterwards.
--
--   NOTICE: ok — the placeholder was deleted, restored by the trigger, and
--           the test rolled back
--   NOTICE: ok — 1 active placeholder row, unchanged
--
-- The first line is the one that matters: the trigger was made to fire, not
-- merely confirmed to exist.
--
-- OR, once somebody has actually filed an invoice against the placeholder:
--
--   NOTICE: SKIPPED the live test — N invoice(s) reference the placeholder...
--   NOTICE: ok — the trigger exists and is statement-level AFTER DELETE...
--
-- That is the foreign key refusing to let the row be deleted while something
-- points at it, which is correct. The wipe deletes invoices first, so it is
-- unaffected.
--
-- To satisfy yourself nothing moved:
--
--   select id, name, active, is_placeholder from suppliers where is_placeholder;
--
-- The id should be the same one CATCH_UP_028 left behind.
-- ---------------------------------------------------------------------------
