# Spendly — Project Memory

> **Maintenance rules — read before editing this file**
>
> 1. This file is **append or update only**. Never delete, reorder or overwrite existing entries.
> 2. To change a fact, add a new dated entry that supersedes it and say which line it supersedes. Leave the old entry intact.
> 3. Every feature, version, decision, bug and fix gets an entry with **why** it exists, not just what changed.
> 4. Keep this file as the index. Put deep detail in `context/*.md`, also append/update only.
> 5. Any AI or engineer continuing this project should read this file first, then the relevant context file.
>
> Last updated: **5 November 2026** — Spendly 3.1.0.

---

## 1. What Spendly is

A private, offline-first personal finance tracker for a single person, built as a static PWA with plain HTML, CSS and JavaScript. No accounts, no backend, no cloud. It tracks:

- **expenses** (the original product),
- **manual monthly salary** (added in 3.0),
- **savings entries** (added in 3.0),

and computes **remaining balance = this month's salary − this month's expenses − this month's savings**.

The product thesis is: a person should be able to open one offline app, record what they earned, what they spent and what they set aside, and see an honest number for what is left this month — without a login or a subscription.

---

## 2. Version history

### 3.0.0 — 5 November 2026 — Salary and Savings management

**Scope requested:** four dedicated pages (Dashboard, Expenses, Salary, Savings), a Liquid Glass bottom navigation, manual month-by-month salary, independent savings with This month/Total tabs, automatic remaining-balance recalculation, an additive IndexedDB migration, offline support and tests.

**Why:** the app could only answer “what did I spend?”. It could not answer “what do I have left?” because it had no income and no notion of money set aside. Salary and savings had to be first-class records, not negative expenses, or every expense analytic would become wrong.

**Implemented**

1. **Four pages** in `index.html`: `#view-dashboard`, `#view-expenses`, `#view-salary`, `#view-savings`. Each page has its own heading, hierarchy and purpose.
2. **Four-tab glass dock** (`#dock`) with Dashboard, Expenses, a raised center Add-expense button, Salary and Savings. Icons, labels, active pill, `aria-current`, safe-area bottom padding, 44 px+ targets.
3. **Monthly finance card** on the dashboard: salary / expenses / savings in a 3-cell grid plus a remaining-balance band; previous/next month stepper; links to Salary and Savings.
4. **Salary page**: dark green income card with month stepper, amount or “Not configured”, notes, a live expenses/savings/remaining split, Add/Edit and Remove actions, and a salary history list. One record per calendar month.
5. **Salary form**: amount (`₹` money input), month + year `<select>` pair (chosen over `input[type=month]` because iOS Safari does not support that input type), optional notes, inline field errors, duplicate-month handling.
6. **Savings page** with two tabs:
   - *This month*: total, entry count, add action, entries with date and optional description, edit/delete.
   - *Total*: accumulated total, growth versus previous month, month-by-month navigator with that month’s entries, and an “All months” list of monthly totals.
7. **Savings form**: amount, date (max today), optional description, inline errors.
8. **Confirmation before destructive actions**: remove salary and delete savings both show an explicit action sheet; savings deletion also offers Undo.
9. **Integer paise** (`toPaise` / `fromPaise`) for all finance arithmetic. Records keep `amount` (rupees, display) and `amountPaise` (integer, calculation), always derived together on write.
10. **IndexedDB v2**: new `salaries` store (unique `by_monthKey`) and `savings` store (`by_monthKey`, `by_date`, `by_date_createdAt`). Existing `expenses`/`meta` untouched. Upgrade aborts (rolls back) on failure.
11. **Repositories**: `SalaryRepository` and `SavingsRepository` mirroring the existing expense repository conventions — validation, stable ids, timestamps, restore for Undo, `replaceAll` for backups.
12. **Version 3 backups** containing expenses, salaries and savings; restore handles older expense-only backups without touching salary/savings, and rolls back a partial restore when possible.
13. **Service worker v4** so the new HTML/CSS/JS generation is precached and old caches are cleaned.
14. **54 unit tests** and **13 Playwright scenarios**, including a real v1 → v2 database upgrade and offline salary/savings.
15. **`memory.md` and `context/`** so the project can be continued without re-deriving decisions.

**Why these choices**

