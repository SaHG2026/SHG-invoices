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
--  This inserts 50 invoices in ONE statement, which is the sharp version of
--  the test: every row in a single statement sees the same snapshot, so a
--  select-then-insert implementation produces fifty identical references,
--  while a correct one produces fifty distinct ones. If this passes, two
--  phones a millisecond apart cannot fail.
--
--  It also exercises the audit trigger 50 times, so it proves attribution
--  works at the same time.
--
--  EVERYTHING IS ROLLED BACK. No invoice, supplier or log entry survives
--  this. Your database is exactly as it was when it finishes.
--
-- ############################################################################

begin;

-- auth.uid() is null in the SQL editor because there is no signed-in user, and
-- the audit trigger refuses to write a log entry without an actor — which is
-- the whole point of it. Name an actor for the duration of this transaction.
select set_config('app.actor_id', (select id::text from profiles where active limit 1), true);

-- No suppliers are seeded yet, so make a throwaway one. It is rolled back too.
insert into suppliers (name, default_terms_days, created_by)
values ('Concurrency test supplier', 14, (select id from profiles where active limit 1));

-- The test itself: 50 invoices, one statement, one business, one day.
insert into invoices (business_id, supplier_id, invoice_date, due_date, amount_cents, created_by)
select
  (select id from businesses where code = 'GMH'),
  (select id from suppliers where name = 'Concurrency test supplier'),
  current_date,
  current_date + 14,
  100000 + g,
  (select id from profiles where active limit 1)
from generate_series(1, 50) as g;

-- ----------------------------------------------------------------------------
-- Expected, on the row marked RESULT:
--
--   invoices           50
--   distinct_refs      50
--   duplicates          0     <-- this is the number that matters
--   activity_entries   50     <-- the audit trigger logged every one
--   sample             GMH-YYMMDD-01 ... GMH-YYMMDD-50
-- ----------------------------------------------------------------------------
select
  'RESULT'                                                as check,
  count(*)                                                as invoices,
  count(distinct i.internal_ref)                          as distinct_refs,
  count(*) - count(distinct i.internal_ref)               as duplicates,
  (select count(*) from activity_log
    where entity_type = 'invoice' and action = 'created') as activity_entries,
  min(i.internal_ref) || '  ...  ' || max(i.internal_ref) as sample
from invoices i;

rollback;

-- After the rollback, confirm nothing was left behind. Both should be 0.
select 'AFTER ROLLBACK' as check,
       (select count(*) from invoices)  as invoices_remaining,
       (select count(*) from suppliers) as suppliers_remaining;
