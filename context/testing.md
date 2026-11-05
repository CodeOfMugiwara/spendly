# Spendly — Testing Context

> **Append or update only.** Add new test coverage notes with a date; do not remove old results. Read `memory.md` first.

Last updated: 5 November 2026 — 54 unit tests, 13 browser scenarios, all passing.

## Commands

```bash
npm test                 # Node unit tests, no install needed
npm install              # Playwright only (devDependency)
npx playwright install chromium
npm run test:e2e         # browser suite, starts its own server
npm start                # local static server on :4173
```

The unit suite is dependency-free (`node --test`). The e2e suite requires Playwright and writes screenshots into `screenshots/` and temporary files into `test-results/` (ignored by Git).

## Unit suites

### `tests/unit/core.test.mjs`
Existing expense domain: period bounds, Monday weeks, elapsed days, real-date validation, money parsing, validation, summaries, week overview, sorting, search, month grouping, legacy-id timestamps, normalisation.

### `tests/unit/repository.test.mjs`
`ExpenseRepository` with an in-memory store: create/update/delete/restore, `replaceAll` atomicity, legacy migration (idempotent, verification failure, duplicates, invalid JSON, existing-record precedence), date-range query.

### `tests/unit/finance.test.mjs`
Pure 3.0 logic:
- month keys and year-boundary shifts, leap February;
- paise conversion and exact addition;
- salary/savings validation and normalisation;
- monthly finance: only selected month, historical independence, no salary, negative balances;
- savings date wins over a stale `monthKey`;
- savings grouping, ordering and exact totals.

### `tests/unit/finance-repository.test.mjs`
`SalaryRepository` and `SavingsRepository` with an in-memory store:
- duplicate month rejected (friendly check and translated `ConstraintError`);
- independent month edits, move-to-taken-month rejection;
- delete/restore, newest-first ordering;
- `replaceAll` duplicate rejection and id dedupe;
- savings date-derived months, cross-month edits, future date rejection;
- optional description.

## Browser suite (`tests/e2e.mjs`)

Fixture: `tests/server.mjs` (zero-dependency static server), Chromium with a 390×844 mobile context, locale `en-IN`, timezone `Asia/Calcutta`.

Scenarios:

1. Legacy `localStorage` migration (ids, timestamps, no duplicates, untouched source).
2. Expense CRUD, undo, search, CSV, backup/restore, invalid restore, safety copy.
3. Full offline lifecycle including restore.
4. Persistent-profile browser restart + offline reload.
5. Salary + savings + expense balance calculation and recalculation after each mutation.
6. Salary month independence, duplicate rejection, future months.
7. No-salary and negative-balance presentation.
8. Savings across months, growth, month navigation, separation from expenses.
9. Real v1 → v2 IndexedDB upgrade.
10. Offline salary/savings add + reload.
11. iOS install hint persistence.
12. Responsive layout at 320/390/1440 px with no horizontal overflow.
13. Screenshot regeneration.

The suite fails on any browser console error. Expected user validation must not be logged with `console.error`.

### Debugging notes

- `dbSnapshot(page)` reads `expenses`, `salaries`, `savings` and `meta`, so tests can assert storage-level separation.
- `#salaryHistoryCount` and `#salaryMonthHint` are uppercase via CSS; assert with `textContent().trim()`.
- `waitForToast` polls `#toast` text; toasts can carry Undo actions used by tests.
- The v1 upgrade fixture navigates to a missing path first to obtain a same-origin document; attach the console watcher after that expected 404.
- Failure screenshots are written to `test-results/failure-*.png`.

## Manual checks automation cannot cover

See the checklist in `README.md`. Highest-value manual checks:

- Real iPhone safe areas with the dock and keyboard open.
- VoiceOver for dock tabs, month steppers and savings tabs.
- Reduce Motion / Reduce Transparency.
- Backup restore on a second device/origin.
- Service worker update banner after a cache bump.

## What is intentionally not tested

- Visual pixel diffs (no baseline images).
- Cross-tab live updates (not a feature).
- Browser storage eviction.
- Dark mode (not implemented).

---

## Addendum — 5 November 2026: navigator and dialog coverage

Two scenarios were added, taking the browser suite to **15** checks (unit suite unchanged at 54).

7. **Salary month navigator** — opens on the current month with no shortcut, seeds one salary + one expense + one saving, asserts the navigator shows the derived remaining balance, opens the picker, jumps to the previous month, verifies `Past month`, `Not configured`, `—` remaining and that history still lists only the real record; steps into a future month with the arrows, verifies `Future month` and the Add-salary label, asserts via `dbSnapshot` that salaries/savings/expenses counts did not change, then returns with **Current month** and re-checks the balance.
8. **Reopening a sheet while it closes** — saves a savings entry and immediately taps Add savings twice; waits for the open animation to finish (`getAnimations()`), asserts the Save button is fully inside the viewport, closes, and repeats. Guards the `openDialog()` / `dataset.session` fix.

Gotcha worth remembering: DOM measurements taken immediately after `waitFor({state:'visible'})` catch the sheet at the *start* of its rise animation, so the button looks off-screen. Wait for the animation to be `finished` before asserting layout.

Debugging tip: `serviceWorkers: 'block'` in a throwaway Playwright context avoids the cached shell hiding local edits while diagnosing.

## Addendum — 6 November 2026: salary-pool and funding-source coverage

The source-aware ledger adds workflows for cross-month allocation by salary entry order, savings contributions, optional old-pool transfers, expenses paid from savings, insufficient-savings blocking, and edits/deletes/Undo across the related records. Real v1 and v2 upgrades remain covered; the v2 fixture verifies timestamp-based pool assignment, preserved transaction dates, `needs_review` flags for unmatched records, and idempotency after reload. Schema v3 adds indexes without clearing stores. Backup/restore coverage now uses format v4 and checks relationship-preserving replacements.

- Current coverage: 56 unit tests and 17 browser scenarios (updated 6 November 2026).
- The browser scenario seeds salary records and transactions through the UI, then inspects IndexedDB to assert that one expense has exactly one withdrawal and that each salary pool and Savings balance recomputes correctly.
- Responsive checks still cover 320/390/1440 px and assert no horizontal overflow. The screenshot set is regenerated for the current screens.
- Timestamp migration assigns legacy transactions to the latest salary at or before their `createdAt`. Records with no reliable salary match are intentionally preserved as unallocated and require manual source review; migration does not guess from the transaction's calendar month.

The suite passed after the migration and UI changes; run `npm test` and `npm run test:e2e` to reproduce. VoiceOver, real iPhone safe areas, and second-origin restore remain manual checks.

## Addendum — 6 November 2026: external funding verification

Final verification after adding Others expenses, external Gift/Bonus/Other savings, salary contribution limits and toast updates: `npm test` passed 57/57; `npm run test:e2e` passed 18/18, including the new source-isolation scenario. IndexedDB v4 upgrade is additive and backups remain compatible at version 4.

## Addendum — 6 November 2026: extra-income coverage

Browser coverage now verifies separate extra-income balance, salary-first allocation and persisted split links. Final suite counts follow after all restore and regression cases complete.
