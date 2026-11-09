# Spendly — Production Release Checklist & Runbook

**Document Version:** 1.0.0  
**Target Application:** Spendly PWA (`spendly@3.7.0`)  
**Status:** Ready for Production Deployment  

---

## 1. Environment Configuration

### A. Environment Variables Summary

| Variable | Description | Development Default | Production Target |
| :--- | :--- | :--- | :--- |
| `VITE_SUPABASE_URL` | Public endpoint for Supabase project | `https://qmvigcbumiumaguwmmbk.supabase.co` | `https://<prod-project-ref>.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Public Anon/Publishable Key (safe for client bundle) | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...` | `<prod-anon-key>` |

> [!IMPORTANT]
> **Never** expose a Supabase `service_role` key in frontend environment variables. All client mutations must be authenticated through user JWTs validated against Row Level Security.

### B. Secret Exclusion Verification
- Verify `.env.local` and `.env` are listed in `.gitignore`.
- Run `git status --ignored` to ensure no active secret files are tracked in Git.

---

## 2. Production Database Migration Order

Apply the repository migrations sequentially to the target production Supabase database:

1. `supabase/migrations/20261108122138_create_spendly_financial_schema.sql`
   - Creates `salary_records`, `expenses`, `savings_transactions`, `savings_funding_allocations`, `extra_income`.
   - Establishes integer paise columns, foreign keys, and indexes.
2. `supabase/migrations/20261108122144_secure_spendly_financial_schema.sql`
   - Enables and forces Row Level Security on all core financial tables.
   - Revokes table grants from `public` and `anon`.
3. `supabase/migrations/20261108123728_enforce_savings_funding_allocation_totals.sql`
   - Enforces allocation balance constraints on extra-income funded savings.
4. `supabase/migrations/20261108125607_fix_null_safe_salary_link_constraints.sql`
   - Ensures null-safe salary pool reference constraints.
5. `supabase/migrations/20261109011000_create_sync_operations_and_rpc.sql`
   - Sets up `sync_operations` idempotency store with SHA-256 payload hashing.
   - Sets up `sync_change_feed` delta log.
   - Creates atomic RPC functions `apply_sync_operation` and `get_sync_changes`.
6. `supabase/migrations/20261109013000_make_sync_change_cursors_transaction_safe.sql`
   - Creates `sync_user_cursors` for account-scoped, row-locked transactional cursor counters.
   - Guarantees zero-gap commit ordering and eliminates sequence race conditions.
   - Revokes direct write privileges on sync infrastructure from `authenticated` and `anon`.
7. `supabase/migrations/20261109020000_enrich_sync_change_feed_savings_allocations.sql`
   - Enriches `get_sync_changes` delta payloads to include detailed extra income funding breakdown.

### Migration Deployment Command
```bash
# Apply all pending migrations to the linked production project
npx supabase db push --linked
```

---

## 3. Google OAuth Production Configuration

In Google Cloud Console and Supabase Dashboard (`Authentication -> URL Configuration` & `Authentication -> Providers -> Google`):

1. **Authorized JavaScript Origins**:
   - `https://<your-production-domain>.netlify.app`
   - `https://spendly.app` (or custom apex domain)
2. **Authorized Redirect URIs**:
   - `https://<prod-project-ref>.supabase.co/auth/v1/callback`
3. **Supabase Redirect URLs**:
   - Site URL: `https://<your-production-domain>.netlify.app/`
   - Additional Redirect URLs: `https://<your-production-domain>.netlify.app/**`

---

## 4. Netlify Hosting & PWA Build Configuration

The repository includes a battle-tested [`netlify.toml`](file:///d:/Spendly/netlify.toml) with:
- **Build Command**: `npm run build`
- **Publish Directory**: `dist`
- **Cache-Control Policies**:
  - `/index.html`: `public, max-age=0, must-revalidate` (ensures users immediately receive app updates)
  - `/sw.js`: `no-cache`, `Service-Worker-Allowed = "/"` (service worker browser script never stalls)
  - `/manifest.json`: `public, max-age=3600`
  - `/icons/*`: `public, max-age=604800`
- **Security Headers**:
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `X-Frame-Options: SAMEORIGIN`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`

---

## 5. Disaster Recovery & Backup Verification

Prior to public release or maintenance windows:
1. **Unencrypted Full JSON Export**:
   - Navigate to `Data Settings` -> `Download backup`.
   - Verify generated JSON has `schemaVersion: 7` and valid integer paise.
2. **Encrypted Export**:
   - Navigate to `Data Settings` -> `Download encrypted backup`.
   - Enter passphrase. Verify downloaded file has `encrypted: true`, `algorithm: 'AES-GCM-256'`, `kdf.iterations: 600000`, and `aad`.
3. **Safety Auto-Backups**:
   - Attempting a replacement restore automatically triggers a pre-restore backup download (`spendly-before-restore-<date>.json`) before modifying local IndexedDB.

---

## 6. Pre-Flight Sign-Off Checklist

- [ ] All unit tests pass: `npm test` (135/135)
- [ ] All E2E browser tests pass: `npm run test:e2e` (47/47)
- [ ] Concurrency test passes: `node supabase/tests/concurrency_test.mjs` (4/4)
- [ ] Production build succeeds: `npm run build` (0 warnings or errors)
- [ ] Code formatting check clean: `git diff --check` (0 anomalies)
- [ ] Working tree is clean: `git status`
- [ ] Target Supabase production project created and migrations applied
- [ ] Netlify site linked with production environment variables configured
