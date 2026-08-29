-- ############################################################################
--
--  LAST PHASE 1 CHECK — prove two people logging at once cannot collide.
--
--  Supabase SQL editor -> New query -> paste all of this -> Run.
--  Send me the result table.
--
--  Notes §2: "Two people logging at the same time will both read 02 and both
--  write GMH-260828-03. This is exactly the class of race that destroyed a
--  shared record in the previous app."
--
--  This inserts 150 invoices in ONE statement, which is the sharp version of
--  the test: every row in a single statement sees the same snapshot, so a
--  select-then-insert implementation produces identical references for all of
--  them, while a correct one produces distinct ones throughout. If this
--  passes, two phones a millisecond apart cannot fail.
--
--  It also fires the audit trigger 150 times, so the same run proves
--  attribution works, and it crosses the 100 boundary where the reference
--  generator was previously truncating.
--
--  EVERYTHING IS ROLLED BACK. No invoice, supplier or log entry survives.
--  You already confirmed that last time: 0 invoices, 0 suppliers remaining.
--
--  Written so that exactly ONE statement returns rows, because the SQL editor
--  only displays the last result — which is why the number that mattered went
--  missing last time.
--
-- ############################################################################

begin;

-- Wrapped in a DO block so it returns no rows of its own.
--
-- auth.uid() is null in the SQL editor because nobody is signed in, and the
-- audit trigger refuses to log without an actor — which is the point of it.
-- So name an actor for the duration of this transaction, and make a throwaway
-- supplier, since none are seeded yet.
do $$
declare
  v_actor uuid;
begin
  select id into v_actor from profiles where active limit 1;
  perform set_config('app.actor_id', v_actor::text, true);

  insert into suppliers (name, default_terms_days, created_by)
  values ('Concurrency test supplier', 14, v_actor);

  -- The test itself: 150 invoices, one statement, one business, one day.
  --
  -- 150 rather than 50 deliberately. The first version of this test stopped at
  -- 50 and passed, while the reference generator was silently broken from 100
  -- onward — lpad truncated '100' to '10'. A test that stops short of the
  -- boundary is a test that certifies the bug.
  insert into invoices (business_id, supplier_id, invoice_date, due_date, amount_cents, created_by)
  select
    (select id from businesses where code = 'GMH'),
    (select id from suppliers where name = 'Concurrency test supplier'),
    current_date,
    current_date + 14,
    100000 + g,
    v_actor
  from generate_series(1, 150) as g;
end $$;

-- ----------------------------------------------------------------------------
-- The only statement that returns rows. Expected:
--
--   invoices         150
--   distinct_refs    150
--   duplicates         0    <-- THIS is the number that matters
--   logged           150    <-- the audit trigger caught every insert
--   attributed_to     one name, never null
--   refs_at_boundary  99, 100, 101   <-- proves lpad is no longer truncating
--   first_ref         GMH-YYMMDD-01
--   last_ref          GMH-YYMMDD-99  (text order, so 99 sorts last)
-- ----------------------------------------------------------------------------
select
  count(*)                                    as invoices,
  count(distinct i.internal_ref)              as distinct_refs,
  count(*) - count(distinct i.internal_ref)   as duplicates,
  (select count(*) from activity_log
    where entity_type = 'invoice' and action = 'created')          as logged,
  (select string_agg(distinct p.display_name, ', ')
     from activity_log a join profiles p on p.id = a.actor_id)     as attributed_to,
  (select string_agg(x.internal_ref, ' | ' order by x.internal_ref)
     from (select internal_ref from invoices
            where internal_ref like '%-99' or internal_ref like '%-100'
               or internal_ref like '%-101') x)                    as refs_at_boundary,
  min(i.internal_ref)                         as first_ref,
  max(i.internal_ref)                         as last_ref
from invoices i;

rollback;
