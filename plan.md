# Spendly — Product and Engineering Plan

> Updated 6 November 2026 after implementing the first plan. This document now records shipped work and the remaining optional improvements.

## Current state

Spendly is a local-first, offline-capable personal finance app built with plain HTML, CSS and JavaScript. It has Dashboard, Expenses, Salary and Savings pages, and stores data in IndexedDB.

| Area | Current state |
|---|---|
| App version | 3.7.0 |
| IndexedDB | v6; Extra Income has a salary-record index |
| Backup | JSON v5, including income and savings allocations; older formats supported |
| Offline shell | Service-worker cache v20 |
| Money | Integer paise for financial calculations |
| Expense sources | Salary, Savings and Others; Others are included in expense reporting without changing either tracked balance |
| Income and savings | Extra Income is linked to one salary record independently of its received date. Salary-funded savings use that pool's regular salary first, then its linked Extra Income. Gifts, bonuses and other manual savings remain independent. |
| Tests | 60 unit tests and 25 browser scenarios pass, including reversals, offline use, erase-all and serious/critical accessibility checks. |

### Important behaviour to preserve

- The most recently created salary is the active salary pool. Pool allocations follow entry timestamps, while expense dates continue to drive calendar-based expense reports.
- Existing records without a reliable timestamp match stay marked **Source needs review**. The app must not guess which salary funded them.
- Extra Income stores the salary record ID separately from its received date. Legacy entries without that link are preserved for explicit review; new savings allocations use Extra Income from the same salary pool only.
- Savings contributions retain their salary and Extra Income allocation details. Allocated income cannot be deleted or reduced below the amount already used.
- Reversals mark the original transaction with a timestamp and stable reversal ID. They preserve its source split, leave its row in history, and reject repeat reversals or reversals that would invalidate later activity.
- Erase all data clears every IndexedDB ledger and metadata store atomically, removes the legacy localStorage copy, and requires a warning confirmation.
- Savings withdrawals linked to expenses remain atomic with those expenses. Savings never appear as expenses or in the expense-only CSV.
- Local data stays on the current browser/site origin. Backup and restore must preserve relationships and must not silently overwrite or discard records.

## Completed in Spendly 3.5

### Expense source changes and legacy review

The mobile workflow is now covered by a browser regression on a phone-sized viewport. Explicit source choices persist after reload and clear stale review flags. Expenses with no safe historical salary match remain explicit review items.

- The Expenses page shows a source-review count and filters to only those entries.
- Saving an explicit source updates the stored record, source label and affected salary/Savings calculations; review flags clear for both expense and savings records.
- After the final unresolved expense is assigned, the list returns to all expenses.
- The service-worker cache was bumped so installed mobile apps receive the updated code.

**Status:** Implemented and covered by the source-persistence and migration browser scenarios.

### Backup reminders and storage health

The data page now explains browser-local storage and shows quota/persistence details when the browser supports them.

- A backup reminder appears after 10 records, can be snoozed for 30 days, and records when a download was requested.
- Restore validates relationships and requires a safety download before replacing data; Undo remains available.
- Merge restore is deferred until conflict rules for salary months and linked ledger records are designed.

**Status:** Reminder, storage status, safety copy and Undo are implemented. Merge remains a separate design decision.

### URL navigation and focus

Page and month state now lives in hash routes, and the destination heading receives focus on deliberate page changes.

- Dashboard/Salary months and Savings tab/month survive reload and browser Back/Forward.
- Month arrows replace the current route entry; explicit page/tab/month selection adds a history entry.
- Existing PWA `?view=` and `?action=` shortcuts are still consumed and preserved.

**Status:** Implemented; route and shortcut browser scenario passes.

### Savings funding details

Contribution history now displays the salary and Other income portions when both funded a savings entry.

- Existing allocation limits and blocked edit/delete messages remain in place.
- Paise-level source allocation totals remain unchanged.

**Status:** Implemented; existing allocation validation remains covered by the savings scenarios.

### Salary history, export and first-use guidance

- Added a separate CSV for salary-pool salary, expenses, savings contributions/transfers and remaining balance. The existing expense CSV is unchanged.
- Added month-over-month spending and net savings comparisons from calendar-date activity.
- Added an explicit previous-month salary prefill that never creates a record before Save.
- Added a compact first-use guide that stays dismissed after a salary has existed.
- Salary-history year filtering, savings search and a savings export remain optional until there is a clear user need.

**Status:** CSV, comparison and prefill flows are implemented and covered by browser scenarios. Optional search/filter work is deferred.

### Accessibility and visual quality

- Axe checks cover all main pages and the expense sheet for serious/critical WCAG A/AA issues.
- Page navigation focuses its heading/landmark, and destination text stays included in the month picker’s accessible name.
- The Savings tab label contrast was darkened to meet 4.5:1 text contrast.
- The inline first-use guide replaces a modal tour. Critical phone layouts remain covered by responsive checks and documentation screenshots.
- A six-month dashboard trend remains optional and is not needed for this release.

### Performance

The app still re-renders multiple sections after mutations. No render-path split was made; measure with a large synthetic ledger before considering any change. Keep the current simple approach unless timings show a user-visible delay.

**Done when:** any rendering change has before/after measurements and preserves the same derived balances and visible state.

## Remaining optional work

- Consider merge restore only after writing conflict rules for same IDs, salary-month collisions, and linked savings withdrawals.
- Add salary/savings search only if history becomes hard to navigate.
- Benchmark large-history render performance before changing rendering.
- Add more dashboard visualization only if users need it and the phone layout stays clear.

## Project hygiene to include with future changes

- Keep README, `context/` docs and this plan aligned with actual IndexedDB, backup, service-worker and app versions. Version and cache references were refreshed for 3.6.0.
- Keep schema upgrades additive and retain old-backup compatibility unless a documented migration says otherwise.
- Add unit coverage for financial rules and browser coverage for user workflows. For source changes, assert persisted records and recalculated balances, not only a toast.
- Check a narrow phone viewport, a typical phone viewport and desktop after UI changes; check the offline flow after changes to cached assets.
- Keep user data local. No analytics, telemetry, login or cloud sync is planned without a separate product decision.

## Non-goals

- Accounts, cloud sync, bank feeds, SMS parsing or receipt OCR.
- Multi-user/shared ledgers or a framework rewrite.
- Automatic salary creation, automatic assignment of ambiguous historical sources, or automatic carry-forward between salary pools.
- Adding charts, recurring transactions or extra dashboard cards without a clear user need and room on mobile.

## Definition of done

1. Financial calculations remain integer-paise and preserve source boundaries.
2. Existing user records and supported backup versions remain intact.
3. New financial logic has unit coverage; new user flows have browser coverage.
4. Phone and desktop layouts work, with no horizontal overflow or blocked controls.
5. Offline launch and service-worker updates still behave correctly after cached files change.
6. README, `memory.md`, and relevant `context/` docs describe the shipped behaviour and current versions.

## Follow-up — salary-linked Other income and combined balance (Spendly 3.6.0)

Each new Extra Income record stores a stable `salaryRecordId`; its received date stays independent. Existing records without a link are preserved for explicit assignment during review. The Salary page combines the linked income with regular salary in Remaining Balance, and savings/transfer allocation uses only income linked to that pool. The month/year selector offers salary records that exist and explains when the selected month needs a salary record first.

**Status:** Implemented, covered by cross-month and v5-upgrade browser scenarios, and delivered with IndexedDB v6 and service-worker cache v19.
