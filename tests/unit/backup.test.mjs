/**
 * Spendly — Phase 7: Backup and Data Recovery Unit Tests
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBackupPayload,
  validateBackup,
  encryptBackupPayload,
  decryptBackupPayload,
  isEncryptedBackup,
  BackupValidationError,
  BackupOwnershipMismatchError,
  BackupDecryptionError,
  BACKUP_SCHEMA_VERSION,
  BACKUP_APP_NAME
} from '../../js/backup.js';
import { FinancialLedgerRepository } from '../../js/repository.js';
import { toISODate, OUTBOX_STATUS, DB_VERSION } from '../../js/core.js';

class MockIndexedDB {
  constructor(name = 'spendly_user_00000000-0000-4000-8000-000000000001', storeNames = ['expenses', 'salaries', 'savings', 'extraIncome', 'meta', 'outbox']) {
    this.name = name;
    this.version = DB_VERSION;
    this.stores = new Map();
    for (const storeName of storeNames) {
      this.stores.set(storeName, new Map());
    }
    this.objectStoreNames = {
      contains: name => this.stores.has(name)
    };
  }

  transaction(storeNames, mode = 'readonly') {
    const db = this;
    const isReadwrite = mode === 'readwrite';
    const workingCopies = new Map();
    for (const name of storeNames) {
      if (!this.stores.has(name)) {
        throw new Error(`Store not found: ${name}`);
      }
      workingCopies.set(name, new Map(this.stores.get(name)));
    }

    let isAborted = false;
    let isCompleted = false;

    const tx = {
      mode,
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      abort() {
        if (isCompleted) return;
        isAborted = true;
        isCompleted = true;
        queueMicrotask(() => {
          if (typeof tx.onabort === 'function') tx.onabort({ target: tx });
          if (typeof tx.onerror === 'function') tx.onerror({ target: tx });
        });
      },
      objectStore(name) {
        const storeMap = isReadwrite ? workingCopies.get(name) : db.stores.get(name);

        return {
          getAll() {
            const req = { onsuccess: null, onerror: null, result: null };
            queueMicrotask(() => {
              if (isAborted) return;
              req.result = [...storeMap.values()].map(v => structuredClone(v));
              if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
            });
            return req;
          },
          get(key) {
            const req = { onsuccess: null, onerror: null, result: null };
            queueMicrotask(() => {
              if (isAborted) return;
              const val = storeMap.get(key);
              req.result = val ? structuredClone(val) : undefined;
              if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
            });
            return req;
          },
          add(record) {
            const key = record.id ?? record.operationId ?? record.key;
            storeMap.set(key, structuredClone(record));
            return { onsuccess: null, onerror: null, result: key };
          },
          put(record) {
            const key = record.id ?? record.operationId ?? record.key;
            storeMap.set(key, structuredClone(record));
            return { onsuccess: null, onerror: null, result: key };
          },
          delete(key) {
            storeMap.delete(key);
            return { onsuccess: null, onerror: null };
          },
          clear() {
            storeMap.clear();
            return { onsuccess: null, onerror: null };
          }
        };
      }
    };

    setTimeout(() => {
      if (isAborted || isCompleted) return;
      if (isReadwrite) {
        for (const [name, map] of workingCopies.entries()) {
          db.stores.set(name, map);
        }
      }
      isCompleted = true;
      if (typeof tx.oncomplete === 'function') {
        tx.oncomplete({ target: tx });
      }
    }, 1);

    return tx;
  }
}

const MOCK_USER_A = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'user.a@spendly.local'
};

const MOCK_USER_B = {
  id: '00000000-0000-4000-8000-000000000002',
  email: 'user.b@spendly.local'
};

/* -------------------------------------------------------------------------- */
/* 1. Backup Generation & Format Tests                                        */
/* -------------------------------------------------------------------------- */

