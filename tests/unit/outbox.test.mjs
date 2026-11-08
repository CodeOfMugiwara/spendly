import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DB_VERSION,
  OUTBOX_STORE,
  OUTBOX_STATUS,
  generateUUID,
  isValidUUID
} from '../../js/core.js';

import {
  DuplicateMonthError,
  FinancialLedgerRepository,
  InsufficientSavingsError,
  NoActiveSalaryError,
  NotFoundError,
  ReferencedSalaryError,
  SalaryRepository,
  ValidationError
} from '../../js/repository.js';

/**
 * High-fidelity in-memory Mock IndexedDB that supports transactions with atomic commit & rollback,
 * multiple object stores, and unique indexes.
 */
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
    this.failNextTransaction = false;
    this.failOutboxAdd = false;
  }

  transaction(storeNames, mode = 'readonly') {
    const db = this;
    const isReadwrite = mode === 'readwrite';

    // Working copies for staging transaction writes
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
        const err = tx.error || new Error('Transaction aborted');
        queueMicrotask(() => {
          if (typeof tx.onabort === 'function') tx.onabort({ target: tx });
          if (typeof tx.onerror === 'function') tx.onerror({ target: tx });
        });
      },
      objectStore(name) {
        if (!storeNames.includes(name)) {
          throw new Error(`Store not in transaction: ${name}`);
        }
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
            if (name === 'outbox' && db.failOutboxAdd) {
              const err = new Error('Injected outbox failure');
              err.name = 'ConstraintError';
              tx.error = err;
              tx.abort();
              return { onsuccess: null, onerror: null, error: err };
            }
            const key = record.id ?? record.operationId ?? record.key;
            if (storeMap.has(key)) {
              const err = new Error(`Key already exists: ${key}`);
              err.name = 'ConstraintError';
              tx.error = err;
              tx.abort();
              return { onsuccess: null, onerror: null, error: err };
            }
            if (name === 'outbox') {
              // check unique sequence
              for (const existing of storeMap.values()) {
                if (existing.sequence === record.sequence) {
                  const err = new Error(`Unique index violation on sequence: ${record.sequence}`);
                  err.name = 'ConstraintError';
                  tx.error = err;
                  tx.abort();
                  return { onsuccess: null, onerror: null, error: err };
                }
              }
            }
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

    // Commit staging on next tick if not aborted
    setTimeout(() => {
      if (isAborted || isCompleted) return;
      if (db.failNextTransaction) {
        db.failNextTransaction = false;
        tx.error = new Error('Injected transaction failure');
        tx.abort();
        return;
      }
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

const TEST_USER_ID = '00000000-0000-4000-8000-000000000001';

/* -------------------------------------------------------------------------- */
/* 1. IndexedDB Schema & UUID Foundation                                      */
/* -------------------------------------------------------------------------- */

test('DB_VERSION is upgraded to 7 and outbox constants are correctly defined', () => {
  assert.equal(DB_VERSION, 7);
  assert.equal(OUTBOX_STORE, 'outbox');
  assert.deepEqual(OUTBOX_STATUS, {
    PENDING: 'pending',
    ACKNOWLEDGED: 'acknowledged',
    BLOCKED: 'blocked'
  });
});

test('generateUUID produces valid RFC 4122 v4 UUIDs recognized by isValidUUID', () => {
  for (let i = 0; i < 20; i++) {
    const uuid = generateUUID();
    assert.equal(isValidUUID(uuid), true, `UUID should be valid: ${uuid}`);
    assert.equal(uuid.length, 36);
    assert.equal(uuid[14], '4', 'version character must be 4');
    assert.match(uuid[19], /[89ab]/i, 'variant character must be 8, 9, a, or b');
  }

  assert.equal(isValidUUID('invalid-uuid'), false);
  assert.equal(isValidUUID(null), false);
  assert.equal(isValidUUID(12345), false);
  assert.equal(isValidUUID(''), false);
  assert.equal(isValidUUID('12345678-1234-4234-8234-123456789012'), true);
});

/* -------------------------------------------------------------------------- */
/* 2. Preservation of Existing Records on Upgrade                             */
/* -------------------------------------------------------------------------- */

test('existing financial records remain intact and are not automatically converted to outbox operations', async () => {
  const db = new MockIndexedDB(`spendly_user_${TEST_USER_ID}`);
  // Seed legacy data before repo connects
  const legacySalary = { id: 'sal-1', monthKey: '2026-10', amount: 50000, amountPaise: 5000000, createdAt: '2026-10-01T00:00:00.000Z' };
  const legacyExpense = { id: 'exp-1', amount: 1500, amountPaise: 150000, date: '2026-10-05', description: 'Groceries', paymentSource: 'salary', salaryRecordId: 'sal-1' };
  db.stores.get('salaries').set('sal-1', legacySalary);
  db.stores.get('expenses').set('exp-1', legacyExpense);

  const repo = new FinancialLedgerRepository(db, { ownerUserId: TEST_USER_ID });
  const pending = await repo.listPendingOperations();
  assert.equal(pending.length, 0, 'historical data must not automatically produce outbox operations');

  // Verify records are untouched
  assert.equal(db.stores.get('salaries').size, 1);
  assert.equal(db.stores.get('expenses').size, 1);
  assert.deepEqual(db.stores.get('salaries').get('sal-1'), legacySalary);
});

/* -------------------------------------------------------------------------- */
/* 3. Salary Mutation & Outbox Atomicity                                      */
/* -------------------------------------------------------------------------- */

test('createSalary commits salary record and outbox operation atomically with monotonic sequence', async () => {
  const db = new MockIndexedDB(`spendly_user_${TEST_USER_ID}`);
  const repo = new FinancialLedgerRepository(db, { ownerUserId: TEST_USER_ID });

  const salary = await repo.createSalary({ monthKey: '2026-11', amount: '60000', notes: 'November paycheck' });
  assert.ok(salary.id);

  const pending = await repo.listPendingOperations();
  assert.equal(pending.length, 1);

  const op = pending[0];
  assert.equal(isValidUUID(op.operationId), true);
  assert.equal(op.ownerUserId, TEST_USER_ID);
  assert.equal(op.operationType, 'salary:create');
  assert.equal(op.entityType, 'salary');
  assert.equal(op.entityId, salary.id);
  assert.equal(op.sequence, 1);
  assert.equal(op.status, 'pending');
  assert.equal(op.attemptCount, 0);
  assert.equal(op.lastAttemptAt, null);
  assert.equal(op.lastError, null);
  assert.equal(op.schemaVersion, 1);
  assert.deepEqual(op.payload.salary, salary);

  // Second salary increments sequence monotonically
  const salary2 = await repo.createSalary({ monthKey: '2026-12', amount: '65000', notes: 'December bonus' });
  const allOps = await repo.listAllOperations();
  assert.equal(allOps.length, 2);
  assert.equal(allOps[1].sequence, 2);
  assert.equal(allOps[1].operationType, 'salary:create');
  assert.equal(allOps[1].entityId, salary2.id);
});

test('updateSalary commits edit and outbox operation atomically', async () => {
  const db = new MockIndexedDB(`spendly_user_${TEST_USER_ID}`);
  const repo = new FinancialLedgerRepository(db, { ownerUserId: TEST_USER_ID });

  const salary = await repo.createSalary({ monthKey: '2026-11', amount: '60000', notes: 'November' });
  const updated = await repo.updateSalary(salary.id, { monthKey: '2026-11', amount: '62000', notes: 'November revised' });

  assert.equal(updated.amount, 62000);
  const pending = await repo.listPendingOperations();
  assert.equal(pending.length, 2);

  const updateOp = pending[1];
  assert.equal(updateOp.operationType, 'salary:update');
  assert.equal(updateOp.sequence, 2);
  assert.equal(updateOp.payload.salary.amount, 62000);
  assert.equal(updateOp.payload.previousSalary.amount, 60000);
});

test('deleteSalaryIfUnused and restoreSalary record outbox operations atomically', async () => {
  const db = new MockIndexedDB(`spendly_user_${TEST_USER_ID}`);
  const repo = new FinancialLedgerRepository(db, { ownerUserId: TEST_USER_ID });

  const salary = await repo.createSalary({ monthKey: '2026-11', amount: '60000' });
  const deleted = await repo.deleteSalaryIfUnused(salary.id);
  assert.equal(deleted.id, salary.id);
  assert.equal(db.stores.get('salaries').has(salary.id), false);

  const restored = await repo.restoreSalary(salary);
  assert.equal(restored.id, salary.id);
  assert.equal(db.stores.get('salaries').has(salary.id), true);

  const pending = await repo.listPendingOperations();
  assert.equal(pending.length, 3);
  assert.equal(pending[1].operationType, 'salary:delete');
  assert.equal(pending[2].operationType, 'salary:restore');
});

test('SalaryRepository delegates to ledgerRepo when wired in options', async () => {
  const db = new MockIndexedDB(`spendly_user_${TEST_USER_ID}`);
  const ledgerRepo = new FinancialLedgerRepository(db, { ownerUserId: TEST_USER_ID });
  const salaryRepo = new SalaryRepository({ getAll: () => [] }, { ledgerRepo });

  const salary = await salaryRepo.create({ monthKey: '2026-11', amount: '50000' });
  assert.ok(salary.id);

  const pending = await ledgerRepo.listPendingOperations();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].operationType, 'salary:create');
  assert.equal(pending[0].entityId, salary.id);
});

/* -------------------------------------------------------------------------- */
/* 4. Expense Operations & Composite Mutations                                */
/* -------------------------------------------------------------------------- */

test('createExpense from salary creates one atomic outbox operation', async () => {
  const db = new MockIndexedDB(`spendly_user_${TEST_USER_ID}`);
  const repo = new FinancialLedgerRepository(db, { ownerUserId: TEST_USER_ID });
  const salary = await repo.createSalary({ monthKey: '2026-11', amount: '50000' });

  const expense = await repo.createExpense({ amount: '1200', description: 'Groceries', date: '2026-11-05' });
  assert.equal(expense.paymentSource, 'salary');
  assert.equal(expense.salaryRecordId, salary.id);

  const pending = await repo.listPendingOperations();
  assert.equal(pending.length, 2); // 1 salary + 1 expense
  const expOp = pending[1];
  assert.equal(expOp.operationType, 'expense:create');
  assert.equal(expOp.entityType, 'expense');
  assert.equal(expOp.entityId, expense.id);
  assert.equal(expOp.payload.linkedWithdrawal, null);
});

test('createExpense funded by savings produces a single composite outbox operation', async () => {
  const db = new MockIndexedDB(`spendly_user_${TEST_USER_ID}`);
  const repo = new FinancialLedgerRepository(db, { ownerUserId: TEST_USER_ID });
  await repo.createSalary({ monthKey: '2026-11', amount: '50000' });
  await repo.createContribution({ amount: '10000', description: 'Savings fund', date: '2026-11-02' });

  // Now create an expense funded by savings
  const expense = await repo.createExpense({
    amount: '4000',
    description: 'New bicycle',
    date: '2026-11-06',
    paymentSource: 'savings'
  });

  // Verify that savings contains the withdrawal
  const savingsRecords = [...db.stores.get('savings').values()];
  const withdrawal = savingsRecords.find(r => r.type === 'withdrawal' && r.expenseId === expense.id);
  assert.ok(withdrawal, 'savings withdrawal must exist');
  assert.equal(withdrawal.amount, 4000);

  // Crucial requirement: only ONE outbox operation for the composite action!
  const pending = await repo.listPendingOperations();
  // 1 salary:create + 1 savings:contribution + 1 expense:create = 3 operations total
  assert.equal(pending.length, 3);

  const expOp = pending[2];
  assert.equal(expOp.operationType, 'expense:create');
  assert.equal(expOp.entityId, expense.id);
  assert.ok(expOp.payload.linkedWithdrawal, 'linked withdrawal must be embedded in payload');
  assert.equal(expOp.payload.linkedWithdrawal.id, withdrawal.id);
  assert.equal(expOp.payload.linkedWithdrawal.amount, 4000);

  // Verify NO separate savings:withdrawal operation was enqueued
  const withdrawalOps = pending.filter(op => op.operationType.includes('withdrawal'));
  assert.equal(withdrawalOps.length, 0, 'no separate withdrawal outbox operation should exist');
});

test('updateExpense, removeExpense, and restoreExpense maintain atomic outbox entries', async () => {
  const db = new MockIndexedDB(`spendly_user_${TEST_USER_ID}`);
  const repo = new FinancialLedgerRepository(db, { ownerUserId: TEST_USER_ID });
  await repo.createSalary({ monthKey: '2026-11', amount: '50000' });
  const expense = await repo.createExpense({ amount: '500', description: 'Snacks', date: '2026-11-04' });

  const updated = await repo.updateExpense(expense.id, { amount: '750', description: 'Snacks and drinks', date: '2026-11-04' });
  assert.equal(updated.amount, 750);

  await repo.removeExpense(expense.id);
  assert.equal(db.stores.get('expenses').has(expense.id), false);

  await repo.restoreExpense(expense);
  assert.equal(db.stores.get('expenses').has(expense.id), true);

  const pending = await repo.listPendingOperations();
  // 1 salary:create + 1 expense:create + 1 expense:update + 1 expense:delete + 1 expense:restore = 5
  assert.equal(pending.length, 5);
  assert.equal(pending[2].operationType, 'expense:update');
  assert.equal(pending[3].operationType, 'expense:delete');
  assert.equal(pending[4].operationType, 'expense:restore');
});

/* -------------------------------------------------------------------------- */
/* 5. Savings, Extra Income & Transfers                                       */
/* -------------------------------------------------------------------------- */

test('savings contributions and external contributions create proper outbox operations', async () => {
  const db = new MockIndexedDB(`spendly_user_${TEST_USER_ID}`);
  const repo = new FinancialLedgerRepository(db, { ownerUserId: TEST_USER_ID });
  await repo.createSalary({ monthKey: '2026-11', amount: '50000' });

  const contrib = await repo.createContribution({ amount: '5000', description: 'Salary savings', date: '2026-11-02' });
  const external = await repo.createExternalContribution({ amount: '2000', description: 'Gift from aunt', date: '2026-11-03', sourceType: 'gift' });

  const pending = await repo.listPendingOperations();
  assert.equal(pending[1].operationType, 'savings:contribution');
  assert.equal(pending[1].entityId, contrib.id);
  assert.equal(pending[2].operationType, 'savings:external_contribution');
  assert.equal(pending[2].entityId, external.id);
});

test('extra income creation, edit, reversal and deletion write outbox entries', async () => {
  const db = new MockIndexedDB(`spendly_user_${TEST_USER_ID}`);
  const repo = new FinancialLedgerRepository(db, { ownerUserId: TEST_USER_ID });
  const salary = await repo.createSalary({ monthKey: '2026-11', amount: '50000' });

  const income = await repo.createExtraIncome({
    amount: '8000',
    description: 'Freelance gig',
    date: '2026-11-01',
    salaryRecordId: salary.id,
    source: 'freelancing'
  });

  const updated = await repo.updateExtraIncome(income.id, {
    amount: '9000',
    description: 'Freelance gig bonus',
    date: '2026-11-01',
    salaryRecordId: salary.id,
    source: 'freelancing'
  });
  assert.equal(updated.amount, 9000);

  const reversed = await repo.reverseExtraIncome(income.id);
  assert.ok(reversed.reversedAt);

  const pending = await repo.listPendingOperations();
  // 1 salary + 1 extra_income:create + 1 extra_income:update + 1 extra_income:reverse
  assert.equal(pending.length, 4);
  assert.equal(pending[1].operationType, 'extra_income:create');
  assert.equal(pending[2].operationType, 'extra_income:update');
  assert.equal(pending[3].operationType, 'extra_income:reverse');
  assert.equal(pending[3].payload.reversedRecord.id, income.id);
});

test('transferSalaryBalance creates savings:transfer_balance outbox operation', async () => {
  const db = new MockIndexedDB(`spendly_user_${TEST_USER_ID}`);
  const repo = new FinancialLedgerRepository(db, { ownerUserId: TEST_USER_ID });
  const salary = await repo.createSalary({ monthKey: '2026-11', amount: '50000' });

  const transfer = await repo.transferSalaryBalance(salary.id);
  assert.equal(transfer.type, 'salary_balance_transfer');
  assert.equal(transfer.amount, 50000);

  const pending = await repo.listPendingOperations();
  assert.equal(pending.length, 2);
  const transOp = pending[1];
  assert.equal(transOp.operationType, 'savings:transfer_balance');
  assert.equal(transOp.entityType, 'saving');
  assert.equal(transOp.entityId, transfer.id);
  assert.equal(transOp.payload.sourceSalaryId, salary.id);
});

test('reverseSaving marks reversal and records outbox operation atomically', async () => {
  const db = new MockIndexedDB(`spendly_user_${TEST_USER_ID}`);
  const repo = new FinancialLedgerRepository(db, { ownerUserId: TEST_USER_ID });
  await repo.createSalary({ monthKey: '2026-11', amount: '50000' });
  const contrib = await repo.createContribution({ amount: '5000', description: 'Emergency', date: '2026-11-02' });

  const reversed = await repo.reverseSaving(contrib.id);
  assert.ok(reversed.reversedAt);
  assert.ok(reversed.reversalId);

  const pending = await repo.listPendingOperations();
  assert.equal(pending.length, 3);
  assert.equal(pending[2].operationType, 'savings:reverse');
  assert.equal(pending[2].entityId, contrib.id);
  assert.equal(pending[2].payload.reversalId, reversed.reversalId);
});

/* -------------------------------------------------------------------------- */
/* 6. Failure Injection & Rollback Proof                                      */
/* -------------------------------------------------------------------------- */

test('failure-injection: if outbox write fails, domain changes roll back completely', async () => {
  const db = new MockIndexedDB(`spendly_user_${TEST_USER_ID}`);
  const repo = new FinancialLedgerRepository(db, { ownerUserId: TEST_USER_ID });
  await repo.createSalary({ monthKey: '2026-11', amount: '50000' });

  // Inject failure into outbox store writes
  db.failOutboxAdd = true;

  await assert.rejects(
    () => repo.createExpense({ amount: '2500', description: 'Should fail', date: '2026-11-05' }),
    /outbox failure|failed/i
  );

  // Verify that NO expense was written to IndexedDB!
  const expenses = [...db.stores.get('expenses').values()];
  assert.equal(expenses.length, 0, 'financial record must not exist when outbox write fails');

  // Verify outbox has no orphaned operations
  const outboxOps = [...db.stores.get('outbox').values()];
  assert.equal(outboxOps.length, 1, 'only initial salary op should exist');
});

test('failure-injection: invalid UUID rejection aborts transaction without modifying records', async () => {
  const db = new MockIndexedDB(`spendly_user_${TEST_USER_ID}`);
  // Force makeOperationId to return an invalid non-UUID string
  const repo = new FinancialLedgerRepository(db, {
    ownerUserId: TEST_USER_ID,
    makeOperationId: () => 'not-a-valid-uuid'
  });

  await assert.rejects(
    () => repo.createSalary({ monthKey: '2026-11', amount: '50000' }),
    /Invalid UUID for outbox operation/
  );

  // Verify salaries store remains empty!
  assert.equal(db.stores.get('salaries').size, 0);
  assert.equal(db.stores.get('outbox').size, 0);
});

/* -------------------------------------------------------------------------- */
/* 7. Account Isolation & Legacy Database Behavior                            */
/* -------------------------------------------------------------------------- */

test('account switching isolation: User A operations are isolated from User B', async () => {
  const userA = '11111111-1111-4000-8000-111111111111';
  const userB = '22222222-2222-4000-8000-222222222222';

  const dbA = new MockIndexedDB(`spendly_user_${userA}`);
  const dbB = new MockIndexedDB(`spendly_user_${userB}`);

  const repoA = new FinancialLedgerRepository(dbA, { ownerUserId: userA });
  const repoB = new FinancialLedgerRepository(dbB, { ownerUserId: userB });

  await repoA.createSalary({ monthKey: '2026-11', amount: '40000' });
  await repoB.createSalary({ monthKey: '2026-11', amount: '80000' });

  const opsA = await repoA.listAllOperations();
  const opsB = await repoB.listAllOperations();

  assert.equal(opsA.length, 1);
  assert.equal(opsA[0].ownerUserId, userA);
  assert.equal(opsA[0].payload.salary.amount, 40000);

  assert.equal(opsB.length, 1);
  assert.equal(opsB[0].ownerUserId, userB);
  assert.equal(opsB[0].payload.salary.amount, 80000);
});

test('ownership mismatch rejection: passing mismatched user ID to named DB throws', () => {
  const db = new MockIndexedDB('spendly_user_user-123');
  assert.throws(
    () => new FinancialLedgerRepository(db, { ownerUserId: 'user-456' }),
    /Owner user ID mismatch/
  );
});

test('legacy unowned database does not enqueue outbox operations', async () => {
  const db = new MockIndexedDB('spendly');
  const repo = new FinancialLedgerRepository(db, { ownerUserId: null });

  const salary = await repo.createSalary({ monthKey: '2026-11', amount: '50000' });
  assert.ok(salary.id);

  const pending = await repo.listPendingOperations();
  assert.equal(pending.length, 0, 'legacy database without ownerUserId must not write outbox entries');
});

/* -------------------------------------------------------------------------- */
/* 8. Outbox Acknowledgement & Retry Metadata                                 */
/* -------------------------------------------------------------------------- */

test('acknowledgeOperation idempotently marks an operation as acknowledged', async () => {
  const db = new MockIndexedDB(`spendly_user_${TEST_USER_ID}`);
  const repo = new FinancialLedgerRepository(db, { ownerUserId: TEST_USER_ID });
  const salary = await repo.createSalary({ monthKey: '2026-11', amount: '50000' });

  let pending = await repo.listPendingOperations();
  assert.equal(pending.length, 1);
  const opId = pending[0].operationId;

  // Acknowledge the operation
  const acked = await repo.acknowledgeOperation(opId, { remoteId: 'remote-sal-101' });
  assert.equal(acked.status, 'acknowledged');
  assert.ok(acked.acknowledgedAt);
  assert.equal(acked.remoteId, 'remote-sal-101');

  // Verify it is no longer pending
  assert.equal(await repo.countPendingOperations(), 0);

  // Historical record is NOT immediately deleted
  const all = await repo.listAllOperations();
  assert.equal(all.length, 1);
  assert.equal(all[0].status, 'acknowledged');

  // Idempotent second call does not throw or change state
  const ackedAgain = await repo.acknowledgeOperation(opId);
  assert.equal(ackedAgain.status, 'acknowledged');
});

test('recordOperationAttempt updates retry count and error diagnostics', async () => {
  const db = new MockIndexedDB(`spendly_user_${TEST_USER_ID}`);
  const repo = new FinancialLedgerRepository(db, { ownerUserId: TEST_USER_ID });
  await repo.createSalary({ monthKey: '2026-11', amount: '50000' });

  const [op] = await repo.listPendingOperations();
  assert.equal(op.attemptCount, 0);

  await repo.recordOperationAttempt(op.operationId, new Error('Network timeout'));
  let updated = await repo.getOperation(op.operationId);
  assert.equal(updated.attemptCount, 1);
  assert.match(updated.lastError, /Network timeout/);
  assert.ok(updated.lastAttemptAt);

  // Second attempt with status change to blocked
  await repo.recordOperationAttempt(op.operationId, 'Invalid remote constraint', { status: 'blocked' });
  updated = await repo.getOperation(op.operationId);
  assert.equal(updated.attemptCount, 2);
  assert.equal(updated.status, 'blocked');
  assert.equal(updated.lastError, 'Invalid remote constraint');
});

test('sync metadata getters and setters operate reliably on meta store', async () => {
  const db = new MockIndexedDB(`spendly_user_${TEST_USER_ID}`);
  const repo = new FinancialLedgerRepository(db, { ownerUserId: TEST_USER_ID });

  await repo.setSyncMetadata({
    lastSyncAt: '2026-11-08T18:00:00.000Z',
    remoteCursor: 'cursor-abc-123',
    syncStatus: 'idle'
  });

  const meta = await repo.getSyncMetadata();
  assert.equal(meta.lastSyncAt, '2026-11-08T18:00:00.000Z');
  assert.equal(meta.remoteCursor, 'cursor-abc-123');
  assert.equal(meta.syncStatus, 'idle');
});

/* -------------------------------------------------------------------------- */
/* 9. Reload Persistence                                                      */
/* -------------------------------------------------------------------------- */

test('reload persistence: newly mounted repository against same DB preserves operations', async () => {
  const db = new MockIndexedDB(`spendly_user_${TEST_USER_ID}`);
  const session1 = new FinancialLedgerRepository(db, { ownerUserId: TEST_USER_ID });
  await session1.createSalary({ monthKey: '2026-11', amount: '50000' });
  await session1.createExpense({ amount: '1500', description: 'Dinner', date: '2026-11-03' });

  // Simulate app reload: create a new repository instance pointing to the same DB
  const session2 = new FinancialLedgerRepository(db, { ownerUserId: TEST_USER_ID });
  const pending = await session2.listPendingOperations();

  assert.equal(pending.length, 2);
  assert.equal(pending[0].sequence, 1);
  assert.equal(pending[1].sequence, 2);

  // Adding a third mutation continues sequence properly from 3
  await session2.createExpense({ amount: '600', description: 'Coffee', date: '2026-11-04' });
  const allOps = await session2.listAllOperations();
  assert.equal(allOps.length, 3);
  assert.equal(allOps[2].sequence, 3);
});
