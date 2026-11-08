import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DB_VERSION,
  OUTBOX_STATUS,
  SYNC_STATUS,
  generateUUID,
  isValidUUID
} from '../../js/core.js';

import {
  FinancialLedgerRepository
} from '../../js/repository.js';

import {
  SyncEngine,
  isAuthError,
  isPermanentError,
  computeBackoffDelay,
  AuthRequiredSyncError,
  PermanentSyncError,
  RetryableSyncError
} from '../../js/sync.js';

/**
 * High-fidelity in-memory Mock IndexedDB supporting atomic multi-store transactions,
 * rollbacks, and indexes.
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
  }

  transaction(storeNames, mode = 'readonly') {
    const db = this;
    const isReadwrite = mode === 'readwrite';
    const workingCopies = new Map();

    for (const name of storeNames) {
      if (!this.stores.has(name)) throw new Error(`Store not found: ${name}`);
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
        if (!storeNames.includes(name)) throw new Error(`Store not in transaction: ${name}`);
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
            if (storeMap.has(key)) {
              const err = new Error(`Key already exists: ${key}`);
              err.name = 'ConstraintError';
              tx.error = err;
              tx.abort();
              return { onsuccess: null, onerror: null, error: err };
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

    setTimeout(() => {
      if (isAborted || isCompleted) return;
      if (db.failNextTransaction) {
        db.failNextTransaction = false;
        tx.error = new Error('Simulated transaction failure');
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

/**
 * Mock Supabase client providing apply_sync_operation and get_sync_changes RPCs.
 */
class MockSupabaseClient {
  constructor() {
    this.appliedOperations = [];
    this.changes = [];
    this.nextCursor = 0;
    this.failRpc = null;
  }

  async rpc(name, params) {
    if (this.failRpc) {
      const err = typeof this.failRpc === 'function' ? this.failRpc(name, params) : this.failRpc;
      if (err) return { data: null, error: err };
    }

    if (name === 'apply_sync_operation') {
      const op = params.p_operation;
      this.appliedOperations.push(structuredClone(op));
      this.nextCursor++;
      return {
        data: {
          ok: true,
          status: 'applied',
          operationId: op.operationId,
          cursor: this.nextCursor,
          serverTime: new Date().toISOString()
        },
        error: null
      };
    }

    if (name === 'get_sync_changes') {
      const afterCursor = Number(params.p_after_cursor || 0);
      const limit = Number(params.p_limit || 100);
      const matching = this.changes.filter(c => c.cursor > afterCursor);
      const page = matching.slice(0, limit);
      const maxCursor = page.length > 0 ? page[page.length - 1].cursor : afterCursor;
      const hasMore = matching.length > limit;

      return {
        data: {
          changes: page,
          nextCursor: maxCursor,
          hasMore
        },
        error: null
      };
    }

    throw new Error(`Unhandled RPC in test mock: ${name}`);
  }
}

const USER_A = '00000000-0000-4000-8000-000000000001';
const USER_B = '00000000-0000-4000-8000-000000000002';

function setupRepo(userId = USER_A) {
  const db = new MockIndexedDB(`spendly_user_${userId}`);
  const repo = new FinancialLedgerRepository(db, { ownerUserId: userId });
  return { db, repo };
}

// ============================================================================
// 1. Error Classification & Backoff
// ============================================================================

test('isAuthError identifies token expiration and auth failures', () => {
  assert.equal(isAuthError({ status: 401, message: 'Unauthorized' }), true);
  assert.equal(isAuthError({ code: '42501', message: 'Authentication required' }), true);
  assert.equal(isAuthError({ message: 'JWT expired' }), true);
  assert.equal(isAuthError({ message: 'Invalid token signature' }), true);
  assert.equal(isAuthError({ message: 'Database connection failed' }), false);
  assert.equal(isAuthError(null), false);
});

