# Spendly — Architecture Context

> **Append or update only.** Do not delete or rewrite existing sections. Add a dated entry for changes and say what it supersedes. Read `memory.md` first.

Last updated: 5 November 2026 (Spendly 3.0.0).

## Shape of the app

```text
index.html
  └── js/app.js                     UI: four views, sheets, toasts, service worker glue
        ├── js/core.js              pure rules: dates, months, paise, validation, finance
        ├── js/repository.js        ExpenseRepository · SalaryRepository · SavingsRepository
        └── js/db.js                the only IndexedDB-aware module
                                      IndexedDBExpenseStore
                                      IndexedDBSalaryStore
                                      IndexedDBSavingsStore
                                      openSpendlyDB() / openExpenseDB() alias
```

Dependencies point one way: `app → repository → db/db core`. `core.js` imports nothing. No module imports `app.js`.

## Responsibilities

### `js/core.js` (pure, testable in Node)
- Calendar helpers: local ISO dates, Monday weeks, period bounds, elapsed days.
- Month keys (`YYYY-MM`): `isMonthKey`, `monthKeyOf`, `currentMonthKey`, `shiftMonth`, `monthBounds`, `formatMonthKey`, `shortMonthLabel`.
- Money: `roundMoney`, `formatMoney`, `formatMoneyParts`, and the paise layer `toPaise` / `fromPaise`.
- Validation/normalisation for all three record types.
- Aggregations: expense summaries, savings grouping, and the single finance rule `computeMonthlyFinance()`.
- No DOM, no storage, no clock except optional injected `now`.

### `js/db.js`
- Schema creation/upgrade and every transaction.
- Three store adapters with a small async surface (`getAll`, `get`, `put`, `delete`, `replaceAll`, index reads, `close`).
- `IndexedDBSalaryStore` has a unique `by_monthKey` index; `getByMonth` returns one record.
- `IndexedDBSavingsStore.getByMonth` returns an array (non-unique index).
- Never validates business rules beyond the unique index.

### `js/repository.js`
- Public API used by the UI.
- Generates stable ids (`crypto.randomUUID` with fallback), stamps `createdAt`/`updatedAt` from an injectable clock.
- Validates before writing, preserves `id`/`createdAt` on update, exposes `restore()` for Undo and `replaceAll()` for backup restore.
- Translates storage `ConstraintError` into `DuplicateMonthError`.
- `ExpenseRepository.migrateLegacy()` owns the one-time localStorage import.

### `js/app.js`
- Boots the database, repositories and legacy migration.
- Holds one in-memory snapshot: `state.expenses`, `state.salaries`, `state.savings`.
- After every mutation: `refreshAll()` → `render()` → toast. There is no partial cache.
- One render function updates all four views, so a salary edit immediately updates the dashboard, the salary page and the savings totals.
- Owns navigation (`showView`), sheets, validation display, confirmation action sheets, Undo toasts, and the service worker lifecycle.

## Render loop

```text
mutation → repository → refreshAll()
          → render()
               ├── renderHero / renderGlance / renderWeek / renderRecent
               ├── renderFinance        (dashboard monthly overview)
               ├── renderExpensesPage
               ├── renderSalaryPage
               └── renderSavingsPage → renderSavingsTotal → renderSavingsTab
          → showToast
```

Because all four views are rendered on every change, no cross-view invalidation logic exists. The cost is negligible for a personal ledger and removes a whole class of stale-UI bugs.

## Navigation

- Internal view keys: `dashboard`, `expenses`, `salary`, `savings`.
- `showView()` toggles `#view-<key>`, updates the dock (`data-view`), `aria-current` and `document.title`, scrolls to top.
- Deep links: `?view=dashboard|expenses|salary|savings`, `?action=add|add-salary|add-saving`. `?view=history` is accepted as a legacy alias for `expenses`. Params are cleared with `replaceState` after applying.
- Month state is independent per page: `state.financeMonth`, `state.salaryMonth`, `state.savingsMonth`. Saving a salary also sets `financeMonth` (and `salaryMonth`) to the edited month.

## Sheets and dialogs

