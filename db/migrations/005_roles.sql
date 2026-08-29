-- ============================================================================
-- 005 — roles and notification preferences
--
-- Everyone keeps full access. Spec §2 and §3.5 are unchanged: any member can
-- add any invoice and tick off any payment, and there is no approval workflow.
--
-- `role` exists only so the app knows whose screen gets the owner's overview
-- and the lightly accented treatment. It is NOT a permission, and it is
-- deliberately absent from every RLS policy in 007. If `role` ever starts
-- deciding what somebody can read or write, that belongs in a policy — and
-- this comment is the warning that no such policy has been written.
--
-- `notify_on_new_invoice` is a per-person setting, on by default for the
-- owner and off for everyone else, changeable by each person for themselves.
-- ============================================================================

alter table profiles
  add column if not exists role text not null default 'member';

alter table profiles
  add column if not exists notify_on_new_invoice boolean not null default false;

do $$ begin
  alter table profiles
    add constraint profiles_role_valid check (role in ('member', 'owner'));
exception when duplicate_object then null;
end $$;