test('isPermanentError distinguishes business/schema violations from transient errors', () => {
  assert.equal(isPermanentError({ code: '23514', message: 'check_violation: overdraft' }), true);
  assert.equal(isPermanentError({ code: '23505', message: 'unique_violation' }), true);
  assert.equal(isPermanentError({ code: '23503', message: 'foreign_key_violation' }), true);
  assert.equal(isPermanentError({ status: 400, message: 'Bad Request' }), true);
  assert.equal(isPermanentError({ status: 409, message: 'Conflict' }), true);

  // Transient / retryable
  assert.equal(isPermanentError({ status: 500, message: 'Internal Server Error' }), false);
  assert.equal(isPermanentError({ status: 503, message: 'Service Unavailable' }), false);
  assert.equal(isPermanentError({ message: 'Failed to fetch' }), false);
  assert.equal(isPermanentError({ status: 429, message: 'Too Many Requests' }), false);
});

test('computeBackoffDelay produces bounded exponential values with jitter', () => {
  const delay0 = computeBackoffDelay(0, 1000, 10000);
  assert.ok(delay0 >= 1000 && delay0 <= 2000);

  const delay3 = computeBackoffDelay(3, 1000, 10000);
  assert.ok(delay3 >= 8000 && delay3 <= 9000);

  const delay10 = computeBackoffDelay(10, 1000, 10000);
  assert.ok(delay10 >= 10000 && delay10 <= 11000, 'Delay capped by maxDelay + jitter');
});

// ============================================================================
// 2. Outbox and Upload Lifecycle
// ============================================================================

test('SyncEngine successfully uploads a pending outbox operation and acknowledges it', async () => {
  const { repo } = setupRepo(USER_A);
  const supabase = new MockSupabaseClient();

  // Create a salary locally (commits to DB and outbox)
  await repo.createSalary({
    monthKey: '2026-01',
    amount: 50000,
    notes: 'Jan Salary'
  });

  const pendingBefore = await repo.listPendingOperations();
  assert.equal(pendingBefore.length, 1);
  const op = pendingBefore[0];
  assert.equal(op.status, OUTBOX_STATUS.PENDING);

  let statusEmitted = null;
  const engine = new SyncEngine({
    supabase,
    ledgerRepo: repo,
    userId: USER_A,
    onStatusChange: s => { statusEmitted = s; }
  });

  const res = await engine.sync();
  assert.equal(res.ok, true);
  assert.equal(res.uploadedCount, 1);

  // Outbox operation is now acknowledged
  const pendingAfter = await repo.listPendingOperations();
  assert.equal(pendingAfter.length, 0);

  const opAfter = await repo.getOperation(op.operationId);
  assert.equal(opAfter.status, OUTBOX_STATUS.ACKNOWLEDGED);
  assert.ok(opAfter.acknowledgedAt);
  assert.equal(opAfter.remoteCursor, 1);

  // Server received the operation
  assert.equal(supabase.appliedOperations.length, 1);
  assert.equal(supabase.appliedOperations[0].operationId, op.operationId);
  assert.equal(supabase.appliedOperations[0].operationType, 'salary:create');

  assert.equal(engine.status, SYNC_STATUS.SYNCED);
  engine.dispose();
});

test('SyncEngine uploads multiple pending operations in causal sequence order', async () => {
  const { repo } = setupRepo(USER_A);
  const supabase = new MockSupabaseClient();

  const salary = await repo.createSalary({ monthKey: '2026-02', amount: 60000 });
  const income = await repo.createExtraIncome({
    salaryRecordId: salary.id,
    amount: 5000,
    date: '2026-02-05',
    source: 'freelancing',
    description: 'Web work'
  });
  await repo.createExpense({
    amount: 1500,
    description: 'Groceries',
    date: '2026-02-06',
    paymentSource: 'salary',
    salaryRecordId: salary.id
  });

  const pending = await repo.listPendingOperations();
  assert.equal(pending.length, 3);
  assert.equal(pending[0].sequence, 1);
  assert.equal(pending[1].sequence, 2);
  assert.equal(pending[2].sequence, 3);

  const engine = new SyncEngine({
    supabase,
    ledgerRepo: repo,
    userId: USER_A
  });

  const res = await engine.sync();
  assert.equal(res.ok, true);
  assert.equal(res.uploadedCount, 3);

  assert.equal(supabase.appliedOperations.length, 3);
  assert.equal(supabase.appliedOperations[0].operationType, 'salary:create');
  assert.equal(supabase.appliedOperations[1].operationType, 'extra_income:create');
  assert.equal(supabase.appliedOperations[2].operationType, 'expense:create');

  const pendingAfter = await repo.countPendingOperations();
  assert.equal(pendingAfter, 0);

  engine.dispose();
});

