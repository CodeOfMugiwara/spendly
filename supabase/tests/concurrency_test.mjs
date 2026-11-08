// Spendly Phase 6.1.1: Concurrency & Transaction-Safety Test Suite
// Verifies:
// 1. Concurrent operations for the same user are serialized by the row-level lock on sync_user_cursors.
// 2. Later operations cannot overtake an earlier in-flight transaction for the same user.
// 3. Different users operate concurrently without blocking each other.
// 4. Multiple change-feed rows from composite operations receive deterministic, sequential cursors.
// 5. Rolled back transactions release the lock and do not create cursor gaps.
// 6. RLS security on sync_user_cursors prevents unauthorized reads and direct writes.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const execAsync = promisify(exec);
const FIXTURES_DIR = path.resolve('supabase', 'tests', 'concurrency_fixtures');

const USER_A_ID = 'e1000000-0000-4000-8000-000000000001';
const USER_B_ID = 'e2000000-0000-4000-8000-000000000002';

async function runQueryFile(filePath) {
  const cmd = `npx --yes supabase@3.0.0 db query --remote --yes --file "${filePath}"`;
  const { stdout, stderr } = await execAsync(cmd, { cwd: process.cwd() });
  // Parse JSON response between boundaries
  const match = stdout.match(/\{[\s\S]*"rows":[\s\S]*\}/);
  if (!match) {
    throw new Error(`Failed to parse query output: ${stdout}\nStderr: ${stderr}`);
  }
  return JSON.parse(match[0]);
}

