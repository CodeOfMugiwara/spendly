# Phase 5 Architecture: Local-First Sync Foundation & Durable Operation Outbox

**Date:** 8-9 November 2026  
**Status:** Complete  
**Related Commit:** [`45a2938`](file:///d:/Spendly/js/repository.js#L605)

---

## 1. Objectives
- Ensure that every local financial mutation persists:
  1. Its normal domain record updates.
  2. A corresponding synchronization operation in the `outbox` store.
- **Strict Atomicity**: Both MUST commit in the **exact same IndexedDB transaction**. If anything fails, all changes roll back.
- Maintain account-scoped outbox isolation.
- No network worker or automatic upload in this phase (deferred to Phase 6).

---

## 2. IndexedDB Schema Upgrade (Version 6 $\rightarrow$ Version 7)

### Object Store: `'outbox'`
- **KeyPath**: `operationId` (RFC 4122 v4 UUID string).
- **Indexes**:
  - `'by_status'` (`status`)
  - `'by_sequence'` (`sequence`, `unique: true`)
  - `'by_createdAt'` (`createdAt`)
  - `'by_ownerUserId'` (`ownerUserId`)
  - `'by_entityType_entityId'` (`['entityType', 'entityId']`)
  - `'by_status_sequence'` (`['status', 'sequence']`)

### Outbox Record Structure
```javascript
{
  operationId: "3d5f3088-294b-4bbf-811c-22a27ffb4594",
  ownerUserId: "00000000-0000-4000-8000-000000000001",
  operationType: "expense:create",
  entityType: "expense",
  entityId: "exp_1731178200000_abc123",
  payload: {
    expense: { ... },
    linkedWithdrawal: { ... } // embedded if savings-funded
  },
  createdAt: "2026-11-08T18:45:00.000Z",
  sequence: 1,               // strictly monotonic per account
  status: "pending",         // "pending" | "acknowledged" | "blocked"
  attemptCount: 0,
  lastAttemptAt: null,
  lastError: null,
  dependsOn: null,
  schemaVersion: 1
}
```

---

## 3. Financial Mutation Integration (All 19 Paths)

`FinancialLedgerRepository` coordinates mutations and enqueues outbox entries within one transaction:

1. **Salary Operations**: `salary:create`, `salary:update`, `salary:delete`, `salary:restore`.
2. **Expense Operations**: `expense:create` (salary & others), `expense:create` (savings-funded composite with withdrawal), `expense:update`, `expense:delete`, `expense:restore`.
3. **Extra Income Operations**: `extra_income:create`, `extra_income:update`, `extra_income:delete`, `extra_income:reverse`.
4. **Savings Operations**: `savings:contribution` (with `extraIncomeAllocations`), `savings:external_contribution`, `savings:update`, `savings:delete`, `savings:restore`, `savings:transfer_balance`, `savings:reverse`.

### Composite Mutation Decision
Creating an expense funded by Savings creates an expense and a linked withdrawal. Rather than logging two independent operations that could be synchronized out of order, it is persisted as a **single logical outbox operation** (`expense:create`) with the withdrawal embedded inside `payload.linkedWithdrawal`.

---

## 4. Verification & Testing
- **Suite**: 23 new unit tests in `tests/unit/outbox.test.mjs`.
- **Atomicity / Rollback**: Verified with failure injection (aborted transactions leave financial stores 100% clean).
- **Reload Persistence**: Pending operations survive page reload and logout.
- **Test Results**: 90/90 unit tests pass; 38/38 browser E2E scenarios pass.