test('SyncEngine safely handles idempotent repeat (status: skipped)', async () => {
  const { repo } = setupRepo(USER_A);
  const supabase = new MockSupabaseClient();

  await repo.createSalary({ monthKey: '2026-03', amount: 40000 });
  const [op] = await repo.listPendingOperations();

  // Mock server returning skipped (idempotent receipt)
  supabase.rpc = async (name, params) => {
    if (name === 'apply_sync_operation') {
      return {
        data: {
          ok: true,
          status: 'skipped',
          operationId: params.p_operation.operationId,
          cursor: 99,
          message: 'Operation already applied (idempotent)'
        },
        error: null
      };
    }
    if (name === 'get_sync_changes') return { data: { changes: [], nextCursor: 0, hasMore: false }, error: null };
  };

  const engine = new SyncEngine({ supabase, ledgerRepo: repo, userId: USER_A });
  const res = await engine.sync();
  assert.equal(res.ok, true);
  assert.equal(res.uploadedCount, 1);

  const opAfter = await repo.getOperation(op.operationId);
  assert.equal(opAfter.status, OUTBOX_STATUS.ACKNOWLEDGED);
  engine.dispose();
});

test('SyncEngine retries transient failures with exponential backoff and does not advance outbox', async () => {
  const { repo } = setupRepo(USER_A);
  const supabase = new MockSupabaseClient();

  await repo.createSalary({ monthKey: '2026-04', amount: 45000 });
  const [op] = await repo.listPendingOperations();

  // Simulate transient 503 error
  supabase.failRpc = { status: 503, message: 'Database connecting' };

  let statusUpdates = [];
  const engine = new SyncEngine({
    supabase,
    ledgerRepo: repo,
    userId: USER_A,
    onStatusChange: s => statusUpdates.push(s.status)
  });

  const res = await engine.sync();
  assert.equal(res.ok, false);
  assert.equal(engine.status, SYNC_STATUS.TEMPORARY_ERROR);

  // Operation remains pending in outbox with attempt diagnostics
  const opAfter = await repo.getOperation(op.operationId);
  assert.equal(opAfter.status, OUTBOX_STATUS.PENDING);
  assert.equal(opAfter.attemptCount, 1);
  assert.match(opAfter.lastError, /Database connecting/);

  // Now clear failure and trigger sync
  supabase.failRpc = null;
  const res2 = await engine.triggerSync();
  assert.equal(res2.ok, true);
  assert.equal(engine.status, SYNC_STATUS.SYNCED);

  const opSuccess = await repo.getOperation(op.operationId);
  assert.equal(opSuccess.status, OUTBOX_STATUS.ACKNOWLEDGED);

  engine.dispose();
});