async function runRawSql(sql) {
  const tempPath = path.join(FIXTURES_DIR, `temp_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  await fs.writeFile(tempPath, sql, 'utf8');
  try {
    return await runQueryFile(tempPath);
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

async function setup() {
  console.log('--- Setting up test environment & test users ---');
  await fs.mkdir(FIXTURES_DIR, { recursive: true });

  const setupSql = `
    -- Cleanup any existing test users
    delete from auth.users where id in ('${USER_A_ID}', '${USER_B_ID}');

    -- Insert synthetic test users
    insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values
      ('${USER_A_ID}', 'authenticated', 'authenticated', 'concurrency-a@example.invalid', '', now(), '{}'::jsonb, '{"name":"Conc User A"}'::jsonb, now(), now()),
      ('${USER_B_ID}', 'authenticated', 'authenticated', 'concurrency-b@example.invalid', '', now(), '{}'::jsonb, '{"name":"Conc User B"}'::jsonb, now(), now());

    select count(*) as count from auth.users where id in ('${USER_A_ID}', '${USER_B_ID}');
  `;
  const res = await runRawSql(setupSql);
  assert.equal(res.rows[0].count, 2, 'Both test users must exist in auth.users');
  console.log('✓ Test users created successfully.');
}

async function testSameUserSerializationAndMultiUserParallelism() {
  console.log('\n--- Test 1: Same-User Row Lock Serialization & Multi-User Parallelism ---');

  // Session 1: User A applies salary:create and holds transaction open with pg_sleep(3.0)
  const session1Sql = `
    begin;
    set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${USER_A_ID}","role":"authenticated"}', true);

    select public.apply_sync_operation(jsonb_build_object(
      'operationId', 'fa000000-0000-4000-8000-000000000001',
      'operationType', 'salary:create',
      'entityType', 'salary',
      'entityId', '${USER_A_ID}',
      'payload', jsonb_build_object('salary', jsonb_build_object('id', '${USER_A_ID}', 'monthKey', '2026-01', 'amount', 75000, 'notes', 'In-flight tx A1'))
    )) as op_result;

    -- Sleep 3 seconds while holding exclusive row lock on User A's cursor counter
    select pg_sleep(3.0);

    commit;
  `;

  // Session 2: User A concurrently applies salary:update (should BLOCK on the row lock until Session 1 commits!)
  // If it does not block, it would fail immediately with P0002 because Session 1's salary record is not yet committed.
  const session2Sql = `
    begin;
    set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${USER_A_ID}","role":"authenticated"}', true);

    select public.apply_sync_operation(jsonb_build_object(
      'operationId', 'fa000000-0000-4000-8000-000000000002',
      'operationType', 'salary:update',
      'entityType', 'salary',
      'entityId', '${USER_A_ID}',
      'payload', jsonb_build_object('salary', jsonb_build_object('id', '${USER_A_ID}', 'amount', 80000, 'notes', 'Blocked tx A2'))
    )) as op_result;

    commit;
  `;

  // Session 3: User B applies salary:create concurrently (should NOT block, completes quickly!)
  const session3Sql = `
    begin;
    set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${USER_B_ID}","role":"authenticated"}', true);

    select public.apply_sync_operation(jsonb_build_object(
      'operationId', 'fb000000-0000-4000-8000-000000000001',
      'operationType', 'salary:create',
      'entityType', 'salary',
      'entityId', '${USER_B_ID}',
      'payload', jsonb_build_object('salary', jsonb_build_object('id', '${USER_B_ID}', 'monthKey', '2026-01', 'amount', 60000, 'notes', 'Concurrent tx User B'))
    )) as op_result;

    commit;
  `;

  const s1Path = path.join(FIXTURES_DIR, 'session1.sql');
  const s2Path = path.join(FIXTURES_DIR, 'session2.sql');
  const s3Path = path.join(FIXTURES_DIR, 'session3.sql');

  await fs.writeFile(s1Path, session1Sql, 'utf8');
  await fs.writeFile(s2Path, session2Sql, 'utf8');
  await fs.writeFile(s3Path, session3Sql, 'utf8');

  const startTimes = {};
  const finishTimes = {};

  startTimes.s1 = Date.now();
  console.log('-> Launching Session 1 (User A, holds lock for 3s)...');
  const p1 = runQueryFile(s1Path).then(res => {
    finishTimes.s1 = Date.now();
    console.log(`<- Session 1 finished in ${(finishTimes.s1 - startTimes.s1) / 1000}s`);
    return res;
  });

  // Wait 400ms to ensure Session 1 has started and acquired row lock
  await new Promise(r => setTimeout(r, 400));

  startTimes.s2 = Date.now();
  console.log('-> Launching Session 2 (User A, concurrent write - expects blocking)...');
  const p2 = runQueryFile(s2Path).then(res => {
    finishTimes.s2 = Date.now();
    console.log(`<- Session 2 finished in ${(finishTimes.s2 - startTimes.s2) / 1000}s`);
    return res;
  });

  // Wait 300ms, then launch Session 3 for User B
  await new Promise(r => setTimeout(r, 300));

  startTimes.s3 = Date.now();
  console.log('-> Launching Session 3 (User B, independent user - expects NO blocking)...');
  const p3 = runQueryFile(s3Path).then(res => {
    finishTimes.s3 = Date.now();
    console.log(`<- Session 3 finished in ${(finishTimes.s3 - startTimes.s3) / 1000}s`);
    return res;
  });

  const [res1, res2, res3] = await Promise.all([p1, p2, p3]);

  // Concurrency Timing & Serialization Assertions:
  // 1. Session 3 (User B) must finish BEFORE Session 1 releases its lock because User B was unblocked!
  const s3Duration = (finishTimes.s3 - startTimes.s3) / 1000;
  const s2Duration = (finishTimes.s2 - startTimes.s2) / 1000;
  assert(
    finishTimes.s3 < finishTimes.s1,
    `User B should finish before User A Session 1 releases lock (s3 finish: ${finishTimes.s3}, s1 finish: ${finishTimes.s1})`
  );
  console.log(`✓ Multi-user parallelism confirmed: User B completed in ${s3Duration.toFixed(2)}s without blocking on User A.`);

  // 2. Session 2 (User A) was blocked on the row lock for ~3 seconds.
  // Its duration must be significantly longer than an unblocked operation.
  assert(
    s2Duration >= s3Duration + 1.5,
    `Session 2 must have blocked on User A's row lock (s2 duration: ${s2Duration.toFixed(2)}s, s3 unblocked: ${s3Duration.toFixed(2)}s)`
  );
  console.log(`✓ Same-user row lock serialization confirmed: Session 2 was blocked for ~3s waiting for Session 1 to commit.`);

  // 3. Verify User A's change feed and cursors in database
  const verifyUserASql = `
    set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${USER_A_ID}","role":"authenticated"}', true);
    select public.get_sync_changes(0, 100) as changes;
  `;
  const userAFeed = await runRawSql(verifyUserASql);
  const changesA = userAFeed.rows[0].changes.changes;
  assert.equal(changesA.length, 2, 'User A must have exactly 2 change records');
  assert.equal(changesA[0].cursor, 1, 'First operation must have cursor 1');
  assert.equal(changesA[0].operationId, 'fa000000-0000-4000-8000-000000000001');
  assert.equal(changesA[1].cursor, 2, 'Second operation must have cursor 2');
  assert.equal(changesA[1].operationId, 'fa000000-0000-4000-8000-000000000002');
  assert.equal(userAFeed.rows[0].changes.nextCursor, 2);
  console.log('✓ User A change feed verified: cursors [1, 2] in exact sequential commit order with no gaps.');

  // Verify User B's change feed
  const verifyUserBSql = `
    set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${USER_B_ID}","role":"authenticated"}', true);
    select public.get_sync_changes(0, 100) as changes;
  `;
  const userBFeed = await runRawSql(verifyUserBSql);
  const changesB = userBFeed.rows[0].changes.changes;
  assert.equal(changesB.length, 1, 'User B must have exactly 1 change record');
  assert.equal(changesB[0].cursor, 1, "User B's cursor space starts at 1 independently of User A");
  console.log("✓ User B change feed verified: cursor space is partitioned per user, starts at 1.");
}