- Native `<dialog>` with `showModal()`, a shared close animation (`closeDialog`), backdrop click-to-close and `cancel` handling.
- `openActionSheet()` is reused for row menus **and** destructive confirmations. For a confirmation, a second action sheet is opened from the first action’s `onSelect` after the first is closed.
- `syncScrollLock()` adds `body.sheet-open` whenever any dialog is open.

## Offline architecture

- `sw.js` precaches the app shell; navigations are served from the cached `index.html`.
- Cache-first for same-origin static assets; network fallback caches new successes.
- New workers wait until the user taps Refresh; old `spendly-*` caches are deleted on activate.
- The service worker never touches IndexedDB.
- The app has zero network dependencies at runtime, so salary/savings are offline by construction.

## Failure handling

- `initData()` failures show `#fatalError`, hide all views and disable the dock. Blocked upgrades (another tab) get a specific message.
- Upgrade errors abort the versionchange transaction so IndexedDB rolls back.
- Repository errors map to inline field errors or sheet-level messages; only unexpected errors reach `console.error`.
- Backup restore validates everything first, downloads a safety copy, restores sequentially, and attempts a rollback if a later step fails.

## Extension seams

- New collection: add a store in `db.js`, a repository in `repository.js`, pure rules in `core.js`, then one render section and one sheet in `app.js`. Do not put finance logic in the UI.
- Remote sync later: repositories already expose stable ids + timestamps and the UI never sees IndexedDB. Add an adapter behind the same interface.
- Do not introduce a framework or build step for this app; the zero-build constraint is deliberate.

---

## Addendum — 5 November 2026: Salary month navigator

The Salary page now owns a complete month navigator instead of only a stepper.

**State.** `state.salaryMonth` (a `YYYY-MM` key) is still the single source of truth for the page. Every render path — amount, notes, status, expenses/savings/remaining split, Add/Edit label — reads from `state.salaryMonth`, so the navigator cannot drift from the data.

**Controls.**
- `#salaryPrevMonth` / `#salaryNextMonth` → `shiftSalaryMonth(±1)` (`shiftMonth` handles January/December).
- `#salaryMonthPickerButton` (the month + year label, with a caret) → `openMonthPicker()`, a native `<dialog>` with independent month and year `<select>`s and a **Go to month** submit → `setSalaryMonth(key)`.
- `#salaryCurrentMonth` → `setSalaryMonth(currentMonthKey())`; the row is `hidden` while the selected month is the current month.
- ArrowLeft/ArrowRight on the navigator also move months for keyboard users.

**No writes.** All three entry points only assign `state.salaryMonth` and re-render. Salary records are created exclusively by `handleSalarySubmit`, so browsing empty or future months can never create a record.

**Picker years.** `populatePickerMonthOptions()` offers current year −6…+3 plus every year that already has a salary record plus the selected year, so restored historical backups stay reachable.

**Month-change feedback.** `pulseMonthChange(direction)` restarts a 0.26 s slide on `#salaryAmount`, skipped under `prefers-reduced-motion`.

## Addendum — 5 November 2026: dialog reopen race

`closeDialog()` animates with `animation: sheet-down … forwards`, then calls `dialog.close()` after 210 ms. If a sheet was reopened inside that window it could end up parked off-screen, and a save that finished after a reopen would close the *new* sheet.

Two guards now exist:
1. `openDialog(dialog)` clears the pending timer, and if the dialog is still open mid-close it calls `close()` before `showModal()` so the open animation restarts from a clean state.
2. Each open stamps `dialog.dataset.session`. Submit handlers capture that value and only call the close helper when `isSameDialogSession()` still matches, so a save never closes a sheet the user reopened with a new entry.

## Addendum — 6 November 2026: salary pools and source-aware expense ledger

Spendly 3.2 changes the financial allocation rule while retaining the four-view app and the one-way `app → repository → db` boundary. Salary month selection remains a view concern; payment allocation is now a stable relationship to a salary record.

