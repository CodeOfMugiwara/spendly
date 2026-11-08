# Spendly — Autonomous Agent & Engineering Guidelines

> **MANDATORY INSTRUCTION FOR ALL AI AGENTS & DEVELOPERS**
> Every new chat, session, subagent, or engineer working on this repository **MUST** read this file and the referenced documents before planning, modifying, or executing tasks.

---

## 1. Project Overview & Guiding Philosophy

Spendly is a private, offline-first personal finance application (PWA) built with Vanilla JavaScript, Vite, IndexedDB, and Supabase PostgreSQL.
- **Local-First Core**: All reads and mutations happen immediately in IndexedDB. The app works 100% offline without network round-trips.
- **Strict Account Partitioning**: Authenticated users have dedicated databases (`spendly_user_${userId}`). Unowned legacy data resides in `spendly` and is never merged or leaked.
- **Atomic Operation Outbox**: Every local mutation commits its financial state and its synchronization operation (`outbox` store) in the **exact same IndexedDB transaction**.
- **No Silent ID Regeneration**: Existing local IDs must never be silently rewritten.
- **Integer Paise Arithmetic**: All financial math uses integer paise (`toPaise`, `fromPaise`) to prevent floating-point rounding drift.

---

## 2. Mandatory Reading Order

Before starting any task, read these documents in order:
1. **`AGENTS.md`** (this file) — Core rules, standards, and incident history.
2. **`memory.md`** — Project memory log (append/update only). Chronological versions, decisions, and issues encountered.
3. **`context/architecture.md`** — System layers, IndexedDB storage, PWA service worker, and Supabase integration.
4. **`context/data-model.md`** — Local IndexedDB schema (v7) and remote PostgreSQL schema.
5. **`context/incidents/`** — Past incidents, exact root causes, and prevention strategies.
6. **`context/phases/`** — Technical design, rationale, and verification records for each implementation phase.

---

## 3. Strict Development Rules

### Rule 1: Never Deploy or Push Without Explicit User Approval
- **NEVER** run `git push`.
- **NEVER** run `netlify deploy` or trigger production builds.
- **NEVER** modify production Supabase databases. Only the development project (`spendly-dev`, ref: `qmvigcbumiumaguwmmbk`) is permissible for migrations and testing.

### Rule 2: Keep Project Memory & Context Updated
- When completing a phase, encountering an issue, fixing a regression, or making an architectural decision:
  1. Add a dedicated document in `context/phases/` or `context/incidents/`.
  2. Append a dated entry to `memory.md` explaining **why** the decision was made.
  3. Never delete, reorder, or overwrite historical entries in `memory.md`.

### Rule 3: Maintain 100% Test Pass Rates
Before committing any change:
- `npm test` — Must pass all unit tests (Node test runner in `tests/unit/*.test.mjs`).
- `npm run build` — Must build Vite bundle with zero errors.
- `npm run test:e2e` — Must pass all browser scenarios via Playwright Chromium.
- `git diff --check` — Must report 0 whitespace or formatting anomalies.

### Rule 4: Respect Database Upgrade Safety
- Schema upgrades in IndexedDB must be strictly additive, idempotent, and transactional.
- In `openExpenseDB`, always wrap store creation in an idempotent check (`if (!contains)`) and call `request.transaction.abort()` on error to prevent half-migrated states.
- Never drop stores or destroy existing user records.

---

## 4. Key Architectural Patterns

### 1. Atomic Outbox Mutation Pattern
In `FinancialLedgerRepository`, all mutation methods must include the `outbox` and `meta` stores in their transaction when an authenticated user is active:
```javascript
this.#transaction(this.#storesWithOutbox(['expenses', 'salaries', 'savings', 'extraIncome']), 'readwrite', ({ collections, snapshots }) => {
  // 1. Perform financial domain updates in IndexedDB collections
  // 2. Enqueue outbox operation in the same transaction
  this.#enqueueOperation(collections, snapshots, {
    operationType: 'expense:create',
    entityType: 'expense',
    entityId: record.id,
    payload: { expense: record, linkedWithdrawal: ... },
    createdAt: timestamp
  });
});
```

### 2. Composite Operation Integrity
When an action updates multiple related tables (e.g. creating an expense paid from Savings, which creates both an `expense` and a savings `withdrawal`), generate **one single logical outbox operation** (`expense:create` with `linkedWithdrawal` embedded in payload). Never create two unlinked operations that could fail or synchronize independently.

### 3. Vite Development Server CSS Handling
Vite dev server returns JavaScript HMR modules for `.css` unless `Accept: text/css` is explicitly passed. Never bypass `devCssMiddleware` in `vite.config.js` or remove MIME checks in `sw.js`. See `context/incidents/incident-ui-ux-vite-mime-poisoning.md`.
