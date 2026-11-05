# Spendly — Data Model Context

> **Append or update only.** Never delete existing schema history; add dated notes for changes. Read `memory.md` and `context/architecture.md` first.

Last updated: 5 November 2026 (database version 2).

## Database

- Name: `spendly`
- Version: **2** (`DB_VERSION` in `js/core.js`)
- Origin-scoped: the same URL origin + browser profile. Not synced.

| Store | Key | Indexes | Since |
|---|---|---|---|
| `expenses` | `id` | `by_date`, `by_createdAt`, `by_date_createdAt` | v1 |
| `meta` | `key` | — | v1 |
| `salaries` | `id` | `by_monthKey` (**unique**), `by_createdAt` | v2 |
| `savings` | `id` | `by_monthKey`, `by_date`, `by_date_createdAt` | v2 |

## Records

### Expense
```json
{
  "id": "uuid",
  "amount": 240,
  "description": "Lunch",
  "date": "2026-11-04",
  "createdAt": "ISO",
  "updatedAt": "ISO"
}
```
`amount` is a rupee number with at most two decimals. Expense totals are summed with `roundMoney`; the monthly finance calculation converts each amount to paise.

### Salary
```json
{
  "id": "uuid",
  "monthKey": "2026-11",
  "amount": 50000,
  "amountPaise": 5000000,
  "notes": "",
  "createdAt": "ISO",
  "updatedAt": "ISO"
}
```
- One record per `monthKey`; enforced by the unique index and by `SalaryRepository.create/update`.
- `monthKey` is a validated `YYYY-MM`, 1900–2200.
- `notes` ≤ 200 characters, optional.
- Moving a salary to a month that already has one throws `DuplicateMonthError`.

### Savings
```json
{
  "id": "uuid",
  "monthKey": "2026-11",
  "amount": 4000,
  "amountPaise": 400000,
  "date": "2026-11-04",
  "description": "Gold",
  "createdAt": "ISO",
  "updatedAt": "ISO"
}
```
- `date` is the authoritative entry date; valid calendar date, not in the future.
- `monthKey` is always recomputed from `date` on save. If an imported record disagrees, the date wins in every calculation.
- `description` ≤ 100 characters, optional.
- Savings are **never** written to `expenses` and never included in expense totals or CSV.

### Meta
```json
{ "key": "migration:localStorage:v1", "version": 1, "completedAt": "ISO", "...": "summary" }
```
Presence of `completedAt` stops the legacy import from running again.

## Money representation

- User input: rupees, parsed by `parseAmountInput` (accepts `₹`, commas and whitespace, max two decimals).
- Display: `Intl.NumberFormat('en-IN', currency INR)` → `₹50,000.00`; negatives render as `-₹1,000.00`.
- Storage: `amount` (rupees) **and** `amountPaise` (integer). Both are derived together in `validateSalaryInput` / `validateSavingInput` / `normalize*`, so they cannot diverge through the app.
- Arithmetic: paise only. `toPaise(0.1) + toPaise(0.2) === 30`.
- `fromPaise` converts back for display.

## Monthly rule

```
remainingPaise = salaryPaise − expensePaise(month) − savingsPaise(month)
```

- `expensePaise(month)` sums expenses whose `date.slice(0,7) === monthKey`.
- `savingsPaise(month)` sums savings whose **date** month equals `monthKey`.
- No carry-forward between months.
- `hasSalary` is false when no salary record exists; the UI must show “Not set / —”, never a remaining number.
- `isNegative` is true only when a salary exists and `remainingPaise < 0`.
- Returned by `computeMonthlyFinance(monthKey, { salary, expenses, savings })` in `js/core.js`.

## Migration history

### v0 → v1 (2.0.0)
- Created `expenses` and `meta`.
- Legacy `localStorage["spendly_expenses_v1"]` imported once by `ExpenseRepository.migrateLegacy()`:
  ids preserved, `createdAt` recovered from legacy ids, verification before the completion marker, source data never deleted.

### v1 → v2 (3.0.0)
- Created `salaries` and `savings` only if missing.
- No existing store is dropped, cleared or rewritten.
- Upgrade handler is idempotent and aborts its transaction on error (rollback to v1).
- The e2e suite constructs a real v1 database and verifies the expense survives the upgrade.

## Backup format (version 3)

```json
{
  "app": "Spendly",
  "version": 3,
  "exportedAt": "ISO",
  "expenses": [],
  "salaries": [],
  "savings": []
}
```

Restore rules:
- `expenses` must be an array (an array at the root is also accepted).
- `salaries`/`savings` arrays are optional. Missing keys leave local data untouched, so v2 backups still work.
- Every record is validated before anything is written.
- Two salaries for the same month reject the whole file.
- A safety copy of current data downloads before replacement; Undo restores the snapshot.

## Data invariants to preserve

1. `expenses` is never deleted or recreated by an upgrade.
2. Savings never become expenses.
3. Salary is unique per `monthKey`.
4. `id` and `createdAt` never change on update.
5. `updatedAt >= createdAt`.
6. Savings `monthKey` always matches `date`'s month after a write.
7. `amountPaise` is an integer and matches `amount` within rounding.
8. Only records belonging to the selected month affect its remaining balance.

---

## Addendum — 6 November 2026: salary-pool allocations and typed savings ledger

IndexedDB schema is now **v3**. The upgrade is additive: it keeps every existing store and record, adding expense relationship indexes plus savings ledger indexes (`by_type`, `by_salaryRecordId`, unique sparse `by_expenseId`).

### Current record relationships

- Expense records carry `paymentSource: 'salary' | 'savings'`, `salaryRecordId` for Salary Balance, and optional `allocationStatus: 'needs_review'` for unresolved historical data.
- Savings records carry `type: 'contribution' | 'salary_balance_transfer' | 'withdrawal'`; optional `salaryRecordId`; and `expenseId` only for withdrawals.
- A savings-funded expense has exactly one withdrawal, enforced by the unique sparse `by_expenseId` index. Creating, editing, deleting and restoring the expense updates that withdrawal in the same multi-store IndexedDB transaction.
- Salary pool balance is derived from its salary, allocated salary expenses, contributions and prior balance transfers. Savings balance is credits minus withdrawals. Neither balance is stored separately.
- The active pool is the salary with greatest `createdAt`; salary creation timestamps are monotonic relative to existing salary records so a newly added pool becomes active.

### One-time v2 allocation migration

`migration:salary-allocation:v1` is written transactionally with expense and savings updates. Each old record is linked to the latest salary created at or before the transaction’s `createdAt`. It preserves date, ID, amount and timestamps. A record without a reliable timestamp match stays unallocated with `allocationStatus: 'needs_review'`; it does not reduce an arbitrary pool. Meta stores unresolved IDs for a one-time review notice. The marker makes the migration idempotent.

### Backup v4

Version 4 preserves payment source, salary IDs, savings transaction types and expense links. Version 3 and expense-only restores remain supported, with timestamp assignment for records lacking allocation fields. Restore validates relationships and the nonnegative savings invariant before replacing related collections atomically.