- **Separate stores, not flags on expenses.** Savings must never appear in expense history, expense totals, CSV exports or analytics. A separate object store makes that impossible by construction rather than by remembering to filter.
- **Unique index for salary months.** The UI checks first for a friendly message, but the database also enforces it, so two tabs cannot create duplicates.
- **Additive migration.** Dropping or recreating stores would risk user data. The upgrade only creates missing stores and never touches `expenses`.
- **Date is authoritative for savings months.** `monthKey` is stored for indexing, but every calculation derives the month from `date` so a stale/mislabelled key can never move money between months.
- **No carry-forward.** Each month is computed from its own records only; this is the correctness rule the whole feature exists for.
- **Native `<select>` month/year.** Works consistently on iOS, Android and desktop, unlike `<input type="month">`.
- **Integer paise.** `0.1 + 0.2 !== 0.3` is unacceptable in a balance a user makes decisions with.

**Files changed in 3.0**

- `index.html` — four pages, new icons, salary/savings sheets, glass dock.
- `css/app.css` — finance card, income card, segmented tabs, month steppers, shortcuts, savings month rows, new form controls, responsive and hidden-attribute fixes.
- `js/core.js` — `DB_VERSION = 2`, month keys, paise helpers, salary/savings validation + normalisation, `computeMonthlyFinance`, savings grouping.
- `js/db.js` — salaries/savings stores, `IndexedDBSalaryStore`, `IndexedDBSavingsStore`, additive v2 upgrade.
- `js/repository.js` — `SalaryRepository`, `SavingsRepository`, `DuplicateMonthError`, generic `NotFoundError` message.
- `js/app.js` — four-view render loop, finance overview, salary/savings pages and forms, backup v3, navigation, month steppers.
- `sw.js` — cache generation `v4`, offline fallback copy.
- `manifest.json` — new name/description and salary/savings shortcuts.
- `package.json` — version 3.0.0, extra unit test files.
- `tests/unit/finance.test.mjs`, `tests/unit/finance-repository.test.mjs` — new.
- `tests/e2e.mjs` — new navigation, finance, upgrade and offline scenarios; DB snapshot reads all stores.
- `README.md`, `memory.md`, `context/*.md` — documentation.

### 2.0.0 — 4 November 2026 — Offline-first IndexedDB + Liquid Glass

Existing, preserved behaviour:

- IndexedDB became primary storage behind `ExpenseRepository`; one-time legacy `localStorage` migration with verification.
- Versioned service worker, offline app shell, safe “Refresh” update flow.
- Liquid Glass redesign: white/forest-green system, translucent dock and sheets, opaque readable data surfaces.
- Existing analytics: week/month/rolling three months/year, daily average, recent expenses, searchable month-grouped history, edit/delete with Undo, CSV, JSON backup/restore.
- PWA install on iPhone, safe areas, reduced motion/transparency support.

### 1.0.0 — 4 November 2026 — Initial tracker

Single-page expense tracker with `localStorage`, basic totals and history. Superseded by 2.0.0.

---

## 3. Issues encountered and how they were resolved

### 3.1 Truncated writes during the 3.0 implementation (tooling, not product)

Large single-file rewrites were interrupted by connection-level provider errors while writing `js/app.js`, `index.html` and `css/app.css`.

**Resolution:** split the work into smaller, verifiable chunks. `app.js` was written as a skeleton with an explicit `/* __NEXT_CHUNK__ */` marker and then extended in four passes; the marker was replaced until none remained. Nothing was left half-written, and each pass ended with a syntax check (`node --check`).

**Lesson:** for this project, write large modules in sections and verify syntax after each section.

### 3.2 Missing imports after splitting `app.js`

`toPaise` and `isMonthKey` were used by the savings/salary code but were not imported after the rewrite.

**Resolution:** a grep for every new helper plus `node --check` caught them; both were added to the `core.js` import list. **Lesson:** after a multi-pass rewrite, cross-check every identifier against the import block, not just syntax.

### 3.3 `hidden` attribute defeated by `.button { display: inline-flex }`

The Salary page’s “Remove salary” button stayed visible on months with no salary, because an author `display` rule overrides the user-agent `[hidden] { display: none }`. The e2e test caught it (`isHidden()` was false).

**Resolution:** added `.button[hidden] { display: none; }` in `css/app.css`. Existing components already had explicit `[hidden]` rules (`.banner[hidden]`, `.toast[hidden]`, `.view[hidden]`, `.install[hidden]`); buttons were the gap. **Lesson:** every component that sets `display` needs a matching `[hidden]` rule.

### 3.4 Tests read CSS-transformed text

`innerText` on `.section__hint` and `.income-card__hint` returned `1 MONTH` / `FUTURE MONTH` because those classes use `text-transform: uppercase`.

**Resolution:** assertions that care about the underlying copy now use `textContent().trim()`. **Lesson:** use `textContent` for semantic strings, `innerText` only when testing what a user sees.

