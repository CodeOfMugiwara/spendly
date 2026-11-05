# Spendly — Roadmap Context

> **Append or update only.** Add new ideas and decisions with a date. Do not delete superseded entries — mark them superseded instead.

Last updated: 5 November 2026 (Spendly 3.0.0).

## Where the product stands

Spendly answers three questions offline, for one person, on one device:

1. What did I spend? (expenses, all original analytics)
2. What did I earn this month? (manual salary)
3. What is left? (salary − expenses − savings, in integer paise)

Deliberately absent: auth, cloud sync, income sources other than salary, budgeting envelopes, dark mode.

## Candidate next steps, in rough order of value

### Near term
- **Copy last month's salary.** One explicit action on the Salary page, never automatic, so no surprising records appear.
- **Yearly savings view.** Current growth chip compares one month; a year strip would make the Total tab complete.
- **Salary month range.** The picker spans current year −6…+3. A custom year entry would cover restored historical backups.
- **Budget per month.** A target expense ceiling would use the same `computeMonthlyFinance` seam; it must stay optional and not turn into a second source of truth.

### Medium term
- **Income sources beyond salary.** Freelance, bonus, interest. Requires either a `source` field on salaries or a new `incomes` store; does not require changing the remaining-balance formula.
- **Recurring expenses.** Would need an explicit "apply to this month" confirmation to avoid silently changing history.
- **Cross-tab live sync.** `BroadcastChannel` is enough on one origin; still no server.

### Longer term / explicitly gated
- **Optional encrypted backup file with a passphrase.** Would remain local; no server.
- **Cloud sync.** The repository seam exists for it (`js/repository.js` → store interface, stable ids, `createdAt`/`updatedAt`). Any implementation must be opt-in and must not remove local-first behaviour. Out of scope until the user asks.
- **Dark theme.** The white/forest identity is the brand; a dark theme would need a full design pass, not a filter.

## Non-goals

- Accounts, subscriptions, paywalls.
- Bank integrations or receipt OCR (needs a backend and credentials).
- Multi-device real-time collaboration.
- Turning every surface into glass — translucency stays limited to navigation, toolbars and floating controls.

## How to add to this file

Append a dated subsection under the right horizon. State the user problem, the smallest shape that solves it, and what it must not break (offline, data safety, expense-only CSV). If an item above is implemented, leave the line and add an entry in `memory.md` linking the version that shipped it.

## Addendum — 6 November 2026: completed salary-pool and expense-source upgrade

Implemented the source-aware salary/savings ledger in Spendly 3.2. Salary records are independent pools keyed by salary record ID; expense dates continue to drive dashboard analytics and savings month grouping. The current active pool is the most recently created salary. New salary-funded expenses and contributions debit that pool, while Savings-funded expenses create linked withdrawals.

The project now supports explicit later transfer of a previous pool's positive remainder into Savings. Transfer and withdrawal rows remain distinct from ordinary contributions and expenses. Salary deletion is blocked while linked activity exists. No automatic carry-forward or split payment was added.

The upgrade keeps IndexedDB local and offline, uses additive v3 indexes, migrates legacy allocation using transaction timestamps, flags ambiguous rows for review, and writes backup v4. The corresponding candidate was not on the roadmap, so this addendum records the shipped scope without removing future items.
