-- Spec §12. Codes are load-bearing: they appear in every internal ref.
insert into businesses (name, code, sort_order) values
  ('GroceryMate Hurstville', 'GMH', 1),
  ('GroceryMate Parramatta', 'GMP', 2),
  ('Majheri Restaurant',     'MJR', 3),
  ('Deli Delights',          'DDL', 4)
on conflict (code) do update
  set name = excluded.name,
      sort_order = excluded.sort_order;
