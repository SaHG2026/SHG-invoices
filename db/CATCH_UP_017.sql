-- ===========================================================================
-- CATCH_UP_017 — a sales invoice may have no due date
--
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- RUN THIS **BEFORE** THE DEPLOY.
--
-- It only ever makes the column more permissive, so the version of the app
-- currently live keeps working unchanged: it always sends a due date, and a
-- date is still a perfectly good value for a nullable column. The new version
-- can send nothing, which is what this file is for.
--
-- ---------------------------------------------------------------------------
-- Why
--
-- The client: *"Need to add a toggle switch next to due date. off by default.
-- we don't want to issue due dates yet."*
--
-- Deli is issuing invoices before it has agreed terms with anybody. Until it
-- has, a due date on the document is a claim nobody made — and worse, it
-- feeds the chasing: an invoice with an invented due date goes overdue on a
-- day that means nothing, and then the one figure the app exists to be
-- trusted about is wrong.
--
-- The alternative was to keep the column NOT NULL and have the app hide the
-- date it had quietly stored. That is the arrangement notes §1.3 warns about
-- — a record that says one thing and a screen that says another — and the
-- stored date would still have driven every "overdue" calculation underneath.
-- So the absence is recorded as an absence.
--
-- ---------------------------------------------------------------------------
-- What this does NOT change
--
-- `create_sales_invoice` needs no edit. It already writes
-- `(p_invoice ->> 'due_date')::date`, and `->>` on a JSON null yields SQL
-- NULL, which casts to a NULL date. The constraint was the only thing
-- refusing it.
--
-- Nothing on the payables side is touched. `invoices.due_date` stays NOT NULL:
-- a bill somebody sent US always has a date on it, and the whole app is built
-- around that being known.
-- ===========================================================================

alter table sales_invoices
  alter column due_date drop not null;

-- ---------------------------------------------------------------------------
-- The partial index on due_date stays exactly as it is.
--
-- Postgres indexes NULLs in a btree, and every query that uses this one orders
-- by due_date, where NULLs sort last ascending. An invoice with no due date is
-- therefore last in the list, which is where something with no deadline
-- belongs. Recorded here because "why is that one at the bottom" is otherwise
-- a question somebody has to re-derive.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- Verification — run this after, it should print `ok`
-- ===========================================================================
do $$
declare
  v_nullable text;
begin
  select is_nullable into v_nullable
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'sales_invoices'
     and column_name = 'due_date';

  if v_nullable is null then
    raise exception 'sales_invoices.due_date not found — is CATCH_UP_015 applied?';
  end if;

  if v_nullable <> 'YES' then
    raise exception 'sales_invoices.due_date is still NOT NULL';
  end if;

  raise notice 'ok — a sales invoice may now be issued with no due date';
end $$;
