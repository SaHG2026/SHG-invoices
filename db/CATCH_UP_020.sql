-- ===========================================================================
-- CATCH_UP_020 — what is printed on a Deli invoice
--
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- RUN THIS **BEFORE** THE DEPLOY, and this one is not a preference.
--
-- The new app version asks `businesses` for two columns by name. PostgREST
-- answers a missing column with 42703 and fails the whole request — and
-- `useBusinesses()` is what the add-invoice sheet waits on before anybody can
-- type anything. Deployed first, this file not run, the app does not work.
--
-- Run before the deploy it is invisible: two nullable columns and one function
-- the live version never calls.
--
-- ---------------------------------------------------------------------------
-- What this is for
--
-- J2, ARCHITECTURE §44.3. Three things go on the document Deli hands over:
--
--   * their own contact block, so a customer can reach them
--   * bank details -- *"For direct pay, use our account details..."*
--   * a signature line
--
-- Only two of them are here. **The signature line stores nothing** and is not
-- in this file at all: it is a ruled line on the paper saying Received by /
-- Signature / Date, for the person taking the delivery to put a pen on. Not a
-- digital signature, nothing to verify, nothing to keep.
--
-- ---------------------------------------------------------------------------
-- Free text, not fields
--
-- Two `text` columns rather than street/suburb/postcode/BSB/account number.
--
-- An address is not the same shape in two countries and a bank line is not the
-- same shape in two banks, so a form of named fields decides both on Deli's
-- behalf and gets one of them wrong. What is wanted is a block of text that
-- prints exactly as it was typed, and that is what this is: newlines are kept
-- and the document renders them with `white-space: pre-line`.
--
-- It also avoids the trap CATCH_UP_016 §4 met from the other side — a field
-- labelled by its role rather than its content is a field that gets filled in
-- wrongly. Nothing here is labelled by its role.
--
-- NULL is a real answer and means not set. The document prints no heading at
-- all for a null, rather than a heading with nothing under it: CATCH_UP_017's
-- rule for the missing due date, and the same reasoning. An empty label reads
-- as something that failed to load.
--
-- ---------------------------------------------------------------------------
-- Live, not copied onto each invoice
--
-- ARCHITECTURE §44.3 said these should be frozen onto every invoice at issue,
-- the way a line's price is frozen (CATCH_UP_015 §2). **That was decided
-- against, deliberately, and it is worth writing down why** because the two
-- look alike:
--
--   A price is a TERM THAT WAS AGREED. Reprinting an invoice with today's
--   price would rewrite what the customer accepted.
--
--   A bank account is a ROUTING INSTRUCTION. This app reprints an invoice at
--   any time, so freezing would mean handing somebody an unpaid invoice
--   naming an account that has since closed -- telling a customer to send
--   money where it cannot arrive.
--
-- So the document reads these live, and changing them changes what every
-- reprint says. The cost is accepted and stated: a settled invoice reprinted
-- next year shows today's details rather than the ones on the paper that was
-- handed over.
--
-- **If that ever has to change**, it is one nullable `jsonb` column on
-- `sales_invoices` holding a snapshot, written by `create_sales_invoice`, with
-- the renderer reading `invoice.issuer ?? the business row`. Null then means
-- "issued before we started snapshotting", which every invoice in the database
-- today would be, so the fallback is needed whichever way it is built. Nothing
-- below makes that harder.
-- ===========================================================================


-- ===========================================================================
--  1. THE TWO COLUMNS
-- ===========================================================================

alter table businesses add column if not exists contact_block text;
alter table businesses add column if not exists bank_details  text;

comment on column businesses.contact_block is
  'Free text, printed under the name on an issued invoice. Newlines kept.';
comment on column businesses.bank_details is
  'Free text, printed as the payment block on an issued invoice. Newlines kept.';


-- ===========================================================================
--  2. WHO MAY WRITE THEM
--
--  `businesses` has exactly one policy, `member_read`, and no UPDATE policy at
--  all -- migration 007 says "businesses are seeded, not managed in the app".
--  **That stays true.** Nothing below adds an update policy and nothing widens
--  a grant, so `name`, `code`, `sort_order` and `active` remain unreachable
--  from a browser, which is what has kept the four businesses stable.
--
--  What changes is that two of the columns now have an owner-only door, and it
--  is a function rather than a policy for the reason CATCH_UP_019 §6 gives in
--  full: a grant is coarse and permanent and cannot ask who is calling. This
--  one can, and it can also confine itself to two columns, which RLS by nature
--  cannot do.
-- ===========================================================================

create or replace function set_business_document(
  p_business_id   uuid,
  p_contact_block text,
  p_bank_details  text
)
returns businesses
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row businesses;
begin
  if not is_owner() then
    raise exception 'Only the owner can change what is printed on an invoice.'
      using errcode = '42501';
  end if;

  update businesses
     set contact_block = nullif(btrim(coalesce(p_contact_block, '')), ''),
         bank_details  = nullif(btrim(coalesce(p_bank_details,  '')), '')
   where id = p_business_id
  returning * into v_row;

  if not found then
    raise exception 'No such business.' using errcode = '22023';
  end if;

  return v_row;
end;
$fn$;

-- Blank is null, and the trimming is done HERE rather than in the app.
--
-- The app trims too, because a field that lets you type spaces and then saves
-- them is a field that lies about being empty. But the app is not the only
-- caller a function ever gets, and '' and NULL meaning different things on the
-- document -- one prints an empty heading, the other prints nothing -- is
-- exactly the two-values-for-one-state shape this project keeps removing.
-- Only NULL can reach the column.

revoke execute on function set_business_document(uuid, text, text) from public, anon;
grant  execute on function set_business_document(uuid, text, text) to   authenticated;


-- ===========================================================================
--  3. CHECK IT WORKED
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
     and table_name   = 'businesses'
     and column_name in ('contact_block', 'bank_details');

  if v_cols <> 2 then
    raise exception 'expected both columns on businesses, found %', v_cols;
  end if;

  select count(*) into v_fn from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'set_business_document';

  if v_fn <> 1 then
    raise exception 'set_business_document is missing';
  end if;

  -- The thing this file must NOT have done. If an update policy has appeared
  -- on `businesses`, somebody can rename a business from a browser, and every
  -- internal ref is built from `code`.
  select count(*) into v_pol
    from pg_policies
   where schemaname = 'public' and tablename = 'businesses'
     and cmd in ('UPDATE', 'ALL');

  if v_pol <> 0 then
    raise exception 'businesses has gained an update policy — that is wrong';
  end if;

  raise notice 'ok — the invoice document is owner-editable, businesses still read-only';
end $$;

-- ---------------------------------------------------------------------------
-- What you should SEE afterwards. Both columns null on all four businesses,
-- because nothing has been typed yet.
-- ---------------------------------------------------------------------------
-- select code, name, contact_block, bank_details from businesses order by sort_order;
--
-- And, signed in as Milan or Sujan, this must be REFUSED with 42501:
--
-- select * from set_business_document(
--   (select id from businesses where code = 'DDL'), 'x', 'y');
