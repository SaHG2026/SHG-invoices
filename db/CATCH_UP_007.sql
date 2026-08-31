-- ============================================================================
--  CATCH-UP 007 — you become the builder, and pictures become yours to change.
--
--  Supabase SQL editor -> New query -> paste -> Run.
--  Safe to run twice. Changes no invoice.
--
--  Two things you asked for, in one file because each one is a round trip
--  through a person:
--
--    1. Your profile stops being one of the three names, while keeping every
--       bit of access you have now.
--    2. A place to put logos and photographs that you can change yourself,
--       from the app, without asking me and without a new deployment.
-- ============================================================================


-- ============================================================================
--  1. THE BUILDER
--
--  Your words: "as the builder and maintenance, I always have the access, but
--  I am not the part of an active management".
--
--  Those are two separate facts, and until now one column carried both. The
--  obvious move is `active = false` and it is WRONG: `is_member()` in migration
--  007 tests exactly that column, so setting it false does not hide you, it
--  locks you out of the app you maintain.
--
--  So `role` gains a third value. It already existed for exactly this kind of
--  fact — what a screen shows — and migration 005 states it is deliberately
--  absent from every RLS policy. Nothing about your access changes here.
-- ============================================================================

-- The constraint has to allow the new value before anything can be set to it.
alter table profiles drop constraint if exists profiles_role_valid;

alter table profiles
  add constraint profiles_role_valid check (role in ('member', 'owner', 'builder'));

update profiles set role = 'builder' where display_name = 'Rabindra';

-- Belt and braces: a builder is never a notification target, whatever any
-- switch says. CATCH_UP_006's views already exclude the role; this makes the
-- underlying flags agree with them so the two can never disagree.
update profiles
   set notify_on_new_invoice = false,
       notify_on_payment     = false
 where role = 'builder';


-- ============================================================================
--  2. PICTURES YOU CAN CHANGE YOURSELF
--
--  Today a logo is a file in the repo and a line in lib/logos.ts, which means
--  every new logo is a message to me and a deployment. This puts them in
--  Supabase Storage instead, so the app reads whatever is in the bucket and
--  you replace it from a screen in the app.
--
--  What this does NOT cover, and cannot: the app's own icon — the tile on the
--  Home Screen, the one in the browser tab. Those are baked into the app when
--  it is built, because the phone reads them before the app has loaded. A new
--  app icon is still a deployment. Everything inside the app is not.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The bucket. Public for reading: these are logos and staff photographs shown
-- on every screen, and putting them behind signed urls would mean a token
-- round trip per picture per screen, on a phone, on shop wifi.
--
-- Public means READABLE by anyone with the exact url. It does not mean
-- writable — that is the policies below, and nothing here is a secret.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('brand', 'brand', true)
on conflict (id) do update set public = true;

-- ----------------------------------------------------------------------------
-- Who may change a picture.
--
-- You (builder) and Mani (owner). Not everybody: a logo changing under people
-- is confusing in a way a mistyped invoice is not, because nobody knows who
-- did it or how to put it back.
--
-- To restrict it to you alone, delete `'owner',` from the line below and run
-- this file again.
-- ----------------------------------------------------------------------------
create or replace function is_brand_editor()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from profiles p
     where p.id = auth.uid()
       and p.active
       and p.role in ('owner', 'builder')
  );
$fn$;

-- Everybody signed in can list the bucket, because the app has to know which
-- pictures exist before it can show them.
drop policy if exists brand_read on storage.objects;
create policy brand_read on storage.objects
  for select using (bucket_id = 'brand' and is_member());

drop policy if exists brand_write on storage.objects;
create policy brand_write on storage.objects
  for insert with check (bucket_id = 'brand' and is_brand_editor());

drop policy if exists brand_update on storage.objects;
create policy brand_update on storage.objects
  for update using (bucket_id = 'brand' and is_brand_editor())
  with check (bucket_id = 'brand' and is_brand_editor());

drop policy if exists brand_delete on storage.objects;
create policy brand_delete on storage.objects
  for delete using (bucket_id = 'brand' and is_brand_editor());


-- ============================================================================
--  3. Check it worked.
--
--  Expect: Rabindra says 'builder' with both notification flags false, and the
--  other three unchanged.
-- ============================================================================
select display_name, role, active, notify_on_new_invoice, notify_on_payment
  from profiles
 order by role, display_name;
