/**
 * Expense repository.
 *
 * The UI only ever calls this class. Records have stable ids and ISO
 * `createdAt` / `updatedAt` timestamps, so a future remote adapter (or a
 * sync-aware repository) can be introduced without touching the interface.
 */

import {
  STORAGE_KEY,
  OUTBOX_STORE,
  OUTBOX_STATUS,
  SYNC_STATUS,
  generateUUID,
  isValidUUID,
  computeSalaryPool,
  computeSavingsBalance,
  extraIncomeRemaining,
  fromPaise,
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
    super('This salary still has expenses, savings, or extra income linked to it. Keep it so the financial history stays accurate.');
    this.name = 'ReferencedSalaryError';
  }
}

export class InsufficientSalaryBalanceError extends Error {
  constructor(availablePaise = null) {
    super(availablePaise === null ? 'The salary pool no longer has enough remaining balance for this transfer.' : 'Insufficient balance across salary and extra income.');
    this.name = 'InsufficientSalaryBalanceError';
    this.availablePaise = availablePaise;
  }
}

export class AlreadyReversedError extends Error {
  constructor() {
    super('This transaction has already been reversed.');
    this.name = 'AlreadyReversedError';
  }
}

export class UndoDependencyError extends Error {
  constructor(message = 'This transaction has been used by a later transaction. Reverse that transaction first.') {
    super(message);
    this.name = 'UndoDependencyError';
  }
}

function isConstraintError(error) {
  return error?.name === 'ConstraintError' || /constraint/i.test(error?.message ?? '');
}

