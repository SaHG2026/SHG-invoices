-- ===========================================================================
-- CATCH_UP_027 — settled money is not an assistant's business
--
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- RUN THIS **WITH OR AFTER** THE DEPLOY, and this one is genuinely either way.
--
-- The app stops showing an assistant anything paid whether or not this has
-- run; this makes it true rather than merely hidden. Run first and an
-- assistant on the live version sees a History screen that has gone empty,
-- which is untidy but harmless. Run after and there is a window where the
-- screen is hidden but the rows are still readable to anything that asks the
-- API directly. Neither is a broken state, which is why this one carries no
-- warning — unlike CATCH_UP_026, which did.
--
-- ---------------------------------------------------------------------------
-- What this is for
--
-- *"also for assistants hide payment history"*.
--
-- CATCH_UP_022 §3 deliberately gave the tier the whole ledger to read, paid
-- and unpaid, and §52 wrote down why: the tier exists so somebody cannot
-- ALTER or SETTLE the ledger, not because what they see is doubted. That
-- reasoning was sound and it has been overruled by the person whose ledger it
-- is. It is a different question from the one §52 answered — not "can they be
-- trusted to look" but "is settled money any of this tier's business" — and
-- the answer to that one is the owner's to give.
--
-- ---------------------------------------------------------------------------
-- Four doors, and the app closed three of them
--
-- The menu row, the History link on each business, and the URL itself are
-- handled in `lib/nav.ts` by `maySeePaymentHistory`. The fourth is the one
-- that is not a screen: **the activity bell**, which announces "Mani marked
-- paid" whether or not the reader can open anything showing it.
--
-- All four are the interface deciding what to offer. **This file is the part
-- that makes it a wall rather than a curtain**, and without it the rows are
-- still there for anything that asks PostgREST directly.
--
-- ---------------------------------------------------------------------------
-- The one thing that would have quietly broken, and did not
--
-- `find_duplicate_invoices` (migration 004) is **security invoker** and
-- returns `setof invoices`. Narrowing the SELECT policy below would therefore
-- have narrowed the duplicate check along with it: an assistant would stop
-- being warned about an invoice that had already been paid — which is the
-- most useful warning it gives, and it would have failed silently.
--
-- CATCH_UP_010 §5 hit this exact wall for the shops and solved it by giving
-- them their own narrowed function. §3 below does the same for this tier, for
-- the same reason and in the same shape. **Spec §6 protection is not allowed
-- to be weakened as a side effect of a permission change.**
-- ===========================================================================


-- ===========================================================================
--  1. THE LEDGER — unpaid and void, never paid
--
--  Replaces the policy from CATCH_UP_022 §3. One added condition; everything
--  else about the tier is untouched.
--
--  `status <> 'paid'` rather than `status = 'unpaid'`, deliberately. A voided
--  invoice is not settled money — it is a mistake with a reason attached, and
--  an assistant who entered one should be able to see that it was rejected.
--  Hiding it would mean they enter it again, which is the failure
--  CATCH_UP_013 §3 already names about rejected venue entries.
-- ===========================================================================

drop policy if exists assistant_read on invoices;
create policy assistant_read on invoices
  for select using (is_assistant() and status <> 'paid');


-- ===========================================================================
--  2. THE LOG — no payment events, and no payment references either
--
--  `action` is the obvious half: 'paid' and 'unpaid' are named actions
--  (migration 003) and both are payment history by definition.
--
--  **`detail` is the half that is easy to miss.** The audit trigger records
--  changed fields, and `payment_ref` is one of them. A payment reference
--  corrected on an already-paid invoice changes no status, so it is logged as
--  'edited' — and `lib/derive/activity.ts` renders it as "payment reference".
--  An action-only filter would let that through, which is the whole thing
--  this file is about arriving by a side road.
--
--  `detail ? 'payment_ref'` is jsonb key existence. Cheap, and it does not
--  care what the value is.
-- ===========================================================================

drop policy if exists assistant_read on activity_log;
create policy assistant_read on activity_log
  for select using (
    is_assistant()
    and action not in ('paid', 'unpaid')
    and not (detail ? 'payment_ref')
  );


-- ===========================================================================
--  3. THE DUPLICATE CHECK THEY KEEP
--
--  A copy of `find_duplicate_invoices_staff` (CATCH_UP_010 §5) with one
--  difference: the shop's version is bounded by `staff_venue()` because a
--  shop sees one business, and an assistant enters against all four.
--
--  **`is_assistant()` in the WHERE is the boundary**, and it has to be
--  written rather than assumed: this is SECURITY DEFINER, so without it any
--  authenticated caller could read across the whole ledger through it. The
--  staff version is guarded by `staff_venue()` returning null for everybody
--  else; this one has no such accident to lean on.
--
--  The return shape is the narrow one, and that is the point. `setof
--  invoices` would hand back `status` and `paid_at` and undo §1 through the
--  back door — which is the sentence CATCH_UP_010 §5 wrote about the shops,
--  still true one tier later.
--
--  It searches PAID invoices too. That is not a leak: the warning says "there
--  is already one of these, entered on the 3rd, for $5,220" and never says
--  whether it was settled. Knowing an invoice exists is what stops it being
--  entered twice; knowing it was paid is what this file withholds.
--
--  **`internal_ref` and `created_by` are in the list on purpose.** They are
--  the two extra things the warning prints — the reference, and "entered by
--  Sujan" — and neither is payment information: a reference is stamped at
--  insert by a trigger and an author is stamped at insert by `auth.uid()`.
--  Leaving them out would have made an assistant's duplicate dialog quieter
--  than everybody else's for no reason anybody could have named later, and
--  spec §6 asks for exactly these five facts because each is a different way
--  of recognising "oh, that one".
--
--  What is withheld is the set that exists only once money moves: `status`,
--  `paid_at`, `paid_by`, `payment_ref`.
-- ===========================================================================

