import test from 'node:test';
import assert from 'node:assert/strict';

import { STORAGE_KEY, sortExpenses } from '../../js/core.js';
import {
  ExpenseRepository,
  MIGRATION_META_KEY,
  NotFoundError,
  ValidationError
} from '../../js/repository.js';

class MemoryStore {
  constructor({ records = [], meta = [] } = {}) {
    this.records = new Map(records.map(record => [record.id, structuredClone(record)]));
    this.meta = new Map(meta.map(entry => [entry.key, structuredClone(entry)]));
    this.dropFirstOnPutMany = false;
    this.closed = false;
  }

  async getAll() {
    return [...this.records.values()].map(record => structuredClone(record));
  }

  async get(id) {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async getByDateRange(start, endExclusive) {
    return [...this.records.values()]
      .filter(record => record.date >= start && record.date < endExclusive)
      .map(record => structuredClone(record));
  }

  async count() {
    return this.records.size;
  }

  async put(record) {
    this.records.set(record.id, structuredClone(record));
  }

  async putMany(records) {
    const list = this.dropFirstOnPutMany ? records.slice(1) : records;
    for (const record of list) this.records.set(record.id, structuredClone(record));
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

  async getMeta(key) {
    return this.meta.has(key) ? structuredClone(this.meta.get(key)) : undefined;
  }

  async setMeta(value) {
    this.meta.set(value.key, structuredClone(value));
  }

  close() {
    this.closed = true;
  }
}

function legacyStorage(recordsOrValue) {
  let value = typeof recordsOrValue === 'string' ? recordsOrValue : JSON.stringify(recordsOrValue);
  return {
    getItem(key) {
      return key === STORAGE_KEY ? value : null;
    },
    setItem(key, next) {
      if (key === STORAGE_KEY) value = next;
    },
    get value() {
      return value;
    }
  };
}

function makeRepo(store, start = '2026-11-04T10:00:00.000Z') {
  let tick = 0;
  let id = 0;
  return new ExpenseRepository(store, {
    now: () => {
      const date = new Date(new Date(start).getTime() + tick * 1000);
      tick += 1;
      return date;
    },
    makeId: () => `new-${++id}`
  });
}

function legacyRecord(overrides = {}) {
  return {
    id: 'legacy-one',
    amount: 120,
    description: 'Lunch',
    date: '2026-11-02',
    ...overrides
  };
}

test('create stores a stable id, timestamps and rounded amount', async () => {
  const store = new MemoryStore();
  const repo = makeRepo(store);

  const created = await repo.create({ amount: '99.5', description: '  Tea  ', date: '2026-11-03' });
  assert.equal(created.id, 'new-1');
  assert.equal(created.amount, 99.5);
  assert.equal(created.description, 'Tea');
  assert.equal(created.createdAt, '2026-11-04T10:00:00.000Z');
  assert.equal(created.updatedAt, created.createdAt);
  assert.equal((await repo.list()).length, 1);
  assert.deepEqual(await store.get('new-1'), created);
});

test('create rejects invalid input without writing', async () => {
  const store = new MemoryStore();
  const repo = makeRepo(store);

  await assert.rejects(
    () => repo.create({ amount: 0, description: 'Nope', date: '2026-11-03' }),
    ValidationError
  );
  assert.equal(store.records.size, 0);
});

test('update preserves id and createdAt, and advances updatedAt', async () => {
  const store = new MemoryStore();
  const repo = makeRepo(store);
  const created = await repo.create({ amount: 10, description: 'Tea', date: '2026-11-03' });

  const updated = await repo.update(created.id, { amount: '12.25', description: 'Chai', date: '2026-11-04' });
  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, created.createdAt);
  assert.notEqual(updated.updatedAt, created.updatedAt);
  assert.equal(updated.amount, 12.25);
  assert.equal(updated.description, 'Chai');
});

test('update of a missing record fails cleanly', async () => {
  const repo = makeRepo(new MemoryStore());
  await assert.rejects(() => repo.update('missing', { amount: 1, description: 'x', date: '2026-11-01' }), NotFoundError);
});

test('delete and undo restore the exact record', async () => {
  const store = new MemoryStore();
  const repo = makeRepo(store);
  const created = await repo.create({ amount: 10, description: 'Tea', date: '2026-11-03' });

  await repo.remove(created.id);
  assert.equal((await repo.list()).length, 0);

  await repo.restore(created);
  const restored = await repo.get(created.id);
  assert.deepEqual(restored, created);
});

test('replaceAll deduplicates ids, generates missing ids and is all-or-nothing', async () => {
  const store = new MemoryStore();
  const repo = makeRepo(store);
  await repo.create({ amount: 10, description: 'Keep me', date: '2026-11-03' });

  await assert.rejects(() => repo.replaceAll([
    { id: 'ok', amount: 10, description: 'Valid', date: '2026-11-01' },
    { id: 'bad', amount: -1, description: 'Invalid', date: '2026-11-01' }
  ]), ValidationError);
  assert.equal((await repo.list())[0].description, 'Keep me');

  const result = await repo.replaceAll([
    { id: 'dup', amount: 10, description: 'First', date: '2026-11-01' },
    { id: 'dup', amount: 20, description: 'Second', date: '2026-11-02' },
    { amount: 30, description: 'Generated id', date: '2026-11-03' }
  ]);
  assert.equal(result.count, 2);
  assert.equal(result.duplicatesRemoved, 1);
  assert.deepEqual((await repo.list()).map(item => item.description), ['Generated id', 'Second']);
});

test('migration imports legacy records once and keeps localStorage intact', async () => {
  const oldDate = Date.UTC(2025, 4, 2, 8, 0, 0);
  const oldId = `${oldDate.toString(36)}abc123`;
  const storage = legacyStorage([
    legacyRecord({ id: oldId, amount: 100 }),
    legacyRecord({ id: 'plain-id', amount: 250, description: 'Petrol', date: '2026-11-04' })
  ]);
  const originalValue = storage.value;
  const store = new MemoryStore();
  const repo = makeRepo(store);

  const result = await repo.migrateLegacy(storage);
  assert.equal(result.status, 'migrated');
  assert.equal(result.imported, 2);
  assert.equal(store.records.size, 2);
  assert.equal(storage.value, originalValue);
  assert.ok(store.meta.get(MIGRATION_META_KEY)?.completedAt);

  const imported = await store.get(oldId);
  assert.equal(imported.createdAt, new Date(oldDate).toISOString());
  assert.equal(imported.updatedAt, imported.createdAt);

  const second = await repo.migrateLegacy(storage);
  assert.equal(second.status, 'already-migrated');
  assert.equal(second.imported, 0);
  assert.equal(store.records.size, 2);
});

test('migration never overwrites an existing IndexedDB record', async () => {
  const existing = {
    id: 'shared',
    amount: 999,
    description: 'Edited after upgrade',
    date: '2026-11-01',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-03T00:00:00.000Z'
  };
  const store = new MemoryStore({ records: [existing] });
  const repo = makeRepo(store);
  const storage = legacyStorage([
    legacyRecord({ id: 'shared', description: 'Old copy', amount: 10 }),
    legacyRecord({ id: 'other', description: 'New copy', amount: 20 })
  ]);

  const result = await repo.migrateLegacy(storage);
  assert.equal(result.status, 'migrated');
  assert.equal(result.imported, 1);
  assert.equal(result.alreadyPresent, 1);
  assert.equal(store.records.size, 2);
  assert.equal((await store.get('shared')).description, 'Edited after upgrade');
});

test('migration deduplicates repeated ids inside legacy data', async () => {
  const store = new MemoryStore();
  const repo = makeRepo(store);
  const storage = legacyStorage([
    legacyRecord({ id: 'same', description: 'First' }),
    legacyRecord({ id: 'same', description: 'Second' })
  ]);

  const result = await repo.migrateLegacy(storage);
  assert.equal(result.status, 'migrated');
  assert.equal(result.imported, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(store.records.size, 1);
  assert.equal((await store.get('same')).description, 'First');
});

test('migration is not marked complete when verification fails', async () => {
  const store = new MemoryStore();
  store.dropFirstOnPutMany = true;
  const repo = makeRepo(store);
  const storage = legacyStorage([
    legacyRecord({ id: 'one' }),
    legacyRecord({ id: 'two' })
  ]);

  await assert.rejects(() => repo.migrateLegacy(storage), /verification failed/i);
  assert.equal(store.meta.has(MIGRATION_META_KEY), false);
  assert.equal(store.records.size, 1);
});

test('invalid legacy JSON is left for a later retry', async () => {
  const store = new MemoryStore();
  const repo = makeRepo(store);
  const storage = legacyStorage('{not valid json');

  const result = await repo.migrateLegacy(storage);
  assert.equal(result.status, 'invalid-json');
  assert.equal(store.meta.has(MIGRATION_META_KEY), false);
});

test('invalid legacy records are skipped and reported', async () => {
  const store = new MemoryStore();
  const repo = makeRepo(store);
  const storage = legacyStorage([
    legacyRecord({ id: 'good' }),
    legacyRecord({ id: 'bad', amount: -5 })
  ]);

  const result = await repo.migrateLegacy(storage);
  assert.equal(result.status, 'migrated');
  assert.equal(result.imported, 1);
  assert.equal(result.invalid, 1);
  assert.equal(store.records.size, 1);
});

test('empty legacy storage is recorded and does not duplicate work', async () => {
  const store = new MemoryStore();
  const repo = makeRepo(store);

  const result = await repo.migrateLegacy(legacyStorage([]));
  assert.equal(result.status, 'empty');
  assert.ok(store.meta.get(MIGRATION_META_KEY));
  assert.equal((await repo.migrateLegacy(legacyStorage([]))).status, 'already-migrated');
});

test('listByDateRange uses an exclusive end date', async () => {
  const store = new MemoryStore();
  const repo = makeRepo(store);
  await repo.create({ amount: 1, description: 'a', date: '2026-11-01' });
  await repo.create({ amount: 2, description: 'b', date: '2026-11-30' });
  await repo.create({ amount: 3, description: 'c', date: '2026-12-01' });

  const records = await repo.listByDateRange('2026-11-01', '2026-12-01');
  assert.deepEqual(sortExpenses(records).map(item => item.description), ['b', 'a']);
  assert.equal(records.length, 2);
});

test('repository can be closed', () => {
  const store = new MemoryStore();
  makeRepo(store).close();
  assert.equal(store.closed, true);
});
