/**
 * IndexedDB adapter for Spendly.
 *
 * This is the only module that knows about databases, stores or indexes. The
 * repositories and the UI talk to the small async interface implemented here.
 *
 * Schema history
 *   v1  expenses (by_date, by_createdAt, by_date_createdAt), meta
 *   v2  + salaries (by_monthKey — unique), savings (by_monthKey, by_date,
 *       by_date_createdAt)
 *   v3  + expense salary/source indexes and savings ledger relationship indexes
 *
 * The v2 upgrade only *adds* stores. It never drops, clears or rewrites the
 * existing `expenses` store, so an upgrade cannot lose expense data.
 */

import { DB_NAME, DB_VERSION } from './core.js';

export const EXPENSES_STORE = 'expenses';
export const META_STORE = 'meta';
export const SALARIES_STORE = 'salaries';
export const SAVINGS_STORE = 'savings';
export const EXTRA_INCOME_STORE = 'extraIncome';

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function ensureExpenseStores(db) {
  if (!db.objectStoreNames.contains(EXPENSES_STORE)) {
    const expenses = db.createObjectStore(EXPENSES_STORE, { keyPath: 'id' });
    // Calendar dates are stored as YYYY-MM-DD, so lexical order is
    // chronological and range queries can use the index directly.
    expenses.createIndex('by_date', 'date', { unique: false });
    expenses.createIndex('by_createdAt', 'createdAt', { unique: false });
    expenses.createIndex('by_date_createdAt', ['date', 'createdAt'], { unique: false });
  }
  if (!db.objectStoreNames.contains(META_STORE)) {
    db.createObjectStore(META_STORE, { keyPath: 'key' });
  }
}

function ensureFinanceStores(db) {
  if (!db.objectStoreNames.contains(SALARIES_STORE)) {
    const salaries = db.createObjectStore(SALARIES_STORE, { keyPath: 'id' });
    // One salary record per YYYY-MM month. The database itself enforces the
    // rule, so two tabs cannot create duplicates.
    salaries.createIndex('by_monthKey', 'monthKey', { unique: true });
    salaries.createIndex('by_createdAt', 'createdAt', { unique: false });
  }
  if (!db.objectStoreNames.contains(SAVINGS_STORE)) {
    const savings = db.createObjectStore(SAVINGS_STORE, { keyPath: 'id' });
    savings.createIndex('by_monthKey', 'monthKey', { unique: false });
    savings.createIndex('by_date', 'date', { unique: false });
    savings.createIndex('by_date_createdAt', ['date', 'createdAt'], { unique: false });
  }

}

function ensureExtraIncomeStore(db) {
  if (!db.objectStoreNames.contains(EXTRA_INCOME_STORE)) {
    const store = db.createObjectStore(EXTRA_INCOME_STORE, { keyPath: 'id' });
    store.createIndex('by_date', 'date', { unique: false });
    store.createIndex('by_createdAt', 'createdAt', { unique: false });
  }
}

