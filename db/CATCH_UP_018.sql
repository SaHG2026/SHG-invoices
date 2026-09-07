-- ===========================================================================
-- CATCH_UP_018 — a shop is only offered Edit on its OWN entries
--
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- RUN THIS **BEFORE** THE DEPLOY.
--
-- It only ADDS a column to a view. The version of the app currently live
-- names the columns it selects explicitly and does not ask for this one, so
-- it carries on unchanged. The new version asks for it and needs it present.
--
-- ---------------------------------------------------------------------------
-- The defect
--
-- `staff_update` (CATCH_UP_010) allows a shop to correct an invoice only when
-- FOUR things hold:
--
--    business_id = staff_venue()               the shop's own venue
--    created_by  = auth.uid()                  the shop entered it
--    status      = 'unpaid'                    nobody has paid it
--    created_at  > now() - interval '5 minutes' inside the window
--
-- `stillCorrectable` in the app gated on the CLOCK alone. So a shop looking at
-- an invoice one of the four had entered minutes earlier was offered an Edit
-- button, and tapping it was refused by the policy — the notes' §6 exactly:
-- do not offer what cannot be done.
--
-- Nothing was ever at risk. The policy refused every one of these, which is
-- why this waited to be batched rather than shipped on its own. It is an
-- honesty fix, not a security fix.
--
-- ---------------------------------------------------------------------------
-- Why a boolean, and not the column
--
-- The obvious fix is to put `created_by` in the view and let the app compare
-- it to the signed-in id. That hands a shop the user id of whichever of the
-- four entered each invoice — a fact about somebody else's account, exported
-- so that a screen can answer one yes/no question.
--
-- `is_mine` answers the question and hands over nothing. The comparison
-- happens in the database, where the answer is already known.
--
-- Of the four conditions, this closes the second. The first is already
-- structural — the view's own WHERE clause. The fourth is the app's clock. The
-- THIRD stays deliberately invisible: a shop cannot be told an invoice is
-- paid (CATCH_UP_010 §3), so it cannot be told that is why editing stopped.
-- Inside five minutes of a shop entering something, one of the four having
-- already paid it is close enough to impossible, and if it happens the save is
-- refused and the app says what it says for every other refusal.
--
-- ---------------------------------------------------------------------------
-- `auth.uid()` inside this view
--
-- The view runs as its OWNER (`security_invoker = false`, set explicitly
-- below), which is how it reads `invoices` at all — a staff account has no
-- select policy on that table.
--
-- That does not change what `auth.uid()` returns. It reads the JWT claims
-- PostgREST sets for the request, which are a property of the SESSION, not of
-- whose privileges the query runs under. `staff_venue()` in the same view's
-- WHERE clause has worked this way since CATCH_UP_010 and is the proof.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The view, with one column added at the end.
--
-- Appended rather than inserted, because `create or replace view` may only ADD
-- columns to the end of the list — every existing column must keep its name,
-- type and position. Putting `is_mine` next to `created_at` would fail with
-- "cannot change name of view column", which is a confusing error for a
-- change that looks tidier.
-- ---------------------------------------------------------------------------
create or replace view staff_invoices as
  select
    i.id,
    i.business_id,
    i.supplier_id,
    s.name           as supplier_name,
    i.invoice_number,
    i.internal_ref,
    i.invoice_date,
    i.due_date,
    i.amount_cents,
    i.created_at,
    -- Answers "may I offer Edit on this", not "who entered it".
    -- `coalesce` because auth.uid() is null for an unauthenticated session,
    -- and `null = anything` is null, not false. A null here would reach the
    -- app as a missing value and read as truthy in the wrong hands.
    coalesce(i.created_by = auth.uid(), false) as is_mine
  from invoices i
  join suppliers s on s.id = i.supplier_id
 where i.business_id = staff_venue()
   and i.status <> 'void';

-- Restated because `create or replace view` does not preserve view options in
-- every Postgres version, and this one is load-bearing: with security_invoker
-- ON, a staff account gets zero rows, because it has no select policy on
-- `invoices`. That is the safe direction to fail, but it is still a broken
-- screen, so the setting is asserted every time the view is written.
do $do$ begin
  alter view staff_invoices set (security_invoker = false);
exception when others then null;   -- option does not exist before Postgres 15,
end $do$;                           -- where every view already ran as its owner.

revoke all    on staff_invoices from anon;
grant  select on staff_invoices to   authenticated;

-- ===========================================================================
-- Verification — run this after. Every line should say ok.
-- ===========================================================================
do $$
declare
  v_has_column  boolean;
  v_col_count   integer;
  v_policy      boolean;
begin
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'staff_invoices'
       and column_name  = 'is_mine'
  ) into v_has_column;

  if not v_has_column then
    raise exception 'staff_invoices.is_mine is missing';
  end if;

  -- The app selects columns by name. A view that quietly grew or lost one
  -- somewhere else would change what every shop screen renders.
  select count(*) into v_col_count
    from information_schema.columns
   where table_schema = 'public' and table_name = 'staff_invoices';

  if v_col_count <> 11 then
    raise exception 'staff_invoices has % columns, expected 11', v_col_count;
  end if;

  -- The policy this view now agrees with. If it were ever dropped, the app
  -- would be offering Edit on the honest set of rows and the database would
  -- be allowing something else entirely.
  select exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename  = 'invoices'
       and policyname = 'staff_update'
  ) into v_policy;

  if not v_policy then
    raise exception 'staff_update policy is missing — re-run CATCH_UP_010';
  end if;

  raise notice 'ok — a shop is now offered Edit only on its own entries';
end $$;

-- ---------------------------------------------------------------------------
-- What you should SEE, signed in as a shop (GMP or GMH).
--
-- `is_mine` true on rows that account entered, false on rows one of the four
-- entered for that venue. Signed in as a member this returns no rows at all,
-- because `staff_venue()` is null for anybody who is not staff — which is
-- itself worth seeing once.
-- ---------------------------------------------------------------------------
-- select invoice_date, supplier_name, amount_cents, is_mine
--   from staff_invoices
--  order by created_at desc
--  limit 20;
