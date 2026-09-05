-- ############################################################################
--
--  CATCH-UP 013 — invoices a shop enters wait to be approved.
--
--  Supabase SQL editor -> New query -> paste the whole file -> Run.
--  Safe to run twice.
--
--  ---------------------------------------------------------------------------
--  READ THIS FIRST — one sentence about what changes for the three of you.
--
--  Nothing you enter changes at all. An invoice one of the four logs is
--  approved by the act of logging it, stamped by a trigger, with no extra tap
--  and no extra screen. What changes is that an invoice GMP or GMH enters
--  does not reach Pending, Overdue or any total until one of you says so.
--  ---------------------------------------------------------------------------
--
--  Your words: "whenever gmh or gmp adds an invoice, then it has to be
--  approved by one of the managements before it shows in the pending or
--  overdue".
--
--  Three other things ride along, because each file is a round trip through a
--  person and these belong to the same change:
--
--    * a shop can no longer CREATE a supplier — it picks one, or picks
--      "Supplier not listed" and writes the real name in a note
--    * every entry sheet gets a note field, and a shop's notes are readable
--      by you and by nobody else
--    * a sales invoice gets a note too
--
-- ############################################################################


-- ============================================================================
--  1. THE SHAPE OF "APPROVED"
--
--  Two columns, not a fourth value on `status`.
--
--  `status` is unpaid/paid/void and it means WHERE THE MONEY IS. Review is a
--  different fact about the same row. Folding them into one enum gives twelve
--  combinations to reason about where four are real, and ARCHITECTURE §19's
--  account of this build is that five of the eight bugs found on a phone were
--  values able to hold a state that should not exist.
--
--  So: two columns and two constraints, and the impossible states cannot be
--  written down rather than merely never being written.
-- ============================================================================

alter table invoices add column if not exists approved_at timestamptz;
alter table invoices add column if not exists approved_by uuid references profiles(id);

comment on column invoices.approved_at is
  'When one of the four accepted this invoice into the ledger. Null means it is '
  'waiting for review, which happens only for invoices a venue entered. Set by '
  'stamp_approval on insert and by approve_invoices afterwards — never by the client.';


-- ----------------------------------------------------------------------------
--  The backfill, before the constraints, and with the log left alone.
--
--  Every invoice that exists now was entered by one of the four, so every one
--  of them is approved. Doing this first is what lets the constraints below be
--  added as valid rather than as `not valid` and then forgotten about.
--
--  The audit trigger is switched off around it deliberately, and for two
--  reasons. The mechanical one: `log_invoice_activity` raises if it cannot
--  find an actor, and in the SQL editor `auth.uid()` is null — the backfill
--  would fail on its first row. The real one: nobody approved these. Writing
--  "Mani approved this" against a hundred rows on a Tuesday afternoon would be
--  the log stating something that did not happen, and a log that contains one
--  invented line is not a log.
-- ----------------------------------------------------------------------------
do $do$
begin
  if exists (select 1 from invoices where approved_at is null) then
    alter table invoices disable trigger invoices_log_activity;
    alter table invoices disable trigger invoices_touch_updated_at;

    update invoices
       set approved_at = created_at,
           approved_by = created_by
     where approved_at is null;

    alter table invoices enable trigger invoices_touch_updated_at;
    alter table invoices enable trigger invoices_log_activity;
  end if;
end
$do$;


-- Both, or neither. The same shape as `paid_fields_consistent`, which has held
-- since migration 001: a row that claims to be approved always knows by whom.
alter table invoices drop constraint if exists approval_fields_consistent;
alter table invoices
  add constraint approval_fields_consistent check (
    (approved_at is     null and approved_by is     null)
    or
    (approved_at is not null and approved_by is not null)
  );

