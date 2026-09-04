-- ############################################################################
--
--  CATCH-UP 011 — one lock that was left off.
--
--  Supabase SQL editor -> New query -> paste -> Run.
--  Safe to run twice. Changes no invoice, no profile, no policy.
--
--  Small, and worth a round trip on its own because it came out of actually
--  running the verification rather than reading the SQL.
--
--  ---------------------------------------------------------------------------
--  WHAT WAS FOUND
--
--  `db/verify_rls.mjs`, run against the live project as the anonymous key,
--  reported this:
--
--     ok   rpc find_duplicate_invoices  changes nothing  — 42501
--     ok   rpc find_duplicate_invoices_staff changes nothing  — 0 rows
--
--  Both pass. They pass for completely different reasons, and only one of
--  those reasons is a lock.
--
--  `find_duplicate_invoices` is SECURITY INVOKER. Run by the anon key it reads
--  `invoices` AS the anon key, which has no grant, so Postgres refuses it
--  outright — 42501, insufficient privilege. The door is bolted.
--
--  `find_duplicate_invoices_staff` is SECURITY DEFINER, because it has to be:
--  a venue account has no access to `invoices` at all, so the function reads
--  the table with its owner's rights. That means table grants cannot stop it.
--  The only thing scoping it is its own WHERE clause —
--
--      where i.business_id = staff_venue()
--
--  — and for an anonymous caller `staff_venue()` is null, `business_id = null`
--  is never true, and it returns nothing. Which is the fail-closed design
--  working exactly as intended.
--
--  But note WHAT is stopping it: not a permission. The anon key is allowed to
--  CALL that function today. It gets nothing because of one comparison inside
--  it.
--
--  ---------------------------------------------------------------------------
--  WHY IT IS NOT ALREADY REVOKED, AND WHY THAT SURPRISED ME
--
--  CATCH_UP_010 says:
--
--      revoke all     on function find_duplicate_invoices_staff(...) from anon;
--      grant  execute on function find_duplicate_invoices_staff(...) to authenticated;
--
--  and that is not enough. PostgreSQL grants EXECUTE on every new function to
--  PUBLIC by default, and PUBLIC is not `anon` — revoking from `anon` removes a
--  grant it never separately had, while the one it is actually using stays
--  where it is.
--
--  So: not a leak today. A missing lock on a door that happens to be bolted
--  from the other side, which is a different thing and a worse one to leave,
--  because the bolt is one careless edit to a WHERE clause away from being
--  slid back by somebody who has no idea it was load-bearing.
-- ############################################################################

revoke execute on function find_duplicate_invoices_staff(uuid, text, int) from public;
revoke execute on function find_duplicate_invoices_staff(uuid, text, int) from anon;
grant  execute on function find_duplicate_invoices_staff(uuid, text, int) to   authenticated;

-- The same default applies to the three SECURITY DEFINER predicates. None of
-- them returns anything an anonymous caller could use — `is_member()` and
-- `is_staff()` return false, `staff_venue()` returns null — so this is
-- tidiness rather than a fix. Included because leaving two of four revoked and
-- two not is how the next person concludes the pattern was deliberate.
revoke execute on function is_member()   from public, anon;
revoke execute on function is_staff()    from public, anon;
revoke execute on function staff_venue() from public, anon;
grant  execute on function is_member()   to authenticated;
grant  execute on function is_staff()    to authenticated;
grant  execute on function staff_venue() to authenticated;

-- ----------------------------------------------------------------------------
-- Deliberately NOT touched: `find_duplicate_invoices`, `mark_invoices_paid`,
-- `unmark_invoice_paid`, `void_invoice`, `mark_sales_received`,
-- `unmark_sales_received`.
--
-- All SECURITY INVOKER, all already refused with 42501 for the anon key by the
-- table grants underneath them, all proven so by verify_rls.mjs. Revoking
-- execute as well would change nothing except how many statements have to be
-- re-reasoned about next time.
-- ----------------------------------------------------------------------------

-- ============================================================================
--  Check it worked.
--
--  Expect ONE row, and `anon_can_execute` false. Then re-run
--  `node db/verify_rls.mjs`, where the staff lookup should stop saying
--  "0 rows" and start saying "42501" — refused by a permission rather than by
--  a comparison.
-- ============================================================================
select
  p.proname,
  p.prosecdef                                          as security_definer,
  has_function_privilege('anon', p.oid, 'EXECUTE')     as anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as members_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'find_duplicate_invoices_staff';
