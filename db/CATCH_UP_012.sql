-- ############################################################################
--
--  CATCH-UP 012 — close two gaps in the venue INSERT policy.
--
--  Supabase SQL editor -> New query -> paste -> Run.
--  Safe to run twice. Changes no existing row.
--
--  ---------------------------------------------------------------------------
--  HOW THIS WAS FOUND
--
--  Not by reading the SQL — by running `db/verify_staff.mjs` against the live
--  test account and looking hard at WHY each rejection happened. Two of the
--  "cannot do X" checks passed for the wrong reason: the crafted request was
--  rejected by a trigger and a foreign key before the policy was ever reached,
--  which made the policy look like it was doing a job it was not.
--
--  ---------------------------------------------------------------------------
--  WHAT WAS WRONG
--
--  CATCH_UP_010's staff insert policy was:
--
--      with check (business_id = staff_venue())
--
--  That checks the venue and nothing else. Two things it does not check, and
--  both matter because the app is never the boundary (notes §2) — a crafted
--  request does not go through the sheet:
--
--    1. STATUS. A venue could insert an invoice with status = 'paid', its own
--       paid_at and paid_by, into its own venue. It would satisfy this policy
--       and the paid_fields_consistent constraint, and succeed. A shop could
--       make a bill appear settled that nobody paid — which is precisely the
--       thing "management reviews" exists to catch, defeated at the point of
--       entry.
--
--    2. CREATED_BY. A venue could set created_by to one of the four, forging
--       who entered the invoice. §33.1 accepted this for MEMBERS, on the
--       reasoning that the activity log takes its actor from the session
--       regardless. It is cheap to not accept it here, where the account is
--       shared and the whole point is knowing a shop entered something.
--
--  Neither is reachable from the app I built — the sheet sends no status and
--  sets created_by to the venue's own id. This is about what the DATABASE
--  permits a hand-crafted request to do, which is the only thing that counts.
--
--  ---------------------------------------------------------------------------
--  THE FIX
--
--  Three conditions instead of one. The two new ones cost the legitimate path
--  nothing: status defaults to 'unpaid' (so a normal insert that names no
--  status passes), and the app already sets created_by to the signed-in id.
-- ############################################################################

drop policy if exists staff_insert on invoices;
create policy staff_insert on invoices
  for insert with check (
    business_id = staff_venue()
    and created_by = auth.uid()
    and status = 'unpaid'
  );

-- ----------------------------------------------------------------------------
-- Check it worked. Expect one row, with the full expression in `with_check`.
-- ----------------------------------------------------------------------------
select polname, pg_get_expr(polwithcheck, polrelid) as with_check
  from pg_policy
 where polname = 'staff_insert'
   and polrelid = 'invoices'::regclass;