test('createBackupPayload produces complete valid schema v7 with integer paise', () => {
  const payload = createBackupPayload({
    expenses: [
      { id: 'exp-1', amount: 150.50, description: 'Coffee & Snacks', date: '2026-11-05', paymentSource: 'salary' }
    ],
    salaries: [
      { id: 'sal-1', monthKey: '2026-11', amount: 75000, notes: 'November pay' }
    ],
    savings: [
      { id: 'sav-1', amount: 10000, type: 'contribution', date: '2026-11-06', monthKey: '2026-11' }
    ],
    extraIncome: [
      { id: 'inc-1', amount: 5000, source: 'bonus', date: '2026-11-04', salaryRecordId: 'sal-1' }
    ],
    outbox: [
      { operationId: 'op-1', status: OUTBOX_STATUS.PENDING, sequence: 1, operationType: 'expense:create', payload: {} },
      { operationId: 'op-2', status: OUTBOX_STATUS.ACKNOWLEDGED, sequence: 2, operationType: 'salary:create', payload: {} }
    ],
    meta: [
      { key: 'sync:lastSyncedCursor', value: '42' }
    ],
    user: MOCK_USER_A
  });

  assert.equal(payload.app, BACKUP_APP_NAME);
  assert.equal(payload.schemaVersion, BACKUP_SCHEMA_VERSION);
  assert.equal(payload.version, BACKUP_SCHEMA_VERSION);
  assert.equal(payload.appVersion, '3.7.0');
  assert.ok(payload.exportedAt);
  assert.equal(payload.account.userId, MOCK_USER_A.id);
  assert.equal(payload.account.email, MOCK_USER_A.email);
  assert.equal(payload.account.isAnonymous, false);

  assert.equal(payload.expenses[0].amountPaise, 15050);
  assert.equal(payload.salaries[0].amountPaise, 7500000);
  assert.equal(payload.savings[0].amountPaise, 1000000);
  assert.equal(payload.extraIncome[0].amountPaise, 500000);

  assert.equal(payload.outbox.length, 1);
  assert.equal(payload.outbox[0].operationId, 'op-1');

  assert.equal(payload.meta.find(m => m.key === 'sync:lastSyncedCursor')?.value, '42');
});

test('createBackupPayload handles empty account cleanly', () => {
  const payload = createBackupPayload({
    user: null
  });

  assert.equal(payload.app, BACKUP_APP_NAME);
  assert.equal(payload.schemaVersion, 7);
  assert.equal(payload.account.userId, null);
  assert.equal(payload.account.isAnonymous, true);
  assert.deepEqual(payload.expenses, []);
  assert.deepEqual(payload.salaries, []);
  assert.deepEqual(payload.savings, []);
  assert.deepEqual(payload.extraIncome, []);
  assert.deepEqual(payload.outbox, []);
});

test('createBackupPayload handles large dataset without failure', () => {
  const manyExpenses = Array.from({ length: 2000 }, (_, i) => ({
    id: `large-exp-${i}`,
    amount: (i % 100) + 1,
    description: `Expense ${i}`,
    date: '2026-11-01',
    paymentSource: 'others'
  }));

  const payload = createBackupPayload({
    expenses: manyExpenses,
    user: MOCK_USER_A
  });

  assert.equal(payload.expenses.length, 2000);
  const found = payload.expenses.find(e => e.id === 'large-exp-1999');
  assert.equal(found.amountPaise, ((1999 % 100) + 1) * 100);
});

/* -------------------------------------------------------------------------- */
/* 2. Web Crypto Optional Encryption Tests                                    */
/* -------------------------------------------------------------------------- */

