/**
 * Expense repository.
 *
 * The UI only ever calls this class. Records have stable ids and ISO
 * `createdAt` / `updatedAt` timestamps, so a future remote adapter (or a
 * sync-aware repository) can be introduced without touching the interface.
 */

import {
  STORAGE_KEY,
  isMonthKey,
  normalizeExpenseRecord,
  normalizeSalaryRecord,
  normalizeSavingRecord,
  sortExpenses,
  sortSavings,
  validateExpenseInput,
  validateSalaryInput,
  validateSavingInput
} from './core.js';

export const MIGRATION_META_KEY = 'migration:localStorage:v1';
export const MIGRATION_VERSION = 1;

export class ValidationError extends Error {
  constructor(errors, message = 'These expense details are not valid.') {
    super(message);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

export class NotFoundError extends Error {
  constructor(id, message = 'That expense no longer exists.') {
    super(message);
    this.name = 'NotFoundError';
    this.id = id;
  }
}

/** The database enforces one salary per month; this maps that to a clear message. */
export class DuplicateMonthError extends Error {
  constructor(monthKey) {
    super('That month already has a salary. Edit it instead of adding a second one.');
    this.name = 'DuplicateMonthError';
    this.monthKey = monthKey;
  }
}

function isConstraintError(error) {
  return error?.name === 'ConstraintError' || /constraint/i.test(error?.message ?? '');
}

function defaultMakeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function resolveStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export class ExpenseRepository {
  constructor(store, options = {}) {
    if (!store) throw new Error('A storage adapter is required.');
    this.store = store;
    this.now = options.now ?? (() => new Date());
    this.makeId = options.makeId ?? defaultMakeId;
  }

  async list() {
    return sortExpenses(await this.store.getAll());
  }

  async listByDateRange(startISO, endExclusiveISO) {
    const records = await this.store.getByDateRange(startISO, endExclusiveISO);
    return sortExpenses(records);
  }

  async get(id) {
    return this.store.get(id);
  }

  async create(input) {
    const checked = validateExpenseInput(input);
    if (!checked.ok) throw new ValidationError(checked.errors);

    const timestamp = this.now().toISOString();
    const record = {
      id: this.makeId(),
      ...checked.value,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    await this.store.put(record);
    return record;
  }

  async update(id, input) {
    const existing = await this.store.get(id);
    if (!existing) throw new NotFoundError(id);

    const checked = validateExpenseInput(input);
    if (!checked.ok) throw new ValidationError(checked.errors);

    const record = {
      ...existing,
      ...checked.value,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: this.now().toISOString()
    };

    await this.store.put(record);
    return record;
  }

  async remove(id) {
    await this.store.delete(id);
  }

  /** Put a previously validated record back (used by "Undo"). */
  async restore(record) {
    const checked = normalizeExpenseRecord(record, { now: this.now, makeId: this.makeId });
    if (!checked.ok) throw new ValidationError(checked.errors, 'That expense could not be restored.');
    await this.store.put(checked.value);
    return checked.value;
  }

  /**
   * Replace the whole collection in one atomic transaction.
   * Returns the number of unique records written.
   */
  async replaceAll(records) {
    if (!Array.isArray(records)) throw new ValidationError({ records: 'Expected a list of expenses.' });

    const byId = new Map();
    const errors = [];
    for (const [index, raw] of records.entries()) {
      const checked = normalizeExpenseRecord(raw, { now: this.now, makeId: this.makeId });
      if (!checked.ok) {
        errors.push(`Record ${index + 1}: ${checked.reasons.join(' ')}`);
        continue;
      }
      byId.set(checked.value.id, checked.value);
    }

    if (errors.length) {
      throw new ValidationError(
        { records: errors.slice(0, 5).join(' ') },
        `${errors.length} record${errors.length === 1 ? '' : 's'} in this file could not be read.`
      );
    }

    const unique = [...byId.values()];
    await this.store.replaceAll(unique);
    return { count: unique.length, duplicatesRemoved: records.length - unique.length };
  }

  /**
   * Move records from the pre-IndexedDB version into IndexedDB.
   *
   * Safety rules:
   *  - never delete or modify the original localStorage value;
   *  - run once, guarded by a completion marker in IndexedDB;
   *  - write with stable ids, so a repeated run cannot duplicate records;
   *  - read the records back before writing the completion marker;
   *  - leave IndexedDB records untouched if the same id already exists.
   */
  async migrateLegacy(storage) {
    const source = resolveStorage(storage);
    if (!source) return { status: 'unavailable', imported: 0 };

    const previous = await this.store.getMeta(MIGRATION_META_KEY).catch(() => null);
    if (previous?.completedAt) {
      return {
        status: 'already-migrated',
        imported: 0,
        previous,
        total: previous.imported ?? 0
      };
    }

    let rawValue;
    try {
      rawValue = source.getItem(STORAGE_KEY);
    } catch {
      return { status: 'unreadable', imported: 0 };
    }

    if (rawValue === null || rawValue === undefined) {
      await this.#markMigration({ imported: 0, reason: 'no-legacy-data' });
      return { status: 'empty', imported: 0 };
    }

    let parsed;
    try {
      parsed = JSON.parse(rawValue);
    } catch {
      return { status: 'invalid-json', imported: 0 };
    }

    if (!Array.isArray(parsed)) return { status: 'invalid-shape', imported: 0 };

    if (parsed.length === 0) {
      await this.#markMigration({ imported: 0, reason: 'empty-list' });
      return { status: 'empty', imported: 0 };
    }

    const valid = [];
    let invalid = 0;
    for (const raw of parsed) {
      const checked = normalizeExpenseRecord(raw, { now: this.now, makeId: this.makeId });
      if (checked.ok) valid.push(checked.value);
      else invalid += 1;
    }

    if (!valid.length) {
      return { status: 'no-valid-records', imported: 0, invalid };
    }

    // De-duplicate ids inside the legacy payload (first occurrence wins).
    const unique = new Map();
    for (const record of valid) {
      if (!unique.has(record.id)) unique.set(record.id, record);
    }

    const existing = await this.store.getAll();
    const existingIds = new Set(existing.map(record => record.id));
    const pending = [...unique.values()].filter(record => !existingIds.has(record.id));

    if (pending.length) await this.store.putMany(pending);

    // Verify before marking the migration as complete.
    const after = await this.store.getAll();
    const afterIds = new Set(after.map(record => record.id));
    const missing = [...unique.values()].filter(record => !afterIds.has(record.id));
    if (missing.length) {
      throw new Error(`Migration verification failed: ${missing.length} expense(s) were not saved.`);
    }

    const summary = {
      imported: pending.length,
      alreadyPresent: unique.size - pending.length,
      duplicates: valid.length - unique.size,
      invalid,
      sourceKey: STORAGE_KEY
    };
    await this.#markMigration(summary);

    return {
      status: 'migrated',
      total: parsed.length,
      ...summary
    };
  }

  async #markMigration(details) {
    await this.store.setMeta({
      key: MIGRATION_META_KEY,
      version: MIGRATION_VERSION,
      completedAt: this.now().toISOString(),
      ...details
    });
  }

  close() {
    this.store.close?.();
  }
}

/* -------------------------------------------------------------------------- */
/* Salary                                                                     */
/* -------------------------------------------------------------------------- */

/** Newest month first; the ordering is purely calendar-based. */
export function sortSalaries(records) {
  return [...records].sort((a, b) => {
    if (a.monthKey !== b.monthKey) return a.monthKey < b.monthKey ? 1 : -1;
    if ((a.createdAt || '') !== (b.createdAt || '')) return (a.createdAt || '') < (b.createdAt || '') ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/**
 * Salary is manual, one record per calendar month.
 *
 * Duplicates are blocked twice: a friendly check here and a unique index in
 * IndexedDB. Editing a month never touches another month's record.
 */
export class SalaryRepository {
  constructor(store, options = {}) {
    if (!store) throw new Error('A storage adapter is required.');
    this.store = store;
    this.now = options.now ?? (() => new Date());
    this.makeId = options.makeId ?? defaultMakeId;
  }

  async list() {
    return sortSalaries(await this.store.getAll());
  }

  async get(id) {
    return this.store.get(id);
  }

  async getByMonth(monthKey) {
    if (!isMonthKey(monthKey)) return undefined;
    if (typeof this.store.getByMonth === 'function') return this.store.getByMonth(monthKey);
    const records = await this.store.getAll();
    return records.find(record => record.monthKey === monthKey);
  }

  async create(input) {
    const checked = validateSalaryInput(input);
    if (!checked.ok) throw new ValidationError(checked.errors, 'These salary details are not valid.');

    const existing = await this.getByMonth(checked.value.monthKey);
    if (existing) throw new DuplicateMonthError(checked.value.monthKey);

    const timestamp = this.now().toISOString();
    const record = {
      id: this.makeId(),
      ...checked.value,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    try {
      await this.store.put(record);
    } catch (error) {
      if (isConstraintError(error)) throw new DuplicateMonthError(record.monthKey);
      throw error;
    }
    return record;
  }

  async update(id, input) {
    const existing = await this.store.get(id);
    if (!existing) throw new NotFoundError(id, 'That salary record no longer exists.');

    const checked = validateSalaryInput(input);
    if (!checked.ok) throw new ValidationError(checked.errors, 'These salary details are not valid.');

    if (checked.value.monthKey !== existing.monthKey) {
      const clash = await this.getByMonth(checked.value.monthKey);
      if (clash && clash.id !== id) throw new DuplicateMonthError(checked.value.monthKey);
    }

    const record = {
      ...existing,
      ...checked.value,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: this.now().toISOString()
    };

    try {
      await this.store.put(record);
    } catch (error) {
      if (isConstraintError(error)) throw new DuplicateMonthError(record.monthKey);
      throw error;
    }
    return record;
  }

  async remove(id) {
    await this.store.delete(id);
  }

  /** Put a previously validated record back (used by "Undo"). */
  async restore(record) {
    const checked = normalizeSalaryRecord(record, { now: this.now, makeId: this.makeId });
    if (!checked.ok) throw new ValidationError(checked.errors, 'That salary record could not be restored.');
    try {
      await this.store.put(checked.value);
    } catch (error) {
      if (isConstraintError(error)) throw new DuplicateMonthError(checked.value.monthKey);
      throw error;
    }
    return checked.value;
  }

  /** Replace every salary record (backup restore). */
  async replaceAll(records) {
    if (!Array.isArray(records)) throw new ValidationError({ records: 'Expected a list of salaries.' });

    const byMonth = new Map();
    for (const [index, raw] of records.entries()) {
      const checked = normalizeSalaryRecord(raw, { now: this.now, makeId: this.makeId });
      if (!checked.ok) {
        throw new ValidationError(
          { records: `Record ${index + 1}: ${checked.reasons.join(' ')}` },
          'That backup contains an unreadable salary record.'
        );
      }
      if (byMonth.has(checked.value.monthKey)) {
        throw new ValidationError(
          { records: `Two salary records for ${checked.value.monthKey}.` },
          'That backup contains two salaries for the same month.'
        );
      }
      byMonth.set(checked.value.monthKey, checked.value);
    }

    await this.store.replaceAll([...byMonth.values()]);
    return { count: byMonth.size };
  }

  close() {
    this.store.close?.();
  }
}

/* -------------------------------------------------------------------------- */
/* Savings                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Savings live in their own object store and never enter the expense ledger
 * or expense analytics. Each entry keeps a `monthKey` derived from its date.
 */
export class SavingsRepository {
  constructor(store, options = {}) {
    if (!store) throw new Error('A storage adapter is required.');
    this.store = store;
    this.now = options.now ?? (() => new Date());
    this.makeId = options.makeId ?? defaultMakeId;
  }

  async list() {
    return sortSavings(await this.store.getAll());
  }

  async get(id) {
    return this.store.get(id);
  }

  async listByMonth(monthKey) {
    if (!isMonthKey(monthKey)) return [];
    if (typeof this.store.getByMonth === 'function') {
      const result = await this.store.getByMonth(monthKey);
      if (Array.isArray(result)) return sortSavings(result);
      if (result) return sortSavings([result]);
    }
    const records = await this.store.getAll();
    return sortSavings(records.filter(record => record.monthKey === monthKey));
  }

  async create(input) {
    const now = this.now();
    const checked = validateSavingInput(input, now);
    if (!checked.ok) throw new ValidationError(checked.errors, 'These savings details are not valid.');

    const timestamp = now.toISOString();
    const record = {
      id: this.makeId(),
      ...checked.value,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    await this.store.put(record);
    return record;
  }

  async update(id, input) {
    const existing = await this.store.get(id);
    if (!existing) throw new NotFoundError(id, 'That savings entry no longer exists.');

    const now = this.now();
    const checked = validateSavingInput(input, now);
    if (!checked.ok) throw new ValidationError(checked.errors, 'These savings details are not valid.');

    const record = {
      ...existing,
      ...checked.value,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: now.toISOString()
    };

    await this.store.put(record);
    return record;
  }

  async remove(id) {
    await this.store.delete(id);
  }

  /** Put a previously validated record back (used by "Undo"). */
  async restore(record) {
    const checked = normalizeSavingRecord(record, { now: this.now, makeId: this.makeId });
    if (!checked.ok) throw new ValidationError(checked.errors, 'That savings entry could not be restored.');
    await this.store.put(checked.value);
    return checked.value;
  }

  /** Replace every savings entry (backup restore). */
  async replaceAll(records) {
    if (!Array.isArray(records)) throw new ValidationError({ records: 'Expected a list of savings.' });

    const byId = new Map();
    for (const [index, raw] of records.entries()) {
      const checked = normalizeSavingRecord(raw, { now: this.now, makeId: this.makeId });
      if (!checked.ok) {
        throw new ValidationError(
          { records: `Record ${index + 1}: ${checked.reasons.join(' ')}` },
          'That backup contains an unreadable savings record.'
        );
      }
      byId.set(checked.value.id, checked.value);
    }

    await this.store.replaceAll([...byId.values()]);
    return { count: byId.size };
  }

  close() {
    this.store.close?.();
  }
}
