import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DuplicateMonthError,
  NotFoundError,
  SalaryRepository,
  SavingsRepository,
  ValidationError
} from '../../js/repository.js';

class MemoryFinanceStore {
  constructor({ records = [], enforceUniqueMonth = false } = {}) {
    this.records = new Map(records.map(record => [record.id, structuredClone(record)]));
    this.enforceUniqueMonth = enforceUniqueMonth;
    this.closed = false;
  }

  async getAll() {
    return [...this.records.values()].map(record => structuredClone(record));
  }

  async get(id) {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async getByMonth(monthKey) {
    const record = [...this.records.values()].find(item => item.monthKey === monthKey);
    return record ? structuredClone(record) : undefined;
  }

  async put(record) {
    if (this.enforceUniqueMonth) {
      const clash = [...this.records.values()].find(item => (
        item.monthKey === record.monthKey && item.id !== record.id
      ));
      if (clash) {
        const error = new Error('A record with that key already exists.');
        error.name = 'ConstraintError';
        throw error;
      }
    }
    this.records.set(record.id, structuredClone(record));
  }

  async putMany(records) {
    for (const record of records) await this.put(record);
  }

  async delete(id) {
    this.records.delete(id);
  }

  async clear() {
    this.records.clear();
  }

  async replaceAll(records) {
    this.records = new Map(records.map(record => [record.id, structuredClone(record)]));
  }

  close() {
    this.closed = true;
  }
}

function makeRepos(store, start = '2026-11-05T10:00:00.000Z') {
  let tick = 0;
  let id = 0;
  const options = {
    now: () => new Date(new Date(start).getTime() + tick++ * 1000),
    makeId: () => `new-${++id}`
  };
  return {
    salaries: new SalaryRepository(store, options),
    savings: new SavingsRepository(store, options)
  };
}

/* -------------------------------------------------------------------------- */
/* Salary                                                                     */
/* -------------------------------------------------------------------------- */

test('a salary can be created once per month with stable timestamps', async () => {
  const store = new MemoryFinanceStore();
  const { salaries } = makeRepos(store);

  const created = await salaries.create({ amount: '45,000', monthKey: '2026-09', notes: ' September ' });
  assert.equal(created.id, 'new-1');
  assert.equal(created.amount, 45000);
  assert.equal(created.amountPaise, 4500000);
  assert.equal(created.monthKey, '2026-09');
  assert.equal(created.notes, 'September');
  assert.equal(created.createdAt, '2026-11-05T10:00:00.000Z');
  assert.equal(created.updatedAt, created.createdAt);
  assert.equal((await salaries.list()).length, 1);
});

test('a second salary for the same month is rejected', async () => {
  const store = new MemoryFinanceStore();
  const { salaries } = makeRepos(store);

  await salaries.create({ amount: 45000, monthKey: '2026-09' });
  await assert.rejects(
    () => salaries.create({ amount: 50000, monthKey: '2026-09' }),
    DuplicateMonthError
  );
  assert.equal(store.records.size, 1);
  assert.equal((await salaries.getByMonth('2026-09')).amount, 45000);
});

test('invalid salary input never writes', async () => {
  const store = new MemoryFinanceStore();
  const { salaries } = makeRepos(store);

  await assert.rejects(() => salaries.create({ amount: 0, monthKey: '2026-09' }), ValidationError);
  await assert.rejects(() => salaries.create({ amount: 1000, monthKey: 'nope' }), ValidationError);
  assert.equal(store.records.size, 0);
});

test('editing one month never changes another', async () => {
  const store = new MemoryFinanceStore();
  const { salaries } = makeRepos(store);

  const september = await salaries.create({ amount: 45000, monthKey: '2026-09' });
  const october = await salaries.create({ amount: 48000, monthKey: '2026-10' });

  const updated = await salaries.update(september.id, { amount: 46000, monthKey: '2026-09', notes: 'Raise' });
  assert.equal(updated.id, september.id);
  assert.equal(updated.createdAt, september.createdAt);
  assert.notEqual(updated.updatedAt, september.updatedAt);
  assert.equal(updated.amount, 46000);
  assert.equal((await salaries.get(october.id)).amount, 48000);
});

test('moving a salary onto a taken month is rejected', async () => {
  const store = new MemoryFinanceStore();
  const { salaries } = makeRepos(store);

  const september = await salaries.create({ amount: 45000, monthKey: '2026-09' });
  await salaries.create({ amount: 48000, monthKey: '2026-10' });

  await assert.rejects(
    () => salaries.update(september.id, { amount: 45000, monthKey: '2026-10' }),
    DuplicateMonthError
  );
  assert.equal((await salaries.get(september.id)).monthKey, '2026-09');
});

test('the database constraint is translated into a duplicate-month error', async () => {
  const store = new MemoryFinanceStore({ enforceUniqueMonth: true });
  const { salaries } = makeRepos(store);

  await salaries.create({ amount: 45000, monthKey: '2026-09' });
  // Bypass the friendly pre-check to exercise the unique index path.
  await assert.rejects(
    () => salaries.restore({
      id: 'other-id',
      monthKey: '2026-09',
      amount: 50000,
      notes: '',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z'
    }),
    DuplicateMonthError
  );
});

test('salary removal can be undone and history is newest-first', async () => {
  const store = new MemoryFinanceStore();
  const { salaries } = makeRepos(store);

  const september = await salaries.create({ amount: 45000, monthKey: '2026-09' });
  const november = await salaries.create({ amount: 50000, monthKey: '2026-11' });
  await salaries.create({ amount: 48000, monthKey: '2026-10' });

  assert.deepEqual(
    (await salaries.list()).map(record => record.monthKey),
    ['2026-11', '2026-10', '2026-09']
  );

  await salaries.remove(november.id);
  assert.equal((await salaries.list()).length, 2);
  await salaries.restore(november);
  assert.equal((await salaries.get(november.id)).amount, 50000);

  await assert.rejects(
    () => salaries.update('missing', { amount: 1, monthKey: '2026-09' }),
    NotFoundError
  );
});

test('replaceAll rejects duplicate months in a backup', async () => {
  const store = new MemoryFinanceStore();
  const { salaries } = makeRepos(store);
  await salaries.create({ amount: 45000, monthKey: '2026-09' });

  await assert.rejects(() => salaries.replaceAll([
    { id: 'a', monthKey: '2026-09', amount: 1000 },
    { id: 'b', monthKey: '2026-09', amount: 2000 }
  ]), ValidationError);
  assert.equal((await salaries.list()).length, 1);

  const result = await salaries.replaceAll([
    { id: 'a', monthKey: '2026-09', amount: 1000 },
    { id: 'b', monthKey: '2026-10', amount: 2000 }
  ]);
  assert.equal(result.count, 2);
  assert.equal((await salaries.list()).length, 2);
});

/* -------------------------------------------------------------------------- */
/* Savings                                                                    */
/* -------------------------------------------------------------------------- */

test('savings entries get ids, timestamps and a date-derived month', async () => {
  const store = new MemoryFinanceStore();
  const { savings } = makeRepos(store);

  const created = await savings.create({ amount: '2,500.50', date: '2026-10-31', description: ' Emergency fund ' });
  assert.equal(created.id, 'new-1');
  assert.equal(created.amount, 2500.5);
  assert.equal(created.amountPaise, 250050);
  assert.equal(created.monthKey, '2026-10');
  assert.equal(created.description, 'Emergency fund');
  assert.equal(created.createdAt, '2026-11-05T10:00:00.000Z');
  assert.equal(created.updatedAt, created.createdAt);
});

test('savings validation blocks zero and future amounts', async () => {
  const store = new MemoryFinanceStore();
  const { savings } = makeRepos(store);

  await assert.rejects(() => savings.create({ amount: 0, date: '2026-10-31' }), ValidationError);
  await assert.rejects(() => savings.create({ amount: 100, date: '2026-12-01' }), ValidationError);
  await assert.rejects(() => savings.create({ amount: 100, date: 'bad' }), ValidationError);
  assert.equal(store.records.size, 0);
});

test('savings can be edited, moved between months and deleted', async () => {
  const store = new MemoryFinanceStore();
  const { savings } = makeRepos(store);

  const created = await savings.create({ amount: 1000, date: '2026-10-05', description: 'October' });
  const updated = await savings.update(created.id, { amount: 1500, date: '2026-11-02', description: 'November' });

  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, created.createdAt);
  assert.notEqual(updated.updatedAt, created.updatedAt);
  assert.equal(updated.amount, 1500);
  assert.equal(updated.monthKey, '2026-11');

  assert.equal((await savings.listByMonth('2026-10')).length, 0);
  assert.equal((await savings.listByMonth('2026-11')).length, 1);

  await savings.remove(created.id);
  assert.equal((await savings.list()).length, 0);

  await savings.restore(created);
  assert.equal((await savings.get(created.id)).monthKey, '2026-10');
});

test('savings history is newest first and replaceAll is keyed by id', async () => {
  const store = new MemoryFinanceStore();
  const { savings } = makeRepos(store);

  await savings.create({ amount: 100, date: '2026-09-01' });
  await savings.create({ amount: 200, date: '2026-11-01' });
  await savings.create({ amount: 300, date: '2026-10-01' });

  assert.deepEqual(
    (await savings.list()).map(record => record.date),
    ['2026-11-01', '2026-10-01', '2026-09-01']
  );

  const result = await savings.replaceAll([
    { id: 'dup', amount: 100, date: '2026-10-01' },
    { id: 'dup', amount: 200, date: '2026-11-01' }
  ]);
  assert.equal(result.count, 1);
  assert.equal((await savings.list()).length, 1);
  assert.equal((await savings.list())[0].amount, 200);
});

test('a store can be closed through either repository', () => {
  const store = new MemoryFinanceStore();
  const { salaries } = makeRepos(store);
  salaries.close();
  assert.equal(store.closed, true);
});