async function testCompositeOperationCursors() {
  console.log('\n--- Test 2: Composite Operation Consecutive Cursor Allocation ---');

  // Expense created with payment source 'savings' and a linked withdrawal.
  // This must allocate exactly 2 consecutive cursors atomically.
  const expenseId = 'ea000000-0000-4000-8000-000000000010';
  const withdrawalId = 'ea000000-0000-4000-8000-000000000011';

  // First fund savings so withdrawal does not overdraft
  const prepSavingsSql = `
    set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${USER_A_ID}","role":"authenticated"}', true);

    select public.apply_sync_operation(jsonb_build_object(
      'operationId', 'fa000000-0000-4000-8000-000000000003',
      'operationType', 'savings:external_contribution',
      'entityType', 'saving',
      'entityId', 'ea000000-0000-4000-8000-000000000009',
      'payload', jsonb_build_object('saving', jsonb_build_object(
        'id', 'ea000000-0000-4000-8000-000000000009',
        'amount', 50000,
        'date', '2026-01-10',
        'sourceType', 'gift',
        'description', 'Funding for composite test'
      ))
    ));
  `;
  await runRawSql(prepSavingsSql);

  const compositeSql = `
    set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${USER_A_ID}","role":"authenticated"}', true);

    select public.apply_sync_operation(jsonb_build_object(
      'operationId', 'fa000000-0000-4000-8000-000000000004',
      'operationType', 'expense:create',
      'entityType', 'expense',
      'entityId', '${expenseId}',
      'payload', jsonb_build_object(
        'expense', jsonb_build_object(
          'id', '${expenseId}',
          'amount', 12000,
          'description', 'Savings funded laptop repair',
          'date', '2026-01-15',
          'paymentSource', 'savings'
        ),
        'linkedWithdrawal', jsonb_build_object(
          'id', '${withdrawalId}',
          'amount', 12000,
          'date', '2026-01-15',
          'description', 'Savings funded laptop repair'
        )
      )
    )) as op_result;
  `;
  const res = await runRawSql(compositeSql);
  const receipt = res.rows[0].op_result;
  assert.equal(receipt.status, 'applied');
  assert.equal(receipt.cursor, 5, 'Composite operation with 2 changes after cursor 3 must have final cursor 5');

  // Query sync_change_feed to verify both change entries have sequential cursors 4 and 5
  const verifyFeedSql = `
    set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${USER_A_ID}","role":"authenticated"}', true);
    select public.get_sync_changes(3, 10) as changes;
  `;
  const feedRes = await runRawSql(verifyFeedSql);
  const changes = feedRes.rows[0].changes.changes;
  assert.equal(changes.length, 2, 'Composite operation must produce exactly 2 change-feed entries');
  assert.equal(changes[0].entityType, 'expense');
  assert.equal(changes[0].cursor, 4, 'First change (expense) must have cursor 4');
  assert.equal(changes[1].entityType, 'saving');
  assert.equal(changes[1].cursor, 5, 'Second change (saving withdrawal) must have cursor 5');
  assert.equal(changes[0].operationId, 'fa000000-0000-4000-8000-000000000004');
  assert.equal(changes[1].operationId, 'fa000000-0000-4000-8000-000000000004');
  console.log('✓ Composite operation verified: expense (cursor 4) and linked withdrawal (cursor 5) committed consecutively.');
}