### 3.5 Savings `now()` was called twice per save

`SavingsRepository.create/update` called `this.now()` once for validation and again for the timestamp. With a fake clock in tests this skipped a tick and made timestamps one second later than expected — and in production it could theoretically stamp a different second than the one validated against.

**Resolution:** capture `const now = this.now()` once and use it for both validation and `createdAt`/`updatedAt`. **Lesson:** an injected clock must be read once per operation.

### 3.6 `listByMonth` assumed the store returns an array

`IndexedDBSavingsStore.getByMonth` returns an array, but the in-memory test store returned one record (matching the salary store’s unique-index contract). `sortSavings(undefined)` threw “savings is not iterable”.

**Resolution:** `SavingsRepository.listByMonth` now normalises the result — array, single record or empty — before sorting. **Lesson:** repository code should tolerate both adapter shapes until the store contract is identical.

### 3.7 Expected validation failures polluted the browser console

The salary duplicate-month path called `console.error`, and the e2e suite fails on any console error. It was a valid, expected user error being logged as a crash.

**Resolution:** all three submit handlers now log only unexpected errors. `ValidationError`, `DuplicateMonthError` and `NotFoundError` go straight to inline field/sheet messages. **Lesson:** expected user errors are UI state, not console errors.

### 3.8 Restore toast copy no longer matched the data

Backups now restore salary and savings too, but the undo toast still said “Your previous expenses are back.”

**Resolution:** copy changed to “Your previous data is back.”, and the e2e assertion updated. **Lesson:** when a feature widens, audit every user-facing string that names its old scope.

### 3.9 Dashboard shortcut labels truncated on a 390 px phone

“₹50,000.00 for Nov 2026” and “₹12,000.00 saved in Nov 2026” were clipped by the two-column shortcut cards.

**Resolution:** shortened the copy to “₹50,000.00 recorded” / “₹12,000.00 saved” and allowed the secondary line to wrap to two lines instead of ellipsising. Verified visually at 390 px. **Lesson:** a month already named in the card header does not need repeating in the shortcut.

### 3.10 Redundant savings/salary metadata

The Savings hero said “2 entries · November 2026” directly under “Saved in November 2026”, and salary rows repeated “Monthly salary · Monthly salary” when the note was “Monthly salary”.

**Resolution:** savings meta is now “2 entries this month” / “2 entries saved”; salary row meta shows the note when present, otherwise “Monthly salary”. **Lesson:** do not restate context that is already on screen.

### 3.11 v1 database upgrade could leave a half-created schema

An error inside `onupgradeneeded` (for example, creating an index on a store that already exists) can leave the versionchange transaction pending.

**Resolution:** the upgrade handler catches errors and calls `request.transaction.abort()`, so IndexedDB rolls back to the v1 schema. Store creation is also idempotent (`if (!contains)`), which covers fresh installs and partial prior states. The e2e suite builds a real v1 database and verifies the upgrade. **Lesson:** upgrade handlers must be idempotent and must abort on failure.

### 3.12 Expected 404 from the upgrade fixture counted as a console error

The v1-upgrade test navigates to a deliberately missing path to get a same-origin blank document before creating the old database, which logs a 404.

**Resolution:** attach the console watcher after that navigation, so only the app’s own errors are counted.

### 3.13 Stale e2e expectations after the balance changed

One assertion expected ₹47,500 after a reload, but the savings entry had been edited to ₹1,200 (total savings ₹1,700), so the correct remaining was ₹47,300.

**Resolution:** corrected the fixture math and documented it in the test comment. **Lesson:** derive expected values from the same rule as the app (salary − expenses − savings), not from an earlier step in the test.

---

## 4. Verification record (5 November 2026)

- `npm test` → **54 passed, 0 failed**.
- `npm run test:e2e` → **13/13 checks passed**, no browser console errors.
- Manual visual review at 390 × 844 and 1440 × 1000:
  - dashboard finance card, shortcuts, glance grid, dock: no overflow, no clipped values;
  - Salary page and salary sheet (month/year selects, notes, remove button);
  - Savings This month and Total tabs, month stepper, month list;
  - expense sheet.
- Confirmed `expenses`, `salaries`, `savings` and `meta` coexist in the upgraded database, and expenses keep their ids/amounts.
- Confirmed offline add/read of salary and savings after an offline reload.

---

## 5. Decisions worth not re-litigating