test('SyncEngine marks permanent failure as BLOCKED and retains downstream pending operations', async () => {
  const { repo } = setupRepo(USER_A);
  const supabase = new MockSupabaseClient();

  // Create two operations
  const s = await repo.createSalary({ monthKey: '2026-05', amount: 50000 });
  await repo.createExpense({ amount: 100, description: 'Test', date: '2026-05-01', paymentSource: 'salary', salaryRecordId: s.id });

  const pending = await repo.listPendingOperations();
  assert.equal(pending.length, 2);

  // Make the first operation fail with a permanent check violation
  supabase.rpc = async (name, params) => {
    if (name === 'apply_sync_operation') {
      if (params.p_operation.operationId === pending[0].operationId) {
        return { data: null, error: { code: '23514', message: 'check_violation: business rule violation' } };
      }
      return { data: { ok: true, status: 'applied', operationId: params.p_operation.operationId }, error: null };
    }
    return { data: { changes: [], nextCursor: 0, hasMore: false }, error: null };
  };

  const engine = new SyncEngine({ supabase, ledgerRepo: repo, userId: USER_A });
  const res = await engine.sync();
  assert.equal(res.ok, false);
  assert.equal(engine.status, SYNC_STATUS.BLOCKED);

  // First operation is BLOCKED, not deleted or discarded
  const op0 = await repo.getOperation(pending[0].operationId);
  assert.equal(op0.status, OUTBOX_STATUS.BLOCKED);
  assert.match(op0.lastError, /check_violation/);

  // Second operation was NOT attempted yet, preserving sequence order
  const op1 = await repo.getOperation(pending[1].operationId);
  assert.equal(op1.status, OUTBOX_STATUS.PENDING);
  assert.equal(op1.attemptCount, 0);

  // Blocked operations count
  assert.equal(await repo.countBlockedOperations(), 1);

  engine.dispose();
});

test('retryBlockedOperations resets blocked operations to pending and re-syncs', async () => {
  const { repo } = setupRepo(USER_A);
  const supabase = new MockSupabaseClient();

  await repo.createSalary({ monthKey: '2026-06', amount: 50000 });
  const [op] = await repo.listPendingOperations();

  // Artificially block the operation
  await repo.recordOperationAttempt(op.operationId, 'Temporary rule block', { status: OUTBOX_STATUS.BLOCKED });
  assert.equal((await repo.getOperation(op.operationId)).status, OUTBOX_STATUS.BLOCKED);

  const engine = new SyncEngine({ supabase, ledgerRepo: repo, userId: USER_A });
  const res = await engine.retryBlockedOperations();
  assert.equal(res.resetCount, 1);
  assert.equal(engine.status, SYNC_STATUS.SYNCED);

  const opAfter = await repo.getOperation(op.operationId);
  assert.equal(opAfter.status, OUTBOX_STATUS.ACKNOWLEDGED);

  engine.dispose();
});

// ============================================================================
// 3. Remote Download & Incremental Change Feed
// ============================================================================

test('SyncEngine downloads remote changes, applies to local DB, and safely advances cursor', async () => {
  const { repo } = setupRepo(USER_A);
  const supabase = new MockSupabaseClient();

  const remoteSalaryId = generateUUID();
  const remoteExpenseId = generateUUID();

  // Populate server changes
  supabase.changes = [
    {
      cursor: 1,
      operationId: generateUUID(),
      operationType: 'salary:create',
      entityType: 'salary',
      entityId: remoteSalaryId,
      action: 'create',
      record: {
        id: remoteSalaryId,
        month_key: '2026-07',
        amount: '75000.00',
        amount_paise: 7500000,
        notes: 'Remote Jan',
        created_at: '2026-07-01T10:00:00.000Z',
        updated_at: '2026-07-01T10:00:00.000Z'
      }
    },
    {
      cursor: 2,
      operationId: generateUUID(),
      operationType: 'expense:create',
      entityType: 'expense',
      entityId: remoteExpenseId,
      action: 'create',
      record: {
        id: remoteExpenseId,
        amount: '250.00',
        amount_paise: 25000,
        description: 'Coffee',
        transaction_date: '2026-07-02',
        payment_source: 'salary',
        salary_record_id: remoteSalaryId,
        created_at: '2026-07-02T11:00:00.000Z',
        updated_at: '2026-07-02T11:00:00.000Z'
      }
    }
  ];

  let remoteChangeNotified = null;
  const engine = new SyncEngine({
    supabase,
    ledgerRepo: repo,
    userId: USER_A,
    onRemoteChange: c => { remoteChangeNotified = c; }
  });

  const res = await engine.sync();
  assert.equal(res.ok, true);
  assert.equal(res.downloadedCount, 2);
  assert.deepEqual(remoteChangeNotified, { count: 2 });

  // Verify local IndexedDB stores now contain the remote records
  const cursor = await repo.getLastSyncedCursor();
  assert.equal(cursor, 2);

  const salaries = await repo.listSalaries();
  assert.equal(salaries.length, 1);
  assert.equal(salaries[0].id, remoteSalaryId);
  assert.equal(salaries[0].amount, 75000);
  assert.equal(salaries[0].amountPaise, 7500000);

  const expenses = await repo.listExpenses();
  assert.equal(expenses.length, 1);
  assert.equal(expenses[0].id, remoteExpenseId);
  assert.equal(expenses[0].amount, 250);
  assert.equal(expenses[0].paymentSource, 'salary');

  // Incremental sync on next pass queries after cursor 2 and downloads 0 changes
  const res2 = await engine.sync();
  assert.equal(res2.downloadedCount, 0);
  assert.equal(await repo.getLastSyncedCursor(), 2);

  engine.dispose();
});