create or replace function find_duplicate_invoices_assistant(
  p_supplier_id    uuid,
  p_invoice_number text,
  p_lookback_days  int default 180
)
returns table (
  id             uuid,
  invoice_number text,
  invoice_date   date,
  amount_cents   bigint,
  internal_ref   text,
  created_by     uuid,
  supplier_name  text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select i.id, i.invoice_number, i.invoice_date, i.amount_cents,
         i.internal_ref, i.created_by, s.name
    from invoices i
    join suppliers s on s.id = i.supplier_id
   where is_assistant()                    -- the boundary; security definer
     and i.supplier_id = p_supplier_id
     and i.invoice_number is not null
     and lower(i.invoice_number) = lower(trim(p_invoice_number))
     and i.status <> 'void'
     and i.invoice_date >= (sydney_today() - p_lookback_days)
   order by i.invoice_date desc;
$fn$;

revoke all     on function find_duplicate_invoices_assistant(uuid, text, int) from anon;
grant  execute on function find_duplicate_invoices_assistant(uuid, text, int) to   authenticated;


-- ===========================================================================
--  4. WHAT IS DELIBERATELY NOT TOUCHED
--
--  * **`invoice_notes`** keeps its unconditional assistant read. A note is
--    free text and one of them will eventually say "paid this on Friday" —
--    but notes are the channel the placeholder mechanism depends on
--    (CATCH_UP_026), and filtering free text on what it might mention is a
--    guess that fails in both directions. Recorded as a known edge, not an
--    oversight.
--
--  * **The four, the shops and the builder.** Nothing above mentions them.
--    `is_assistant()` is false for every one of them, so each policy here is
--    inert on their side and the other policies on these tables are what
--    still answer for them.
--
--  * **`mark_invoices_paid` and friends.** An assistant could never call
--    them: `is_owner()` has guarded all four since CATCH_UP_019. Reading is
--    the only thing that changes in this file.
-- ===========================================================================


-- ===========================================================================
--  5. VERIFICATION
-- ===========================================================================
do $$
declare
  v_invoices text;
  v_log      text;
begin
  select qual into v_invoices
    from pg_policies
   where tablename = 'invoices' and policyname = 'assistant_read';

  if v_invoices is null then
    raise exception 'assistant_read on invoices is missing — CATCH_UP_022 has been undone';
  end if;

  if v_invoices not like '%paid%' then
    raise exception 'assistant_read on invoices does not mention paid — this file did not apply';
  end if;

  select qual into v_log
    from pg_policies
   where tablename = 'activity_log' and policyname = 'assistant_read';

  if v_log is null then
    raise exception 'assistant_read on activity_log is missing';
  end if;

  if v_log not like '%payment_ref%' then
    raise exception 'the log policy does not exclude payment_ref — an edited row would leak it';
  end if;

  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'find_duplicate_invoices_assistant'
       and p.prosecdef
  ) then
    raise exception 'find_duplicate_invoices_assistant is missing or not security definer';
  end if;

  -- The guard that stops a SECURITY DEFINER function being a hole.
  if (select pg_get_functiondef(p.oid)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'find_duplicate_invoices_assistant')
     not like '%is_assistant()%' then
    raise exception 'the assistant duplicate function has no is_assistant() guard — it reads everything';
  end if;

  -- Unchanged, and checked because §1 rewrites a policy on the same table.
  if not exists (
    select 1 from pg_policies
     where tablename = 'invoices' and policyname = 'assistant_insert'
  ) then
    raise exception 'assistant_insert on invoices is gone — they could no longer enter anything';
  end if;

  raise notice 'ok — an assistant reads unpaid and void, no payment events, and still gets duplicate warnings';
end $$;


-- ---------------------------------------------------------------------------
-- What you should SEE afterwards.
--
-- One notice starting "ok".
--
-- The policies, to read them back in words:
--
--   select tablename, policyname, qual
--     from pg_policies
--    where policyname like 'assistant%'
--    order by tablename, policyname;
--
-- And the real test, signed in as an assistant, which is the only proof that
-- counts:
--
--   * Paid history is not in the side menu, and no business shows a History
--     link
--   * opening /b/all/history directly says it is not part of their access
--   * the bell shows entries added and edited, and nothing marked paid
--   * entering an invoice number that already exists STILL warns, including
--     when the earlier one has been paid — this is the one that would have
--     broken silently, and §3 is why it did not
-- ---------------------------------------------------------------------------
