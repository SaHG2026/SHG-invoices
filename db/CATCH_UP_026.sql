-- ===========================================================================
-- CATCH_UP_026 — an assistant's "Supplier not listed" waits for review
--
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- RUN THIS **BEFORE** THE DEPLOY, and this one is not a preference.
--
-- Run late, the new app tells an assistant "Sent for review — a manager will
-- set the supplier" while the trigger is still approving the row on its way
-- in. The invoice would go straight into Pending and into the owed total,
-- under a placeholder, and the sentence the person just read would be false.
-- An app that lies about where money went is worse than one that is a day old.
--
-- Run early it is nearly invisible: the live version already offers the
-- placeholder to an assistant, and those entries begin queueing in Review
-- instead of landing in the ledger. That is the safe direction to be wrong in
-- — the invoice is held, not lost — and Review is a screen the four already
-- work.
--
-- **Nothing below changes anybody's access, and nothing already entered
-- moves.** §5 counts what is already sitting on the placeholder and tells you;
-- it does not touch it.
--
-- ---------------------------------------------------------------------------
-- What this is for
--
-- CATCH_UP_022 §5 decided that an assistant's entries do not wait for review,
-- and gave three good reasons: they are a named person, the tier exists to
-- stop somebody ALTERING or SETTLING the ledger rather than because what they
-- type is doubted, and queueing everything would make a manager the
-- bottleneck for every invoice.
--
-- **All three of those reasons hold, and none of them is about this case.**
--
-- §22 also gave the assistant the venue's other half — "Supplier not listed",
-- the placeholder row — because they cannot create a supplier either. That
-- part was inherited from CATCH_UP_013 without noticing that in the venue's
-- design it is only half a mechanism. The other half is Review: a shop files
-- against the placeholder, writes the real name in the note, and a manager
-- reads the note, makes the supplier and points the invoice at it. The picker
-- that does that exists on exactly one screen, and that screen shows only
-- unapproved rows.
--
-- So an assistant's placeholder invoice was approved on the way in, never
-- reached Review, and sat in the ledger under "Supplier not listed" with
-- nobody asked to fix it — which is the failure ARCHITECTURE §36.7 names by
-- name, in the paragraph explaining why the placeholder is default-off
-- everywhere else:
--
--   "a member who files against it loses an invoice in plain sight"
--
-- ---------------------------------------------------------------------------
-- The narrowness is the point
--
-- This is NOT §22's decision reversed. An assistant naming a real supplier is
-- approved on the way in exactly as before — the common case, the fast case,
-- and the one the bottleneck argument was about.
--
-- What queues is the case where the invoice still has an unanswered question
-- in it: **which supplier is this?** Nobody can answer it from the row, the
-- assistant is not permitted to answer it, and the answer is sitting in a note
-- that only Review displays.
--
-- The test is not "do we trust this person". It is "is this record finished".
-- ===========================================================================


-- ===========================================================================
--  1. THE TRIGGER LEARNS ONE MORE CASE
--
--  `stamp_approval` (CATCH_UP_013 §1) still does what it did: it OVERWRITES
--  what the client sent, both ways, rather than validating it. An invoice from
--  one of the four is approved even if the app forgets to say so, and one that
--  must wait is held even if the app insists otherwise. The app's new
--  `awaitsReview` flag is a rendering hint and is not consulted here — it
--  cannot be, and `lib/queries/invoices.ts` says so where it is declared.
--
--  Three cases now, in the order they are asked:
--
--    is_staff()                     → held. A shop, unchanged since 013.
--    is_assistant() AND placeholder → held. New, and the whole of this file.
--    everything else                → approved.
--
--  The placeholder is found by `suppliers.is_placeholder`, never by name.
--  CATCH_UP_013 §5 chose a column for this deliberately: a name is a string
--  somebody can edit, and renaming that row must not quietly turn it into an
--  ordinary supplier — nor, here, quietly stop this check from firing.
--
--  `coalesce(..., false)` because `suppliers` is looked up rather than joined.
--  The foreign key means the row is always there, but a null from a lookup
--  that somehow found nothing must read as "not the placeholder, approve it
--  normally", not as null propagating into an `if` that then does neither.
-- ===========================================================================

create or replace function stamp_approval()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_unlisted boolean;
begin
  -- A shop. Every entry waits, whatever supplier is on it. CATCH_UP_013 §1.
  if is_staff() then
    new.approved_at := null;
    new.approved_by := null;
    return new;
  end if;

  -- An assistant, on "Supplier not listed". CATCH_UP_026.
  if is_assistant() then
    select coalesce(s.is_placeholder, false)
      into v_unlisted
      from suppliers s
     where s.id = new.supplier_id;

    if coalesce(v_unlisted, false) then
      new.approved_at := null;
      new.approved_by := null;
      return new;
    end if;
  end if;

  -- Everybody else, and an assistant naming a real supplier. Unchanged.
  new.approved_at := now();
  new.approved_by := coalesce(auth.uid(), new.created_by);
  return new;
end;
$fn$;

-- Restated so this file can be read on its own. The trigger itself is
-- unchanged from CATCH_UP_013 — only the function it calls has moved.
drop trigger if exists invoices_stamp_approval on invoices;
create trigger invoices_stamp_approval
  before insert on invoices
  for each row execute function stamp_approval();