test('SyncEngine processes paginated remote changes until hasMore is false', async () => {
  const { repo } = setupRepo(USER_A);
  const supabase = new MockSupabaseClient();

  // Create 5 remote changes
  for (let i = 1; i <= 5; i++) {
    const id = generateUUID();
    supabase.changes.push({
      cursor: i,
      operationId: generateUUID(),
      operationType: 'expense:create',
      entityType: 'expense',
      entityId: id,
      action: 'create',
      record: {
        id,
        amount: `${10 * i}.00`,
        description: `Item ${i}`,
        transaction_date: '2026-08-01',
        payment_source: 'others',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    });
  }

  // Set batchLimit to 2 to force 3 paginated round-trips (2, 2, 1)
  const engine = new SyncEngine({
    supabase,
    ledgerRepo: repo,
    userId: USER_A,
    options: { batchLimit: 2 }
  });

  const res = await engine.sync();
  assert.equal(res.ok, true);
  assert.equal(res.downloadedCount, 5);

  const cursor = await repo.getLastSyncedCursor();
  assert.equal(cursor, 5);

  const expenses = await repo.listExpenses();
  assert.equal(expenses.length, 5);

  engine.dispose();
});

test('Recovery after interrupted application: transaction abort does not advance cursor', async () => {
  const { db, repo } = setupRepo(USER_A);
  const supabase = new MockSupabaseClient();

  const id = generateUUID();
  supabase.changes = [{
    cursor: 10,
    operationId: generateUUID(),
    operationType: 'salary:create',
    entityType: 'salary',
    entityId: id,
    action: 'create',
    record: { id, month_key: '2026-09', amount: 50000 }
  }];

  // Inject transaction rollback
  db.failNextTransaction = true;

  await assert.rejects(
    async () => {
      await repo.applyRemoteChanges(supabase.changes, 10);
    },
    /Simulated transaction failure/
  );

  // Neither the salary record nor the cursor was persisted
  const cursor = await repo.getLastSyncedCursor();
  assert.equal(cursor, 0);

  const salaries = await repo.listSalaries();
  assert.equal(salaries.length, 0);
});

test('Avoid re-uploading remotely received changes as new local outbox operations', async () => {
  const { repo } = setupRepo(USER_A);
  const supabase = new MockSupabaseClient();

  const salaryId = generateUUID();
  supabase.changes = [{
    cursor: 1,
    operationId: generateUUID(),
    operationType: 'salary:create',
    entityType: 'salary',
    entityId: salaryId,
    action: 'create',
    record: { id: salaryId, month_key: '2026-10', amount: 50000, created_at: new Date().toISOString() }
  }];

  const engine = new SyncEngine({ supabase, ledgerRepo: repo, userId: USER_A });
  await engine.sync();

  // Outbox must be empty! Remotely applied changes must NOT enqueue local outbox operations
  const outboxOps = await repo.listAllOperations();
  assert.equal(outboxOps.length, 0);

  engine.dispose();
});

// ============================================================================
// 4. Concurrency, Account Isolation & Conflict Handling
// ============================================================================

test('Multiple concurrent sync() calls coalesce into a single execution stream', async () => {
  const { repo } = setupRepo(USER_A);
  const supabase = new MockSupabaseClient();

  await repo.createSalary({ monthKey: '2026-11', amount: 50000 });

  const engine = new SyncEngine({ supabase, ledgerRepo: repo, userId: USER_A });

  // Fire 5 concurrent sync() requests
  const results = await Promise.all([
    engine.sync(),
    engine.sync(),
    engine.sync(),
    engine.sync(),
    engine.sync()
  ]);

  for (const r of results) {
    assert.equal(r.ok, true);
  }

  // Exactly 1 upload occurred
  assert.equal(supabase.appliedOperations.length, 1);
  assert.equal(await repo.countPendingOperations(), 0);

  engine.dispose();
});

test('Account isolation: User A sync cannot touch or leak User B operations or data', async () => {
  const { repo: repoA } = setupRepo(USER_A);
  const { repo: repoB } = setupRepo(USER_B);
  const supabase = new MockSupabaseClient();

  await repoA.createSalary({ monthKey: '2026-01', amount: 50000 });
  await repoB.createSalary({ monthKey: '2026-01', amount: 70000 });

  const engineA = new SyncEngine({ supabase, ledgerRepo: repoA, userId: USER_A });
  const resA = await engineA.sync();
  assert.equal(resA.uploadedCount, 1);

  // User A's outbox is acknowledged
  assert.equal(await repoA.countPendingOperations(), 0);

  // User B's outbox remains completely untouched and pending
  assert.equal(await repoB.countPendingOperations(), 1);

  engineA.dispose();
});

test('Disposing a SyncEngine halts retries and rejects subsequent actions', async () => {
  const { repo } = setupRepo(USER_A);
  const supabase = new MockSupabaseClient();
  const engine = new SyncEngine({ supabase, ledgerRepo: repo, userId: USER_A });

  engine.dispose();
  const res = await engine.sync();
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'disposed');
});

