-- Spec §12, with the four accounts created in the SHG invoicing project.
--
-- profiles.id references auth.users(id), so these UUIDs are the ones Supabase
-- issued when the accounts were created. They are not secrets — they are row
-- identifiers, and they are what every invoice records as its author.
--
-- `accent` is a SLOT NAME, not a colour: person-1 .. person-4.
--
-- The stylesheet decides what each slot looks like (app/globals.css, section
-- 5). Storing a hex here would put four colours outside the one file allowed
-- to contain any, and a repaint would silently miss the attribution chips.
--
-- Roles: Mani and Rabindra are `owner`, so they see the same screens and the
-- same lightly accented treatment, and Rabindra can tune it against his own
-- account. Role is not a permission — all four have identical access.
--
-- Notifications: on for Mani by default, and on for Rabindra so the push flow
-- can actually be tested end to end in Phase 7. Milan and Sujan start off and
-- can switch themselves on from their own settings.
--
-- Rabindra is a test account. When it is finished with, do not delete it —
-- run the statement at the bottom. Deactivating removes him from the profile
-- picker and the type-aheads while every invoice he entered keeps its
-- attribution. Notes §8: nothing is ever deleted.

insert into profiles (id, display_name, initials, accent, role, notify_on_new_invoice) values
  ('b3153037-4bf5-4baa-8c11-b94e690c92bd', 'Mani',     'MA', 'person-2', 'owner',  true),
  ('a207c7b2-5389-445a-a46e-bb3dd7b2caad', 'Milan',    'MI', 'person-3', 'member', false),
  ('f57715ab-a468-4d2a-9796-0c639a2d259b', 'Sujan',    'SU', 'person-4', 'member', false),
  ('2da43dcf-8b0f-4229-bf5c-e5af68210045', 'Rabindra', 'RA', 'person-1', 'owner',  true)
on conflict (id) do update
  set display_name          = excluded.display_name,
      initials              = excluded.initials,
      accent                = excluded.accent,
      role                  = excluded.role,
      notify_on_new_invoice = excluded.notify_on_new_invoice,
      active                = true;

-- ----------------------------------------------------------------------------
-- Later, when the test account is finished with. Run this on its own.
-- ----------------------------------------------------------------------------
-- update profiles set active = false
--  where id = '2da43dcf-8b0f-4229-bf5c-e5af68210045';
