# Spendly — Design System Context

> **Append or update only.** Existing principles stay; new rules are appended with a date. Read `memory.md` first.

Last updated: 5 November 2026 (four-page release).

## Direction

Apple's Liquid Glass material language, interpreted for a calm personal ledger:

- **White and forest green.** Readable white surfaces for data; deep green for identity, income and primary actions.
- **Glass only where it floats.** The app bar, bottom dock, sheets, banners, toasts and small chips. Data cards stay opaque.
- **Quiet hierarchy.** Uppercase micro-labels, display-font amounts, tabular numerals, restrained shadows.
- **IOS-first, desktop-capable.** Safe areas, 44 px targets, native sheets, no horizontal overflow; the same layout centers at 760 px on desktop.

Reference material: Apple HIG “Materials” and “Liquid Glass”.

## Tokens (`:root` in `css/app.css`)

| Role | Token | Value |
|---|---|---|
| Background | `--paper` | `#f3f6f2` |
| Surface | `--surface` | `#ffffff` |
| Soft surface | `--surface-soft` | `#f7faf6` |
| Ink | `--ink` | `#14251b` |
| Muted | `--muted` | `#5f7167` |
| Forest | `--forest` | `#176b3a` |
| Forest deep | `--forest-deep` | `#0b3a23` |
| Mint | `--mint` | `#e7f3eb` |
| Danger | `--danger` | `#b42318` |
| Glass fill | `--glass-bg` | `rgba(255,255,255,.66)` |
| Radii | `--radius-xl/lg/md/sm` | 30 / 24 / 18 / 14 px |
| Gutter | `--gutter` | `clamp(16px, 4.4vw, 28px)` |

Typography: system UI for text, rounded display stack for amounts and headings. Amounts use `font-variant-numeric: tabular-nums`.

## Components

### Glass bottom dock (`.dock`)
- Fixed, centered, `width: min(412px, 100vw - 26px)`, bottom `10px + safe-area`.
- Five-slot grid: Dashboard, Expenses, raised Add expense, Salary, Savings.
- Active tab: soft mint fill, forest text, `aria-current="page"`.
- 48 px tab height, 9 px labels, ellipsis rather than overflow.
- On desktop: 396 px wide, 24 px from the bottom.

### Sheets (`.sheet`)
- Mobile: bottom sheet, 28 px top radius, grip handle, `max-height: 92dvh`, scrollable body, safe-area bottom padding.
- Desktop (≥720 px): centered modal with scale/fade.
- Shared close animation and backdrop; `body.sheet-open` locks scroll.

### Monthly finance card (`.finance`)
- Three equal cells: Salary, Expenses, Savings; 1 px dividers.
- Remaining band below: label + large display amount + note.
- Neutral mint for a positive balance, danger tint + red amount for negative, muted soft surface when no salary.
- The only place on the dashboard that mixes all three record types.

### Income card (`.income-card`)
- Deep green gradient, white text, month stepper in translucent circular buttons.
- Large amount, optional italic note, status line, 3-cell split (Expenses / Savings / Remaining), then actions.
- “Not configured” is rendered smaller and muted rather than as ₹0.

### Savings components
- `.segmented`: two-tab glass/segmented control with a white active pill.
- `.savings-hero`: label, large forest amount, meta, optional growth chip, actions.
- `.savings-month`: month total + entry list.
- `.month-row`: month label, entry count, total, chevron; `aria-pressed` marks the focused month.
- `.savings-growth`: trend icon, signed delta, comparison text; green up, danger down.

### Entries (`.entry`)
- 38 px rounded avatar, title, meta, amount, more-actions button.
- Expense avatars use deterministic tints; salary uses a mint rupee icon; savings uses a blue-tinted jar icon.
- Savings amounts are prefixed `+` and shown in forest green.

### Forms
- `.money-input` with ₹ prefix and 30 px amount.
- `.month-select` with native month + year `<select>`s (iOS-safe).
- Textarea for notes; optional label suffix.
- Inline `.field__error`, sheet `.form-error`, `aria-invalid`, focus the first invalid control.
- Primary button full width; “Saving…” with `aria-busy` prevents double submission.

## Page hierarchy

1. **Dashboard** — hero (month spending) → monthly overview + shortcuts → expense analytics (glance, recent, week) → install tip. No salary/savings data-entry forms.
2. **Expenses** — title → all-time panel → search → grouped ledger → data management → privacy note.
3. **Salary** — title → month income card (the whole month’s salary story) → history → explainer.
4. **Savings** — title → segmented tabs → this-month hero + entries, or total hero + growth + month navigator + all months → explainer.