test('encryptBackupPayload and decryptBackupPayload roundtrip successfully', async () => {
  const rawPayload = createBackupPayload({
    expenses: [{ id: 'secret-1', amount: 999, description: 'Secret gift', date: '2026-11-08' }],
    user: MOCK_USER_A
  });

  const passphrase = 'SuperSecretPassphrase123!';
  const encrypted = await encryptBackupPayload(rawPayload, passphrase);

  assert.equal(isEncryptedBackup(encrypted), true);
  assert.equal(encrypted.encrypted, true);
  assert.ok(encrypted.salt);
  assert.ok(encrypted.iv);
  assert.ok(encrypted.ciphertext);
  assert.equal(encrypted.expenses, undefined, 'Plaintext expenses must not be visible in encrypted payload');

  const decrypted = await decryptBackupPayload(encrypted, passphrase);
  assert.equal(decrypted.app, BACKUP_APP_NAME);
  assert.equal(decrypted.expenses.length, 1);
  assert.equal(decrypted.expenses[0].description, 'Secret gift');
});

test('decryptBackupPayload rejects wrong passphrase', async () => {
  const rawPayload = createBackupPayload({ user: MOCK_USER_A });
  const encrypted = await encryptBackupPayload(rawPayload, 'correct-passphrase');

  await assert.rejects(
    () => decryptBackupPayload(encrypted, 'wrong-passphrase'),
    BackupDecryptionError
  );
});

/* -------------------------------------------------------------------------- */
/* 3. Backup Validation Tests                                                 */
/* -------------------------------------------------------------------------- */

test('validateBackup accepts valid v7 backup', async () => {
  const valid = createBackupPayload({
    salaries: [{ id: 'sal-1', monthKey: '2026-11', amount: 50000 }],
    expenses: [{ id: 'exp-1', amount: 200, description: 'Groceries', date: '2026-11-02', paymentSource: 'salary', salaryRecordId: 'sal-1' }],
    user: MOCK_USER_A
  });

  const result = await validateBackup(valid, MOCK_USER_A);
  assert.equal(result.ok, true);
  assert.equal(result.summary.expenseCount, 1);
  assert.equal(result.summary.salaryCount, 1);
  assert.equal(result.data.expenses[0].amountPaise, 20000);
});

test('validateBackup rejects corrupted JSON string', async () => {
  await assert.rejects(
    () => validateBackup('{ "app": "Spendly", corrupt...', MOCK_USER_A),
    BackupValidationError
  );
});

test('validateBackup rejects negative amounts', async () => {
  const bad = {
    app: BACKUP_APP_NAME,
    version: 7,
    expenses: [{ id: 'bad-1', amount: -50, description: 'Negative', date: '2026-11-01' }]
  };

  await assert.rejects(
    () => validateBackup(bad, null),
    BackupValidationError
  );
});

test('validateBackup rejects duplicate record IDs within collection', async () => {
  const bad = {
    app: BACKUP_APP_NAME,
    version: 7,
    expenses: [
      { id: 'dup-id', amount: 10, description: 'First', date: '2026-11-01' },
      { id: 'dup-id', amount: 20, description: 'Second', date: '2026-11-02' }
    ]
  };

  await assert.rejects(
    () => validateBackup(bad, null),
    /Duplicate ID found in expenses/
  );
});

test('validateBackup rejects duplicate salary months', async () => {
  const bad = {
    app: BACKUP_APP_NAME,
    version: 7,
    salaries: [
      { id: 'sal-1', monthKey: '2026-11', amount: 50000 },
      { id: 'sal-2', monthKey: '2026-11', amount: 60000 }
    ]
  };

  await assert.rejects(
    () => validateBackup(bad, null),
    /Duplicate salary month found: "2026-11"/
  );
});

test('validateBackup rejects savings withdrawal without matching expense', async () => {
  const bad = {
    app: BACKUP_APP_NAME,
    version: 7,
    expenses: [
      { id: 'exp-1', amount: 500, description: 'Shoes', date: '2026-11-01', paymentSource: 'others' }
    ],
    savings: [
      { id: 'sav-1', amount: 500, type: 'withdrawal', expenseId: 'exp-1', date: '2026-11-01' }
    ]
  };

  await assert.rejects(
    () => validateBackup(bad, null),
    /is linked to an expense that is not funded by savings/
  );
});