test('Conflict handling: remote change does not overwrite uncommitted local outbox edit', async () => {
  const { repo } = setupRepo(USER_A);
  const supabase = new MockSupabaseClient();

  // Create salary locally
  const salary = await repo.createSalary({ monthKey: '2026-12', amount: 50000, notes: 'Local draft' });

  // Remote change arrives for this salary from another device with older amount
  const remoteChange = {
    cursor: 1,
    operationId: generateUUID(),
    operationType: 'salary:update',
    entityType: 'salary',
    entityId: salary.id,
    action: 'update',
    record: { id: salary.id, month_key: '2026-12', amount: 30000, notes: 'Stale remote' }
  };

  await repo.applyRemoteChanges([remoteChange], 1);

  // Local record must NOT have been overwritten by stale remote update because an outbox op is pending
  const current = (await repo.listSalaries()).find(s => s.id === salary.id);
  assert.equal(current.amount, 50000);
  assert.equal(current.notes, 'Local draft');
});

// ============================================================================
// 5. Financial Integrity
// ============================================================================

test('Savings-funded expense + linked withdrawal syncs atomically with consecutive cursors', async () => {
  const { repo } = setupRepo(USER_A);
  const supabase = new MockSupabaseClient();

  const expenseId = generateUUID();
  const withdrawalId = generateUUID();

  // Remote savings-funded expense + withdrawal arrive together
  supabase.changes = [
    {
      cursor: 5,
      operationId: generateUUID(),
      operationType: 'expense:create',
      entityType: 'expense',
      entityId: expenseId,
      action: 'create',
      record: {
        id: expenseId,
        amount: 3000,
        description: 'New Camera',
        transaction_date: '2026-08-10',
        payment_source: 'savings'
      }
    },
    {
      cursor: 6,
      operationId: generateUUID(),
      operationType: 'expense:create',
      entityType: 'saving',
      entityId: withdrawalId,
      action: 'create',
      record: {
        id: withdrawalId,
        amount: 3000,
        transaction_date: '2026-08-10',
        transaction_type: 'withdrawal',
        expense_id: expenseId,
        description: 'New Camera'
      }
    }
  ];

  const engine = new SyncEngine({ supabase, ledgerRepo: repo, userId: USER_A });
  await engine.sync();

  const expenses = await repo.listExpenses();
  assert.equal(expenses.length, 1);
  assert.equal(expenses[0].id, expenseId);
  assert.equal(expenses[0].paymentSource, 'savings');

  const savings = await repo.listSavings();
  assert.equal(savings.length, 1);
  assert.equal(savings[0].id, withdrawalId);
  assert.equal(savings[0].type, 'withdrawal');
  assert.equal(savings[0].expenseId, expenseId);

  engine.dispose();
});

