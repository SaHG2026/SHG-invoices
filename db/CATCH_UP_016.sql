-- ############################################################################
--
--  CATCH-UP 016 — a shop's note could never actually be written.
--
--  Supabase SQL editor -> New query -> paste -> Run. Safe to run twice.
--
--  A defect I introduced in CATCH_UP_013, found by reading it again rather
--  than by anything failing loudly — which is the problem with it.
--
--  ---------------------------------------------------------------------------
--  WHAT WAS WRONG
--
--  CATCH_UP_013 §6 gave a venue permission to write a note:
--
--    create policy staff_insert on invoice_notes
--      for insert with check (
--        author_id = auth.uid()
--        and exists (
--          select 1 from invoices i
--           where i.id = invoice_notes.invoice_id
--             and i.business_id = staff_venue()
--        )
--      );
--
--  That `exists` reads `invoices`. **A policy expression runs as the caller,
--  not as the owner** — so RLS on `invoices` applies to it, and a venue has no
--  SELECT policy on `invoices` at all. The subquery therefore finds nothing,
--  for every invoice, including the shop's own. The check is false always and
--  the note is refused with 42501, every time.
--
--  The reason it went unnoticed is the reason it matters: the note is written
--  as a SECOND queued write, after the invoice, and nothing waits on it. The
--  invoice saves, the toast says Saved, and the note silently is not there.
--
--  And the note is not a nicety. Since CATCH_UP_013 §5 a shop cannot create a
--  supplier, so the note is the ONLY way it can tell you a delivery came from
--  somebody new. That channel has been closed since the day it was opened.
--  ---------------------------------------------------------------------------
--
--  THE FIX: ask a SECURITY DEFINER function instead of reading the table.
--
--  `staff_venue()` is already exactly this shape and already works — it reads
--  `profiles`, which staff also cannot read freely, and it works because it is
--  SECURITY DEFINER. The same move, one table over.
--
-- ############################################################################


-- ============================================================================
--  1. THE HELPER
--
--  Answers one question and returns one boolean: is this invoice in the
--  calling venue's own venue?
--
--  SECURITY DEFINER so it may read `invoices` — and it returns a yes/no about
--  a row the caller already named, never a row, so it cannot become a way to
--  read anything. `staff_venue()` returns NULL for anybody who is not staff,
--  and `business_id = null` is never true, so this is false for the four as
--  well. They do not need it: `member_all` already covers them, and policies
--  of the same command are OR'd.
-- ============================================================================

create or replace function invoice_is_own_venue(p_invoice_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from invoices i
     where i.id = p_invoice_id
       and i.business_id = staff_venue()
  );
$fn$;

revoke all     on function invoice_is_own_venue(uuid) from anon;
grant  execute on function invoice_is_own_venue(uuid) to   authenticated;


-- ============================================================================
--  2. THE POLICY, REWRITTEN
--
--  `author_id = auth.uid()` is unchanged and is still the half that is easy to
--  leave out: without it a shop could file a note as Mani.
-- ============================================================================

drop policy if exists staff_insert on invoice_notes;
create policy staff_insert on invoice_notes
  for insert with check (
    author_id = auth.uid()
    and invoice_is_own_venue(invoice_id)
  );

-- Reading is unchanged: its own notes and nothing else. It never had this bug,
-- because it asks only about `author_id`, which is on the row itself.
drop policy if exists staff_read on invoice_notes;
create policy staff_read on invoice_notes
  for select using (author_id = auth.uid() and is_staff());


-- ============================================================================
--  3. CHECK IT WORKED
--
--  Expect: helper 1, policies 2.
--
--  This one cannot be proven from here — the whole point is that it behaves
--  differently for a venue than for you, and running it as yourself proves
--  nothing. `db/verify_staff.mjs` gained a check for exactly this; run it as
--  the shop afterwards.
-- ============================================================================

select
  (select count(*) from pg_proc where proname = 'invoice_is_own_venue')  as helper,
  (select count(*) from pg_policies
     where tablename = 'invoice_notes'
       and policyname in ('staff_insert', 'staff_read'))                 as policies;


-- ############################################################################
--
--  4. JOB TITLES — asked for separately, and it needs a column
--
--  "under the profile name lets add a tag: Mani- Ceo, Milan-COO, Sujan-General
--  Manager (GM), Rabindra (builder)"
--
--  ---------------------------------------------------------------------------
--  Why this is not derived from `role`
--
--  `role` cannot tell Milan from Sujan — both are `member`. It never could:
--  it exists to decide what a screen shows and, for `staff`, what a policy
--  allows. Overloading it with a job title would make four roles into six and
--  put a permission next to a business card.
--
--  And why it is not a lookup table in the app keyed on the name: HANDOFF §4
--  is explicit that nothing branches on a display name. A name is data. The
--  single place a name may appear is a statement like the one below, SETTING
--  data — which is exactly what CATCH_UP_006 does for `notify_on_payment`.
--  ---------------------------------------------------------------------------
--
--  Not in the column grant, deliberately. A person may change their own
--  notification preference and their own reminder time; a job title is a fact
--  about the company, not a preference, and nobody appoints themselves.
--
-- ############################################################################

alter table profiles add column if not exists title text;

comment on column profiles.title is
  'Job title shown under the name in Settings. Deliberately NOT in the '
  'self_update column grant — a title is a fact about the company, not a '
  'preference. Change it here.';

update profiles set title = 'CEO'             where display_name = 'Mani';
update profiles set title = 'COO'             where display_name = 'Milan';
update profiles set title = 'General Manager' where display_name = 'Sujan';
update profiles set title = 'Builder'         where display_name = 'Rabindra';

-- Expect four rows with a title, and the two shops with none.
select display_name, role, coalesce(title, '—') as title
  from profiles
 where active
 order by role, display_name;