- `computeSalaryPool()` derives one pool from its salary, salary-funded expenses, contributions and outgoing balance transfers. `computeSavingsBalance()` derives Savings from typed credits and expense withdrawals. Both use integer paise.
- `FinancialLedgerRepository` owns atomic multi-store writes for expenses and their savings withdrawals, balance transfers, salary deletion guards, and full collection replacement. The UI calls these repository methods rather than coordinating writes between stores itself.
- `paymentSource` and `salaryRecordId` on expenses preserve the original funding source when transaction dates differ from salary months. Savings-funded expenses have one linked `withdrawal` keyed by the unique sparse `by_expenseId` index.
- Salary contribution and transfer records retain `salaryRecordId`, so recomputation and Undo can return money to the correct pool. A salary with any linked ledger activity cannot be deleted.
- A one-time IndexedDB transaction assigns legacy financial rows to the latest salary whose `createdAt` is no later than the transaction timestamp. It preserves original transaction dates and identifiers. Records with no safe match remain unallocated and are marked for review.
- Backup restore validates relations and replaces provided collections in a single transaction; optional collections absent from old backups remain untouched. Backup format is v4; IndexedDB schema is v3.

The previous month-only formula in the 3.0/3.1 history is superseded for salary balances. Dashboard expense analytics and Savings month tabs remain calendar-date based.

## Addendum — 6 November 2026: Extra Income and salary-first savings allocation

The Salary page displays regular salary remaining and extra-income remaining as separate amounts. Extra income has CRUD history on the Salary page, while its own store remains separate from monthly salary records. A salary-funded savings contribution is one savings ledger record with paise-based allocations to salary and zero or more extra-income entries. The multi-store IndexedDB transaction enforces available combined balance and salary-first priority. Existing savings records with no allocation breakdown continue to debit their historical salary pool.

## Addendum — 6 November 2026: Spendly 3.5 navigation, source review and backup status

Spendly 3.5 keeps the same module boundaries and IndexedDB v5 schema. The Salary, Savings and Dashboard month/tab selections are reflected in the hash route (`#/salary/YYYY-MM`, `#/savings/month|total/YYYY-MM`, and `#/dashboard/YYYY-MM`). Page navigation pushes history; month arrows replace the current route entry; deliberate month-picker and tab changes push entries. The existing `?view=` and `?action=` PWA launch parameters are consumed before being removed.

The Expenses page derives a review queue from salary-funded entries with no `salaryRecordId` or a stale `needs_review` flag. A saved source clears the flag, and the queue can filter directly to those expenses. Saving rows also clear the flag when the user explicitly selects a source. This is a presentation over the existing fields, with no migration or schema change.

`FinancialLedgerRepository` exposes metadata get/set operations backed by the existing `meta` store. The app uses it for the last requested backup download, a 30-day reminder snooze and a completed-onboarding marker. Browser storage quota/persistence APIs are queried when available; their absence does not block app use. Restore remains a validated Replace operation with a safety download and Undo; no merge mode was added.

Other derived UI additions are Salary pool CSV export, transaction-date month comparisons, previous-month salary prefill, contribution allocation labels, and the inline first-use guide. No rendering architecture change was made. IndexedDB remains v5, JSON backup remains v5, and the service-worker cache is v18.


## Addendum — Spendly 3.6.0: salary-linked Extra Income

The `extraIncome` store has a non-unique `by_salaryRecordId` index. Extra income stores the selected salary record ID independently from its received date. Its balance is computed within that salary pool as amount less savings allocations that reference the income record. The Salary page combines regular salary remaining with that linked income remaining. New contributions and balance transfers preserve salary-first source allocation and use income from the same salary record only. Schema migration leaves old records without a salary reference intact with `needs_review`; date alone is never used to assign them.

## Addendum — Spendly 3.7.0: ledger reversals and full local erase

Extra Income and savings credits/transfers are reversed in-place with `reversedAt` and a stable `reversalId`; original dates, salary references and paise allocation splits remain on their original records. Derived balances ignore reversed rows while history continues to display them. Reversal writes and dependency checks are atomic in IndexedDB; income used by an active savings record and credits whose reversal would make Savings negative are protected. No schema or backup version change is required. The Your data panel's erase-all confirmation clears expenses, salaries, savings, Extra Income and metadata in one IndexedDB transaction, then removes the legacy localStorage copy.
