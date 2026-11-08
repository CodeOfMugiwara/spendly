# Phase 5.2: Pre-Sync Readiness Audit Report

**Date:** 9 November 2026  
**Status:** Complete  

---

## 1. Summary of Audit Findings

### A. Git & UI Fix Status
- Working tree was verified completely clean.
- UI restoration fixes were confirmed already committed in commit `0b325ca`.
- Phase 5 outbox foundation is committed in `45a2938`.

### B. Financial ID Compatibility Analysis
- **PostgreSQL Schema**: Primary keys on `salary_records`, `expenses`, `extra_income`, `savings_transactions`, and foreign keys `salary_record_id`, `expense_id`, `extra_income_id`, `savings_transaction_id` are strictly `uuid`.
- **Local Client `defaultMakeId()`**:
  - Uses `globalThis.crypto?.randomUUID()` when available.
  - However, its fallback generated non-UUID string `sp_${Date.now().toString(36)}...`.
- **Action for Phase 6.1**:
  - Replace the fallback in `defaultMakeId()` with `generateUUID()` from `js/core.js` so that all new entities are strictly valid RFC 4122 v4 UUIDs.
  - Preserve historical local records without rewriting IDs.

### C. Missing Server-Side Infrastructure for Phase 6
1. **Idempotency Table (`public.sync_operations`)**: Needed to track applied operation receipts and deduplicate retries.
2. **Transactional RPC (`public.apply_sync_operation`)**: PostgreSQL deferred constraint triggers (`savings_withdrawal_expense_integrity_from_expenses` and `savings_funding_split_integrity_from_transactions`) require that composite operations be committed in a single database transaction on the server.
3. **Change Feed (`public.sync_change_feed`)**: Needed to provide a monotonic server-side cursor for delta fetching on other devices.
