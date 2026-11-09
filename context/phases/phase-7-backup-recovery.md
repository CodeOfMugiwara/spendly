# Phase 7 Architecture: Data Recovery, Backup Validation & Sync Integration

**Date:** 9 November 2026  
**Status:** Complete  
**Application Version:** `3.7.0`  
**Schema Version:** `7`  
**Target Environment:** Local-First IndexedDB (`spendly_user_${userId}`) & Supabase PostgreSQL (`spendly-dev`, ref: `qmvigcbumiumaguwmmbk`)  

---

## 1. Objectives & Architectural Scope

The Phase 7 Data Recovery & Backup System provides a reliable, secure, and user-friendly disaster recovery mechanism for Spendly. It safeguards financial ledgers against:
- Browser storage eviction, accidental cache clearing, or device loss.
- In-flight network synchronization interruptions or outbox corruption.
- Cross-account contamination during backup imports.
- Structural corruption, negative balances, or invalid foreign key relationships.

The backup system works directly with the existing Phase 5 Outbox and Phase 6 Synchronization Engine without creating parallel synchronization pathways.

---

## 2. Backup Format Specification (Schema v7)

The export file (`spendly-backup-YYYY-MM-DD.json`) is a versioned JSON payload structured as follows:

```json
{
  "app": "Spendly",
  "schemaVersion": 7,
  "version": 7,
  "appVersion": "3.7.0",
  "exportedAt": "2026-11-09T22:30:00.000Z",
  "account": {
    "userId": "00000000-0000-4000-8000-000000000001",
    "email": "alex@spendly.local",
    "isAnonymous": false
  },
  "salaries": [ ... ],
  "expenses": [ ... ],
  "savings": [ ... ],
  "extraIncome": [ ... ],
  "outbox": [ ... ],
  "meta": [
    { "key": "sync:lastSyncedCursor", "value": "142" }
  ]
}
```

### Key Format Guarantees:
1. **Integer Paise Precision**: All monetary values are exported with integer paise fields (`amountPaise`, `extra_income_allocations`, etc.) to eliminate floating-point rounding drift.
2. **Account Ownership Metadata**: Backups record the exporting user's `userId` and `email` to enforce account isolation during restoration.
3. **Outbox Durability**: Pending and unacknowledged outbox operations are exported with their exact `operationId`, `sequence`, and payload to permit resuming cloud sync seamlessly after restore.
4. **Synchronization Cursor State**: The high-water mark (`sync:lastSyncedCursor`) is preserved, enabling incremental change fetching from Supabase upon recovery on a new device.
5. **No Secrets**: Authentication tokens, refresh tokens, passwords, and API keys are strictly excluded.

---

## 3. Client-Side Web Crypto Encryption

Spendly supports optional passphrase encryption using standard browser Web Crypto APIs:
- **Key Derivation**: `PBKDF2` with `SHA-256`, 100,000 iterations, and a cryptographically random 16-byte salt (`crypto.getRandomValues`).
- **Cipher**: `AES-GCM` with a 256-bit key and an unpredictable 12-byte initialization vector (IV).
- **Format**:
  ```json
  {
    "app": "Spendly",
    "encrypted": true,
    "algorithm": "AES-GCM-256",
    "kdf": "PBKDF2-SHA256-100000",
    "salt": "<base64>",
    "iv": "<base64>",
    "ciphertext": "<base64>"
  }
  ```
- **Security**: The passphrase is never stored on disk or sent over the network. Wrong passphrases fail decryption with an explicit `BackupDecryptionError`.

---

## 4. Comprehensive Backup Validation Engine

Implemented in `js/backup.js`, `validateBackup(payload, currentUser)` runs rigorous pre-import checks before any database transaction is initiated:

1. **Envelope & Versioning**:
   - Rejects payloads without `app: 'Spendly'`.
   - Rejects future unsupported schema versions (`schemaVersion > 7`).
   - Normalizes legacy backup schemas (v1 to v5) into canonical v7 objects.
2. **Account Ownership Isolation**:
   - If the backup belongs to an authenticated user (`userId_A`), restoring it while authenticated as `userId_B` throws `BackupOwnershipMismatchError`.
   - Restoring an authenticated backup into an unauthenticated guest session throws an ownership error directing the user to sign in.
   - Restoring an anonymous/guest backup into an authenticated session is permitted to support account onboarding and data claiming.
3. **Relational & Financial Ledger Integrity**:
   - **ID Uniqueness**: Duplicate record IDs within any entity collection are rejected.
   - **Salary Uniqueness**: Two salaries for the exact same `monthKey` are strictly rejected (`Duplicate salary month`).
   - **Linked Expense & Withdrawal Integrity**: Every savings-funded expense (`paymentSource: 'savings'`) must have a corresponding withdrawal in `savings` for the exact same amount. Every withdrawal must point to an existing expense.
   - **Extra Income Allocation Ceilings**: The sum of all allocated portions of an extra income record cannot exceed its total `amountPaise`.
   - **Non-Negative Savings Balance**: The derived cumulative savings balance (`contributions + external - withdrawals`) cannot be negative.
   - **Paise Validation**: All monetary values must be non-negative integers.

---

## 5. Transactional Restoration & Sync Engine Reconciliation

Restoration is performed atomically via `FinancialLedgerRepository.prototype.restoreCollections({ data, mode })`:

### A. Safety Pre-Backup
Before executing a destructive `replace` restoration, the UI automatically exports and triggers a browser download of the current local state (`spendly-before-restore-YYYY-MM-DD.json`), ensuring zero accidental data loss.

### B. Restoration Modes
1. **`replace`**:
   - Clears existing domain collections (`expenses`, `salaries`, `savings`, `extraIncome`, `outbox`).
   - Inserts all restored records.
   - Replaces the outbox with pending operations from the backup.
   - Reconciles the synchronization cursor: `sync:lastSyncedCursor = max(currentLocalCursor, backupCursor)`.
2. **`merge` (Safe Default)**:
   - Deduplicates records by ID: existing local records are preserved without silent mutation.
   - Duplicate salary months are detected and blocked.
   - Non-duplicate pending outbox operations are merged into the outbox.
   - Sets the cursor to `max(currentLocalCursor, backupCursor)` to avoid regressing change-feed downloads.

### C. Synchronization Reconciliation
- Restoring a backup containing pending operations (`status: 'pending'`) triggers the `SyncEngine`.
- Operations upload cleanly to Supabase using `apply_sync_operation(p_operation)`.
- If an operation was already acknowledged in the cloud prior to the backup, the server's idempotent SHA-256 receipt returns `status: 'skipped'`, which the client acknowledges without duplicating transactions.
- The high-water mark cursor prevents downloading historical changes already present in the restored backup.

---

## 6. Verification Records

| Test Suite | Scope | Result |
| :--- | :--- | :--- |
| **Unit Tests** (`tests/unit/*.test.mjs`) | Core, auth, repository, finance, outbox, sync, and backup validation | **131/131 passed (100%)** |
| **Playwright E2E** (`tests/e2e.mjs`) | Browser interactions, multi-account isolation, offline sync, backup export/restore | **46/46 passed (100%)** |
| **Concurrency Suite** (`supabase/tests/concurrency_test.mjs`) | Same-user lock serialization & multi-user parallelism on `spendly-dev` | **4/4 passed (100%)** |
| **Production Build** (`vite build`) | Production bundle compilation | **12 modules transformed in 530ms, 0 errors** |
| **Formatting** (`git diff --check`) | Whitespace and line-ending validation | **0 anomalies** |
