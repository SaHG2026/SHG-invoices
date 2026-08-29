-- ############################################################################
--
--  CATCH-UP 002 — fix a reference collision at 100 invoices in one day.
--
--  Supabase SQL editor -> New query -> paste all of this -> Run.
--  Send me the result table (it proves the bug and the fix in one go).
--
--  ------------------------------------------------------------------------
--  THE BUG
--
--  The reference was built with lpad(n, 2, '0') to get '01', '02', '50'.
--  PostgreSQL's lpad does not only pad — if the string is ALREADY longer
--  than the target length, it TRUNCATES it:
--
--      lpad('7',   2, '0')  ->  '07'    correct
--      lpad('50',  2, '0')  ->  '50'    correct
--      lpad('100', 2, '0')  ->  '10'    <-- silently cut to two characters
--
--  So the 100th invoice logged for one business on one day would be given
--  GMH-260829-10 — the reference already belonging to the 10th. Two different
--  invoices, one reference, no error.
--
--  The concurrency test passed because it stopped at 50. Everything below 100
--  is correct, which is exactly what makes this the dangerous kind of bug.
--
--  Is 100 invoices for one business in one day likely? No. But "unlikely" is
--  the reasoning that ships silent corruption, and a duplicated reference in a
--  payments ledger is the kind of thing you find out about during an argument
--  with a supplier.
--
--  ------------------------------------------------------------------------
--  THE FIX — two parts, because one of them is a guess and the other is not
--
--  1. Stop truncating. Pad to two digits below 100, then just let the number
--     grow: ...-99, ...-100, ...-101.
--
--  2. Add a unique index on internal_ref. This is the real defence. The
--     generator is now correct as far as I can reason about it, but so was
--     the last version. With the index, any future mistake fails loudly at
--     the moment of insert instead of silently producing two invoices that
--     claim to be the same one. Notes §2: enforcement belongs in the database.
--
-- ############################################################################


-- ============================================================================
-- 1. Regenerate the reference function without the truncation.
-- ============================================================================

create or replace function set_internal_ref()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_day  date;
  v_code text;
  v_n    int;
begin
  if new.internal_ref is not null and new.internal_ref <> '' then
    return new;
  end if;

  v_day := sydney_today();

  select code into v_code from businesses where id = new.business_id;
  if v_code is null then
    raise exception 'unknown business_id: %', new.business_id;
  end if;

  -- One statement. This is the race fix, unchanged and already proven:
  -- 50 inserts in a single statement produced 50 distinct references.
  insert into invoice_ref_counters (business_id, day, n)
  values (new.business_id, v_day, 1)
  on conflict (business_id, day)
    do update set n = invoice_ref_counters.n + 1
  returning n into v_n;

  -- Pad to two digits, but never truncate. lpad alone would cut 100 to 10.
  new.internal_ref := v_code || '-' || to_char(v_day, 'YYMMDD') || '-' ||
    case when v_n < 100 then lpad(v_n::text, 2, '0') else v_n::text end;

  return new;
end;
$fn$;


-- ============================================================================
-- 2. The backstop. If a reference is ever generated twice, the insert fails
--    instead of succeeding quietly.
-- ============================================================================

create unique index if not exists invoices_internal_ref_unique
  on invoices (internal_ref);


-- ============================================================================
-- 3. Proof. The only statement that returns rows.
--
--    Expected: `old_lpad` goes 01, 09, 10, 50, 99, 10, 15  <-- wrong at the end
--              `fixed`    goes 01, 09, 10, 50, 99, 100, 150
--              `broken`   is true on exactly the last two rows
-- ============================================================================

select
  n,
  lpad(n::text, 2, '0')                                             as old_lpad,
  case when n < 100 then lpad(n::text, 2, '0') else n::text end     as fixed,
  lpad(n::text, 2, '0')
    <> (case when n < 100 then lpad(n::text, 2, '0') else n::text end) as broken
from (values (1), (9), (10), (50), (99), (100), (150)) as t(n)
order by n;