-- Nothing unreviewed can be paid.
--
-- This is the rule the whole feature exists for, and it is here rather than in
-- `mark_invoices_paid` because a constraint cannot be gone around. A check in
-- the RPC would be correct until the day somebody writes a second way to mark
-- something paid.
alter table invoices drop constraint if exists paid_needs_approval;
alter table invoices
  add constraint paid_needs_approval check (
    status <> 'paid' or approved_at is not null
  );


-- ============================================================================
--  2. WHO ARRIVES APPROVED — decided by a trigger, never by the app
--
--  If the client can send it, the client can send it wrong, and a venue able
--  to pre-approve its own entry would make this whole file decorative. Same
--  reasoning as `set_internal_ref`: the fact is stamped by the database, and
--  the app has no say in it.
--
--  Note what this does NOT do: it does not read what the client sent and
--  validate it. It overwrites it, both ways. An invoice from one of the four
--  is approved even if the app forgets to say so, and an invoice from a shop
--  is not approved even if the app insists.
-- ============================================================================

create or replace function stamp_approval()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if is_staff() then
    new.approved_at := null;
    new.approved_by := null;
  else
    new.approved_at := now();
    new.approved_by := coalesce(auth.uid(), new.created_by);
  end if;
  return new;
end;
$fn$;

drop trigger if exists invoices_stamp_approval on invoices;
create trigger invoices_stamp_approval
  before insert on invoices
  for each row execute function stamp_approval();


-- ----------------------------------------------------------------------------
--  The hole a policy cannot close, and the trigger that already exists for it.
--
--  `staff_update` (CATCH_UP_010) lets a venue change its own invoice for five
--  minutes, and RLS lets an UPDATE write any column the role may write. So a
--  crafted correction could set `approved_at` and approve itself.
--
--  `pin_invoice_facts` is already the answer to exactly this class of problem
--  — it exists because nothing stopped `created_at` being reset to keep the
--  five-minute window open forever. It gains the two new columns, under the
--  same rule: when the caller is staff, these are facts about the row, not
--  fields on it.
--
--  For everybody else the columns stay writable, because `approve_invoices`
--  below is an ordinary update and has to be able to write them.
-- ----------------------------------------------------------------------------
create or replace function pin_invoice_facts()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  new.created_at   := old.created_at;
  new.internal_ref := old.internal_ref;

  if is_staff() then
    new.approved_at := old.approved_at;
    new.approved_by := old.approved_by;
  end if;

  return new;
end;
$fn$;

-- Unchanged, restated so this file can be read on its own.
drop trigger if exists invoices_pin_facts on invoices;
create trigger invoices_pin_facts
  before update on invoices
  for each row execute function pin_invoice_facts();


-- ============================================================================
--  3. APPROVING
--
--  One statement, one transaction, `security invoker` — the same pattern as
--  `mark_invoices_paid` (migration 004) and for the same three reasons:
--
--    * RLS and auth.uid() both still apply, so this is not a hole around the
--      policies
--    * it covers one invoice and a shop's whole morning in one call, so there
--      is one code path to get right
--    * it returns only the rows it actually changed, so if somebody approved
--      the same invoice thirty seconds ago the app can say so honestly
--      instead of silently re-stamping it with a new name
--
--  A staff caller gets nothing back from this, and that is not a special case:
--  `RETURNING` applies SELECT policies, staff have none on `invoices`, and
--  `pin_invoice_facts` puts the columns back regardless. Two independent
--  mechanisms, neither of which had to remember this function exists.
-- ============================================================================

create or replace function approve_invoices(p_ids uuid[])
returns setof invoices
language sql
security invoker
set search_path = public, pg_temp
as $fn$
  update invoices
     set approved_at = now(),
         approved_by = auth.uid(),
         updated_at  = now()
   where id = any(p_ids)
     and approved_at is null
     and status = 'unpaid'
  returning *;
$fn$;

revoke all     on function approve_invoices(uuid[]) from anon;
grant  execute on function approve_invoices(uuid[]) to   authenticated;