-- ===========================================================================
--  2. NOTHING ELSE HAS TO CHANGE, AND THAT IS WORTH SAYING OUT LOUD
--
--  Each of these was checked rather than assumed, because "nothing else
--  changes" is the claim that is wrong most often:
--
--  * `approve_invoices` (013 §3) is `where approved_at is null and status =
--    'unpaid'`. It never asked who entered the row, so it already accepts
--    these.
--
--  * Reassigning the supplier is a plain UPDATE from the Review screen, and
--    managers hold `member_all` on `invoices` (migration 007). No new policy.
--
--  * `pin_invoice_facts` (013 §2) puts the approval columns back only when
--    `is_staff()`. A manager approving one of these writes through.
--
--  * `member_all` on `invoice_notes` (migration 007) lets a manager read the
--    assistant's note, which is the only place the real supplier's name
--    exists. `assistant_insert` on `invoice_notes` (022 §4) lets them write
--    it. Both already there.
--
--  * `useUnpaidInvoices` asks for `approved_at is not null`, so a held row
--    cannot reach any total by any route — including one written next year.
--    That is `lib/queries/invoices.ts`, and it is a condition in the QUERY
--    rather than a filter over the result for exactly this reason.
--
--  * The assistant themselves cannot see the row afterwards: they have no
--    read on the review queue, and the ledger excludes it. That is why the
--    app says so in a toast at the moment of saving — it is the only place
--    the sentence can be said, because there is no row anywhere to carry it.
-- ===========================================================================


-- ===========================================================================
--  3. VERIFICATION — the function, and the case it must now hold
-- ===========================================================================
do $$
declare
  v_src text;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'stamp_approval';

  if v_src is null then
    raise exception 'stamp_approval does not exist';
  end if;

  if v_src not like '%is_assistant()%' then
    raise exception 'stamp_approval does not ask about an assistant — this file did not apply';
  end if;

  if v_src not like '%is_placeholder%' then
    raise exception 'stamp_approval does not look at is_placeholder — it would hold every assistant entry';
  end if;

  if v_src not like '%is_staff()%' then
    raise exception 'stamp_approval no longer holds a shop back — CATCH_UP_013 has been undone';
  end if;

  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'stamp_approval' and p.prosecdef
  ) then
    raise exception 'stamp_approval is not security definer — it cannot read suppliers';
  end if;

  if not exists (
    select 1 from pg_trigger where tgname = 'invoices_stamp_approval'
  ) then
    raise exception 'the trigger is missing — the function would never run';
  end if;

  raise notice 'ok — a shop still waits, and so does an assistant on Supplier not listed';
end $$;


-- ===========================================================================
--  4. THE CONSTRAINT THAT WAS ALREADY GUARDING THIS
--
--  `approval_fields_consistent` (013) says a row that claims to be approved
--  knows by whom. Both branches above set the pair together, so it holds
--  either way. Restated as a check, not re-added.
-- ===========================================================================
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'approval_fields_consistent'
       and conrelid = 'invoices'::regclass
  ) then
    raise exception 'approval_fields_consistent is gone — a half-approved row is now possible';
  end if;

  raise notice 'ok — approval_fields_consistent still holds';
end $$;


-- ===========================================================================
--  5. WHAT IS ALREADY SITTING ON THE PLACEHOLDER — counted, NOT moved
--
--  Any invoice already approved against "Supplier not listed" was filed before
--  this file existed. It is in the ledger and in the owed total right now, and
--  somebody may have already paid it.
--
--  **This does not un-approve them, deliberately.** Two reasons, and the
--  second is the real one:
--
--  * un-approving a row somebody has acted on would take it out of a total
--    they are looking at, with no notice
--  * it would be the database asserting that these were never approved, which
--    is false. They were, by the trigger, in good faith. CATCH_UP_013 §1
--    refused to write "Mani approved this" against rows nobody approved, for
--    the same reason: a log with one invented line in it is not a log.
--
--  So this REPORTS. If the count is not zero, the fix is a person looking at
--  the list and reassigning each one from the invoice screen, which is an
--  ordinary edit that leaves an ordinary audit trail.
-- ===========================================================================
do $$
declare
  v_stranded integer;
begin
  select count(*)
    into v_stranded
    from invoices i
    join suppliers s on s.id = i.supplier_id
   where s.is_placeholder
     and i.approved_at is not null
     and i.status <> 'void';

  if v_stranded = 0 then
    raise notice 'ok — nothing is stranded on the placeholder';
  else
    raise notice 'ATTENTION — % approved invoice(s) sit on "Supplier not listed".', v_stranded;
    raise notice 'They are not affected by this file. List them with the query at the bottom';
    raise notice 'and reassign each one from its invoice screen.';
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- What you should SEE afterwards.
--
-- Three notices from the blocks above, all starting "ok" — except §5, which
-- says ATTENTION and a number if anything was already stranded.
--
-- The stranded list, if §5 reported any. Each of these needs a real supplier
-- chosen on its invoice screen; the note on it says which:
--
--   select i.internal_ref,
--          i.invoice_date,
--          i.amount_cents / 100.0 as amount,
--          b.code                 as business,
--          p.display_name         as entered_by,
--          (select string_agg(n.body, ' | ' order by n.created_at)
--             from invoice_notes n where n.invoice_id = i.id) as notes
--     from invoices  i
--     join suppliers s on s.id = i.supplier_id
--     join businesses b on b.id = i.business_id
--     join profiles   p on p.id = i.created_by
--    where s.is_placeholder
--      and i.approved_at is not null
--      and i.status <> 'void'
--    order by i.invoice_date;
--
-- And the behaviour itself, which is worth one real test after the deploy:
-- sign in as an assistant, enter an invoice on "Supplier not listed" with a
-- note, and confirm it appears in Review rather than in Pending. Then enter
-- one naming a real supplier and confirm it does NOT — that half is the part
-- CATCH_UP_022 §5 decided, and it must still be true.
-- ---------------------------------------------------------------------------
