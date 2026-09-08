-- ###########################################################################
--
--   RESET TO A CLEAN SLATE
--
--   THIS DELETES DATA PERMANENTLY. THERE ARE NO BACKUPS.
--   Nothing in this file can be undone. Read the two sections below before
--   you run it.
--
--   THERE IS NOW A SECOND WAY TO DO THIS. `wipe_everything()`, from
--   CATCH_UP_021, does exactly what this file does — same rows, same order,
--   same things kept — from inside the app, owner only, behind four
--   confirmations. ARCHITECTURE §49.5.
--
--   **If you change one, change the other**, or the app and this file mean
--   different things by "empty". This file remains the way in when the app
--   cannot be reached, or when nobody wants to sign in to do it.
--
--   Run it in the Supabase SQL editor, in one go. It is wrapped in a single
--   transaction, so either all of it happens or none of it does — there is no
--   half-wiped state to recover from.
--
-- ###########################################################################


-- ===========================================================================
--  1. BEFORE YOU RUN THIS — one thing that actually matters
-- ===========================================================================
--
--  Every phone with the app installed can hold WORK THAT HAS NOT BEEN SENT.
--  That is the offline queue, and it is the whole point of it: an invoice
--  typed in a cold room with no signal is kept on the phone and sent later.
--
--  A queued invoice does not know this file exists. If somebody has unsent
--  work and opens the app after the wipe, it will be sent, and you will have
--  one invoice in an otherwise empty ledger.
--
--  So, on EVERY phone that has the app, before you run this:
--
--    1. Open the app with signal.
--    2. Look at the wifi symbol in the top bar. If there is a number beside
--       it, that is how many things are still waiting to send. Wait until the
--       number is gone.
--    3. Then leave it alone until the wipe is done.
--
--  Afterwards, everyone should close the app completely and reopen it. The
--  app remembers the last screen it drew, so for a few seconds it will show
--  invoices that no longer exist. That is a stale picture, not a failed wipe;
--  it corrects itself as soon as it reaches the database.
--
--
-- ===========================================================================
--  2. WHAT THIS DELETES, AND WHAT IT KEEPS
-- ===========================================================================
--
--  DELETED — everything transactional, and the three lists:
--
--    invoices                 every supplier bill ever logged, paid or not,
--                             including who entered it and who paid it
--    invoice_notes            every note on every one of them (cascade)
--    invoice_ref_counters     so internal references restart at 01
--    sales_invoices           every invoice Deli has issued
--    sales_invoice_lines      the products on them (cascade)
--    sales_invoice_counters   so the next Deli invoice is DDL-0001
--    activity_log             the whole history: who added, paid, voided what
--    products                 Deli's price list
--    customers                who Deli sells to
--    suppliers                who you buy from
--
--  KEPT — everything that is not a record of a transaction:
--
--    profiles                 all six logins, names, photos, roles,
--                             notification settings and reminder times
--    businesses               the four: GMH, GMP, MJR, DDL
--    push_subscriptions       so nobody has to re-enable notifications
--    storage                  uploaded logos and photographs are files, not
--                             rows, and this file does not touch them
--
--  Every policy, function, view, trigger and index is untouched. This deletes
--  rows. It does not change the shape of anything.
--
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- Order matters, and it is not alphabetical.
--
-- A row cannot be deleted while another row points at it. So children go
-- before parents, and the two that cascade are named here anyway so that
-- anybody reading this can see they were thought about rather than forgotten:
--
--   invoice_notes       cascades from invoices
--   sales_invoice_lines cascades from sales_invoices
--
-- Everything else is explicit. `activity_log.entity_id` is a plain uuid with
-- no foreign key — it would NOT be cleared by any cascade, and leaving it
-- would keep a readable history of invoices that no longer exist.
-- ---------------------------------------------------------------------------

-- Deli's side first: lines cascade, then the header, then the numbering.
delete from sales_invoice_lines;      -- explicit, though the cascade covers it
delete from sales_invoices;
delete from sales_invoice_counters;

-- The payables side.
delete from invoice_notes;            -- explicit, though the cascade covers it
delete from invoices;
delete from invoice_ref_counters;

-- The history of both.
delete from activity_log;

-- The three lists. These reference nothing that is left, and nothing that is
-- left references them — which is only true because the rows above are gone.
delete from products;
delete from customers;
delete from suppliers;

commit;


-- ===========================================================================
--  3. VERIFICATION — run this after. Every number must be 0, and the last
--     two must not be.
-- ===========================================================================
select
  (select count(*) from invoices)               as invoices,
  (select count(*) from invoice_notes)          as notes,
  (select count(*) from invoice_ref_counters)   as ref_counters,
  (select count(*) from sales_invoices)         as sales_invoices,
  (select count(*) from sales_invoice_lines)    as sales_lines,
  (select count(*) from sales_invoice_counters) as sales_counters,
  (select count(*) from activity_log)           as activity,
  (select count(*) from products)               as products,
  (select count(*) from customers)              as customers,
  (select count(*) from suppliers)              as suppliers,
  -- These two are the check that the wipe stopped where it was meant to.
  (select count(*) from profiles where active)  as logins_kept,
  (select count(*) from businesses)             as businesses_kept;

-- Expected: ten zeros, then 6 and 4.
--
-- If `logins_kept` is not 6 or `businesses_kept` is not 4, something went
-- further than this file intends — stop and say so before using the app.