-- ----------------------------------------------------------------------------
--  Rejecting is voiding, and needs nothing new.
--
--  `void_invoice(p_id, p_reason)` already exists and already demands a reason.
--  A rejected entry is a wrong entry, which is what void means — and rule 5
--  holds: the row stays, with the reason on it, forever.
--
--  The consequence, stated because it is a real cost and was accepted rather
--  than missed: `staff_invoices` excludes voided rows, so a rejected invoice
--  disappears from the shop's list with no explanation the app will give. Tell
--  them, or they will enter it again. Showing them the rejection means editing
--  the view whose WHERE clause is the entire venue boundary, and that was
--  deliberately not done in this file.
-- ----------------------------------------------------------------------------


-- ============================================================================
--  4. THE LOG LEARNS THE WORD
--
--  Without this, approving logs as nothing at all: the audit trigger records
--  an update as 'edited' with a diff of the fields it tracks, `approved_at` is
--  not one of them, the diff comes out empty, and the trigger returns early.
--  The one action people will actually want to look up — who let this in —
--  would be the only one leaving no trace.
--
--  So it becomes a named action, beside paid, unpaid and voided.
-- ============================================================================

create or replace function log_invoice_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor  uuid := current_actor_id();
  v_action text;
  v_detail jsonb := '{}'::jsonb;
  v_field  text;
begin
  if v_actor is null then
    raise exception 'activity_log needs an actor: auth.uid() is null and app.actor_id is unset';
  end if;

  if tg_op = 'INSERT' then
    v_action := 'created';
    v_detail := jsonb_build_object(
      'internal_ref', new.internal_ref,
      'amount_cents', new.amount_cents,
      'due_date',     new.due_date,
      'business_id',  new.business_id,
      'supplier_id',  new.supplier_id,
      -- So the feed can say "entered by Parramatta, waiting for review"
      -- without a second query to work out which kind of insert this was.
      'approved',     (new.approved_at is not null)
    );
  else
    if new.status is distinct from old.status then
      v_action := case new.status
                    when 'paid'   then 'paid'
                    when 'void'   then 'voided'
                    when 'unpaid' then 'unpaid'
                  end;
    elsif old.approved_at is null and new.approved_at is not null then
      -- Checked before 'edited', and only in this direction. Approval is not
      -- reversible: there is no path in the app or in these functions that
      -- sets approved_at back to null, and if one is ever added it needs its
      -- own word here rather than quietly reading as an approval.
      v_action := 'approved';
    else
      v_action := 'edited';
    end if;

    foreach v_field in array array[
      'invoice_number', 'invoice_date', 'due_date', 'amount_cents',
      'business_id', 'supplier_id', 'status', 'payment_ref', 'void_reason'
    ] loop
      if to_jsonb(new) -> v_field is distinct from to_jsonb(old) -> v_field then
        v_detail := v_detail || jsonb_build_object(
          v_field,
          jsonb_build_object('from', to_jsonb(old) -> v_field, 'to', to_jsonb(new) -> v_field)
        );
      end if;
    end loop;

    -- An update that changed nothing we track is not worth a log line. An
    -- approval always is, even though it moves none of those fields.
    if v_action = 'edited' and v_detail = '{}'::jsonb then
      return null;
    end if;
  end if;

  insert into activity_log (entity_type, entity_id, action, actor_id, detail)
  values ('invoice', new.id, v_action, v_actor, v_detail);

  return null;
end;
$fn$;


-- ============================================================================
--  5. A SHOP PICKS A SUPPLIER; IT DOES NOT MAKE ONE
--
--  Your words: "not allow staffs to create a new supplier, they have to choose
--  from the ones already available. however if there genuinely is a new
--  supplier then they can at least leave a note to that invoice".
--
--  One dropped policy is the whole enforcement. Everything the app does about
--  it is a courtesy on top of a door that is already shut.
-- ============================================================================

drop policy if exists staff_insert on suppliers;