test('validateBackup rejects withdrawal amount mismatch', async () => {
  const bad = {
    app: BACKUP_APP_NAME,
    version: 7,
    expenses: [
      { id: 'exp-1', amount: 500, description: 'Shoes', date: '2026-11-01', paymentSource: 'savings' }
    ],
    savings: [
      { id: 'sav-1', amount: 450, type: 'withdrawal', expenseId: 'exp-1', date: '2026-11-01' }
    ]
  };

  await assert.rejects(
    () => validateBackup(bad, null),
    /does not match its linked expense amount/
  );
});

test('validateBackup rejects negative derived savings balance', async () => {
  const bad = {
    app: BACKUP_APP_NAME,
    version: 7,
    expenses: [
      { id: 'exp-1', amount: 1000, description: 'Vacation ticket', date: '2026-11-01', paymentSource: 'savings' }
    ],
    savings: [
      { id: 'sav-contrib', amount: 200, type: 'contribution', date: '2026-11-01' },
      { id: 'sav-with', amount: 1000, type: 'withdrawal', expenseId: 'exp-1', date: '2026-11-01' }
    ]
  };

  await assert.rejects(
    () => validateBackup(bad, null),
    /result in a negative savings balance/
  );
});

test('validateBackup rejects unsupported future schema version', async () => {
  const future = {
    app: BACKUP_APP_NAME,
    schemaVersion: 99,
    expenses: []
  };

  await assert.rejects(
    () => validateBackup(future, null),
    /newer version of Spendly/
  );
});

/* -------------------------------------------------------------------------- */
/* 4. Account Ownership Isolation Tests                                       */
/* -------------------------------------------------------------------------- */

test('validateBackup rejects User A backup when User B is signed in', async () => {
  const backupUserA = createBackupPayload({ user: MOCK_USER_A });

  await assert.rejects(
    () => validateBackup(backupUserA, MOCK_USER_B),
    BackupOwnershipMismatchError
  );
});

test('validateBackup rejects authenticated backup when guest is signed out', async () => {
  const backupUserA = createBackupPayload({ user: MOCK_USER_A });

  await assert.rejects(
    () => validateBackup(backupUserA, null),
    BackupOwnershipMismatchError
  );
});

test('validateBackup permits anonymous backup for authenticated user', async () => {
  const anonBackup = createBackupPayload({ user: null });
  const result = await validateBackup(anonBackup, MOCK_USER_A);
  assert.equal(result.ok, true);
});

test('validateBackup permits same-user backup restoration', async () => {
  const sameUserBackup = createBackupPayload({ user: MOCK_USER_A });
  const result = await validateBackup(sameUserBackup, MOCK_USER_A);
  assert.equal(result.ok, true);
});

/* -------------------------------------------------------------------------- */
/* 5. Repository Restoration (Replace & Merge) Tests                          */
/* -------------------------------------------------------------------------- */