Rules: one primary action per page; no page repeats another page’s main job; context (month label) is stated once, not repeated in every row.

## Mobile rules (iPhone)

- `viewport-fit=cover`; every fixed element respects `env(safe-area-inset-*)`.
- Main content has bottom padding `128px + safe-area` so the dock never hides the last row or the save button.
- Sheets are bottom-anchored on mobile and their bodies scroll with `overscroll-behavior: contain`.
- Minimum 40–44 px controls; icon buttons get an invisible 2 px hit expansion.
- No horizontal scrolling at 320 px; dock labels shrink at ≤380 px and long values wrap (`overflow-wrap: anywhere`).
- Animations: 0.16–0.38 s ease-out; all disabled under `prefers-reduced-motion`; glass becomes opaque under `prefers-reduced-transparency`.

## Accessibility

- Semantic headings and `aria-labelledby` per view.
- Dock tabs use `aria-current`; savings tabs use `role="tab"`/`tabpanel`, roving `tabindex` and arrow/Home/End keys.
- Amounts carry `aria-label`s with the full currency string.
- Errors are announced (`role="alert"` on the sheet error).
- Focus rings use `:focus-visible` with forest outline.

## Known aesthetic constraints

- Light theme only; no dark mode.
- Glass is decorative: every value must remain readable without blur.
- No icon font or component library; symbols live in the inline SVG sprite in `index.html`.
- Do not make every card translucent — that is the most common way to break this design.

---

## Addendum — 5 November 2026: salary month navigator

- The navigator lives **inside** the dark income card, between the two stepper buttons. The month + year is a real button (`.income-card__titles--button`) with a 12 px chevron-down caret at 68% opacity, a translucent hover/focus fill and a 0.985 press scale — it reads as tappable without competing with the amount.
- Touch targets: stepper buttons 34 × 34 inside the card (44 px minimum is preserved by the surrounding padding), the month button fills the available width, and the **Current month** chip is 30 px tall with 12 px side padding.
- The **Current month** chip only exists off the current month, so the card never shows a control that does nothing. It uses the same translucent white-on-green treatment as the card’s other secondary surfaces.
- Month changes animate the amount with a 10 px horizontal slide (direction follows the navigation), never the whole card, so the layout does not jump.
- The picker is a compact sheet (`.sheet--compact`, max 460 px) with the same grip, close button, header and primary button as every other sheet. Month and year are native selects side by side, matching the salary form.
- Reduced motion disables the slide; reduced transparency keeps the dock and app bar opaque as before.

## Addendum — 6 November 2026: funding source and ledger interaction

- The salary card keeps the established forest-green surface; its largest value is now **Remaining balance**, with the supporting order Salary, Savings, Expenses. A negative remaining amount stays visible and red so an overspend does not disappear.
- Expense sheets show a compact **Paid From** choice with available Salary Balance and Savings amounts. The selection is preserved during edits; changing it moves the financial effect atomically and savings never silently covers a shortfall.
- Expense history uses a small source label to make funding visible without adding another prominent amount to each row.
- Savings retains its dedicated two-tab page. The summary separates contributions, salary transfers and withdrawals; transfer and withdrawal rows use clear ledger labels so savings movements are not mistaken for expenses.
- The prior-salary transfer prompt is contextual to a real positive balance. **Not Now** leaves the amount in its original pool, and the Salary page retains a later transfer action for deferred balances.
- Screens were regenerated for the updated balance hierarchy and source selector. Check the real device keyboard/safe-area combinations manually; browser viewport coverage cannot fully reproduce iOS Safari.

## Addendum — 6 November 2026: source review, local backup status and navigation

- The source-review panel uses a quiet mint surface and a single solid action. It belongs above the expense search so the user can resolve imported rows without changing the ledger layout or mistaking migration flags for a funding source.
- Backup reminders sit inside **Your data**, use plain language about browser-local storage, and expose a 44 px minimum action area. The storage explanation remains visible even when the reminder is snoozed.
- URL-backed page navigation focuses the destination heading; the dashboard uses the main landmark because its visible h1 is screen-reader-only.
- The Salary comparison is a single muted line inside the existing income card. It compares calendar-date activity only and appears only when the previous month has data.
- Savings rows show the salary and other-income amounts when a contribution used both. The existing single-line meta truncation keeps the row compact on phones; the button’s accessible name contains the full details.
- The first-use guide is an opaque card with three direct actions. It stays below the monthly overview and disappears after salary has existed, without adding a modal tour.
