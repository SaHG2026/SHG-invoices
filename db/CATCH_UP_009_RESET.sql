-- ############################################################################
-- #                                                                          #
-- #   THIS DELETES EVERY INVOICE, SUPPLIER AND CUSTOMER IN THE DATABASE.     #
-- #   IT CANNOT BE UNDONE. RUN IT ONCE, BEFORE THE OTHERS START USING THE    #
-- #   APP, AND THEN DELETE THIS FILE.                                        #
-- #                                                                          #
-- ############################################################################
--
--  CATCH-UP 009 — the clean slate.
--
--  Supabase SQL editor -> New query -> paste -> Run.
--
--  ---------------------------------------------------------------------------
--  What goes
--
--    every invoice, and every note and activity row about one
--    every supplier
--    every customer, and every invoice sent to one
--    the reference counters
--    every push subscription (the devices you tested on)
--
--  What stays
--
--    the four businesses
--    the four profiles, including yours and its builder role
--    every setting, policy, view, function and trigger
--
--  Nobody's sign-in is affected. Nothing about how the app works changes. The
--  app is exactly as it is now, with nothing in it.
--
--  ---------------------------------------------------------------------------
--  Why this is a file you run once and not a button in the app
--
--  HANDOFF §4 rule 5 is "nothing is ever deleted" — void with a reason,
--  deactivate rather than remove. That rule is load-bearing: it is why a
--  mistaken tap can never lose an invoice, and why history can always answer
--  what happened.
--
--  A reset is the one moment where deleting is the right thing, and the way to
--  have both is for it to live **outside the app entirely**. No screen, no
--  button, no admin mode. If a delete path existed in the interface, rule 5
--  would be a convention rather than a fact, and conventions get worn away by
--  the next feature that finds them inconvenient. ARCHITECTURE §28.1.
--
--  ---------------------------------------------------------------------------
--  Two things worth knowing before you press Run
--
--  1. **Running it twice is harmless the first time and expensive later.** On
--     an empty ledger it deletes nothing. On a month-old one it deletes the
--     month. Nothing in SQL can tell those apart, which is why the warning at
--     the top of this file is the only safeguard there is.
--
--  2. **No notifications are sent and no history is written.** The audit
--     trigger and the push trigger both fire on insert and update only, so a
--     delete passes them silently. Nobody's phone will buzz.
--  ---------------------------------------------------------------------------

begin;

-- ----------------------------------------------------------------------------
-- What is about to go. Read this, then scroll to the bottom for what is left.
-- ----------------------------------------------------------------------------
select 'BEFORE' as when,
       (select count(*) from invoices)            as invoices,
       (select count(*) from suppliers)           as suppliers,
       (select count(*) from customers)           as customers,
       (select count(*) from sales_invoices)      as sales_invoices,
       (select count(*) from invoice_notes)       as notes,
       (select count(*) from activity_log)        as activity,
       (select count(*) from push_subscriptions)  as devices;

-- ----------------------------------------------------------------------------
-- In foreign-key order: the things that point at other things first.
--
-- `delete` rather than `truncate` throughout. Truncate is faster and would
-- need `cascade`, which follows foreign keys into tables this file has not
-- named — and a reset that removes something nobody listed is exactly the kind
-- of surprise this file exists to avoid.
-- ----------------------------------------------------------------------------
delete from activity_log;
delete from invoice_notes;
delete from invoices;

delete from sales_invoices;
delete from customers;

delete from suppliers;

-- ----------------------------------------------------------------------------
-- The counters, so the first real invoice is GMH-260901-01.
--
-- Small, and worth doing: leave them and the first thing Mani ever logs is
-- numbered in the nineties, which says loudly that he is using somebody's test
-- rig. ARCHITECTURE §28.1.
-- ----------------------------------------------------------------------------
delete from invoice_ref_counters;

-- ----------------------------------------------------------------------------
-- The devices you tested push on.
--
-- These are registrations, not data — each one is a browser that asked to be
-- notified. Clearing them means the three of them switch notifications on
-- deliberately, on their own phones, rather than inheriting whatever was left
-- over from testing. Turning the switch on in Settings makes a new one.
-- ----------------------------------------------------------------------------
delete from push_subscriptions;

commit;

-- ----------------------------------------------------------------------------
-- What is left. Expect every count on the first row to be 0, and the second
-- row to show 4 businesses and 4 profiles — one of them the builder.
-- ----------------------------------------------------------------------------
select 'AFTER' as when,
       (select count(*) from invoices)            as invoices,
       (select count(*) from suppliers)           as suppliers,
       (select count(*) from customers)           as customers,
       (select count(*) from sales_invoices)      as sales_invoices,
       (select count(*) from invoice_notes)       as notes,
       (select count(*) from activity_log)        as activity,
       (select count(*) from push_subscriptions)  as devices;

select 'KEPT' as when,
       (select count(*) from businesses)                          as businesses,
       (select count(*) from profiles)                            as profiles,
       (select count(*) from profiles where role = 'builder')     as builders,
       (select count(*) from profiles where notify_on_payment)    as told_about_payments;