test('Savings contribution with extra-income funding allocations syncs correctly', async () => {
  const { repo } = setupRepo(USER_A);
  const supabase = new MockSupabaseClient();

  const incomeId = generateUUID();
  const savingId = generateUUID();

  supabase.changes = [
    {
      cursor: 1,
      operationId: generateUUID(),
      operationType: 'extra_income:create',
      entityType: 'extra_income',
      entityId: incomeId,
      action: 'create',
      record: {
        id: incomeId,
        amount: 10000,
        received_date: '2026-08-01',
        source: 'bonus',
        description: 'Performance Bonus'
      }
    },
    {
      cursor: 2,
      operationId: generateUUID(),
      operationType: 'savings:contribution',
      entityType: 'saving',
      entityId: savingId,
      action: 'create',
      record: {
        id: savingId,
        amount: 7000,
        transaction_date: '2026-08-05',
        transaction_type: 'contribution',
        salary_allocation_paise: 200000,
        extra_income_allocations: [
          { extraIncomeRecordId: incomeId, amountPaise: 500000 }
        ]
      }
    }
  ];

  const engine = new SyncEngine({ supabase, ledgerRepo: repo, userId: USER_A });
  await engine.sync();

  const savings = await repo.listSavings();
  assert.equal(savings.length, 1);
  assert.equal(savings[0].id, savingId);
  assert.equal(savings[0].salaryAllocationPaise, 200000);
  assert.equal(savings[0].extraIncomeAllocations.length, 1);
  assert.equal(savings[0].extraIncomeAllocations[0].extraIncomeRecordId, incomeId);
  assert.equal(savings[0].extraIncomeAllocations[0].amountPaise, 500000);

  engine.dispose();
});

test('Reversals applied remotely update local reversedAt and reversalId', async () => {
  const { repo } = setupRepo(USER_A);
  const supabase = new MockSupabaseClient();

  const savingId = generateUUID();

  // Create initial saving
  supabase.changes = [
    {
      cursor: 1,
      operationId: generateUUID(),
      operationType: 'savings:external_contribution',
      entityType: 'saving',
      entityId: savingId,
      action: 'create',
      record: {
        id: savingId,
        amount: 5000,
        transaction_date: '2026-08-15',
        transaction_type: 'external_contribution',
        source_type: 'gift'
      }
    }
  ];

  const engine = new SyncEngine({ supabase, ledgerRepo: repo, userId: USER_A });
  await engine.sync();

  // Now a remote reversal arrives
  const revTimestamp = new Date().toISOString();
  supabase.changes.push({
    cursor: 2,
    operationId: generateUUID(),
    operationType: 'savings:reverse',
    entityType: 'saving',
    entityId: savingId,
    action: 'reverse',
    record: {
      id: savingId,
      amount: 5000,
      transaction_date: '2026-08-15',
      transaction_type: 'external_contribution',
      reversed_at: revTimestamp,
      reversal_id: 'rev_remote_1'
    }
  });

  await engine.sync();

  const savings = await repo.listSavings();
  assert.equal(savings.length, 1);
  assert.equal(savings[0].reversedAt, revTimestamp);
  assert.equal(savings[0].reversalId, 'rev_remote_1');

  engine.dispose();
});
