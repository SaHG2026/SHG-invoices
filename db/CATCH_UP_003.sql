-- ############################################################################
--
--  CATCH-UP 003 — accents become slot names, not colours.
--
--  Supabase SQL editor -> New query -> paste -> Run.
--  Safe to run twice. Touches nothing but the four profile rows.
--
--  Why: the new palette's one rule is that hex values live in exactly one
--  file. profiles.accent held a hex, which put four colours outside it — so a
--  repaint would have silently missed the attribution chips, which are the one
--  thing on screen that identifies a person.
--
--  The database now stores WHICH PERSON this is; the stylesheet decides what
--  that looks like. Identity is a fact about the row, colour is a presentation
--  decision, and they belong in different places.
--
--  The app already tolerates the old hex values, so nothing is broken while
--  this is pending — chips just fall back to a slot derived from the id.
--
-- ############################################################################

update profiles set accent = 'person-1' where display_name = 'Rabindra';
update profiles set accent = 'person-2' where display_name = 'Mani';
update profiles set accent = 'person-3' where display_name = 'Milan';
update profiles set accent = 'person-4' where display_name = 'Sujan';

-- Expect four rows, each with a person-N slot.
select display_name, initials, accent, role, notify_on_new_invoice
  from profiles
 order by display_name;