| Decision | Reason |
|---|---|
| Savings in a separate store | Guarantees they never enter expense history, CSV or analytics. |
| `amountPaise` stored alongside `amount` | Safe arithmetic with a human-readable field; both derived on write. |
| Date is authoritative for a savings month | Prevents stale `monthKey` values from moving money between months. |
| Native `<select>` for month/year | iOS Safari does not support `<input type="month">` well. |
| Additive DB upgrade only | Any destructive schema step risks the user’s only copy of their data. |
| Duplicate salary blocked by a unique index | The UI check alone cannot stop a second tab. |
| Confirm + Undo for savings delete | Destructive action needs confirmation; Undo covers mistakes. |
| Salary removal confirmed, not immediate | Historical calculations change when a salary disappears. |
| No salary → “Not configured / —” | A zero balance would be a lie; the requirement is explicit. |
| Backup version 3 includes all three collections | A backup that silently drops income/savings is not a backup. |

## 6. Open questions / next steps

- **Salary month range** is current year −6 to +3 in the picker. A date-free custom range or an “add year” option may be needed for very old records.
- **Yearly savings overview** could complement the monthly growth chip.
- **Income sources beyond salary** (freelance, bonus) would need a source field or a second collection; not implemented.
- **Cross-tab live sync** is still reload-based.
- **Dark theme** is deliberately out of scope for the white/forest identity.
- **Recurring salary** could prefill next month’s salary, but only with an explicit “copy last month” action to avoid surprising records.

---

## 7. How to continue safely

1. Read this file, then `context/architecture.md` and `context/data-model.md` (plus `context/design-system.md`, `context/testing.md` and `context/roadmap.md` when relevant).
2. Run `npm test` before and after changes.
3. Install Playwright once (`npm install`, `npx playwright install chromium`) and run `npm run test:e2e`.
4. Never bump the DB version destructively; add stores/indexes and abort on failure.
5. Never add savings to expense totals, CSV or analytics.
6. Bump `CACHE_VERSION` in `sw.js` for every cached-asset change.
7. Append to this file and the relevant `context/` file. Do not overwrite history.

### Context index (5 November 2026)

| File | Contains |
|---|---|
| `context/architecture.md` | Layers, render loop, navigation, offline/service worker, extension seams. |
| `context/data-model.md` | IndexedDB v2 schema, record shapes, migration, paise rules, backup v3. |
| `context/design-system.md` | Colour, type, spacing, glass rules, components, motion, accessibility. |
| `context/testing.md` | Unit/e2e suites, fixtures, debugging notes, manual-only checks. |
| `context/roadmap.md` | Candidate next steps, non-goals, and the bar for each change. |

---

## 8. Version 3.1.0 — 5 November 2026 — Salary Month Navigator

**Scope:** turn the Salary page into a proper month-by-month financial overview with a prominent navigator, a month/year picker, a **Current month** shortcut, and month-only calculations. Requested on top of 3.0.0; no architecture change.

### Implemented
1. **Navigator in the income card** — previous arrow, month + year button, next arrow, all riding the existing `state.salaryMonth` key.
2. **Tap the month** → compact `#monthPickerSheet` with month and year selects, **Go to month**. Year list = current −6…+3 plus any year already present in salary history plus the selected year.
3. **Current month chip** (`#salaryCurrentMonth`) appears only when another month is selected and returns to today.
4. **Arrow-key navigation** on the navigator (Left/Right) for keyboard users.
5. **Month-change animation** — the amount slides 10 px in the travel direction for 0.26 s; skipped under `prefers-reduced-motion`.
6. **Zero-write navigation** — every navigator path only sets `state.salaryMonth` and re-renders. No code path creates, copies or edits a salary record while browsing.
7. **Accessible labels** — the month button reports `Selected month: November 2026. Choose another month and year.`, `aria-haspopup="dialog"`, and the chip has a real label.
8. **Tests** — 2 new browser scenarios (navigator, sheet-reopen race) → 15 total; 54 unit tests unchanged.

### Everything the navigator already had (3.0.0), now confirmed by tests
- Expenses and savings are filtered by their own `date` against the selected month; nothing is carried forward.
- No salary → **Not configured** and `—` remaining, while that month's expense/savings totals still display.
- Negative remaining shows in red with the explanatory note.
- Editing one month never touches another; duplicates stay blocked by the unique index.

### Issues found and how they were fixed
1. **Reopening a sheet during its close animation parked it off-screen.**
   Cause: `.sheet.is-closing` uses `animation: sheet-down … forwards`; the pending `setTimeout(close, 210)` ran against a dialog that had already been reopened, leaving `[open]` applied with the end-frame transform.
   Fix: `openDialog()` now clears the timer, and when the dialog is still open mid-close it calls `close()` before `showModal()` so the open animation replays. A `dataset.session` stamp also stops a late-finishing save from closing a freshly reopened sheet.
