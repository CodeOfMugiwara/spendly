# Phase 6.1 Architecture: Secure Server-Side Financial Operations & Sync Infrastructure

**Date:** 9 November 2026  
**Status:** Complete  
**Target Environment:** Supabase PostgreSQL 17 (`spendly-dev`, ref: `qmvigcbumiumaguwmmbk`)  
**Migration:** [`20261109011000_create_sync_operations_and_rpc.sql`](file:///d:/Spendly/supabase/migrations/20261109011000_create_sync_operations_and_rpc.sql)  
**Integration Tests:** [`supabase/tests/sync_rpc_tests.sql`](file:///d:/Spendly/supabase/tests/sync_rpc_tests.sql)  

---

## 1. Objectives & Scope
- Implement the server-side infrastructure required for Spendly's offline-to-cloud synchronization.
- Guarantee idempotency, atomicity, cross-user isolation, and strict server-side validation.
- Unify client financial ID generation to strictly produce RFC 4122 v4 UUIDs.
- **Strict Boundary**: Server-side infrastructure only. No client-side upload worker (`js/sync.js`), background sync, or automatic uploads in this phase.

---

## 2. Financial ID Unification
In `js/repository.js`, `defaultMakeId()` was unified with `generateUUID()` from `js/core.js`:
```javascript
function defaultMakeId() {
  return generateUUID();
}
```
- Eliminates the previous non-UUID fallback (`sp_...`), ensuring every newly generated financial entity (`salary`, `expense`, `saving`, `extra_income`, `withdrawal`, `reversal`) has a valid UUID that PostgreSQL accepts into its `uuid` primary and foreign key columns.
- Preserves all historical records without silent rewriting.

---

## 3. Database Schema: Idempotency & Change Tracking

### A. Operation Receipts (`public.sync_operations`)
Records processed outbox operations by `(user_id, operation_id)`.
```sql
create table public.sync_operations (
  user_id uuid not null references auth.users (id) on delete cascade,
  operation_id uuid not null,
  operation_type text not null,
  entity_type text not null,
  entity_id uuid not null,
  payload_hash text not null,
  status text not null check (status in ('applied', 'skipped', 'conflict')),
  result jsonb not null default '{}'::jsonb,
  applied_at timestamptz not null default now(),
  primary key (user_id, operation_id)
);
```
- **RLS**: Enabled and forced. Authenticated users can only `SELECT` their own receipts. Direct inserts/updates are revoked from all users and managed exclusively via `SECURITY DEFINER` RPC.
- **Idempotency Check**: When an operation arrives, its SHA-256 payload hash is computed via `encode(sha256(payload::text::bytea), 'hex')`. If the `(user_id, operation_id)` already exists:
  - If the payload hash matches: Returns the existing receipt with `status: 'skipped'`.
  - If the payload hash differs: Rejects with `unique_violation` (23505).

### B. Remote Change Feed (`public.sync_change_feed`)
Provides a deterministic, globally monotonic cursor for incremental delta queries across devices:
```sql
create table public.sync_change_feed (
  cursor bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  operation_id uuid not null,
  operation_type text not null,
  entity_type text not null,
  entity_id uuid not null,
  action text not null check (action in ('create', 'update', 'delete', 'reverse')),
  record jsonb not null,
  created_at timestamptz not null default now()
);
```
- Indexed on `(user_id, cursor)`.
- RLS enabled and forced: Authenticated users can only read rows where `user_id = auth.uid()`.

---

## 4. Atomic Financial RPC: `apply_sync_operation`

`public.apply_sync_operation(p_operation jsonb) returns jsonb`
- **Security Profile**: `SECURITY DEFINER`, `SET search_path = ''`.
- **Privileges**: Executable only by `authenticated`; revoked from `public` and `anon`.
- **Identity Derivation**: `auth.uid()` is strictly authoritative; client-supplied `user_id` is ignored.

### Operations Covered (All 19 Outbox Types):
1. **Salary**: `salary:create`, `salary:update`, `salary:delete` (checks for active references before deleting), `salary:restore`.
2. **Expenses**:
   - `expense:create`: Normal salary/others expense, and composite savings-funded expense (atomically creates linked withdrawal in `savings_transactions`).
   - `expense:update`: Automatically creates, deletes, or updates linked withdrawals when the payment source changes between `salary`, `savings`, and `others`.
   - `expense:delete`: Atomically deletes linked withdrawal.
   - `expense:restore`: Atomically restores expense and linked withdrawal.
3. **Extra Income**: `extra_income:create`, `extra_income:update`, `extra_income:delete` (blocks deletion if allocated to active savings), `extra_income:reverse` (blocks reversal if allocated to active savings).
4. **Savings**:
   - `savings:contribution`: Inserts saving and atomically inserts each item in `extraIncomeAllocations` into `public.savings_funding_allocations`.
   - `savings:external_contribution`: Inserts external gift/bonus/other credit.
   - `savings:transfer_balance`: Transfers salary remainder and atomically inserts `extraIncomeAllocations`.
   - `savings:update`: Replaces `savings_funding_allocations` atomically.
   - `savings:delete`: Cleans up allocations and soft-deletes transaction.
   - `savings:restore`: Restores transaction and funding allocations.
   - `savings:reverse`: Sets `reversed_at` and `reversal_id`, verifying no overdraft results.

### Server-Side Balance & Overdraft Guards
After every operation affecting savings, the function computes:
$$\text{Balance} = \sum_{\text{credits}} \text{amount\_paise} - \sum_{\text{withdrawals}} \text{amount\_paise}$$
If $\text{Balance} < 0$, the function raises an exception (`check_violation: 23514`), aborting the entire transaction.

---

## 5. Incremental Change Query RPC: `get_sync_changes`

`public.get_sync_changes(p_after_cursor bigint default 0, p_limit integer default 100) returns jsonb`
- **Security Profile**: `SECURITY DEFINER`, `SET search_path = ''`.
- **Privileges**: Granted only to `authenticated`.
- **Behavior**:
  - Bound limit: `least(greatest(coalesce(p_limit, 100), 1), 500)`.
  - Queries `public.sync_change_feed` where `user_id = auth.uid() and cursor > p_after_cursor order by cursor asc`.
  - Returns `{ changes: [...], nextCursor: bigint, hasMore: boolean }`.

---

## 6. Verification & Test Summary
1. **Database Integration Tests (`supabase/tests/sync_rpc_tests.sql`)**:
   - Ran against `spendly-dev` (`qmvigcbumiumaguwmmbk`) with full transactional rollback.
   - Tested anonymous access rejection, idempotent replay, altered payload rejection, cross-user isolation, linked expense/withdrawal atomicity, savings funding split enforcement, overdraft prevention, and cursor pagination.
   - **Result**: Passed with exit code 0.
2. **Hosted Security Tests (`supabase/tests/rls_security.sql`)**:
   - Ran against `spendly-dev`.
   - **Result**: Passed with exit code 0.
3. **Unit Tests (`npm test`)**: 90/90 passed.
4. **Production Build (`npm run build`)**: Vite compiled in 341ms.
