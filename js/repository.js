/**
 * Expense repository.
 *
 * The UI only ever calls this class. Records have stable ids and ISO
 * `createdAt` / `updatedAt` timestamps, so a future remote adapter (or a
 * sync-aware repository) can be introduced without touching the interface.
 */

import {
  STORAGE_KEY,
  computeSalaryPool,
  computeSavingsBalance,
  findActiveSalary,
  localToday,
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

export class InsufficientSavingsError extends Error {
  constructor(availablePaise) {
    super('Insufficient savings balance. Lower the amount or choose Salary Balance.');
    this.name = 'InsufficientSavingsError';
    this.availablePaise = availablePaise;
  }
}

export class NoActiveSalaryError extends Error {
  constructor() {
    super('Add a salary before using Salary Balance or recording a salary-funded savings contribution.');
    this.name = 'NoActiveSalaryError';
  }
}

export class ReferencedSalaryError extends Error {
  constructor() {
    super('This salary still has allocated expenses or savings. Keep it so the financial history stays accurate.');
    this.name = 'ReferencedSalaryError';
  }
}

export class InsufficientSalaryBalanceError extends Error {
  constructor() {
    super('The salary pool no longer has enough remaining balance for this transfer.');
    this.name = 'InsufficientSalaryBalanceError';
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

    const now = this.now();
    const latestCreatedAt = (await this.store.getAll()).reduce((latest, record) => {
      const value = Date.parse(record.createdAt ?? '');
      return Number.isFinite(value) ? Math.max(latest, value) : latest;
    }, -Infinity);
    const timestamp = new Date(Math.max(now.getTime(), Number.isFinite(latestCreatedAt) ? latestCreatedAt + 1 : now.getTime())).toISOString();
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

const ALLOCATION_MIGRATION_KEY = 'migration:salary-allocation:v1';
const FINANCIAL_STORES = ['expenses', 'salaries', 'savings', 'meta'];

/**
 * Multi-store ledger operations. Related expense/withdrawal changes use one
 * IndexedDB transaction so a failure cannot leave only half a money movement.
 */
export class FinancialLedgerRepository {
  constructor(db, options = {}) {
    if (!db) throw new Error('A database connection is required.');
    this.db = db;
    this.now = options.now ?? (() => new Date());
    this.makeId = options.makeId ?? defaultMakeId;
  }

  #transaction(stores, mode, operation) {
    return new Promise((resolve, reject) => {
      let transaction;
      let result;
      let failure = null;
      try {
        transaction = this.db.transaction(stores, mode);
      } catch (error) {
        reject(error);
        return;
      }

      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(failure ?? transaction.error ?? new Error('Financial transaction failed.'));
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Financial transaction was cancelled.'));

      const collections = Object.fromEntries(stores.map(name => [name, transaction.objectStore(name)]));
      const snapshots = {};
      let pending = stores.length;
      for (const name of stores) {
        const request = collections[name].getAll();
        request.onsuccess = () => {
          snapshots[name] = request.result;
          pending -= 1;
          if (pending !== 0) return;
          try {
            result = operation({ transaction, collections, snapshots });
          } catch (error) {
            failure = error;
            try { transaction.abort(); } catch { /* already completed */ }
          }
        };
        request.onerror = () => {
          failure = request.error ?? new Error('Could not read financial records.');
          try { transaction.abort(); } catch { /* already completed */ }
        };
      }
    });
  }

  /** Idempotent timestamp-based v2 migration; ambiguous records stay reviewable. */
  migrateAllocations() {
    return this.#transaction(FINANCIAL_STORES, 'readwrite', ({ collections, snapshots }) => {
      const existing = snapshots.meta.find(record => record.key === ALLOCATION_MIGRATION_KEY);
      if (existing) return { status: 'already-migrated', ...existing };

      const salaries = snapshots.salaries;
      const assignSalary = createdAt => {
        const transactionTime = Date.parse(createdAt ?? '');
        if (!Number.isFinite(transactionTime)) return null;
        return salaries
          .filter(salary => {
            const salaryTime = Date.parse(salary.createdAt ?? '');
            return Number.isFinite(salaryTime) && salaryTime <= transactionTime;
          })
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.id).localeCompare(String(a.id)))[0] ?? null;
      };

      const expenses = snapshots.expenses.map(expense => {
        if (expense.salaryRecordId || expense.paymentSource === 'savings') return expense;
        const salary = assignSalary(expense.createdAt);
        const updated = {
          ...expense,
          paymentSource: 'salary',
          salaryRecordId: salary?.id ?? null,
          ...(salary ? { allocationStatus: undefined } : { allocationStatus: 'needs_review' })
        };
        if (updated.allocationStatus === undefined) delete updated.allocationStatus;
        collections.expenses.put(updated);
        return updated;
      });

      const savings = snapshots.savings.map(record => {
        if (record.type) return record;
        const salary = assignSalary(record.createdAt);
        const updated = {
          ...record,
          type: 'contribution',
          ...(salary ? { salaryRecordId: salary.id } : { allocationStatus: 'needs_review' })
        };
        collections.savings.put(updated);
        return updated;
      });

      const unresolvedExpenseIds = expenses.filter(record => record.paymentSource === 'salary' && !record.salaryRecordId).map(record => record.id);
      const unresolvedSavingIds = savings.filter(record => record.type === 'contribution' && !record.salaryRecordId).map(record => record.id);
      const marker = {
        key: ALLOCATION_MIGRATION_KEY,
        version: 1,
        mode: 'createdAt-active-salary',
        migratedAt: this.now().toISOString(),
        unresolvedExpenseIds,
        unresolvedSavingIds
      };
      collections.meta.put(marker);
      return { status: 'migrated', ...marker };
    });
  }

  /** Atomically replace the supplied collections and validate their links. */
  replaceCollections(data) {
    return this.#transaction(FINANCIAL_STORES, 'readwrite', ({ collections, snapshots }) => {
      const salaries = Array.isArray(data.salaries) ? data.salaries : snapshots.salaries;
      const salaryIds = new Set(salaries.map(record => record.id));
      const assignSalary = createdAt => {
        const transactionTime = Date.parse(createdAt ?? '');
        if (!Number.isFinite(transactionTime)) return null;
        return salaries.filter(record => {
          const salaryTime = Date.parse(record.createdAt ?? '');
          return Number.isFinite(salaryTime) && salaryTime <= transactionTime;
        }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.id).localeCompare(String(a.id)))[0] ?? null;
      };
      const expenses = Array.isArray(data.expenses) ? data.expenses : snapshots.expenses;
      const savings = Array.isArray(data.savings) ? data.savings : snapshots.savings;
      const preparedExpenses = expenses.map(record => {
        if (record.paymentSource) return record;
        const previous = snapshots.expenses.find(item => item.id === record.id);
        if (previous?.paymentSource && previous.date === record.date && Number(previous.amount) === Number(record.amount) && previous.description === record.description) {
          return { ...record, paymentSource: previous.paymentSource, salaryRecordId: previous.salaryRecordId ?? null, ...(previous.allocationStatus ? { allocationStatus: previous.allocationStatus } : {}) };
        }
        const salary = assignSalary(record.createdAt);
        return {
          ...record, paymentSource: 'salary', salaryRecordId: salary?.id ?? null,
          ...(salary ? {} : { allocationStatus: 'needs_review' })
        };
      });
      let preparedSavings = savings.map(record => {
        if (record.type) return record;
        const previous = snapshots.savings.find(item => item.id === record.id);
        if (previous?.type && previous.date === record.date && Number(previous.amount) === Number(record.amount) && previous.description === record.description) return previous;
        const salary = assignSalary(record.createdAt);
        return {
          ...record, type: 'contribution', ...(salary ? { salaryRecordId: salary.id } : { allocationStatus: 'needs_review' })
        };
      });

      if (!Array.isArray(data.savings) && Array.isArray(data.expenses)) {
        const retainedExpenseIds = new Set(preparedExpenses.map(record => record.id));
        preparedSavings = preparedSavings.filter(record => record.type !== 'withdrawal' || retainedExpenseIds.has(record.expenseId));
      }

      const expenseById = new Map(preparedExpenses.map(record => [record.id, record]));
      const withdrawalByExpense = new Map();
      for (const record of preparedSavings) {
        if (record.salaryRecordId && !salaryIds.has(record.salaryRecordId)) {
          throw new ValidationError({ backup: 'A savings record refers to a salary that is missing from this backup.' });
        }
        if (record.type === 'withdrawal') {
          const expense = expenseById.get(record.expenseId);
          if (!expense || expense.paymentSource !== 'savings' || Math.round(expense.amount * 100) !== Math.round(record.amount * 100)) {
            throw new ValidationError({ backup: 'A savings withdrawal does not match its linked expense.' });
          }
          if (withdrawalByExpense.has(record.expenseId)) throw new ValidationError({ backup: 'An expense has duplicate savings withdrawals.' });
          withdrawalByExpense.set(record.expenseId, record);
        }
      }
      for (const record of preparedExpenses) {
        if (record.salaryRecordId && !salaryIds.has(record.salaryRecordId)) {
          throw new ValidationError({ backup: 'An expense refers to a salary that is missing from this backup.' });
        }
        if (record.paymentSource === 'savings' && !withdrawalByExpense.has(record.id)) {
          throw new ValidationError({ backup: 'A savings-funded expense is missing its withdrawal record.' });
        }
      }
      if (computeSavingsBalance(preparedSavings).balancePaise < 0) {
        throw new ValidationError({ backup: 'This backup would make the savings balance negative.' });
      }

      if (Array.isArray(data.expenses)) {
        collections.expenses.clear();
        for (const record of preparedExpenses) collections.expenses.put(record);
      }
      if (Array.isArray(data.salaries)) {
        collections.salaries.clear();
        for (const record of salaries) collections.salaries.put(record);
      }
      if (Array.isArray(data.savings) || (Array.isArray(data.expenses) && preparedSavings.length !== snapshots.savings.length)) {
        collections.savings.clear();
        for (const record of preparedSavings) collections.savings.put(record);
      }

      const unresolvedExpenseIds = preparedExpenses.filter(record => record.allocationStatus === 'needs_review').map(record => record.id);
      const unresolvedSavingIds = preparedSavings.filter(record => record.allocationStatus === 'needs_review').map(record => record.id);
      collections.meta.put({
        key: ALLOCATION_MIGRATION_KEY, version: 1, mode: 'createdAt-active-salary',
        migratedAt: this.now().toISOString(), unresolvedExpenseIds, unresolvedSavingIds
      });
      return { expenseCount: preparedExpenses.length, salaryCount: salaries.length, savingsCount: preparedSavings.length };
    });
  }

  /** Add a salary-funded or savings-funded expense with the current allocation. */
  createExpense(input) {
    const checked = validateExpenseInput(input);
    if (!checked.ok) throw new ValidationError(checked.errors);
    const paymentSource = input.paymentSource === 'savings' ? 'savings' : 'salary';
    const timestamp = this.now().toISOString();
    return this.#transaction(['expenses', 'salaries', 'savings'], 'readwrite', ({ collections, snapshots }) => {
      const activeSalary = findActiveSalary(snapshots.salaries);
      if (paymentSource === 'salary' && !activeSalary) throw new NoActiveSalaryError();
      const expense = {
        id: this.makeId(), ...checked.value,
        paymentSource,
        salaryRecordId: paymentSource === 'salary' ? activeSalary.id : null,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      if (paymentSource === 'savings') {
        const amountPaise = Math.round(expense.amount * 100);
        const balance = computeSavingsBalance(snapshots.savings);
        if (balance.balancePaise < amountPaise) throw new InsufficientSavingsError(balance.balancePaise);
        collections.savings.add({
          id: this.makeId(), monthKey: expense.date.slice(0, 7), amount: expense.amount, amountPaise,
          date: expense.date, description: expense.description, type: 'withdrawal', expenseId: expense.id,
          createdAt: timestamp, updatedAt: timestamp
        });
      }
      collections.expenses.add(expense);
      return expense;
    });
  }

  updateExpense(id, input) {
    const checked = validateExpenseInput(input);
    if (!checked.ok) throw new ValidationError(checked.errors);
    const timestamp = this.now().toISOString();
    return this.#transaction(['expenses', 'salaries', 'savings'], 'readwrite', ({ collections, snapshots }) => {
      const existing = snapshots.expenses.find(record => record.id === id);
      if (!existing) throw new NotFoundError(id);
      const source = input.paymentSource === 'savings' ? 'savings' : 'salary';
      const withdrawal = snapshots.savings.find(record => record.type === 'withdrawal' && record.expenseId === id);
      const activeSalary = findActiveSalary(snapshots.salaries);
      if (source === 'salary' && !activeSalary) {
        throw new NoActiveSalaryError();
      }

      const salaryRecordId = source === 'savings'
        ? null
        : (existing.paymentSource === 'savings' ? activeSalary.id : existing.salaryRecordId ?? activeSalary.id);
      const expense = {
        ...existing, ...checked.value, paymentSource: source, salaryRecordId,
        ...(salaryRecordId ? { allocationStatus: undefined } : {}),
        id: existing.id, createdAt: existing.createdAt, updatedAt: timestamp
      };
      if (expense.allocationStatus === undefined) delete expense.allocationStatus;

      if (source === 'savings') {
        const balance = computeSavingsBalance(snapshots.savings);
        const available = balance.balancePaise + (withdrawal ? Math.round(Number(withdrawal.amount) * 100) : 0);
        const newAmountPaise = Math.round(expense.amount * 100);
        if (available < newAmountPaise) throw new InsufficientSavingsError(available);
        const newWithdrawal = {
          id: withdrawal?.id ?? this.makeId(), monthKey: expense.date.slice(0, 7), amount: expense.amount,
          amountPaise: newAmountPaise, date: expense.date, description: expense.description,
          type: 'withdrawal', expenseId: expense.id, createdAt: withdrawal?.createdAt ?? timestamp, updatedAt: timestamp
        };
        collections.savings.put(newWithdrawal);
      } else if (withdrawal) {
        collections.savings.delete(withdrawal.id);
      }
      collections.expenses.put(expense);
      return expense;
    });
  }

  removeExpense(id) {
    return this.#transaction(['expenses', 'salaries', 'savings'], 'readwrite', ({ collections, snapshots }) => {
      const expense = snapshots.expenses.find(record => record.id === id);
      if (!expense) throw new NotFoundError(id);
      collections.expenses.delete(id);
      for (const record of snapshots.savings) {
        if (record.type === 'withdrawal' && record.expenseId === id) collections.savings.delete(record.id);
      }
      return expense;
    });
  }

  restoreExpense(raw) {
    const checked = normalizeExpenseRecord(raw, { now: this.now, makeId: this.makeId });
    if (!checked.ok) throw new ValidationError(checked.errors, 'That expense could not be restored.');
    const expense = checked.value;
    return this.#transaction(['expenses', 'salaries', 'savings'], 'readwrite', ({ collections, snapshots }) => {
      if (snapshots.expenses.some(record => record.id === expense.id)) return expense;
      if (expense.paymentSource === 'savings') {
        const amountPaise = Math.round(expense.amount * 100);
        const balance = computeSavingsBalance(snapshots.savings);
        if (balance.balancePaise < amountPaise) throw new InsufficientSavingsError(balance.balancePaise);
        collections.savings.add({
          id: this.makeId(), monthKey: expense.date.slice(0, 7), amount: expense.amount, amountPaise,
          date: expense.date, description: expense.description, type: 'withdrawal', expenseId: expense.id,
          createdAt: expense.createdAt, updatedAt: expense.updatedAt
        });
      }
      collections.expenses.add(expense);
      return expense;
    });
  }

  createContribution(input) {
    const now = this.now();
    const checked = validateSavingInput(input, now);
    if (!checked.ok) throw new ValidationError(checked.errors, 'These savings details are not valid.');
    const timestamp = now.toISOString();
    return this.#transaction(['expenses', 'salaries', 'savings'], 'readwrite', ({ collections, snapshots }) => {
      const activeSalary = findActiveSalary(snapshots.salaries);
      if (!activeSalary) throw new NoActiveSalaryError();
      const record = {
        id: this.makeId(), ...checked.value, type: 'contribution', salaryRecordId: activeSalary.id,
        createdAt: timestamp, updatedAt: timestamp
      };
      collections.savings.add(record);
      return record;
    });
  }

  updateSaving(id, input) {
    const now = this.now();
    const checked = validateSavingInput(input, now);
    if (!checked.ok) throw new ValidationError(checked.errors, 'These savings details are not valid.');
    const timestamp = now.toISOString();
    return this.#transaction(['expenses', 'salaries', 'savings'], 'readwrite', ({ collections, snapshots }) => {
      const existing = snapshots.savings.find(record => record.id === id);
      if (!existing) throw new NotFoundError(id, 'That savings entry no longer exists.');
      if (existing.type === 'withdrawal') throw new ValidationError({ record: 'Edit this withdrawal from its linked expense.' });
      const record = { ...existing, ...checked.value, id, type: existing.type ?? 'contribution', createdAt: existing.createdAt, updatedAt: timestamp };
      const savingsBalance = computeSavingsBalance(snapshots.savings);
      const oldAmountPaise = Math.round(Number(existing.amount) * 100);
      const newAmountPaise = Math.round(Number(record.amount) * 100);
      if (savingsBalance.balancePaise - oldAmountPaise + newAmountPaise < 0) {
        throw new InsufficientSavingsError(savingsBalance.balancePaise - oldAmountPaise);
      }
      if (record.type === 'salary_balance_transfer') {
        const salary = snapshots.salaries.find(item => item.id === existing.salaryRecordId);
        if (salary) {
          const available = computeSalaryPool(salary, snapshots.expenses, snapshots.savings).remainingPaise + oldAmountPaise;
          if (newAmountPaise > available) throw new InsufficientSalaryBalanceError();
        }
      }
      collections.savings.put(record);
      return record;
    });
  }

  removeSaving(id) {
    return this.#transaction(['expenses', 'salaries', 'savings'], 'readwrite', ({ collections, snapshots }) => {
      const record = snapshots.savings.find(item => item.id === id);
      if (!record) throw new NotFoundError(id, 'That savings entry no longer exists.');
      if (record.type === 'withdrawal') throw new ValidationError({ record: 'Remove this withdrawal by editing or deleting its linked expense.' });
      const balance = computeSavingsBalance(snapshots.savings);
      if (record.type !== 'withdrawal' && balance.balancePaise - Math.round(Number(record.amount) * 100) < 0) {
        throw new InsufficientSavingsError(balance.balancePaise - Math.round(Number(record.amount) * 100));
      }
      collections.savings.delete(id);
      return record;
    });
  }

  restoreSaving(raw) {
    const checked = normalizeSavingRecord(raw, { now: this.now, makeId: this.makeId });
    if (!checked.ok) throw new ValidationError(checked.errors, 'That savings entry could not be restored.');
    const record = checked.value;
    return this.#transaction(['expenses', 'salaries', 'savings'], 'readwrite', ({ collections, snapshots }) => {
      if (snapshots.savings.some(item => item.id === record.id)) return record;
      if (record.type === 'withdrawal') {
        const expense = snapshots.expenses.find(item => item.id === record.expenseId);
        if (!expense) throw new ValidationError({ record: 'The linked expense is missing; this withdrawal cannot be restored alone.' });
        const balance = computeSavingsBalance(snapshots.savings);
        if (balance.balancePaise < Math.round(record.amount * 100)) throw new InsufficientSavingsError(balance.balancePaise);
      }
      collections.savings.add(record);
      return record;
    });
  }

  transferSalaryBalance(salaryId) {
    const now = this.now();
    const timestamp = now.toISOString();
    return this.#transaction(['expenses', 'salaries', 'savings'], 'readwrite', ({ collections, snapshots }) => {
      const salary = snapshots.salaries.find(record => record.id === salaryId);
      if (!salary) throw new NotFoundError(salaryId, 'That salary no longer exists.');
      const pool = computeSalaryPool(salary, snapshots.expenses, snapshots.savings);
      if (pool.remainingPaise <= 0) throw new InsufficientSalaryBalanceError();
      const record = {
        id: this.makeId(), monthKey: localToday(now).slice(0, 7), amount: pool.remaining,
        amountPaise: pool.remainingPaise, date: localToday(now), description: `Remaining ${salary.monthKey} salary`,
        type: 'salary_balance_transfer', salaryRecordId: salary.id, createdAt: timestamp, updatedAt: timestamp
      };
      collections.savings.add(record);
      return record;
    });
  }

  deleteSalaryIfUnused(id) {
    return this.#transaction(['expenses', 'salaries', 'savings'], 'readwrite', ({ collections, snapshots }) => {
      const used = snapshots.expenses.some(record => record.salaryRecordId === id) ||
        snapshots.savings.some(record => record.salaryRecordId === id);
      if (used) throw new ReferencedSalaryError();
      collections.salaries.delete(id);
    });
  }
}