-- `staff_read` stays. The type-ahead is how the fifteen seconds works and it
-- needs the list (CATCH_UP_010 §7). A name carries no amount.


-- ----------------------------------------------------------------------------
--  Where an unknown supplier's invoice goes in the meantime.
--
--  A delivery arrives from somebody nobody has entered yet. The shop still has
--  to be able to log it — that is the instruction — but it must not be filed
--  against the wrong REAL supplier, because a wrong attribution is far harder
--  to find later than a missing one. Nobody goes looking for an invoice that
--  is sitting under Bidfood.
--
--  So there is one placeholder row, and it is marked as such by a column
--  rather than by its name. A name is a string somebody can edit; a flag is
--  what the app filters on, so renaming the row cannot quietly turn it into an
--  ordinary supplier that four businesses start using.
-- ----------------------------------------------------------------------------
alter table suppliers add column if not exists is_placeholder boolean not null default false;

comment on column suppliers.is_placeholder is
  'True for the single "Supplier not listed" row a venue picks when a delivery '
  'arrives from somebody not yet on the list. Hidden from the four people''s '
  'own type-ahead; surfaced first on the review screen.';

-- Created by whoever runs this file, which is one of the four. `created_by`
-- is `not null` and this row has no natural author.
insert into suppliers (name, default_terms_days, is_placeholder, created_by)
select 'Supplier not listed', null, true, p.id
  from profiles p
 where p.role in ('owner', 'builder') and p.active
 order by case p.role when 'owner' then 0 else 1 end
 limit 1
on conflict do nothing;

-- Idempotent second pass: if the row already existed from a previous run under
-- a different spelling of the flag, make sure it carries it.
update suppliers set is_placeholder = true
 where lower(name) = 'supplier not listed' and is_placeholder = false;


-- ============================================================================
--  6. NOTES ON EVERY ENTRY
--
--  Your words: "add a note section on every new entry, if to let know about
--  any irregularities."
--
--  `invoice_notes` has existed since migration 001, with its table, its index,
--  its RLS and a policy. It was simply never wired to the entry sheets. So the
--  only thing missing on this side is what a venue may do with it.
-- ============================================================================

-- Insert: on an invoice in their own venue, and signed with their own name.
--
-- `author_id = auth.uid()` is the half that is easy to leave out and is the
-- reason to write it: without it a shop could file a note as Mani.
drop policy if exists staff_insert on invoice_notes;
create policy staff_insert on invoice_notes
  for insert with check (
    author_id = auth.uid()
    and exists (
      select 1 from invoices i
       where i.id = invoice_notes.invoice_id
         and i.business_id = staff_venue()
    )
  );

-- Read: their own notes, and nothing else.
--
-- Deliberately NOT "every note on their venue's invoices". Notes are free text
-- written by people talking to each other about money, and one of them will
-- eventually say "paid this on Friday". The whole venue boundary exists to
-- keep that sentence away from a shop, and a notes policy is not the place to
-- hand it back.
drop policy if exists staff_read on invoice_notes;
create policy staff_read on invoice_notes
  for select using (author_id = auth.uid() and is_staff());


-- A sales invoice gets a note as a column rather than a table.
--
-- A payables invoice is a thing several people talk about over a fortnight and
-- it needs a thread. A sales invoice is a document you issue once. Giving it a
-- second notes table would be symmetry for its own sake.
alter table sales_invoices add column if not exists note text;


-- ============================================================================
--  7. WHAT THE PUSH SAYS
--
--  The trigger already fires on every insert. All that changes is the wording
--  when the invoice is one that needs looking at — the audience, the rules and
--  the "never tell somebody about their own action" clause are untouched.
--
--  If push has not been set up on this project, `notify_push` returns early
--  and this section does nothing at all. It is safe either way.
-- ============================================================================

create or replace function on_invoice_notify()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $fn$
declare
  v_supplier text;
  v_amount   text;
  v_venue    text;
