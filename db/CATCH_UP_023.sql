-- ===========================================================================
-- CATCH_UP_023 — J5: discounts and refunds on Deli's invoices
--
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- RUN THIS **BEFORE** THE DEPLOY, and this one is not a preference.
--
-- ---------------------------------------------------------------------------
-- THIS FILE FAILED THE FIRST TIME IT WAS RUN, AND THE REASON IS WORTH KEEPING
--
-- It used to carry a fourth thing: four UPDATEs converting `profiles.accent`
-- from hex to slot names, which CATCH_UP_003 was meant to do and never did.
-- Unrelated work, folded in because each of these files costs a round trip
-- through a person.
--
-- Those updates matched on ids taken from `db/seed/002_profiles.sql`. When
-- they matched nothing, the verification block's `raise exception` fired --
-- and because the SQL editor runs a script as one transaction, **the table
-- and both functions rolled back with it.** The schema change was destroyed
-- by a cosmetic one that failed beside it.
--
-- The accents are now CATCH_UP_024, on their own, written so they cannot
-- fail. **A cosmetic change must never be able to roll back a schema change**,
-- and "it is only four UPDATEs" is exactly how one ends up able to.
-- ---------------------------------------------------------------------------
--
-- The new app version asks every sales invoice for its adjustments by name.
-- PostgREST answers a missing relationship with a 400 and fails the whole
-- request — so Receivables, the customer screens and every issued invoice
-- would come back empty. Deployed first with this file not run, Deli's side
-- of the app does not work.
--
-- Run before the deploy it is invisible: one empty table and two functions
-- the live version never calls.
--
-- ---------------------------------------------------------------------------
-- What this is for
--
-- ARCHITECTURE §44.6, in his words: *"Custom payment (applied discount,
-- refunded amount etc)"* and *"Discounts, only for Deli's Customers (because
-- refund or can offer discount)"*.
--
-- **This was deliberately closed once.** §28.3 refused `amount_received_cents`
-- as "the first plank of an accounts package", and part payments are carried
-- by a note and a moved due date. That decision is being reopened on purpose,
-- and the shape below is what makes it safe to reopen: not an edit to a
-- figure, but rows that say what happened and why.
--
-- ---------------------------------------------------------------------------
-- Why this is not a column on `sales_invoices`
--
-- The obvious change is `amount_cents = amount_cents - 40`. Three rules say
-- no, and each one on its own would be enough:
--
--   Rule 5  An overwritten amount destroys what the invoice originally said,
--           and the original is what the customer's copy says.
--   Rule 4  A total must be derived from the rows it summarises, not from a
--           column somebody has to remember to keep in step.
--   §28.3   "Why is this bill $40 less than the docket" is a question a
--           column cannot answer and a row can.
--
-- So: append-only rows carrying what, how much, why, who and when. Every
-- figure in the app derives the net from them.
--
-- ---------------------------------------------------------------------------
-- Manager level, and that is deliberately NOT where paid/unpaid sits
--
-- Marking an invoice received records that money moved: it is a statement
-- about the bank, and CATCH_UP_019 §5 made it the owner's alone. A discount
-- changes what is owed, on Deli's own invoice, before anybody has paid
-- anything — a commercial decision the people running the shop are there to
-- make.
--
-- One consequence to build for, and §44.6 named it: this is the first thing a
-- manager may do that changes a figure the owner watches. So every row
-- carries who and why, both print on the invoice, and the activity log gets a
-- line — an unexplained $40 is exactly the disagreement §28.3 refused
-- `amount_cents` to avoid.
-- ===========================================================================


-- ===========================================================================
--  1. THE TABLE
--
--  `on delete cascade` from the invoice, matching `sales_invoice_lines`. An
--  adjustment has no meaning without the invoice it reduces, and the only
--  thing that deletes a sales invoice is the wipe (CATCH_UP_021), which is
--  meant to take everything with it.
-- ===========================================================================

create table if not exists sales_invoice_adjustments (
  id               uuid primary key,
  sales_invoice_id uuid not null references sales_invoices(id) on delete cascade,

  -- Two kinds, and they are genuinely different events rather than a sign on
  -- a number. A DISCOUNT reduces what is owed before it is settled; a REFUND
  -- gives money back after it has been. Both reduce the net, and somebody
  -- reading the invoice next year needs to know which one happened.
  kind             text not null check (kind in ('discount', 'refund')),

  -- Always positive, always a reduction. A signed amount would allow an
  -- adjustment that INCREASES an invoice, which is not a discount or a refund
  -- — it is a second invoice, and it should be one.
  amount_cents     integer not null check (amount_cents > 0),

  -- Not nullable and not blank. The reason is the entire argument for this
  -- table existing (§28.3), so an adjustment without one would be the column
  -- this table was built instead of.
  reason           text not null check (btrim(reason) <> ''),

  created_by       uuid not null references profiles(id),
  created_at       timestamptz not null default now(),

  -- ---- Undoing one -------------------------------------------------------
  -- Voided, never deleted (rule 5), and the same shape an invoice uses.
  --
  -- Append-only without a way back sounds purer and is wrong here: somebody
  -- will type 400 for 40, and with no reversal the invoice total is
  -- permanently untrue. "Correct it with an opposite entry" does not work
  -- either, because both kinds REDUCE — there is no adjustment that adds.
  voided_at        timestamptz,
  voided_by        uuid references profiles(id),
  void_reason      text,

  constraint adjustment_void_is_whole check (
    (voided_at is     null and voided_by is     null and void_reason is null) or
    (voided_at is not null and voided_by is not null)
  )
);