async function testRollbackSafetyNoGaps() {
  console.log('\n--- Test 3: Rollback Safety & Zero Cursor Gaps ---');

  // Transaction that starts, increments cursor counter, but then ROLLS BACK
  const rollbackSql = `
    begin;
    set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${USER_A_ID}","role":"authenticated"}', true);

    -- Intentionally cause an exception (e.g. invalid UUID) after allocating cursor or abort
    select public.apply_sync_operation(jsonb_build_object(
      'operationId', 'fa000000-0000-4000-8000-000000000099',
      'operationType', 'salary:create',
      'entityType', 'salary',
      'entityId', 'ea000000-0000-4000-8000-000000000099',
      'payload', jsonb_build_object('salary', jsonb_build_object('id', 'ea000000-0000-4000-8000-000000000099', 'monthKey', '2026-02', 'amount', 50000))
    ));

    -- Explicitly rollback transaction
    rollback;
  `;
  await runRawSql(rollbackSql);

  // Now execute the next valid operation.
  // Because the previous transaction rolled back, the cursor counter in PostgreSQL must have rolled back too!
  // The next cursor must be 6, NOT 7!
  const nextOpSql = `
    set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${USER_A_ID}","role":"authenticated"}', true);

    select public.apply_sync_operation(jsonb_build_object(
      'operationId', 'fa000000-0000-4000-8000-000000000005',
      'operationType', 'salary:create',
      'entityType', 'salary',
      'entityId', 'ea000000-0000-4000-8000-000000000005',
      'payload', jsonb_build_object('salary', jsonb_build_object('id', 'ea000000-0000-4000-8000-000000000005', 'monthKey', '2026-03', 'amount', 90000))
    )) as op_result;
  `;
  const nextRes = await runRawSql(nextOpSql);
  const nextReceipt = nextRes.rows[0].op_result;
  assert.equal(nextReceipt.status, 'applied');
  assert.equal(
    nextReceipt.cursor,
    6,
    `Cursor after rolled back transaction must be strictly 6 (got ${nextReceipt.cursor}), proving no gap was created`
  );
  console.log('✓ Rollback safety verified: rolled-back transaction created 0 cursor gaps; next operation received cursor 6.');
}

async function testSecurityAndRls() {
  console.log('\n--- Test 4: RLS & Access Control on sync_user_cursors ---');

  // 1. Anonymous user cannot select sync_user_cursors
  const anonSql = `
    set local role anon;
    select count(*) from public.sync_user_cursors;
  `;
  let anonBlocked = false;
  try {
    await runRawSql(anonSql);
  } catch (err) {
    anonBlocked = true;
  }
  assert.equal(anonBlocked, true, 'Anonymous user must be denied access to sync_user_cursors');
  console.log('✓ Anonymous access to sync_user_cursors is denied.');

  // 2. Authenticated user can only see their own cursor row
  const rlsSql = `
    set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${USER_B_ID}","role":"authenticated"}', true);
    select count(*) as count, bool_and(user_id = '${USER_B_ID}') as only_own from public.sync_user_cursors;
  `;
  const rlsRes = await runRawSql(rlsSql);
  assert.equal(rlsRes.rows[0].count, 1, 'User B must see only 1 row in sync_user_cursors');
  assert.equal(rlsRes.rows[0].only_own, true, "User B's visible row must be strictly User B's own row");
  console.log('✓ RLS isolation on sync_user_cursors verified: User B only sees their own row.');

  // 3. Authenticated user direct write is denied
  const writeSql = `
    set local role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${USER_B_ID}","role":"authenticated"}', true);
    update public.sync_user_cursors set last_cursor = 999 where user_id = '${USER_B_ID}';
  `;
  let directWriteBlocked = false;
  try {
    await runRawSql(writeSql);
  } catch (err) {
    directWriteBlocked = true;
  }
  assert.equal(directWriteBlocked, true, 'Direct UPDATE on sync_user_cursors by authenticated user must be denied');
  console.log('✓ Direct write prevention verified: authenticated users cannot directly mutate sync_user_cursors.');
}

async function teardown() {
  console.log('\n--- Cleaning up test environment ---');
  const cleanupSql = `
    delete from auth.users where id in ('${USER_A_ID}', '${USER_B_ID}');
  `;
  await runRawSql(cleanupSql);
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true }).catch(() => {});
  console.log('✓ Cleanup complete. Synthetic test data removed.');
}

async function main() {
  console.log('================================================================');
  console.log('Spendly Phase 6.1.1: Concurrency & Transaction-Safety Test Suite');
  console.log('================================================================');
  try {
    await setup();
    await testSameUserSerializationAndMultiUserParallelism();
    await testCompositeOperationCursors();
    await testRollbackSafetyNoGaps();
    await testSecurityAndRls();
    console.log('\n================================================================');
    console.log('ALL PHASE 6.1.1 CONCURRENCY & TRANSACTION-SAFETY TESTS PASSED!');
    console.log('================================================================\n');
  } finally {
    await teardown();
  }
}

main().catch(err => {
  console.error('\nFAILED CONCURRENCY TEST:', err);
  teardown().finally(() => process.exit(1));
});