2. **Test measured layout mid-animation and reported a false failure.**
   Cause: `waitFor({state:'visible'})` resolves when the dialog starts rising from `translateY(100%)`.
   Fix: the test waits until `getAnimations()` are `finished` before asserting the Save button is inside the viewport.
3. **Stale service-worker shell hid the new markup during review**, which also looked like “the bottom nav is missing”.
   Cause: the worker precaches `index.html` and serves navigations cache-first, so a previously installed worker keeps an older generation until the update flow runs.
   Fix: `CACHE_VERSION` bumped on every cached-asset change (now `v8`); for local review, unregister the worker / clear caches, then reload. The dock itself was never removed — `#dock` is intact in `index.html` with four tabs and the raised add button.
4. **Dashboard glance hint said “Saved totals” next to “Spending at a glance”.**
   Fix: changed to **All periods**.
5. **Page title still said “Expense Tracker”.**
   Fix: `Spendly — Salary, Spending & Savings` in the `<title>` and in `VIEW_TITLES.dashboard`.

### Files touched in 3.1.0
- `index.html` — month button + caret, **Current month** row, month-picker sheet, `i-chevron-down`, `i-calendar-dot` symbols, title.
- `js/app.js` — `setSalaryMonth`, `shiftSalaryMonth(delta, animate)`, `pulseMonthChange`, `populatePickerMonthOptions`, `openMonthPicker`, `handleMonthPickerSubmit`, `openDialog` + `isSameDialogSession`, session guards in all three submit handlers, page title, dialog sessions.
- `css/app.css` — navigator button, caret, chip, amount slide keyframes, `.sheet--compact`.
- `sw.js` — cache generation `v8`.
- `tests/e2e.mjs` — navigator scenario, sheet-reopen scenario, selector fixes.
- `README.md`, `memory.md`, `context/architecture.md`, `context/design-system.md`, `context/testing.md`, `context/roadmap.md`.

### Verification
- `npm test` → **54 passed, 0 failed**.
- `npm run test:e2e` → **15/15 checks passed**, no console errors.
- Manual: navigator opens on November 2026; picker to October 2026 shows **Past month**, **Not configured**, `—`, zero expenses/savings; **Current month** restores ₹50,000 with ₹40,800 remaining; dock visible at 390 × 844 with no overlap.

## 9. Version 3.2.0 — 6 November 2026 — Salary pools and source-aware ledger

**Why:** month-based accounting incorrectly tied transactions to their calendar month, although a salary remains the available pool until a newer salary is manually recorded. Savings also needed to be spendable without misreporting withdrawals as contributions or double-counting expenses.

### Implemented

1. Salary is now a distinct pool. New salary-funded expenses and savings contributions reference the latest created salary record, regardless of the transaction's calendar date. Historical salary pools retain their own calculations.
2. Salary's primary amount is its remaining balance. The selected month still selects a salary record, and an absent record has a clear empty state.
3. The user may explicitly transfer a previous salary pool's positive remainder into Savings. Transfers are typed credits and debits from the originating pool; deferred balances remain transferable later.
4. Expenses include a Paid From choice for Salary Balance or Savings. A savings-funded expense and its unique linked withdrawal are created, edited, removed and restored atomically. Insufficient Savings blocks the write.
5. The Savings view distinguishes contributions, salary transfers and withdrawals. CSV remains expenses-only, and dashboard expense analytics continue to use actual dates for either funding source.
6. IndexedDB v3 adds relationship indexes without clearing records. A one-time idempotent migration assigns legacy rows by timestamp; rows without a safe match are retained for review. JSON backup format is v4.
7. `FinancialLedgerRepository` centralizes multi-store integrity operations; derived balances continue to use integer paise and are not separately persisted.
8. Added coverage for pool math, migration-sensitive financial workflows, insufficient balances, transfer handling, edits/deletes/Undo and browser layout. The v2 fixture verifies entry-time allocation, preserved dates, unmatched-row review flags and idempotency after reload. Latest run: 56 unit tests and 17 browser scenarios passed.

**Decision:** use entry timestamps for legacy assignment. Each legacy row goes to the most recently created salary at or before `createdAt`; transaction date is retained but does not decide funding. Unmatched records remain unallocated with `needs_review` status.

**Docs:** `context/architecture.md`, `context/data-model.md`, `context/design-system.md`, `context/testing.md`, `context/roadmap.md` and README contain the current model, migration and deployment steps.
