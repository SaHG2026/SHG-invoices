-- ============================================================================
-- Phase 1 exit test: prove two people logging at once cannot collide.
--
-- Notes §2: "Two people logging at the same time will both read 02 and both
-- write GMH-260828-03. This is exactly the class of race that destroyed a
-- shared record in the previous app."
--
-- The test below inserts 50 invoices in a SINGLE statement. That is the sharp
-- version of the test, because every row in one statement sees the same
-- snapshot — so a select-then-insert implementation produces fifty identical
-- refs, while the counter upsert produces fifty distinct ones. If this passes,
-- the ordinary two-phones-at-once case cannot fail.
--
-- Run in the Supabase SQL editor. It rolls itself back; nothing is kept.
-- ============================================================================

begin;

-- Attribute the writes: auth.uid() is null in the SQL editor, and the audit
-- trigger refuses to log without an actor (which is the point of notes §2).
select set_config('app.actor_id', (select id::text from profiles limit 1), true);

insert into invoices (business_id, supplier_id, invoice_date, due_date, amount_cents, created_by)
select
  (select id from businesses where code = 'GMH'),
  (select id from suppliers limit 1),
  current_date,
  current_date + 14,
  100000 + g,
  (select id from profiles limit 1)
from generate_series(1, 50) as g;

-- Expect: total 50, distinct 50, duplicates 0.
select
  count(*)                                  as total,
  count(distinct internal_ref)              as distinct_refs,
  count(*) - count(distinct internal_ref)   as duplicates
from invoices
where created_at > now() - interval '1 minute';

-- Expect: every ref matches GMH-YYMMDD-NN, numbered without repeats.
select internal_ref
from invoices
where created_at > now() - interval '1 minute'
order by internal_ref
limit 10;

rollback;

-- ----------------------------------------------------------------------------
-- The genuinely concurrent version, for when two sessions are available.
-- Open two SQL editor tabs and run this in both at the same time; then compare
-- the refs. Same expectation: no two rows share one.
-- ----------------------------------------------------------------------------