/** Open (and if needed create or upgrade) the Spendly database. */
export function openExpenseDB(factory = globalThis.indexedDB) {
  if (!factory) return Promise.reject(new Error('IndexedDB is not available in this browser.'));

  return new Promise((resolve, reject) => {
    let request;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }

    request.onupgradeneeded = event => {
      const db = request.result;
      try {
        // Both helpers are idempotent, which covers fresh installs, v1 -> v2
        // upgrades and a re-opened database where one store is already present.
        ensureExpenseStores(db);
        if (event.oldVersion < 2 || !db.objectStoreNames.contains(SALARIES_STORE) ||
            !db.objectStoreNames.contains(SAVINGS_STORE)) {
          ensureFinanceStores(db);
        }
        const transaction = request.transaction;
        const expenses = transaction.objectStore(EXPENSES_STORE);
        if (!expenses.indexNames.contains('by_salaryRecordId')) expenses.createIndex('by_salaryRecordId', 'salaryRecordId', { unique: false });
        if (!expenses.indexNames.contains('by_paymentSource')) expenses.createIndex('by_paymentSource', 'paymentSource', { unique: false });
        const savings = transaction.objectStore(SAVINGS_STORE);
        if (!savings.indexNames.contains('by_type')) savings.createIndex('by_type', 'type', { unique: false });
        if (!savings.indexNames.contains('by_salaryRecordId')) savings.createIndex('by_salaryRecordId', 'salaryRecordId', { unique: false });
        // Missing expenseId fields are omitted from this index. The unique
        // index then guarantees one savings withdrawal per linked expense.
        if (!savings.indexNames.contains('by_expenseId')) savings.createIndex('by_expenseId', 'expenseId', { unique: true });
        ensureExtraIncomeStore(db);
      } catch (error) {
        // Abort the versionchange transaction so IndexedDB rolls back to the
        // previous schema instead of leaving a half-created database.
        try { request.transaction?.abort(); } catch { /* already finished */ }
        console.error('Spendly database upgrade failed:', error);
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // Let a future version upgrade instead of blocking other tabs.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open the local database.'));
    request.onblocked = () => reject(new Error('The local database is open in another tab. Close other Spendly tabs and reload.'));
  });
}

/** Alias with the app-wide naming; `openExpenseDB` stays for older callers. */
export const openSpendlyDB = openExpenseDB;

/** Generic single-store helper shared by the finance collections. */
class IndexedDBCollection {
  constructor(db, storeName) {
    if (!db) throw new Error('A database connection is required.');
    this.db = db;
    this.storeName = storeName;
  }

  run(stores, mode, operation) {
    return new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = this.db.transaction(stores, mode);
      } catch (error) {
        reject(error);
        return;
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Database transaction failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Database transaction was cancelled.'));

      try {
        operation(transaction);
      } catch (error) {
        try { transaction.abort(); } catch { /* already finished */ }
        reject(error);
      }
    });
  }

  async getAll() {
    const transaction = this.db.transaction(this.storeName, 'readonly');
    return requestToPromise(transaction.objectStore(this.storeName).getAll());
  }

  async get(id) {
    const transaction = this.db.transaction(this.storeName, 'readonly');
    return requestToPromise(transaction.objectStore(this.storeName).get(id));
  }

  async count() {
    const transaction = this.db.transaction(this.storeName, 'readonly');
    return requestToPromise(transaction.objectStore(this.storeName).count());
  }

  /** All records matching one value of a (non-unique) index. */
  async getAllByIndex(indexName, key) {
    const transaction = this.db.transaction(this.storeName, 'readonly');
    const index = transaction.objectStore(this.storeName).index(indexName);
    return requestToPromise(index.getAll(IDBKeyRange.only(key)));
  }

  /** First record matching a unique index value. */
  async getByIndex(indexName, key) {
    const transaction = this.db.transaction(this.storeName, 'readonly');
    const index = transaction.objectStore(this.storeName).index(indexName);
    return requestToPromise(index.get(IDBKeyRange.only(key)));
  }

  put(record) {
    return this.run([this.storeName], 'readwrite', transaction => {
      transaction.objectStore(this.storeName).put(record);
    });
  }

  putMany(records) {
    if (!records.length) return Promise.resolve();
    return this.run([this.storeName], 'readwrite', transaction => {
      const store = transaction.objectStore(this.storeName);
      for (const record of records) store.put(record);
    });
  }

  delete(id) {
    return this.run([this.storeName], 'readwrite', transaction => {
      transaction.objectStore(this.storeName).delete(id);
    });
  }

  clear() {
    return this.run([this.storeName], 'readwrite', transaction => {
      transaction.objectStore(this.storeName).clear();
    });
  }

  /** Atomically replace every record. A failed write leaves the old set intact. */
  replaceAll(records) {
    return this.run([this.storeName], 'readwrite', transaction => {
      const store = transaction.objectStore(this.storeName);
      store.clear();
      for (const record of records) store.put(record);
    });
  }

  close() {
    this.db.close();
  }
}

