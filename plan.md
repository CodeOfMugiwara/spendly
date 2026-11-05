# Spendly — Improvement Plan

> **No code was changed to produce this document.** It is a plan only.
> Read [memory.md](memory.md) first for history; this file looks forward.
> Status: draft, 5 November 2026, based on Spendly 3.1.0 (54 unit tests, 15 browser scenarios passing).

---

## 1. Where the product actually is

| Area | State | Evidence |
|---|---|---|
| Pages | Four dedicated pages, glass dock, no URL state | [index.html:538](index.html#L538), `showView()` [js/app.js:683](js/app.js#L683) |
| Money | Integer paise, per-month, no carry-forward | `computeMonthlyFinance` in [js/core.js](js/core.js) |
| Storage | IndexedDB v2, additive upgrade, unique salary month | [js/db.js](js/db.js) |
| Offline | Full shell precache, update banner, `v8` | [sw.js](sw.js) |
| Backup | JSON v3 + CSV (expenses only) | [js/app.js:1397](js/app.js#L1397) |
| Rendering | Whole app re-rendered on every mutation | `render()` [js/app.js:230](js/app.js#L230) |
| Code size | ~3.9k JS, 3.3k CSS, 1.2k test lines | `wc -l` |
| Navigation state | Not in the URL; no back-button support | `state.view` is memory-only |
| Accessibility | Good labels/aria-live, no automated checks, focus not moved on view change | 14 focus/aria hooks in `app.js` |

The core loop is correct and tested. The remaining opportunities are mostly about **feeling like a real app on a phone**, **insight rather than raw numbers**, and **not letting the single-file UI logic calcify**.

---

## 2. Principles for anything added

1. **Offline first, always.** Any feature must work with the network off, on first paint, from IndexedDB.
2. **No new architecture without a seam.** New data = new store + repository; never overload `expenses`.
3. **Savings are never expenses.** Any analytics change must keep CSV, totals and history expense-only.
4. **Money stays integer paise.** No floats in calculations, ever.
5. **Quiet UI.** One focal number per page; translucency only on navigation, toolbars and floating controls.
6. **Every claim needs a check.** New behaviour ships with a unit test if it is logic, a browser scenario if it is flow.

---

## 3. Prioritised opportunities

Effort: **S** ≤ ½ day, **M** 1–2 days, **L** 3–5 days. Priority reflects user value ÷ risk.

### P0 — Things a user will hit in the first week

#### 3.1 URL state for pages and months (`#/salary/2026-10`)
- **Problem:** the app has four pages but the browser back button exits the app. Reloading always returns to Dashboard. Shared links cannot point at a month.
- **Why it matters:** on iPhone the edge-swipe back gesture is muscle memory; on desktop users expect `Alt+←`. This is the single most "not an app" behaviour left.
- **Shape:** hash routing (`#/expenses`, `#/salary/2026-10`, `#/savings/total`) parsed in `showView`/`setSalaryMonth`; `history.pushState` per navigation; `popstate` re-renders. Keep the existing `?view=&action=` launch params for PWA shortcuts.
- **Effort:** M. **Risk:** medium — must not create duplicate history entries on month arrows (use `replaceState` for arrow steps, `pushState` for tab changes).
- **Done when:** back after Dashboard → Salary → earlier month returns month by month; a copied URL opens the same page/month; existing shortcuts still work; new e2e scenario covers back/forward and deep link.

#### 3.2 Backup that can merge, not only replace
- **Problem:** restore replaces everything. Two devices therefore can never both keep their data; a partial restore loses the other device's records.
- **Why it matters:** data safety is the product's promise, and "export before changing domains" is currently the only escape hatch.
- **Shape:** add **Merge** alongside **Replace** in the restore sheet. Merge inserts by id, skips existing ids, and reports `added / skipped / conflicts`. Same for CSV import of expenses (dedupe on date+amount+description). Keep the safety copy before either action.
- **Effort:** M. **Risk:** low-medium; the transactional `replaceAll` pattern already exists.
- **Done when:** unit tests cover id collision, salary month collision (report, don't overwrite), and zero-change merges; e2e proves replacement still works and merge preserves both sides.

#### 3.3 Backup nudge + storage health
- **Problem:** nothing tells a user their only copy lives in a browser that can evict it. `navigator.storage.persist()` is requested silently ([js/app.js:200](js/app.js#L200)) with no explanation.
- **Why it matters:** this is the highest-consequence failure mode in the whole product.
- **Shape:** once there are ≥ 10 records and no backup in 30 days, show a quiet one-line card on Expenses → Your data with **Download backup**. Add a storage line using `navigator.storage.estimate()` (used / quota) and whether persistence was granted. Store `lastBackupAt` in `meta`, not localStorage.
- **Effort:** S. **Risk:** low. **Done when:** dismissing stays dismissed for 30 days; the line reports real numbers; no console errors when the API is missing.

#### 3.4 Focus and announcement on page change
- **Problem:** `showView()` swaps hidden sections and scrolls to top, but focus stays on the dock button and screen readers announce nothing.
- **Shape:** on view change, move focus to the page `<h1>` (`tabindex="-1"`) and announce "Salary page" once via the existing polite live region. Do not steal focus on first load.
- **Effort:** S. **Risk:** low. **Done when:** VoiceOver/TalkBack reads the new page; keyboard `Tab` continues inside the page, not from the top of the document.

### P1 — The difference between "tracker" and "useful"

#### 3.5 Month-over-month deltas
- **Problem:** the Salary page shows one month in isolation; the user cannot see whether spending is up or down without tapping back and forth.
- **Shape:** under the split, one line: `Spent ₹2,400 more than October` with the previous month's value, and a ± chip on savings. Derived only — no storage change.
- **Effort:** S. **Risk:** low. **Done when:** the sentence is correct across year boundaries, when the previous month has no data, and never appears for the current month if it is the first record.

#### 3.6 "Copy last month's salary" as an explicit action
- **Problem:** salary is entered by hand every month; that is the point, but re-typing the same number is friction.
- **Shape:** on an empty month with a previous salary, show **Use ₹50,000 from October** as a secondary action that *opens the sheet prefilled* — never auto-creates.
- **Effort:** S. **Risk:** low. **Done when:** nothing is written until Save; the button never appears when there is nothing to copy; duplicate-month guard still applies.

#### 3.7 Savings goal
- **Problem:** the Total tab answers "how much", not "how am I doing".
- **Shape:** optional monthly goal on the Savings page (stored in a small `settings` store or `meta`), progress bar in the hero, and "₹2,000 to go" copy. Purely additive; savings arithmetic unchanged.
- **Effort:** M. **Risk:** medium — introduce `settings` cleanly rather than stuffing JSON in `meta`.
- **Done when:** goal persists offline, never affects remaining balance, and progress is exact in paise.

#### 3.8 Search and filter where they are missing
- **Problem:** only Expenses has search. Savings history and Salary history are scroll-only.
- **Shape:** reuse `matchesQuery` on savings (description/date/amount) and a year filter on salary history. No new UI pattern — the same compact search field already exists.
- **Effort:** M. **Risk:** low. **Done when:** search is debounced, preserves the active tab, and e2e proves filtering does not mutate data.

#### 3.9 Export everything
- **Problem:** CSV covers expenses only, by design — but users will want their salary/savings out too.
- **Shape:** a second CSV (`Month, Salary, Expenses, Savings, Remaining`) on the Salary page, generated from the same computation as the UI so numbers cannot diverge; keep the expenses CSV untouched.
- **Effort:** S. **Risk:** low. **Done when:** totals match the Salary page for three seeded months, including a negative month.

### P2 — Scale, polish, and the long game

#### 3.10 Incremental rendering
- **Problem:** every save re-renders all four pages (`render()`), rebuilding eight lists. Fine at 200 records; noticeable at 5,000.
- **Shape:** split `render()` into `renderDashboard`, `renderExpenses`, `renderSalary`, `renderSavings` and call only the affected ones plus a cheap "derived summary" invalidation. Add a `renderCount` debug counter.
- **Effort:** M. **Risk:** medium (stale UI bugs). **Measure first:** time `render()` with 5,000 synthetic records in a benchmark script; only proceed if > 16 ms.
- **Done when:** one save costs < 8 ms at 5,000 records and all 15 scenarios still pass.

#### 3.11 Charts, sparingly
- **Problem:** "Spending at a glance" is numbers only; trends are invisible.
- **Shape:** one inline SVG sparkline of the last six months on the dashboard, no library, no axes, `aria-label` with the full series. Do not add a chart per page.
- **Effort:** M. **Risk:** low. **Done when:** it renders offline, is readable at 320 px, and respects reduced motion.

#### 3.12 Accessibility and regression gates
- **Problem:** accessibility is careful but unverified; CSS is 3,200 lines with no visual baseline.
- **Shape:** add `@axe-core/playwright` (one dev dependency) and fail the suite on serious violations; add three screenshot baselines (dashboard, salary, savings) compared with a tolerance. Keep `axe` scoped to avoid noise from `backdrop-filter` contrast.
- **Effort:** M. **Risk:** low. **Done when:** both suites fail loudly on a deliberate regression.

#### 3.13 Type checking without a rewrite
- **Problem:** 2,200 lines of plain JS with JSDoc-shaped intent but no machine check.
- **Shape:** `// @ts-check` at the top of `core.js` and `repository.js` plus a `tsconfig.json` with `checkJs` limited to those two files. No build step, no bundler, no framework.
- **Effort:** S–M. **Risk:** low. **Done when:** `npx tsc --noEmit` is clean and wired into `npm test`.

#### 3.14 Onboarding that teaches the formula once
- **Problem:** a first-time user sees an empty dashboard and may not realise salary is the thing that unlocks the balance.
- **Shape:** on the empty dashboard, a three-step inline hint: add salary → add expenses → set money aside, with the current step highlighted. Disappears forever once a salary exists. No modal tour.
- **Effort:** S. **Risk:** low. **Done when:** it never appears again after a salary is saved, including after restore.

---

## 4. Sequenced plan

| Phase | Contents | Outcome |
|---|---|---|
| **1. Trust** (≈2 days) | 3.3 backup nudge, 3.2 merge restore, 3.4 focus on view change | Data feels safe; keyboard/screen-reader users are not stranded |
| **2. Navigation** (≈1.5 days) | 3.1 hash routing | Back button, reload and shared links behave like an app |
| **3. Insight** (≈2 days) | 3.5 deltas, 3.6 copy salary, 3.9 export everything | Each page answers a question, not just a number |
| **4. Depth** (≈3 days) | 3.7 savings goal, 3.8 search, 3.14 onboarding | The app grows with the user |
| **5. Hardening** (≈2 days) | 3.13 ts-check, 3.12 axe + visual baselines, 3.10 benchmark → maybe incremental render | Regressions get caught before users do |
| **6. Optional** (gated) | 3.11 sparkline, dark theme decision, recurring expenses | Only if the above is stable and measured |

Each phase: bump `CACHE_VERSION`, append to `memory.md`, add the relevant `context/` addendum, and keep the suites green before moving on.

---

## 5. Explicit non-goals (still)

- Accounts, login, cloud sync, Supabase/Firebase.
- Bank feeds, receipt OCR, SMS parsing — all need a backend or permissions that break offline-first.
- Multi-user or shared ledgers.
- Turning every surface into glass, or adding a second accent colour.
- A framework rewrite. The plain-module architecture is why the app boots instantly offline.

---

## 6. Measurement, so "better" is not a feeling

| Question | How to answer without new infrastructure |
|---|---|
| Is rendering a bottleneck? | Throwaway Playwright benchmark: 5,000 records, time `render()` 20×, report p50/p95 |
| Is the app usable offline after updates? | Existing restart + offline reload scenario |
| Did a change break layout? | 3 screenshot baselines at 320 / 390 / 1440 |
| Is accessibility regressing? | axe serious/critical = 0 |
| Is money arithmetic still exact? | Unit tests over `toPaise`/`computeMonthlyFinance` with awkward values (0.1 + 0.2, ₹99,999.99, negative) |

No analytics, no telemetry, no network calls — consistent with the product's privacy promise.

---

## 7. Risks and how to keep them small

- **Routing churn:** hash routing touches every navigation path. Land it behind the existing `showView`/`setSalaryMonth` entry points only, with a scenario per page plus back/forward before touching anything else.
- **Merge data loss:** merge must be insert-only and report conflicts; a conflicting salary month is skipped, never overwritten. Test with a deliberately corrupted file.
- **Incremental render staleness:** do not start until the benchmark proves a problem; if started, add a dev-only assertion that every visible derived value matches a fresh full calculation.
- **Feature creep into the dashboard:** the dashboard is already at its density limit. New insight belongs on the relevant page, or replaces something, never stacks.

---

## 8. Definition of done for any item in this plan

1. Works with the network disabled.
2. Existing data untouched; a v1 database still upgrades.
3. Savings never enters expense totals, history or CSV.
4. Logic has unit tests; flow has a browser scenario; no console errors.
5. Mobile (320/390) and desktop (1440) checked, no horizontal overflow.
6. `CACHE_VERSION` bumped; `memory.md` and the relevant `context/` file appended.

---

## 9. If only one thing gets done

**P0 3.1 (URL state).** It converts a set of pages into a navigable app on both iPhone and desktop, and it is the change a user notices within thirty seconds — before any new feature would matter.