function defaultMakeId() {
  return generateUUID();
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
    this.ledgerRepo = options.ledgerRepo ?? null;
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
    if (this.ledgerRepo) return this.ledgerRepo.createSalary(input);
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
    if (this.ledgerRepo) return this.ledgerRepo.updateSalary(id, input);
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
    if (this.ledgerRepo) return this.ledgerRepo.deleteSalaryIfUnused(id);
    await this.store.delete(id);
  }

  /** Put a previously validated record back (used by "Undo"). */
  async restore(record) {
    if (this.ledgerRepo) return this.ledgerRepo.restoreSalary(record);
    const checked = normalizeSalaryRecord(record, { now: this.now, makeId: this.makeId });
    if (!checked.ok) throw new ValidationError(checked.errors, 'That salary record could not be restored.');
    try {
      await this.store.put(checked.value);
    } catch (error) {
      if (isConstraintError(error)) throw new DuplicateMonthError(record.monthKey);
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
const EXTRA_INCOME_POOL_MIGRATION_KEY = 'migration:extra-income-salary-pool:v1';
const FINANCIAL_STORES = ['expenses', 'salaries', 'savings', 'meta', 'extraIncome'];

/**
 * Multi-store ledger operations. Related expense/withdrawal changes use one
 * IndexedDB transaction so a failure cannot leave only half a money movement.
 */
export class FinancialLedgerRepository {
  #inferredUserId;

  constructor(db, options = {}) {
    if (!db) throw new Error('A database connection is required.');
    this.db = db;
    this.now = options.now ?? (() => new Date());
    this.makeId = options.makeId ?? defaultMakeId;
    this.makeOperationId = options.makeOperationId ?? generateUUID;
    this.#inferredUserId = null;
    if (typeof db.name === 'string' && db.name.startsWith('spendly_user_')) {
      this.#inferredUserId = db.name.slice('spendly_user_'.length);
    }
    this.ownerUserId = options.ownerUserId !== undefined ? options.ownerUserId : this.#inferredUserId;
    if (this.#inferredUserId && this.ownerUserId && this.ownerUserId !== this.#inferredUserId) {
      throw new Error(`Owner user ID mismatch: provided '${this.ownerUserId}', but database name is '${db.name}'`);
    }
  }

  #storesWithOutbox(baseStores) {
    const stores = new Set(baseStores);
    if (this.ownerUserId && this.db.objectStoreNames.contains('outbox')) {
      stores.add('outbox');
      if (this.db.objectStoreNames.contains('meta')) {
        stores.add('meta');
      }
    }
    return Array.from(stores);
  }

  #getNextSequence(collections, snapshots) {
    let metaRecord = snapshots.meta?.find(item => item.key === 'sync:localSequence');
    const next = (Number(metaRecord?.value) || 0) + 1;
    if (collections.meta) {
      collections.meta.put({ key: 'sync:localSequence', value: next });
    }
    if (snapshots.meta) {
      if (metaRecord) {
        metaRecord.value = next;
      } else {
        snapshots.meta.push({ key: 'sync:localSequence', value: next });
      }
    }
    return next;
  }

  #enqueueOperation(collections, snapshots, operationData) {
    if (!this.ownerUserId) return null;
    if (!collections.outbox) return null;

    if (this.#inferredUserId && this.ownerUserId !== this.#inferredUserId) {
      throw new Error(`Account ownership mismatch: repository user ${this.ownerUserId} does not match database user ${this.#inferredUserId}`);
    }

    const nextSeq = this.#getNextSequence(collections, snapshots);
    const operationId = operationData.operationId ?? this.makeOperationId();
    if (!isValidUUID(operationId)) {
      throw new Error(`Invalid UUID for outbox operation: ${operationId}`);
    }

    const record = {
      operationId,
      ownerUserId: this.ownerUserId,
      operationType: operationData.operationType,
      entityType: operationData.entityType,
      entityId: operationData.entityId,
      payload: operationData.payload ?? {},
      createdAt: operationData.createdAt ?? this.now().toISOString(),
      sequence: nextSeq,
      status: OUTBOX_STATUS.PENDING,
      attemptCount: 0,
      lastAttemptAt: null,
      lastError: null,
      dependsOn: operationData.dependsOn ?? null,
      schemaVersion: 1
    };

    collections.outbox.add(record);
    if (snapshots.outbox) {
      snapshots.outbox.push(record);
    }
    return record;
  }

  getMetadata(key) {
    return this.#transaction(['meta'], 'readonly', ({ snapshots }) => (
      snapshots.meta.find(record => record.key === key)?.value ?? null
    ));
  }

  setMetadata(key, value) {
    return this.#transaction(['meta'], 'readwrite', ({ collections }) => {
      collections.meta.put({ key, value });
    });
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

  /** Link pre-v6 income to the salary month it was already shown under. */
  migrateExtraIncomePools() {
    return this.#transaction(FINANCIAL_STORES, 'readwrite', ({ collections, snapshots }) => {
      const existing = snapshots.meta.find(record => record.key === EXTRA_INCOME_POOL_MIGRATION_KEY);
      if (existing) return { status: 'already-migrated', ...existing };

      const salaryIds = new Set(snapshots.salaries.map(record => record.id));
      const extraIncome = snapshots.extraIncome.map(record => {
        if (record.salaryRecordId && salaryIds.has(record.salaryRecordId)) return record;
        const updated = { ...record, allocationStatus: 'needs_review' };
        collections.extraIncome.put(updated);
        return updated;
      });
      const unresolvedExtraIncomeIds = extraIncome
        .filter(record => record.allocationStatus === 'needs_review' || !salaryIds.has(record.salaryRecordId))
        .map(record => record.id);
      const marker = {
        key: EXTRA_INCOME_POOL_MIGRATION_KEY,
        version: 1,
        mode: 'legacy-income-requires-explicit-salary-month',
        migratedAt: this.now().toISOString(),
        unresolvedExtraIncomeIds
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
      const extraIncome = Array.isArray(data.extraIncome) ? data.extraIncome : snapshots.extraIncome;
      const preparedExtraIncome = extraIncome.map(record => {
        if (record.salaryRecordId) {
          if (!salaryIds.has(record.salaryRecordId)) {
            throw new ValidationError({ backup: 'An extra income entry refers to a salary that is missing from this backup.' });
          }
          return record;
        }
        return { ...record, allocationStatus: 'needs_review' };
      });
      const extraIncomeIds = new Set(preparedExtraIncome.map(record => record.id));
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
        const extraAllocated = (record.extraIncomeAllocations ?? []).reduce((sum, item) => sum + (Number(item.amountPaise) || 0), 0);
        if (record.type === 'contribution' && (record.salaryAllocationPaise ?? 0) + extraAllocated > Math.round(record.amount * 100)) {
          throw new ValidationError({ backup: 'A savings contribution has invalid funding totals.' });
        }
        for (const allocation of record.extraIncomeAllocations ?? []) {
          if (!extraIncomeIds.has(allocation.extraIncomeRecordId) || !Number.isSafeInteger(allocation.amountPaise) || allocation.amountPaise < 0) {
            throw new ValidationError({ backup: 'A savings contribution refers to invalid extra income funding.' });
          }
        }
      }
      const allocationTotals = new Map();
      for (const record of preparedSavings) for (const allocation of record.extraIncomeAllocations ?? []) {
        allocationTotals.set(allocation.extraIncomeRecordId, (allocationTotals.get(allocation.extraIncomeRecordId) ?? 0) + allocation.amountPaise);
      }
      for (const income of preparedExtraIncome) if ((allocationTotals.get(income.id) ?? 0) > Math.round(income.amount * 100)) {
        throw new ValidationError({ backup: 'Savings allocations exceed an extra income record.' });
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
      if (Array.isArray(data.extraIncome)) {
        collections.extraIncome.clear();
        for (const record of preparedExtraIncome) collections.extraIncome.put(record);
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

  /** Add an expense funded by the active salary, savings or external money. */
  createExpense(input) {
    const checked = validateExpenseInput(input);
    if (!checked.ok) throw new ValidationError(checked.errors);
    const paymentSource = ['savings', 'others'].includes(input.paymentSource) ? input.paymentSource : 'salary';
    const timestamp = this.now().toISOString();
    return this.#transaction(this.#storesWithOutbox(['expenses', 'salaries', 'savings']), 'readwrite', ({ collections, snapshots }) => {
      const activeSalary = findActiveSalary(snapshots.salaries);
      if (paymentSource === 'salary' && !activeSalary) throw new NoActiveSalaryError();
      const expense = {
        id: this.makeId(), ...checked.value,
        paymentSource,
        salaryRecordId: paymentSource === 'salary' ? activeSalary.id : null,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      let linkedWithdrawal = null;
      if (paymentSource === 'savings') {
        const amountPaise = Math.round(expense.amount * 100);
        const balance = computeSavingsBalance(snapshots.savings);
        if (balance.balancePaise < amountPaise) throw new InsufficientSavingsError(balance.balancePaise);
        linkedWithdrawal = {
          id: this.makeId(), monthKey: expense.date.slice(0, 7), amount: expense.amount, amountPaise,
          date: expense.date, description: expense.description, type: 'withdrawal', expenseId: expense.id,
          createdAt: timestamp, updatedAt: timestamp
        };
        collections.savings.add(linkedWithdrawal);
      }
      collections.expenses.add(expense);
      this.#enqueueOperation(collections, snapshots, {
        operationType: 'expense:create',
        entityType: 'expense',
        entityId: expense.id,
        payload: {
          expense,
          linkedWithdrawal: linkedWithdrawal ?? null
        },
        createdAt: timestamp
      });
      return expense;
    });
  }

  updateExpense(id, input) {
    const checked = validateExpenseInput(input);
    if (!checked.ok) throw new ValidationError(checked.errors);
    const timestamp = this.now().toISOString();
    return this.#transaction(this.#storesWithOutbox(['expenses', 'salaries', 'savings']), 'readwrite', ({ collections, snapshots }) => {
      const existing = snapshots.expenses.find(record => record.id === id);
      if (!existing) throw new NotFoundError(id);
      const source = ['savings', 'others'].includes(input.paymentSource) ? input.paymentSource : 'salary';
      const withdrawal = snapshots.savings.find(record => record.type === 'withdrawal' && record.expenseId === id);
      const activeSalary = findActiveSalary(snapshots.salaries);
      if (source === 'salary' && !activeSalary) {
        throw new NoActiveSalaryError();
      }

      const salaryRecordId = source !== 'salary'
        ? null
        : (existing.paymentSource === 'savings' ? activeSalary.id : existing.salaryRecordId ?? activeSalary.id);
      const expense = {
        ...existing, ...checked.value, paymentSource: source, salaryRecordId,
        allocationStatus: undefined,
        id: existing.id, createdAt: existing.createdAt, updatedAt: timestamp
      };
      // A saved source is an explicit resolution, including Savings and Others.
      delete expense.allocationStatus;

      let newWithdrawal = null;
      let removedWithdrawalId = null;
      if (source === 'savings') {
        const balance = computeSavingsBalance(snapshots.savings);
        const available = balance.balancePaise + (withdrawal ? Math.round(Number(withdrawal.amount) * 100) : 0);
        const newAmountPaise = Math.round(expense.amount * 100);
        if (available < newAmountPaise) throw new InsufficientSavingsError(available);
        newWithdrawal = {
          id: withdrawal?.id ?? this.makeId(), monthKey: expense.date.slice(0, 7), amount: expense.amount,
          amountPaise: newAmountPaise, date: expense.date, description: expense.description,
          type: 'withdrawal', expenseId: expense.id, createdAt: withdrawal?.createdAt ?? timestamp, updatedAt: timestamp
        };
        collections.savings.put(newWithdrawal);
      } else if (withdrawal) {
        removedWithdrawalId = withdrawal.id;
        collections.savings.delete(withdrawal.id);
      }
      collections.expenses.put(expense);
      this.#enqueueOperation(collections, snapshots, {
        operationType: 'expense:update',
        entityType: 'expense',
        entityId: expense.id,
        payload: {
          expense,
          previousExpense: existing,
          linkedWithdrawal: newWithdrawal ?? null,
          removedWithdrawalId: removedWithdrawalId ?? null
        },
        createdAt: timestamp
      });
      return expense;
    });
  }

  removeExpense(id) {
    const timestamp = this.now().toISOString();
    return this.#transaction(this.#storesWithOutbox(['expenses', 'salaries', 'savings']), 'readwrite', ({ collections, snapshots }) => {
      const expense = snapshots.expenses.find(record => record.id === id);
      if (!expense) throw new NotFoundError(id);
      collections.expenses.delete(id);
      let deletedWithdrawal = null;
      for (const record of snapshots.savings) {
        if (record.type === 'withdrawal' && record.expenseId === id) {
          deletedWithdrawal = record;
          collections.savings.delete(record.id);
        }
      }
      this.#enqueueOperation(collections, snapshots, {
        operationType: 'expense:delete',
        entityType: 'expense',
        entityId: id,
        payload: {
          expenseId: id,
          deletedExpense: expense,
          deletedWithdrawal: deletedWithdrawal ?? null
        },
        createdAt: timestamp
      });
      return expense;
    });
  }

  restoreExpense(raw) {
    const checked = normalizeExpenseRecord(raw, { now: this.now, makeId: this.makeId });
    if (!checked.ok) throw new ValidationError(checked.errors, 'That expense could not be restored.');
    const expense = checked.value;
    const timestamp = this.now().toISOString();
    return this.#transaction(this.#storesWithOutbox(['expenses', 'salaries', 'savings']), 'readwrite', ({ collections, snapshots }) => {
      if (snapshots.expenses.some(record => record.id === expense.id)) return expense;
      let linkedWithdrawal = null;
      if (expense.paymentSource === 'savings') {
        const amountPaise = Math.round(expense.amount * 100);
        const balance = computeSavingsBalance(snapshots.savings);
        if (balance.balancePaise < amountPaise) throw new InsufficientSavingsError(balance.balancePaise);
        linkedWithdrawal = {
          id: this.makeId(), monthKey: expense.date.slice(0, 7), amount: expense.amount, amountPaise,
          date: expense.date, description: expense.description, type: 'withdrawal', expenseId: expense.id,
          createdAt: expense.createdAt, updatedAt: expense.updatedAt
        };
        collections.savings.add(linkedWithdrawal);
      }
      collections.expenses.add(expense);
      this.#enqueueOperation(collections, snapshots, {
        operationType: 'expense:restore',
        entityType: 'expense',
        entityId: expense.id,
        payload: {
          expense,
          linkedWithdrawal: linkedWithdrawal ?? null
        },
        createdAt: timestamp
      });
      return expense;
    });
  }

  createContribution(input) {
    const now = this.now();
    const checked = validateSavingInput(input, now);
    if (!checked.ok) throw new ValidationError(checked.errors, 'These savings details are not valid.');
    const timestamp = now.toISOString();
    return this.#transaction(this.#storesWithOutbox(['expenses', 'salaries', 'savings', 'extraIncome']), 'readwrite', ({ collections, snapshots }) => {
      const activeSalary = findActiveSalary(snapshots.salaries);
      if (!activeSalary) throw new NoActiveSalaryError();
      const pool = computeSalaryPool(activeSalary, snapshots.expenses, snapshots.savings, snapshots.extraIncome);
      const salaryAvailable = Math.max(0, pool.remainingPaise);
      const poolIncome = snapshots.extraIncome.filter(entry => !entry.reversedAt && entry.salaryRecordId === activeSalary.id);
      const extraAvailable = poolIncome.reduce((sum, entry) => sum + Math.max(0, Math.round(extraIncomeRemaining(entry, snapshots.savings) * 100)), 0);
      const totalAvailable = Math.max(0, pool.combinedRemainingPaise);
      if (totalAvailable < checked.value.amountPaise) throw new InsufficientSalaryBalanceError(totalAvailable);
      let remaining = Math.max(0, checked.value.amountPaise - salaryAvailable);
      const extraIncomeAllocations = [];
      for (const entry of [...poolIncome].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (!remaining) break;
        const available = Math.max(0, Math.round(extraIncomeRemaining(entry, snapshots.savings) * 100));
        const amountPaise = Math.min(available, remaining);
        if (amountPaise) extraIncomeAllocations.push({ extraIncomeRecordId: entry.id, amountPaise });
        remaining -= amountPaise;
      }
      const salaryAllocationPaise = checked.value.amountPaise - extraIncomeAllocations.reduce((sum, item) => sum + item.amountPaise, 0);
      const record = {
        id: this.makeId(), ...checked.value, type: 'contribution', sourceType: 'salary', salaryRecordId: activeSalary.id,
        salaryAllocationPaise, extraIncomeAllocations,
        createdAt: timestamp, updatedAt: timestamp
      };
      collections.savings.add(record);
      this.#enqueueOperation(collections, snapshots, {
        operationType: 'savings:contribution',
        entityType: 'saving',
        entityId: record.id,
        payload: { saving: record },
        createdAt: timestamp
      });
      return record;
    });
  }

  createExternalContribution(input) {
    const checked = validateSavingInput(input, this.now());
    if (!checked.ok) throw new ValidationError(checked.errors, 'These savings details are not valid.');
    const timestamp = this.now().toISOString();
    const sourceType = ['gift', 'bonus', 'other'].includes(input.sourceType) ? input.sourceType : 'other';
    return this.#transaction(this.#storesWithOutbox(['savings']), 'readwrite', ({ collections, snapshots }) => {
      const record = { id: this.makeId(), ...checked.value, type: 'external_contribution', sourceType, createdAt: timestamp, updatedAt: timestamp };
      collections.savings.add(record);
      this.#enqueueOperation(collections, snapshots, {
        operationType: 'savings:external_contribution',
        entityType: 'saving',
        entityId: record.id,
        payload: { saving: record },
        createdAt: timestamp
      });
      return record;
    });
  }

  updateSaving(id, input) {
    const now = this.now();
    const checked = validateSavingInput(input, now);
    if (!checked.ok) throw new ValidationError(checked.errors, 'These savings details are not valid.');
    const timestamp = now.toISOString();
    return this.#transaction(this.#storesWithOutbox(['expenses', 'salaries', 'savings', 'extraIncome']), 'readwrite', ({ collections, snapshots }) => {
      const existing = snapshots.savings.find(record => record.id === id);
      if (!existing) throw new NotFoundError(id, 'That savings entry no longer exists.');
      if (existing.reversedAt) throw new AlreadyReversedError();
      if (existing.type === 'withdrawal') throw new ValidationError({ record: 'Edit this withdrawal from its linked expense.' });
      const sourceType = ['gift', 'bonus', 'other'].includes(input.sourceType) ? input.sourceType : 'salary';
      const type = existing.type === 'salary_balance_transfer' ? 'salary_balance_transfer' : sourceType === 'salary' ? 'contribution' : 'external_contribution';
      const activeSalary = findActiveSalary(snapshots.salaries);
      if (sourceType === 'salary' && !activeSalary) throw new NoActiveSalaryError();
      const record = { ...existing, ...checked.value, id, type, sourceType: type === 'salary_balance_transfer' ? undefined : sourceType, salaryRecordId: type === 'salary_balance_transfer' ? existing.salaryRecordId : sourceType === 'salary' ? (existing.salaryRecordId ?? activeSalary.id) : undefined, createdAt: existing.createdAt, updatedAt: timestamp };
      delete record.allocationStatus;
      if (type === 'external_contribution') {
        delete record.salaryAllocationPaise;
        delete record.extraIncomeAllocations;
      }
      const savingsBalance = computeSavingsBalance(snapshots.savings);
      const oldAmountPaise = Math.round(Number(existing.amount) * 100);
      const newAmountPaise = Math.round(Number(record.amount) * 100);
      if (savingsBalance.balancePaise - oldAmountPaise + newAmountPaise < 0) {
        throw new InsufficientSavingsError(savingsBalance.balancePaise - oldAmountPaise);
      }
      if (record.type === 'salary_balance_transfer') {
        const salary = snapshots.salaries.find(item => item.id === existing.salaryRecordId);
        if (salary) {
          const pool = computeSalaryPool(salary, snapshots.expenses, snapshots.savings, snapshots.extraIncome);
          const available = pool.combinedRemainingPaise + oldAmountPaise;
          if (newAmountPaise > available) throw new InsufficientSalaryBalanceError();
          const salaryAvailable = Math.max(0, pool.remainingPaise + Number(existing.salaryAllocationPaise ?? oldAmountPaise));
          let remaining = Math.max(0, newAmountPaise - salaryAvailable);
          const poolIncome = snapshots.extraIncome.filter(entry => !entry.reversedAt && entry.salaryRecordId === salary.id);
          record.extraIncomeAllocations = [];
          for (const entry of [...poolIncome].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
            if (!remaining) break;
            const previouslyAllocated = (existing.extraIncomeAllocations ?? [])
              .filter(item => item.extraIncomeRecordId === entry.id)
              .reduce((sum, item) => sum + item.amountPaise, 0);
            const extraAvailable = Math.max(0, Math.round(extraIncomeRemaining(entry, snapshots.savings) * 100) + previouslyAllocated);
            const amountPaise = Math.min(extraAvailable, remaining);
            if (amountPaise) record.extraIncomeAllocations.push({ extraIncomeRecordId: entry.id, amountPaise });
            remaining -= amountPaise;
          }
          record.salaryAllocationPaise = newAmountPaise - record.extraIncomeAllocations.reduce((sum, item) => sum + item.amountPaise, 0);
        }
      }
      if (type === 'contribution') {
        const salary = snapshots.salaries.find(item => item.id === record.salaryRecordId);
        if (!salary) throw new NoActiveSalaryError();
        const poolIncome = snapshots.extraIncome.filter(entry => !entry.reversedAt && entry.salaryRecordId === salary.id);
        const oldAllocations = existing.extraIncomeAllocations ?? [];
        const usedFromOtherPool = oldAllocations.some(allocation => {
          const income = snapshots.extraIncome.find(entry => entry.id === allocation.extraIncomeRecordId);
          return allocation.amountPaise > 0 && income && income.salaryRecordId !== salary.id;
        });
        if (usedFromOtherPool && newAmountPaise !== oldAmountPaise) {
          throw new ValidationError({ amount: 'This older savings contribution used income from another salary month. Its original funding must stay unchanged.' });
        }
        if (existing.type === 'contribution' && newAmountPaise === oldAmountPaise) {
          record.salaryAllocationPaise = Number.isSafeInteger(existing.salaryAllocationPaise)
            ? existing.salaryAllocationPaise
            : Math.max(0, oldAmountPaise - oldAllocations.reduce((sum, item) => sum + item.amountPaise, 0));
          record.extraIncomeAllocations = [...oldAllocations];
          collections.savings.put(record);
          this.#enqueueOperation(collections, snapshots, {
            operationType: 'savings:update',
            entityType: 'saving',
            entityId: record.id,
            payload: { saving: record, previousSaving: existing },
            createdAt: timestamp
          });
          return record;
        }
        const priorSalaryAllocation = existing.type === 'contribution' ? Number(existing.salaryAllocationPaise ?? oldAmountPaise) : 0;
        const salaryAvailable = Math.max(0, computeSalaryPool(salary, snapshots.expenses, snapshots.savings, snapshots.extraIncome).remainingPaise + priorSalaryAllocation);
        const priorPoolAllocations = oldAllocations.filter(allocation => poolIncome.some(entry => entry.id === allocation.extraIncomeRecordId));
        const extraAvailable = poolIncome.reduce((sum, entry) => sum + Math.max(0, Math.round(extraIncomeRemaining(entry, snapshots.savings) * 100)), 0) + priorPoolAllocations.reduce((sum, item) => sum + item.amountPaise, 0);
        const pool = computeSalaryPool(salary, snapshots.expenses, snapshots.savings, snapshots.extraIncome);
        const totalAvailable = Math.max(0, pool.combinedRemainingPaise + (existing.type === 'contribution' ? oldAmountPaise : 0));
        if (totalAvailable < newAmountPaise) throw new InsufficientSalaryBalanceError(totalAvailable);
        let remaining = Math.max(0, newAmountPaise - salaryAvailable);
        record.extraIncomeAllocations = [];
        for (const entry of [...poolIncome].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
          if (!remaining) break;
          const previouslyAllocated = (existing.extraIncomeAllocations ?? [])
            .filter(item => item.extraIncomeRecordId === entry.id).reduce((sum, item) => sum + item.amountPaise, 0);
          const available = Math.max(0, Math.round(extraIncomeRemaining(entry, snapshots.savings) * 100) + previouslyAllocated);
          const amountPaise = Math.min(available, remaining);
          if (amountPaise) record.extraIncomeAllocations.push({ extraIncomeRecordId: entry.id, amountPaise });
          remaining -= amountPaise;
        }
        record.salaryAllocationPaise = newAmountPaise - record.extraIncomeAllocations.reduce((sum, item) => sum + item.amountPaise, 0);
      }
      collections.savings.put(record);
      this.#enqueueOperation(collections, snapshots, {
        operationType: 'savings:update',
        entityType: 'saving',
        entityId: record.id,
        payload: { saving: record, previousSaving: existing },
        createdAt: timestamp
      });
      return record;
    });
  }

  removeSaving(id) {
    const timestamp = this.now().toISOString();
    return this.#transaction(this.#storesWithOutbox(['expenses', 'salaries', 'savings']), 'readwrite', ({ collections, snapshots }) => {
      const record = snapshots.savings.find(item => item.id === id);
      if (!record) throw new NotFoundError(id, 'That savings entry no longer exists.');
      if (record.reversedAt) throw new AlreadyReversedError();
      if (record.type === 'withdrawal') throw new ValidationError({ record: 'Remove this withdrawal by editing or deleting its linked expense.' });
      const balance = computeSavingsBalance(snapshots.savings);
      if (record.type !== 'withdrawal' && balance.balancePaise - Math.round(Number(record.amount) * 100) < 0) {
        throw new InsufficientSavingsError(balance.balancePaise - Math.round(Number(record.amount) * 100));
      }
      collections.savings.delete(id);
      this.#enqueueOperation(collections, snapshots, {
        operationType: 'savings:delete',
        entityType: 'saving',
        entityId: id,
        payload: { savingId: id, deletedSaving: record },
        createdAt: timestamp
      });
      return record;
    });
  }

  restoreSaving(raw) {
    const checked = normalizeSavingRecord(raw, { now: this.now, makeId: this.makeId });
    if (!checked.ok) throw new ValidationError(checked.errors, 'That savings entry could not be restored.');
    const record = checked.value;
    const timestamp = this.now().toISOString();
    return this.#transaction(this.#storesWithOutbox(['expenses', 'salaries', 'savings']), 'readwrite', ({ collections, snapshots }) => {
      if (snapshots.savings.some(item => item.id === record.id)) return record;
      if (record.type === 'withdrawal') {
        const expense = snapshots.expenses.find(item => item.id === record.expenseId);
        if (!expense) throw new ValidationError({ record: 'The linked expense is missing; this withdrawal cannot be restored alone.' });
        const balance = computeSavingsBalance(snapshots.savings);
        if (balance.balancePaise < Math.round(record.amount * 100)) throw new InsufficientSavingsError(balance.balancePaise);
      }
      collections.savings.add(record);
      this.#enqueueOperation(collections, snapshots, {
        operationType: 'savings:restore',
        entityType: 'saving',
        entityId: record.id,
        payload: { saving: record },
        createdAt: timestamp
      });
      return record;
    });
  }

  createExtraIncome(input) {
    const checked = validateSavingInput(input, this.now());
    if (!checked.ok) throw new ValidationError(checked.errors, 'These extra income details are not valid.');
    const source = ['freelancing', 'part-time', 'bonus', 'other'].includes(input.source) ? input.source : 'other';
    const timestamp = this.now().toISOString();
    return this.#transaction(this.#storesWithOutbox(['salaries', 'extraIncome']), 'readwrite', ({ collections, snapshots }) => {
      const salary = snapshots.salaries.find(item => item.id === input.salaryRecordId);
      if (!salary) throw new ValidationError({ salaryRecordId: 'Choose an existing salary month for this income.' });
      const record = { id: this.makeId(), ...checked.value, source, salaryRecordId: salary.id, createdAt: timestamp, updatedAt: timestamp };
      collections.extraIncome.add(record);
      this.#enqueueOperation(collections, snapshots, {
        operationType: 'extra_income:create',
        entityType: 'extra_income',
        entityId: record.id,
        payload: { extraIncome: record },
        createdAt: timestamp
      });
      return record;
    });
  }

  updateExtraIncome(id, input) {
    const checked = validateSavingInput(input, this.now());
    if (!checked.ok) throw new ValidationError(checked.errors, 'These extra income details are not valid.');
    const timestamp = this.now().toISOString();
    return this.#transaction(this.#storesWithOutbox(['salaries', 'extraIncome', 'savings']), 'readwrite', ({ collections, snapshots }) => {
      const existing = snapshots.extraIncome.find(item => item.id === id);
      if (!existing) throw new NotFoundError(id);
      if (existing.reversedAt) throw new AlreadyReversedError();
      const salary = snapshots.salaries.find(item => item.id === input.salaryRecordId);
      if (!salary) throw new ValidationError({ salaryRecordId: 'Choose an existing salary month for this income.' });
      const allocated = snapshots.savings.reduce((sum, entry) => sum + (entry.extraIncomeAllocations ?? [])
        .filter(item => item.extraIncomeRecordId === id).reduce((subtotal, item) => subtotal + item.amountPaise, 0), 0);
      if (checked.value.amountPaise < allocated) throw new InsufficientSalaryBalanceError(allocated);
      if (allocated > 0 && snapshots.salaries.some(item => item.id === existing.salaryRecordId) && salary.id !== existing.salaryRecordId) {
        throw new ValidationError({ salaryRecordId: 'This income has funded savings, so its salary month cannot be changed.' });
      }
      const record = { ...existing, ...checked.value, source: ['freelancing', 'part-time', 'bonus', 'other'].includes(input.source) ? input.source : 'other', salaryRecordId: salary.id, id, createdAt: existing.createdAt, updatedAt: timestamp };
      delete record.allocationStatus;
      collections.extraIncome.put(record);
      this.#enqueueOperation(collections, snapshots, {
        operationType: 'extra_income:update',
        entityType: 'extra_income',
        entityId: record.id,
        payload: { extraIncome: record, previousExtraIncome: existing },
        createdAt: timestamp
      });
      return record;
    });
  }

  deleteExtraIncome(id) {
    const timestamp = this.now().toISOString();
    return this.#transaction(this.#storesWithOutbox(['extraIncome', 'savings']), 'readwrite', ({ collections, snapshots }) => {
      const record = snapshots.extraIncome.find(item => item.id === id);
      if (!record) throw new NotFoundError(id);
      if (record.reversedAt) throw new AlreadyReversedError();
      const allocated = snapshots.savings.some(entry => (entry.extraIncomeAllocations ?? []).some(item => item.extraIncomeRecordId === id && item.amountPaise > 0));
      if (allocated) throw new Error('This income has funded savings. Remove or edit those savings contributions before deleting it.');
      collections.extraIncome.delete(id);
      this.#enqueueOperation(collections, snapshots, {
        operationType: 'extra_income:delete',
        entityType: 'extra_income',
        entityId: id,
        payload: { extraIncomeId: id, deletedExtraIncome: record },
        createdAt: timestamp
      });
      return record;
    });
  }

  transferSalaryBalance(salaryId) {
    const now = this.now();
    const timestamp = now.toISOString();
    return this.#transaction(this.#storesWithOutbox(['expenses', 'salaries', 'savings', 'extraIncome']), 'readwrite', ({ collections, snapshots }) => {
      const salary = snapshots.salaries.find(record => record.id === salaryId);
      if (!salary) throw new NotFoundError(salaryId, 'That salary no longer exists.');
      const pool = computeSalaryPool(salary, snapshots.expenses, snapshots.savings, snapshots.extraIncome);
      if (pool.combinedRemainingPaise <= 0) throw new InsufficientSalaryBalanceError();
      const salaryAllocationPaise = Math.max(0, pool.remainingPaise);
      let remaining = pool.combinedRemainingPaise - salaryAllocationPaise;
      const extraIncomeAllocations = [];
      const poolIncome = snapshots.extraIncome.filter(entry => !entry.reversedAt && entry.salaryRecordId === salary.id);
      for (const entry of [...poolIncome].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (!remaining) break;
        const available = Math.max(0, Math.round(extraIncomeRemaining(entry, snapshots.savings) * 100));
        const amountPaise = Math.min(available, remaining);
        if (amountPaise) extraIncomeAllocations.push({ extraIncomeRecordId: entry.id, amountPaise });
        remaining -= amountPaise;
      }
      const totalPaise = salaryAllocationPaise + extraIncomeAllocations.reduce((sum, item) => sum + item.amountPaise, 0);
      if (remaining > 0) throw new InsufficientSalaryBalanceError(totalPaise);
      const record = {
        id: this.makeId(), monthKey: localToday(now).slice(0, 7), amount: fromPaise(totalPaise),
        amountPaise: totalPaise, date: localToday(now), description: `Remaining ${salary.monthKey} salary`,
        type: 'salary_balance_transfer', salaryRecordId: salary.id, salaryAllocationPaise, extraIncomeAllocations,
        createdAt: timestamp, updatedAt: timestamp
      };
      collections.savings.add(record);
      this.#enqueueOperation(collections, snapshots, {
        operationType: 'savings:transfer_balance',
        entityType: 'saving',
        entityId: record.id,
        payload: { saving: record, sourceSalaryId: salaryId },
        createdAt: timestamp
      });
      return record;
    });
  }

  /** Mark income as reversed without deleting its dates, salary link or source. */
  reverseExtraIncome(id) {
    const timestamp = this.now().toISOString();
    return this.#transaction(this.#storesWithOutbox(['expenses', 'salaries', 'extraIncome', 'savings']), 'readwrite', ({ collections, snapshots }) => {
      const record = snapshots.extraIncome.find(item => item.id === id);
      if (!record) throw new NotFoundError(id, 'That extra income record no longer exists.');
      if (record.reversedAt) throw new AlreadyReversedError();
      const used = snapshots.savings.some(entry => !entry.reversedAt && (entry.extraIncomeAllocations ?? [])
        .some(item => item.extraIncomeRecordId === id && item.amountPaise > 0));
      if (used) throw new UndoDependencyError('This income has funded savings. Reverse those savings entries first.');
      const salary = snapshots.salaries.find(item => item.id === record.salaryRecordId);
      if (!salary) throw new UndoDependencyError('The salary record for this income is missing. Restore the salary before reversing the income.');
      const remainingAfter = computeSalaryPool(
        salary, snapshots.expenses, snapshots.savings,
        snapshots.extraIncome.map(item => item.id === id ? { ...item, reversedAt: timestamp } : item)
      ).combinedRemainingPaise;
      if (remainingAfter < 0) {
        throw new UndoDependencyError('This income has since been used. Reversing it would make the salary balance negative.');
      }
      const reversed = { ...record, reversedAt: timestamp, reversalId: this.makeId(), updatedAt: timestamp };
      collections.extraIncome.put(reversed);
      this.#enqueueOperation(collections, snapshots, {
        operationType: 'extra_income:reverse',
        entityType: 'extra_income',
        entityId: id,
        payload: {
          extraIncomeId: id,
          reversedRecord: reversed,
          reversalId: reversed.reversalId,
          reversedAt: reversed.reversedAt
        },
        createdAt: timestamp
      });
      return reversed;
    });
  }

  /** Reverse a savings credit while preserving its exact source allocation. */
  reverseSaving(id) {
    const timestamp = this.now().toISOString();
    return this.#transaction(this.#storesWithOutbox(['savings']), 'readwrite', ({ collections, snapshots }) => {
      const record = snapshots.savings.find(item => item.id === id);
      if (!record) throw new NotFoundError(id, 'That savings entry no longer exists.');
      if (record.reversedAt) throw new AlreadyReversedError();
      if (!['contribution', 'external_contribution', 'salary_balance_transfer'].includes(record.type ?? 'contribution')) {
        throw new ValidationError({ record: 'This savings transaction cannot be reversed here.' });
      }
      const remaining = computeSavingsBalance(snapshots.savings.filter(item => item.id !== id)).balancePaise;
      if (remaining < 0) {
        throw new UndoDependencyError('This savings entry has already been used. Reverse the later savings withdrawals first.');
      }
      const reversed = { ...record, reversedAt: timestamp, reversalId: this.makeId(), updatedAt: timestamp };
      collections.savings.put(reversed);
      this.#enqueueOperation(collections, snapshots, {
        operationType: 'savings:reverse',
        entityType: 'saving',
        entityId: id,
        payload: {
          savingId: id,
          reversedRecord: reversed,
          reversalId: reversed.reversalId,
          reversedAt: reversed.reversedAt
        },
        createdAt: timestamp
      });
      return reversed;
    });
  }

  createSalary(input) {
    const checked = validateSalaryInput(input);
    if (!checked.ok) throw new ValidationError(checked.errors, 'These salary details are not valid.');
    const now = this.now();
    return this.#transaction(this.#storesWithOutbox(['salaries']), 'readwrite', ({ collections, snapshots }) => {
      const existing = snapshots.salaries.find(record => record.monthKey === checked.value.monthKey);
      if (existing) throw new DuplicateMonthError(checked.value.monthKey);

      const latestCreatedAt = snapshots.salaries.reduce((latest, record) => {
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
        collections.salaries.put(record);
      } catch (error) {
        if (isConstraintError(error)) throw new DuplicateMonthError(record.monthKey);
        throw error;
      }

      this.#enqueueOperation(collections, snapshots, {
        operationType: 'salary:create',
        entityType: 'salary',
        entityId: record.id,
        payload: { salary: record },
        createdAt: timestamp
      });
      return record;
    });
  }

  updateSalary(id, input) {
    const checked = validateSalaryInput(input);
    if (!checked.ok) throw new ValidationError(checked.errors, 'These salary details are not valid.');
    const timestamp = this.now().toISOString();
    return this.#transaction(this.#storesWithOutbox(['salaries']), 'readwrite', ({ collections, snapshots }) => {
      const existing = snapshots.salaries.find(record => record.id === id);
      if (!existing) throw new NotFoundError(id, 'That salary record no longer exists.');

      if (checked.value.monthKey !== existing.monthKey) {
        const clash = snapshots.salaries.find(record => record.monthKey === checked.value.monthKey && record.id !== id);
        if (clash) throw new DuplicateMonthError(checked.value.monthKey);
      }

      const record = {
        ...existing,
        ...checked.value,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: timestamp
      };

      try {
        collections.salaries.put(record);
      } catch (error) {
        if (isConstraintError(error)) throw new DuplicateMonthError(record.monthKey);
        throw error;
      }

      this.#enqueueOperation(collections, snapshots, {
        operationType: 'salary:update',
        entityType: 'salary',
        entityId: record.id,
        payload: { salary: record, previousSalary: existing },
        createdAt: timestamp
      });
      return record;
    });
  }

  deleteSalaryIfUnused(id) {
    const timestamp = this.now().toISOString();
    return this.#transaction(this.#storesWithOutbox(['expenses', 'salaries', 'savings', 'extraIncome']), 'readwrite', ({ collections, snapshots }) => {
      const salary = snapshots.salaries.find(record => record.id === id);
      if (!salary) throw new NotFoundError(id, 'That salary record no longer exists.');
      const used = snapshots.expenses.some(record => record.salaryRecordId === id) ||
        snapshots.savings.some(record => record.salaryRecordId === id) ||
        snapshots.extraIncome.some(record => record.salaryRecordId === id);
      if (used) throw new ReferencedSalaryError();
      collections.salaries.delete(id);
      this.#enqueueOperation(collections, snapshots, {
        operationType: 'salary:delete',
        entityType: 'salary',
        entityId: id,
        payload: { salaryId: id, deletedSalary: salary },
        createdAt: timestamp
      });
      return salary;
    });
  }

  restoreSalary(raw) {
    const checked = normalizeSalaryRecord(raw, { now: this.now, makeId: this.makeId });
    if (!checked.ok) throw new ValidationError(checked.errors, 'That salary record could not be restored.');
    const record = checked.value;
    const timestamp = this.now().toISOString();
    return this.#transaction(this.#storesWithOutbox(['salaries']), 'readwrite', ({ collections, snapshots }) => {
      if (snapshots.salaries.some(item => item.id === record.id)) return record;
      const clash = snapshots.salaries.find(item => item.monthKey === record.monthKey && item.id !== record.id);
      if (clash) throw new DuplicateMonthError(record.monthKey);

      try {
        collections.salaries.put(record);
      } catch (error) {
        if (isConstraintError(error)) throw new DuplicateMonthError(record.monthKey);
        throw error;
      }

      this.#enqueueOperation(collections, snapshots, {
        operationType: 'salary:restore',
        entityType: 'salary',
        entityId: record.id,
        payload: { salary: record },
        createdAt: timestamp
      });
      return record;
    });
  }

  /** Erase all ledger records and migration metadata in one IndexedDB transaction. */
  clearAllData() {
    const stores = ['expenses', 'salaries', 'savings', 'meta', 'extraIncome'];
    if (this.db.objectStoreNames.contains('outbox')) stores.push('outbox');
    return this.#transaction(stores, 'readwrite', ({ collections }) => {
      for (const collection of Object.values(collections)) collection.clear();
      return true;
    });
  }

  listPendingOperations() {
    if (!this.db.objectStoreNames.contains('outbox')) return Promise.resolve([]);
    return this.#transaction(['outbox'], 'readonly', ({ snapshots }) => {
      return (snapshots.outbox || [])
        .filter(record => record.status === OUTBOX_STATUS.PENDING)
        .sort((a, b) => a.sequence - b.sequence);
    });
  }

  listAllOperations() {
    if (!this.db.objectStoreNames.contains('outbox')) return Promise.resolve([]);
    return this.#transaction(['outbox'], 'readonly', ({ snapshots }) => {
      return (snapshots.outbox || []).sort((a, b) => a.sequence - b.sequence);
    });
  }

  getOperation(operationId) {
    if (!this.db.objectStoreNames.contains('outbox')) return Promise.resolve(null);
    return this.#transaction(['outbox'], 'readonly', ({ snapshots }) => {
      return snapshots.outbox?.find(op => op.operationId === operationId) ?? null;
    });
  }

  countPendingOperations() {
    if (!this.db.objectStoreNames.contains('outbox')) return Promise.resolve(0);
    return this.#transaction(['outbox'], 'readonly', ({ snapshots }) => {
      return (snapshots.outbox || []).filter(record => record.status === OUTBOX_STATUS.PENDING).length;
    });
  }

  acknowledgeOperation(operationId, ackMetadata = {}) {
    if (!this.db.objectStoreNames.contains('outbox')) return Promise.resolve();
    return this.#transaction(['outbox'], 'readwrite', ({ collections, snapshots }) => {
      const record = snapshots.outbox?.find(op => op.operationId === operationId);
      if (!record || record.status === OUTBOX_STATUS.ACKNOWLEDGED) return record ?? null;
      const updated = {
        ...record,
        status: OUTBOX_STATUS.ACKNOWLEDGED,
        acknowledgedAt: ackMetadata.acknowledgedAt ?? this.now().toISOString(),
        ...(ackMetadata.remoteId ? { remoteId: ackMetadata.remoteId } : {}),
        ...(ackMetadata.remoteCursor != null ? { remoteCursor: ackMetadata.remoteCursor } : {})
      };
      collections.outbox.put(updated);
      return updated;
    });
  }

  recordOperationAttempt(operationId, error = null, options = {}) {
    if (!this.db.objectStoreNames.contains('outbox')) return Promise.resolve();
    return this.#transaction(['outbox'], 'readwrite', ({ collections, snapshots }) => {
      const record = snapshots.outbox?.find(op => op.operationId === operationId);
      if (!record) return null;
      const updated = {
        ...record,
        attemptCount: (record.attemptCount ?? 0) + 1,
        lastAttemptAt: this.now().toISOString(),
        lastError: error ? (typeof error === 'string' ? error : (error.message ?? String(error))) : null,
        ...(options.status ? { status: options.status } : {})
      };
      collections.outbox.put(updated);
      return updated;
    });
  }

  getSyncMetadata() {
    if (!this.db.objectStoreNames.contains('meta')) return Promise.resolve({});
    return this.#transaction(['meta'], 'readonly', ({ snapshots }) => {
      const map = {};
      for (const item of snapshots.meta || []) {
        if (typeof item.key === 'string' && item.key.startsWith('sync:')) {
          map[item.key.slice(5)] = item.value;
        }
      }
      return map;
    });
  }

  setSyncMetadata(updates) {
    if (!this.db.objectStoreNames.contains('meta')) return Promise.resolve({});
    return this.#transaction(['meta'], 'readwrite', ({ collections }) => {
      for (const [key, value] of Object.entries(updates)) {
        collections.meta.put({ key: `sync:${key}`, value });
      }
      return updates;
    });
  }

  /**
   * Atomically apply remote changes from Supabase sync_change_feed into local IndexedDB
   * and advance the sync cursor. Never enqueues new outbox operations.
   */
  applyRemoteChanges(changes = [], newCursor = null) {
    if (!changes.length && newCursor == null) return Promise.resolve(0);

    const stores = ['expenses', 'salaries', 'savings', 'extraIncome', 'meta'];
    if (this.db.objectStoreNames.contains('outbox')) stores.push('outbox');

    return this.#transaction(stores, 'readwrite', ({ collections, snapshots }) => {
      let appliedCount = 0;

      for (const change of changes) {
        if (!change || !change.entityType) continue;

        // 1. If this operation originated from this device's outbox, acknowledge it
        const localOutboxOp = snapshots.outbox?.find(op => op.operationId === change.operationId);
        if (localOutboxOp) {
          if (localOutboxOp.status === OUTBOX_STATUS.PENDING) {
            localOutboxOp.status = OUTBOX_STATUS.ACKNOWLEDGED;
            localOutboxOp.acknowledgedAt = this.now().toISOString();
            if (change.cursor) localOutboxOp.remoteCursor = change.cursor;
            collections.outbox?.put(localOutboxOp);
          }
          continue;
        }

        // 2. Conflict check: if local has a pending outbox edit on the exact same entity,
        // do not overwrite uncommitted local edits with remote data.
        const hasPendingLocalEdit = snapshots.outbox?.some(
          op => op.status === OUTBOX_STATUS.PENDING && op.entityId === change.entityId
        );
        if (hasPendingLocalEdit) {
          continue;
        }

        const record = change.record;
        if (!record && change.action !== 'delete') continue;

        switch (change.entityType) {
          case 'salary': {
            if (change.action === 'delete' || record?.deleted_at) {
              collections.salaries.delete(change.entityId);
              const idx = snapshots.salaries.findIndex(s => s.id === change.entityId);
              if (idx !== -1) snapshots.salaries.splice(idx, 1);
            } else {
              const localSalary = {
                id: record.id,
                monthKey: record.month_key,
                amount: Number(record.amount),
                amountPaise: Number(record.amount_paise) || Math.round(Number(record.amount) * 100),
                notes: record.notes || '',
                createdAt: record.created_at,
                updatedAt: record.updated_at
              };
              collections.salaries.put(localSalary);
              const idx = snapshots.salaries.findIndex(s => s.id === localSalary.id);
              if (idx !== -1) snapshots.salaries[idx] = localSalary;
              else snapshots.salaries.push(localSalary);
            }
            appliedCount++;
            break;
          }

          case 'expense': {
            if (change.action === 'delete' || record?.deleted_at) {
              collections.expenses.delete(change.entityId);
              const idx = snapshots.expenses.findIndex(e => e.id === change.entityId);
              if (idx !== -1) snapshots.expenses.splice(idx, 1);
            } else {
              const localExpense = {
                id: record.id,
                amount: Number(record.amount),
                amountPaise: Number(record.amount_paise) || Math.round(Number(record.amount) * 100),
                description: record.description || '',
                date: record.transaction_date,
                paymentSource: record.payment_source,
                salaryRecordId: record.salary_record_id || null,
                ...(record.allocation_status ? { allocationStatus: record.allocation_status } : {}),
                createdAt: record.created_at,
                updatedAt: record.updated_at
              };
              collections.expenses.put(localExpense);
              const idx = snapshots.expenses.findIndex(e => e.id === localExpense.id);
              if (idx !== -1) snapshots.expenses[idx] = localExpense;
              else snapshots.expenses.push(localExpense);
            }
            appliedCount++;
            break;
          }

          case 'extra_income': {
            if (change.action === 'delete' || record?.deleted_at) {
              collections.extraIncome.delete(change.entityId);
              const idx = snapshots.extraIncome.findIndex(i => i.id === change.entityId);
              if (idx !== -1) snapshots.extraIncome.splice(idx, 1);
            } else {
              const localIncome = {
                id: record.id,
                salaryRecordId: record.salary_record_id || null,
                amount: Number(record.amount),
                amountPaise: Number(record.amount_paise) || Math.round(Number(record.amount) * 100),
                date: record.received_date,
                monthKey: record.month_key || record.received_date?.slice(0, 7),
                source: record.source,
                description: record.description || '',
                ...(record.allocation_status ? { allocationStatus: record.allocation_status } : {}),
                reversedAt: record.reversed_at || null,
                reversalId: record.reversal_id || null,
                createdAt: record.created_at,
                updatedAt: record.updated_at
              };
              collections.extraIncome.put(localIncome);
              const idx = snapshots.extraIncome.findIndex(i => i.id === localIncome.id);
              if (idx !== -1) snapshots.extraIncome[idx] = localIncome;
              else snapshots.extraIncome.push(localIncome);
            }
            appliedCount++;
            break;
          }

          case 'saving': {
            if (change.action === 'delete' || record?.deleted_at) {
              collections.savings.delete(change.entityId);
              const idx = snapshots.savings.findIndex(s => s.id === change.entityId);
              if (idx !== -1) snapshots.savings.splice(idx, 1);
            } else {
              const rawAlloc = record.extra_income_allocations ?? record.extraIncomeAllocations;
              const extraIncomeAllocations = Array.isArray(rawAlloc)
                ? rawAlloc.map(a => ({
                    extraIncomeRecordId: a.extraIncomeRecordId || a.extra_income_id,
                    amountPaise: Number(a.amountPaise || a.amount_paise)
                  }))
                : [];

              const localSaving = {
                id: record.id,
                amount: Number(record.amount),
                amountPaise: Number(record.amount_paise) || Math.round(Number(record.amount) * 100),
                date: record.transaction_date,
                monthKey: record.month_key || record.transaction_date?.slice(0, 7),
                description: record.description || '',
                type: record.transaction_type,
                ...(record.source_type ? { source: record.source_type } : {}),
                salaryRecordId: record.salary_record_id || null,
                expenseId: record.expense_id || null,
                salaryAllocationPaise: record.salary_allocation_paise != null ? Number(record.salary_allocation_paise) : null,
                extraIncomeAllocations,
                ...(record.allocation_status ? { allocationStatus: record.allocation_status } : {}),
                reversedAt: record.reversed_at || null,
                reversalId: record.reversal_id || null,
                createdAt: record.created_at,
                updatedAt: record.updated_at
              };
              collections.savings.put(localSaving);
              const idx = snapshots.savings.findIndex(s => s.id === localSaving.id);
              if (idx !== -1) snapshots.savings[idx] = localSaving;
              else snapshots.savings.push(localSaving);
            }
            appliedCount++;
            break;
          }

          default:
            break;
        }
      }

      // Persist the new synchronization cursor atomically
      if (newCursor != null && collections.meta) {
        collections.meta.put({ key: 'sync:lastSyncedCursor', value: Number(newCursor) });
        const metaItem = snapshots.meta?.find(r => r.key === 'sync:lastSyncedCursor');
        if (metaItem) metaItem.value = Number(newCursor);
        else snapshots.meta?.push({ key: 'sync:lastSyncedCursor', value: Number(newCursor) });
      }

      return appliedCount;
    });
  }

  getLastSyncedCursor() {
    if (!this.db.objectStoreNames.contains('meta')) return Promise.resolve(0);
    return this.#transaction(['meta'], 'readonly', ({ snapshots }) => {
      const item = snapshots.meta?.find(r => r.key === 'sync:lastSyncedCursor');
      return item ? Number(item.value) : 0;
    });
  }

  resetBlockedOperations() {
    if (!this.db.objectStoreNames.contains('outbox')) return Promise.resolve(0);
    return this.#transaction(['outbox'], 'readwrite', ({ collections, snapshots }) => {
      let resetCount = 0;
      for (const op of snapshots.outbox || []) {
        if (op.status === OUTBOX_STATUS.BLOCKED) {
          op.status = OUTBOX_STATUS.PENDING;
          op.lastError = null;
          collections.outbox.put(op);
          resetCount++;
        }
      }
      return resetCount;
    });
  }

  countBlockedOperations() {
    if (!this.db.objectStoreNames.contains('outbox')) return Promise.resolve(0);
    return this.#transaction(['outbox'], 'readonly', ({ snapshots }) => {
      return (snapshots.outbox || []).filter(op => op.status === OUTBOX_STATUS.BLOCKED).length;
    });
  }

  listSalaries() {
    if (!this.db.objectStoreNames.contains('salaries')) return Promise.resolve([]);
    return this.#transaction(['salaries'], 'readonly', ({ snapshots }) => snapshots.salaries || []);
  }

  listExpenses() {
    if (!this.db.objectStoreNames.contains('expenses')) return Promise.resolve([]);
    return this.#transaction(['expenses'], 'readonly', ({ snapshots }) => snapshots.expenses || []);
  }

  listSavings() {
    if (!this.db.objectStoreNames.contains('savings')) return Promise.resolve([]);
    return this.#transaction(['savings'], 'readonly', ({ snapshots }) => snapshots.savings || []);
  }

  listExtraIncome() {
    if (!this.db.objectStoreNames.contains('extraIncome')) return Promise.resolve([]);
    return this.#transaction(['extraIncome'], 'readonly', ({ snapshots }) => snapshots.extraIncome || []);
  }
}