begin
  select name into v_supplier from suppliers where id = new.supplier_id;
  v_amount := to_char(new.amount_cents / 100.0, 'FM999,999,990.00');

  if tg_op = 'INSERT' then
    if new.approved_at is null then
      -- Entered by a shop. Say which one, because "who entered this" is the
      -- whole of what reviewing means (ARCHITECTURE §34).
      select b.name into v_venue from businesses b where b.id = new.business_id;
      perform notify_push(
        'new_invoice',
        new.created_by,
        'Needs review',
        coalesce(v_venue, 'A venue') || ' entered ' ||
          coalesce(v_supplier, 'a supplier') || ' — $' || v_amount,
        '/review');
    else
      perform notify_push(
        'new_invoice',
        new.created_by,
        'New invoice',
        coalesce(v_supplier, 'A supplier') || ' — $' || v_amount,
        '/invoices/' || new.id);
    end if;

  elsif tg_op = 'UPDATE'
        and new.status = 'paid' and old.status is distinct from 'paid' then
    perform notify_push(
      'payment',
      new.paid_by,
      'Invoice paid',
      coalesce(v_supplier, 'A supplier') || ' — $' || v_amount,
      '/invoices/' || new.id);
  end if;

  return null;
end;
$fn$;


-- ============================================================================
--  8. CHECK IT WORKED
--
--  One query, because the SQL editor only shows the last result.
--
--  Expect, on the single row that comes back:
--
--    waiting_for_review     0     <- nothing is waiting yet; correct
--    unapproved_and_paid    0     <- MUST be 0. It is what the constraint stops
--    approved_but_no_by     0     <- MUST be 0
--    approval_columns       2
--    approval_constraints   2
--    stamp_trigger          1
--    approve_function       1
--    placeholder_suppliers  1     <- "Supplier not listed"
--    staff_can_add_supplier f     <- MUST be false. This is the lockdown
--    staff_note_policies    2
--    sales_note_column      1
-- ============================================================================

select
  (select count(*) from invoices where approved_at is null)              as waiting_for_review,
  (select count(*) from invoices
     where status = 'paid' and approved_at is null)                      as unapproved_and_paid,
  (select count(*) from invoices
     where approved_at is not null and approved_by is null)              as approved_but_no_by,

  (select count(*) from information_schema.columns
     where table_name = 'invoices'
       and column_name in ('approved_at', 'approved_by'))                as approval_columns,
  (select count(*) from pg_constraint
     where conname in ('approval_fields_consistent', 'paid_needs_approval'))
                                                                        as approval_constraints,
  (select count(*) from pg_trigger where tgname = 'invoices_stamp_approval')
                                                                        as stamp_trigger,
  (select count(*) from pg_proc where proname = 'approve_invoices')      as approve_function,

  (select count(*) from suppliers where is_placeholder)                  as placeholder_suppliers,
  (select exists (select 1 from pg_policies
     where tablename = 'suppliers' and policyname = 'staff_insert'))     as staff_can_add_supplier,
  (select count(*) from pg_policies
     where tablename = 'invoice_notes'
       and policyname in ('staff_insert', 'staff_read'))                 as staff_note_policies,
  (select count(*) from information_schema.columns
     where table_name = 'sales_invoices' and column_name = 'note')       as sales_note_column;


-- ############################################################################
--
--  9. AFTERWARDS — the one thing to run by hand, once.
--
--  Nothing above needs it. This is only if you want to see the review screen
--  working before a shop enters anything: it puts one of your own invoices
--  back into the waiting state so it appears in Review, and you approve it
--  from the app like any other.
--
--  Pick an UNPAID one and paste its reference:
--
--    update invoices
--       set approved_at = null, approved_by = null
--     where internal_ref = 'GMH-260905-01' and status = 'unpaid';
--
--  It will vanish from Pending and appear in Review, which is the whole
--  behaviour, demonstrated on a row you can put back with one tap.
--
-- ############################################################################