comment on table sales_invoice_adjustments is
  'Discounts and refunds against one of Deli''s invoices. Append-only, voided '
  'never deleted, every total derived. ARCHITECTURE §53.';

create index if not exists sales_adjustments_invoice
  on sales_invoice_adjustments (sales_invoice_id, created_at);


-- ===========================================================================
--  2. WHO MAY SEE THEM
--
--  A select policy and NOTHING ELSE. No insert, no update, no delete — the
--  two functions below are the only writers, exactly as `activity_log` has
--  only its trigger.
--
--  That is what makes "append-only" a property of the database rather than a
--  habit of the app: there is no policy a crafted request could use to change
--  an adjustment after the fact, so the reason attached to a figure cannot be
--  quietly rewritten later.
--
--  `is_manager_or_above()` like every other policy on Deli's side. The
--  assistant tier (CATCH_UP_022) gets no policy here at all and therefore no
--  access, which is correct: it has none to `sales_invoices` either.
-- ===========================================================================

alter table sales_invoice_adjustments enable row level security;

drop policy if exists member_read on sales_invoice_adjustments;
create policy member_read on sales_invoice_adjustments
  for select using (is_manager_or_above());

revoke all on sales_invoice_adjustments from anon;
grant select on sales_invoice_adjustments to authenticated;


-- ===========================================================================
--  3. ADDING ONE
--
--  The id is generated by the CLIENT and passed in, which is CATCH_UP_015
--  §3's pattern and the reason is worth repeating: a queued write replayed
--  from a cold start must be able to arrive twice without creating two rows.
--  With the id fixed by the caller, the second arrival is a primary-key
--  clash the app can recognise as "it already worked".
-- ===========================================================================

create or replace function add_sales_adjustment(
  p_id          uuid,
  p_invoice_id  uuid,
  p_kind        text,
  p_amount_cents integer,
  p_reason      text
)
returns sales_invoice_adjustments
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_invoice sales_invoices;
  v_already integer;
  v_reason  text;
  v_row     sales_invoice_adjustments;
begin
  if not is_manager_or_above() then
    raise exception 'Only a manager or the owner can apply a discount.'
      using errcode = '42501';
  end if;

  if p_kind not in ('discount', 'refund') then
    raise exception 'An adjustment is either a discount or a refund.'
      using errcode = '22023';
  end if;

  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'An adjustment has to be more than nothing.'
      using errcode = '22023';
  end if;

  -- Trimmed here, not only in the app. The app trims too, because a field
  -- that lets you type spaces and saves them is a field that lies about being
  -- empty -- but the app is not the only caller a function ever gets, and a
  -- blank reason is the one thing this table must never hold.
  v_reason := btrim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'Say why. An amount with no reason is what this replaced.'
      using errcode = '22023';
  end if;

  select * into v_invoice from sales_invoices where id = p_invoice_id;
  if not found then
    raise exception 'No such invoice.' using errcode = '22023';
  end if;

  if v_invoice.status = 'void' then
    raise exception 'That invoice is voided. There is nothing to discount.'
      using errcode = '22023';
  end if;

  -- ---- It cannot reduce an invoice below nothing --------------------------
  -- Checked here rather than by a constraint, because it is a fact about the
  -- SUM of sibling rows and a check constraint can only see one row.
  --
  -- This is the guard that keeps the receivables total honest: a net below
  -- zero would mean a customer owes negative money, and that figure would
  -- flow into every screen on Deli's side as a credit nobody agreed to.
  select coalesce(sum(amount_cents), 0) into v_already
    from sales_invoice_adjustments
   where sales_invoice_id = p_invoice_id
     and voided_at is null;

  if v_already + p_amount_cents > v_invoice.amount_cents then
    raise exception
      'That is more than is left on this invoice. % remains.',
      to_char((v_invoice.amount_cents - v_already) / 100.0, 'FM999999990.00')
      using errcode = '22023';
  end if;

  insert into sales_invoice_adjustments
    (id, sales_invoice_id, kind, amount_cents, reason, created_by)
  values
    (p_id, p_invoice_id, p_kind, p_amount_cents, v_reason, auth.uid())
  returning * into v_row;

  -- ---- The trace ---------------------------------------------------------
  -- A manager changing a figure the owner watches does not happen quietly.
  --
  -- `entity_type` is 'sales_invoice', which keeps it out of the header bell
  -- and the invoice stream: both filter `entity_type = 'invoice'`, so no
  -- renderer has to learn a word for this and a discount cannot appear in the
  -- feed as a supplier invoice that does not exist. It is on the document and
  -- in the database, which is where somebody looks for it.
  insert into activity_log (entity_type, entity_id, action, actor_id, detail)
  values (
    'sales_invoice',
    p_invoice_id,
    'adjusted',
    auth.uid(),
    jsonb_build_object(
      'kind', p_kind,
      'amount_cents', p_amount_cents,
      'reason', v_reason
    )
  );

  return v_row;
