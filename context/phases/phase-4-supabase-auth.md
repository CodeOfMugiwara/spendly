# Phase 4 Architecture: Supabase Authentication & Multi-Account Isolation

**Date:** 8 November 2026  
**Status:** Complete  
**Related Commits:** [`53abd1a`](file:///d:/Spendly/js/supabase.js), [`8328410`](file:///d:/Spendly/js/app.js#L3160)

---

## 1. Objectives
- Introduce Supabase email/password authentication without compromising offline-first principles.
- Maintain complete local data isolation between authenticated user accounts.
- Preserve legacy unowned data in the local `spendly` database without leaking or auto-merging it.

---

## 2. Key Architectural Decisions

### Account-Scoped IndexedDB Isolation
Instead of storing all user data in a single database with a `user_id` column in IndexedDB:
- Authenticated user data is stored in dedicated, physically isolated IndexedDB databases named `spendly_user_${userId}`.
- Switching accounts closes the active database and mounts the new account's database.
- Legacy unowned data remains stored in `spendly`.
- Logout closes the user database and returns to the authentication screen without deleting local data.

### Offline Authentication Token Caching
- Supabase auth session tokens are cached in `localStorage` under `spendly.auth.token`.
- On boot, if offline, Spendly inspects the cached session. If valid and not expired, it opens the app in offline mode without requiring network verification.
- Destructive online actions (e.g. password resets, cloud uploads) are blocked with user-friendly notices when offline.

---

## 3. Database Schema & RLS Security
Four SQL migrations were authored and applied using Supabase CLI `3.0.0` against PostgreSQL 17:
1. `20261108122138_create_spendly_financial_schema.sql`: Base tables (`profiles`, `salary_records`, `expenses`, `extra_income`, `savings_transactions`, `savings_funding_allocations`).
2. `20261108122144_secure_spendly_financial_schema.sql`: Force RLS on all 6 tables; restrict access to `user_id = auth.uid()`.
3. `20261108123728_enforce_savings_funding_allocation_totals.sql`: Deferred triggers enforcing cross-row paise integrity for savings allocations and extra income limits.
4. `20261108125607_fix_null_safe_salary_link_constraints.sql`: NULL-safe checks for `salary_record_id` and `allocation_status`.

---

## 4. Google OAuth Integration (Phase 4.1)
- Added `signInWithGoogle()` in `js/supabase.js`.
- Branded "Continue with Google" buttons on both Login and Register views with official Google branding guidelines.
- Clean URL parsing: Callback tokens or error fragments (`#error=...`, `?error_description=...`) are parsed, user-friendly toast messages are displayed, and `window.history.replaceState` cleans the browser URL immediately.
- Strict isolation: Google accounts use `spendly_user_${googleUserId}` and maintain complete separation from email accounts and unowned data.