test('restoreCollections in replace mode cleanly populates empty repository and outbox', async () => {
  const db = new MockIndexedDB(`spendly_user_${MOCK_USER_A.id}`);
  const repo = new FinancialLedgerRepository(db, {
    ownerUserId: MOCK_USER_A.id,
    now: () => new Date('2026-11-09T10:00:00.000Z')
  });

  const backupData = {
    salaries: [{ id: 'sal-1', monthKey: '2026-11', amount: 80000, amountPaise: 8000000 }],
    expenses: [{ id: 'exp-1', amount: 300, amountPaise: 30000, description: 'Fuel', date: '2026-11-05', paymentSource: 'salary', salaryRecordId: 'sal-1' }],
    savings: [{ id: 'sav-1', amount: 5000, amountPaise: 500000, type: 'contribution', date: '2026-11-06' }],
    extraIncome: [],
    outbox: [
      { operationId: 'pending-op-1', status: OUTBOX_STATUS.PENDING, operationType: 'expense:create', sequence: 1 }
    ],
    meta: [
      { key: 'sync:lastSyncedCursor', value: '150' }
    ]
  };

  const result = await repo.restoreCollections({ data: backupData, mode: 'replace' });
  assert.equal(result.mode, 'replace');
  assert.equal(result.expenseCount, 1);
  assert.equal(result.salaryCount, 1);

  const salaries = await repo.listSalaries();
  const expenses = await repo.listExpenses();
  const cursor = await repo.getLastSyncedCursor();
  const pendingOps = await repo.listPendingOperations();

  assert.equal(salaries.length, 1);
  assert.equal(salaries[0].amountPaise, 8000000);
  assert.equal(expenses.length, 1);
  assert.equal(cursor, 150);
  assert.equal(pendingOps.length, 1);
  assert.equal(pendingOps[0].operationId, 'pending-op-1');
});

test('restoreCollections in replace mode sets cursor to max(local, backup)', async () => {
  const db = new MockIndexedDB(`spendly_user_${MOCK_USER_A.id}`);
  const repo = new FinancialLedgerRepository(db, {
    ownerUserId: MOCK_USER_A.id,
    now: () => new Date('2026-11-09T10:00:00.000Z')
  });

  // Local is already at cursor 200
  await repo.setSyncMetadata({ lastSyncedCursor: 200 });

  // Backup is at older cursor 120
  const backupData = {
    salaries: [],
    expenses: [],
    savings: [],
    extraIncome: [],
    outbox: [],
    meta: [{ key: 'sync:lastSyncedCursor', value: '120' }]
  };

  await repo.restoreCollections({ data: backupData, mode: 'replace' });
  const cursor = await repo.getLastSyncedCursor();

  // Must not regress cursor!
  assert.equal(cursor, 200);
});

test('restoreCollections in merge mode safely merges new records without deleting existing', async () => {
  const db = new MockIndexedDB(`spendly_user_${MOCK_USER_A.id}`);
  const repo = new FinancialLedgerRepository(db, {
    ownerUserId: MOCK_USER_A.id,
    now: () => new Date('2026-11-09T10:00:00.000Z')
  });

  // Create existing local data: Nov 2026 salary and expense
  await repo.createSalary({ monthKey: '2026-11', amount: '50000' });
  await repo.createExpense({ amount: '100', description: 'Local chai', date: '2026-11-02' });

  // Backup contains: Dec 2026 salary, and another expense
  const backupData = {
    salaries: [
      { id: 'sal-dec', monthKey: '2026-12', amount: 60000, amountPaise: 6000000 },
      // Duplicate month should be skipped to prevent collision
      { id: 'sal-nov-conflict', monthKey: '2026-11', amount: 99999, amountPaise: 9999900 }
    ],
    expenses: [
      { id: 'exp-backup', amount: 250, amountPaise: 25000, description: 'Backup lunch', date: '2026-11-03', paymentSource: 'others' }
    ],
    savings: [],
    extraIncome: [],
    outbox: [],
    meta: []
  };

  const result = await repo.restoreCollections({ data: backupData, mode: 'merge' });
  assert.equal(result.mode, 'merge');
  assert.equal(result.addedExpenses, 1);
  assert.equal(result.addedSalaries, 1);

  const salaries = await repo.listSalaries();
  const expenses = await repo.listExpenses();

  // Both Nov and Dec exist; Nov kept local 50000 amount
  assert.equal(salaries.length, 2);
  const nov = salaries.find(s => s.monthKey === '2026-11');
  assert.equal(nov.amountPaise, 5000000);

  // Both local chai and backup lunch exist
  assert.equal(expenses.length, 2);
  assert.ok(expenses.some(e => e.description === 'Local chai'));
  assert.ok(expenses.some(e => e.description === 'Backup lunch'));
});
