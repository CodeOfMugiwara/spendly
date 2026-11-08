# Supabase database workflow

The migrations in `migrations/` target PostgreSQL 17 and were authored and applied with the official Supabase CLI `3.0.0`.

Run the CLI at that pinned version without adding it to the application dependency tree:

```sh
npx --yes supabase@3.0.0 --version
npx --yes supabase@3.0.0 link --project-ref <development-project-ref>
npx --yes supabase@3.0.0 db push --dry-run --remote
npx --yes supabase@3.0.0 db push --remote
npx --yes supabase@3.0.0 db query --remote --yes --file supabase/tests/rls_security.sql
```

Always verify the project name and reference with `supabase projects list` before a hosted operation. Do not use `db reset --remote`. `tests/rls_security.sql` is a transactional check using synthetic identities and data; it ends with `ROLLBACK` and must only be run against the development project.
