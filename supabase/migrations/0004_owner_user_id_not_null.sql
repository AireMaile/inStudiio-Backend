-- Every v1 studio has an owner by design (per owner/RBAC spec). Enforce it in
-- the schema before any studio rows exist to worry about. Safe to apply in
-- place — the table is empty at this point.
alter table public.studios
  alter column owner_user_id set not null;
