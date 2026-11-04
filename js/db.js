/**
 * IndexedDB adapter for Spendly.
 *
 * This is the only module that knows about databases, stores or indexes. The
 * repository and the UI talk to the small async interface implemented here.
 */

import { DB_NAME, DB_VERSION } from './core.js';

export const EXPENSES_STORE = 'expenses';
export const META_STORE = 'meta';

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

/** Open (and if needed create) the Spendly database. */
export function openExpenseDB(factory = globalThis.indexedDB) {
  if (!factory) return Promise.reject(new Error('IndexedDB is not available in this browser.'));

  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
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