export class IndexedDBSalaryStore extends IndexedDBCollection {
  constructor(db) {
    super(db, SALARIES_STORE);
  }

  getByMonth(monthKey) {
    return this.getByIndex('by_monthKey', monthKey);
  }
}

export class IndexedDBSavingsStore extends IndexedDBCollection {
  constructor(db) {
    super(db, SAVINGS_STORE);
  }

  getByMonth(monthKey) {
    return this.getAllByIndex('by_monthKey', monthKey);
  }

  getByDateRange(startISO, endExclusiveISO) {
    const transaction = this.db.transaction(SAVINGS_STORE, 'readonly');
    const index = transaction.objectStore(SAVINGS_STORE).index('by_date');
    const range = IDBKeyRange.bound(startISO, endExclusiveISO, false, true);
    return requestToPromise(index.getAll(range));
  }
}

export class IndexedDBExtraIncomeStore extends IndexedDBCollection {
  constructor(db) { super(db, EXTRA_INCOME_STORE); }
}

export class IndexedDBExpenseStore {
  constructor(db) {
    if (!db) throw new Error('A database connection is required.');
    this.db = db;
  }

  #run(stores, mode, operation) {
    return new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = this.db.transaction(stores, mode);
      } catch (error) {
        reject(error);
        return;
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Database transaction failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Database transaction was cancelled.'));

      try {
        operation(transaction);
      } catch (error) {
        try { transaction.abort(); } catch { /* already finished */ }
        reject(error);
      }
    });
  }

  async getAll() {
    const transaction = this.db.transaction(EXPENSES_STORE, 'readonly');
    return requestToPromise(transaction.objectStore(EXPENSES_STORE).getAll());
  }

  async get(id) {
    const transaction = this.db.transaction(EXPENSES_STORE, 'readonly');
    return requestToPromise(transaction.objectStore(EXPENSES_STORE).get(id));
  }

  async getByDateRange(startISO, endExclusiveISO) {
    const transaction = this.db.transaction(EXPENSES_STORE, 'readonly');
    const index = transaction.objectStore(EXPENSES_STORE).index('by_date');
    const range = IDBKeyRange.bound(startISO, endExclusiveISO, false, true);
    return requestToPromise(index.getAll(range));
  }

  async count() {
    const transaction = this.db.transaction(EXPENSES_STORE, 'readonly');
    return requestToPromise(transaction.objectStore(EXPENSES_STORE).count());
  }

  put(record) {
    return this.#run([EXPENSES_STORE], 'readwrite', transaction => {
      transaction.objectStore(EXPENSES_STORE).put(record);
    });
  }

  putMany(records) {
    if (!records.length) return Promise.resolve();
    return this.#run([EXPENSES_STORE], 'readwrite', transaction => {
      const store = transaction.objectStore(EXPENSES_STORE);
      for (const record of records) store.put(record);
    });
  }

  delete(id) {
    return this.#run([EXPENSES_STORE], 'readwrite', transaction => {
      transaction.objectStore(EXPENSES_STORE).delete(id);
    });
  }

  clear() {
    return this.#run([EXPENSES_STORE], 'readwrite', transaction => {
      transaction.objectStore(EXPENSES_STORE).clear();
    });
  }

  /** Atomically replace every expense. A failed write leaves the old set intact. */
  replaceAll(records) {
    return this.#run([EXPENSES_STORE], 'readwrite', transaction => {
      const store = transaction.objectStore(EXPENSES_STORE);
      store.clear();
      for (const record of records) store.put(record);
    });
  }

  async getMeta(key) {
    const transaction = this.db.transaction(META_STORE, 'readonly');
    return requestToPromise(transaction.objectStore(META_STORE).get(key));
  }

  setMeta(value) {
    return this.#run([META_STORE], 'readwrite', transaction => {
      transaction.objectStore(META_STORE).put(value);
    });
  }

  close() {
    this.db.close();
  }
}
