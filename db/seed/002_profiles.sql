-- Spec §12.
--
-- Run this AFTER creating the three users in the Supabase dashboard
-- (Authentication -> Users -> Add user), and paste their UUIDs in below.
-- profiles.id references auth.users(id), so the accounts must exist first.
--
-- Accents are the app's only colour-as-identity device (spec §9), and they
-- match the palette exactly: Mani gold, Milan slate, Sujan chilli.

insert into profiles (id, display_name, initials, accent) values
  ('00000000-0000-0000-0000-000000000000', 'Mani',  'MA', '#C9A227'),
  ('00000000-0000-0000-0000-000000000001', 'Milan', 'MI', '#2E7C93'),
  ('00000000-0000-0000-0000-000000000002', 'Sujan', 'SU', '#4F8F2E')
on conflict (id) do update
  set display_name = excluded.display_name,
      initials     = excluded.initials,
      accent       = excluded.accent,
      active       = true;