end;
$fn$;

revoke execute on function add_sales_adjustment(uuid, uuid, text, integer, text)
  from public, anon;
grant  execute on function add_sales_adjustment(uuid, uuid, text, integer, text)
  to   authenticated;


-- ===========================================================================
--  4. UNDOING ONE
--
--  An update, and the only one this table has. It is confined to the three
--  void columns by being the only door -- RLS cannot restrict columns, which
--  is CATCH_UP_020 §2's reasoning, and here it matters more: a function that
--  could write `amount_cents` would be the edit this whole table exists to
--  prevent.
-- ===========================================================================

create or replace function void_sales_adjustment(p_id uuid, p_reason text)
returns sales_invoice_adjustments
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row sales_invoice_adjustments;
begin
  if not is_manager_or_above() then
    raise exception 'Only a manager or the owner can undo a discount.'
      using errcode = '42501';
  end if;

  select * into v_row from sales_invoice_adjustments where id = p_id;
  if not found then
    raise exception 'No such adjustment.' using errcode = '22023';
  end if;

  -- Voiding a voided row would move `voided_at` and lose when it actually
  -- happened. Refused rather than ignored: silently doing nothing and
  -- returning the row would look like it worked.
  if v_row.voided_at is not null then
    raise exception 'That was already undone.' using errcode = '22023';
  end if;

  update sales_invoice_adjustments
     set voided_at   = now(),
         voided_by   = auth.uid(),
         void_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_id
  returning * into v_row;

  insert into activity_log (entity_type, entity_id, action, actor_id, detail)
  values (
    'sales_invoice',
    v_row.sales_invoice_id,
    'adjustment_undone',
    auth.uid(),
    jsonb_build_object(
      'kind', v_row.kind,
      'amount_cents', v_row.amount_cents,
      'reason', v_row.void_reason
    )
  );

  return v_row;
end;
$fn$;

revoke execute on function void_sales_adjustment(uuid, text) from public, anon;
grant  execute on function void_sales_adjustment(uuid, text) to   authenticated;


-- ===========================================================================
--  5. CHECK IT WORKED
--
--  Raises rather than returning rows, so a failure cannot be scrolled past.
-- ===========================================================================

do $$
declare
  v_cols int;
  v_fn   int;
  v_pol  int;
begin
  select count(*) into v_cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'sales_invoice_adjustments';
  if v_cols < 10 then
    raise exception 'sales_invoice_adjustments is missing columns, found %', v_cols;
  end if;

  select count(*) into v_fn from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('add_sales_adjustment', 'void_sales_adjustment');
  if v_fn <> 2 then
    raise exception 'expected both adjustment functions, found %', v_fn;
  end if;

  -- ---- The thing this file must NOT have done ---------------------------
  -- Any policy that can write is the append-only guarantee gone: it would
  -- mean the reason attached to a figure can be rewritten after the fact.
  select count(*) into v_pol
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'sales_invoice_adjustments'
     and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');
  if v_pol <> 0 then
    raise exception 'sales_invoice_adjustments has a write policy — that is wrong';
  end if;

  if not exists (
    select 1 from pg_tables
     where schemaname = 'public'
       and tablename  = 'sales_invoice_adjustments'
       and rowsecurity
  ) then
    raise exception 'row level security is off on sales_invoice_adjustments';
  end if;

  raise notice 'ok — adjustments exist, nothing can write them but the two functions';
end $$;

-- ---------------------------------------------------------------------------
-- What you should SEE afterwards. An empty table:
--
--   select count(*) from sales_invoice_adjustments;
--
-- And signed in as a shop login, this must be REFUSED with 42501:
--
--   select * from add_sales_adjustment(
--     gen_random_uuid(),
--     (select id from sales_invoices limit 1),
--     'discount', 100, 'testing');
-- ---------------------------------------------------------------------------
