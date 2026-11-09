/**
 * Spendly — Phase 7: Data Recovery & Backup System
 *
 * Implements backup payload generation, comprehensive validation, optional
 * Web Crypto AES-GCM encryption, and safe account-isolated restoration.
 */

import {
  fromPaise,
  toPaise,
  formatMoney,
  normalizeExpenseRecord,
  normalizeSalaryRecord,
  normalizeSavingRecord,
  sortExpenses,
  computeSavingsBalance,
  OUTBOX_STATUS
} from './core.js';

export const BACKUP_APP_NAME = 'Spendly';
export const BACKUP_SCHEMA_VERSION = 7;
export const BACKUP_MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB

/** Error thrown when a backup file has invalid format or violates financial rules. */
export class BackupValidationError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'BackupValidationError';
    this.errors = errors;
  }
}

/** Error thrown when a backup belongs to another user account. */
export class BackupOwnershipMismatchError extends Error {
  constructor(message, backupAccount = null, currentAccount = null) {
    super(message);
    this.name = 'BackupOwnershipMismatchError';
    this.backupAccount = backupAccount;
    this.currentAccount = currentAccount;
  }
}

/** Error thrown when decryption fails or passphrase is wrong. */
export class BackupDecryptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupDecryptionError';
  }
}

/* -------------------------------------------------------------------------- */
/* Web Crypto & Base64 Helpers                                                */
/* -------------------------------------------------------------------------- */

export function uint8ArrayToBase64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64) {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function isEncryptedBackup(obj) {
  return Boolean(
    obj &&
    typeof obj === 'object' &&
    obj.app === BACKUP_APP_NAME &&
    obj.encrypted === true &&
    obj.ciphertext &&
    obj.iv &&
    obj.salt
  );
}

/**
 * Encrypt backup payload with a passphrase using PBKDF2 (SHA-256) and AES-GCM.
 */
export async function encryptBackupPayload(payload, passphrase) {
  if (!passphrase || typeof passphrase !== 'string') {
    throw new BackupDecryptionError('A non-empty passphrase is required to encrypt this backup.');
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto API is not available in this environment.');
  }

  const encoder = new TextEncoder();
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));

  const keyMaterial = await subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  const key = await subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const plaintext = encoder.encode(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const ciphertextBuffer = await subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext
  );

  return {
    app: BACKUP_APP_NAME,
    version: BACKUP_SCHEMA_VERSION,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    encrypted: true,
    algorithm: 'AES-GCM-PBKDF2',
    iterations: 100000,
    salt: uint8ArrayToBase64(salt),
    iv: uint8ArrayToBase64(iv),
    ciphertext: uint8ArrayToBase64(new Uint8Array(ciphertextBuffer)),
    exportedAt: new Date().toISOString()
  };
}

/**
 * Decrypt an encrypted backup payload using the passphrase.
 */
export async function decryptBackupPayload(encryptedObj, passphrase) {
  if (!passphrase || typeof passphrase !== 'string') {
    throw new BackupDecryptionError('A passphrase is required to decrypt this backup.');
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto API is not available in this environment.');
  }

  try {
    const salt = base64ToUint8Array(encryptedObj.salt);
    const iv = base64ToUint8Array(encryptedObj.iv);
    const ciphertext = base64ToUint8Array(encryptedObj.ciphertext);
    const iterations = encryptedObj.iterations || 100000;

    const encoder = new TextEncoder();
    const keyMaterial = await subtle.importKey(
      'raw',
      encoder.encode(passphrase),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    const key = await subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );

    const decryptedBuffer = await subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );

    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(decryptedBuffer));
  } catch (err) {
    throw new BackupDecryptionError('Incorrect passphrase or corrupted encrypted backup file.');
  }
}

/* -------------------------------------------------------------------------- */
/* Backup Payload Generator                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Generate a complete, versioned Spendly backup payload.
 */
export function createBackupPayload({
  expenses = [],
  salaries = [],
  savings = [],
  extraIncome = [],
  outbox = [],
  meta = [],
  user = null,
  now = () => new Date()
} = {}) {
  // Normalize and preserve integer paise
  const cleanExpenses = sortExpenses(expenses).map(record => ({
    id: record.id,
    amount: Number(record.amount),
    amountPaise: Number(record.amountPaise) || Math.round(Number(record.amount) * 100),
    description: record.description || '',
    date: record.date,
    paymentSource: record.paymentSource || 'salary',
    salaryRecordId: record.salaryRecordId ?? null,
    ...(record.allocationStatus ? { allocationStatus: record.allocationStatus } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt || record.createdAt
  }));

  const cleanSalaries = [...salaries].map(record => ({
    id: record.id,
    monthKey: record.monthKey,
    amount: Number(record.amount),
    amountPaise: Number(record.amountPaise) || Math.round(Number(record.amount) * 100),
    notes: record.notes || '',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt || record.createdAt
  }));

  const cleanSavings = [...savings].map(record => ({
    id: record.id,
    amount: Number(record.amount),
    amountPaise: Number(record.amountPaise) || Math.round(Number(record.amount) * 100),
    type: record.type || 'contribution',
    sourceType: record.sourceType || 'salary',
    description: record.description || '',
    date: record.date,
    monthKey: record.monthKey,
    salaryRecordId: record.salaryRecordId ?? null,
    salaryAllocationPaise: Number(record.salaryAllocationPaise) || 0,
    extraIncomeAllocations: Array.isArray(record.extraIncomeAllocations)
      ? record.extraIncomeAllocations.map(a => ({
          extraIncomeRecordId: a.extraIncomeRecordId,
          amountPaise: Number(a.amountPaise) || 0
        }))
      : [],
    expenseId: record.expenseId ?? null,
    reversedAt: record.reversedAt ?? null,
    reversalId: record.reversalId ?? null,
    ...(record.allocationStatus ? { allocationStatus: record.allocationStatus } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt || record.createdAt
  }));

  const cleanExtraIncome = [...extraIncome].map(record => ({
    id: record.id,
    amount: Number(record.amount),
    amountPaise: Number(record.amountPaise) || Math.round(Number(record.amount) * 100),
    source: record.source || 'other',
    description: record.description || '',
    date: record.date,
    salaryRecordId: record.salaryRecordId ?? null,
    reversedAt: record.reversedAt ?? null,
    reversalId: record.reversalId ?? null,
    ...(record.allocationStatus ? { allocationStatus: record.allocationStatus } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt || record.createdAt
  }));

  // Preserve pending outbox operations without sensitive credentials
  const cleanOutbox = [...outbox]
    .filter(op => op.status === OUTBOX_STATUS.PENDING || op.status === OUTBOX_STATUS.BLOCKED)
    .map(op => ({
      operationId: op.operationId,
      sequence: op.sequence,
      operationType: op.operationType,
      entityType: op.entityType,
      entityId: op.entityId,
      payload: op.payload,
      createdAt: op.createdAt,
      status: op.status
    }));

  // Preserve relevant synchronization and ledger metadata
  const cleanMeta = [...meta].filter(item =>
    item.key === 'sync:lastSyncedCursor' ||
    item.key === 'allocationMigrationKey' ||
    item.key === 'spendly_allocation_migration_v1'
  );

  return {
    app: BACKUP_APP_NAME,
    appVersion: '3.7.0',
    schemaVersion: BACKUP_SCHEMA_VERSION,
    version: BACKUP_SCHEMA_VERSION,
    exportedAt: now().toISOString(),
    account: {
      userId: user?.id ?? null,
      email: user?.email ?? null,
      isAnonymous: !user
    },
    expenses: cleanExpenses,
    salaries: cleanSalaries,
    savings: cleanSavings,
    extraIncome: cleanExtraIncome,
    outbox: cleanOutbox,
    meta: cleanMeta
  };
}

/* -------------------------------------------------------------------------- */
/* Backup Validation Engine                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Validates a parsed backup object or JSON string against the current user account
 * and financial ledger integrity rules.
 */
export async function validateBackup(rawInput, currentUser = null, options = {}) {
  let parsed;
  if (typeof rawInput === 'string') {
    if (rawInput.length > BACKUP_MAX_FILE_SIZE) {
      throw new BackupValidationError('The backup file exceeds the 15 MB limit.');
    }
    try {
      parsed = JSON.parse(rawInput);
    } catch {
      throw new BackupValidationError('The file is not valid JSON.');
    }
  } else if (rawInput && typeof rawInput === 'object') {
    parsed = rawInput;
  } else {
    throw new BackupValidationError('The provided backup input is empty or invalid.');
  }

  // Handle encrypted backup
  if (isEncryptedBackup(parsed)) {
    if (!options.passphrase) {
      return {
        ok: false,
        requiresPassphrase: true,
        encrypted: true,
        error: 'This backup is password-protected. Please enter the passphrase to decrypt it.'
      };
    }
    parsed = await decryptBackupPayload(parsed, options.passphrase);
  }

  // Format recognition: legacy array vs Spendly backup object
  const isLegacyArray = Array.isArray(parsed);
  if (!isLegacyArray && (!parsed || typeof parsed !== 'object')) {
    throw new BackupValidationError('That file doesn’t contain a Spendly backup. Nothing was changed.');
  }

  if (!isLegacyArray && parsed.app && parsed.app !== BACKUP_APP_NAME) {
    throw new BackupValidationError(`Unsupported application backup: expected ${BACKUP_APP_NAME}.`);
  }

  const schemaVersion = isLegacyArray ? 1 : (parsed.schemaVersion || parsed.version || 1);
  if (schemaVersion > BACKUP_SCHEMA_VERSION) {
    throw new BackupValidationError(
      `Backup was created with a newer version of Spendly (schema v${schemaVersion}). Please update Spendly to restore this file.`
    );
  }

  // Account Ownership Isolation Validation
  const backupAccount = parsed.account;
  if (backupAccount?.userId) {
    if (currentUser?.id) {
      if (backupAccount.userId !== currentUser.id) {
        throw new BackupOwnershipMismatchError(
          `This backup belongs to account (${backupAccount.email || backupAccount.userId}). You are currently signed in as (${currentUser.email || currentUser.id}). Cross-account restoration is prevented to ensure data isolation.`,
          backupAccount,
          currentUser
        );
      }
    } else {
      // Unauthenticated visitor trying to restore an authenticated user's backup
      throw new BackupOwnershipMismatchError(
        `This backup belongs to registered account (${backupAccount.email || backupAccount.userId}). Please sign in to that account before restoring this file.`,
        backupAccount,
        null
      );
    }
  }

  // Extract raw collections
  const rawExpenses = isLegacyArray ? parsed : (Array.isArray(parsed.expenses) ? parsed.expenses : []);
  const rawSalaries = Array.isArray(parsed.salaries) ? parsed.salaries : [];
  const rawSavings = Array.isArray(parsed.savings) ? parsed.savings : [];
  const rawExtraIncome = Array.isArray(parsed.extraIncome) ? parsed.extraIncome : [];
  const rawOutbox = Array.isArray(parsed.outbox) ? parsed.outbox : [];
  const rawMeta = Array.isArray(parsed.meta) ? parsed.meta : [];

  if (!isLegacyArray && !rawExpenses.length && !rawSalaries.length && !rawSavings.length && !rawExtraIncome.length) {
    // Empty backup is valid (e.g. freshly created account)
  }

  // Field and record validation
  const errors = [];
  const normOptions = { now: () => new Date(), makeId: () => globalThis.crypto?.randomUUID?.() || `sp_${Date.now()}` };

  const checkedExpenses = rawExpenses.map(record => normalizeExpenseRecord(record, normOptions));
  const checkedSalaries = rawSalaries.map(record => normalizeSalaryRecord(record, normOptions));
  const checkedSavings = rawSavings.map(record => normalizeSavingRecord(record, normOptions));
  const checkedExtraIncome = rawExtraIncome.map(record => normalizeSavingRecord(record, normOptions));

  const invalidExpenses = checkedExpenses.filter(r => !r.ok);
  const invalidSalaries = checkedSalaries.filter(r => !r.ok);
  const invalidSavings = checkedSavings.filter(r => !r.ok);
  const invalidIncome = checkedExtraIncome.filter(r => !r.ok);

  const totalInvalid = invalidExpenses.length + invalidSalaries.length + invalidSavings.length + invalidIncome.length;
  if (totalInvalid > 0) {
    throw new BackupValidationError(
      `That backup has ${totalInvalid} unreadable record${totalInvalid === 1 ? '' : 's'}. Nothing was changed.`
    );
  }

  const expenses = checkedExpenses.map((r, i) => ({
    ...r.value,
    amountPaise: Number(rawExpenses[i]?.amountPaise) || Math.round(r.value.amount * 100)
  }));
  const salaries = checkedSalaries.map((r, i) => ({
    ...r.value,
    amountPaise: Number(rawSalaries[i]?.amountPaise) || Math.round(r.value.amount * 100)
  }));
  const savings = checkedSavings.map((r, i) => ({
    ...r.value,
    amountPaise: Number(rawSavings[i]?.amountPaise) || Math.round(r.value.amount * 100),
    salaryAllocationPaise: Number(rawSavings[i]?.salaryAllocationPaise) || 0,
    extraIncomeAllocations: Array.isArray(rawSavings[i]?.extraIncomeAllocations) ? rawSavings[i].extraIncomeAllocations : []
  }));
  const extraIncome = checkedExtraIncome.map((r, i) => ({
    ...r.value,
    amountPaise: Number(rawExtraIncome[i]?.amountPaise) || Math.round(r.value.amount * 100)
  }));

  // Duplicate ID checks
  const checkDuplicateIds = (list, name) => {
    const ids = new Set();
    for (const item of list) {
      if (ids.has(item.id)) {
        errors.push(`Duplicate ID found in ${name}: "${item.id}".`);
      }
      ids.add(item.id);
    }
  };
  checkDuplicateIds(expenses, 'expenses');
  checkDuplicateIds(salaries, 'salaries');
  checkDuplicateIds(savings, 'savings');
  checkDuplicateIds(extraIncome, 'extraIncome');

  // Salary monthKey uniqueness check
  const salaryMonths = new Set();
  for (const s of salaries) {
    if (salaryMonths.has(s.monthKey)) {
      errors.push(`Duplicate salary month found: "${s.monthKey}". Only one salary per month is permitted.`);
    }
    salaryMonths.add(s.monthKey);
  }

  // Relational Integrity Checks
  const salaryIds = new Set(salaries.map(s => s.id));
  const expenseMap = new Map(expenses.map(e => [e.id, e]));
  const extraIncomeIds = new Set(extraIncome.map(i => i.id));
  const withdrawalByExpense = new Map();

  for (const s of savings) {
    if (s.salaryRecordId && salaries.length > 0 && !salaryIds.has(s.salaryRecordId)) {
      errors.push(`A savings record refers to a missing salary record ID: "${s.salaryRecordId}".`);
    }
    if (s.type === 'withdrawal') {
      const exp = expenseMap.get(s.expenseId);
      if (!exp) {
        errors.push(`A savings withdrawal refers to an expense that is missing from this backup: "${s.expenseId}".`);
      } else if (exp.paymentSource !== 'savings') {
        errors.push(`A savings withdrawal is linked to an expense that is not funded by savings.`);
      } else if (Math.round(exp.amount * 100) !== Math.round(s.amount * 100)) {
        errors.push(`A savings withdrawal amount (${s.amount}) does not match its linked expense amount (${exp.amount}).`);
      }
      if (withdrawalByExpense.has(s.expenseId)) {
        errors.push(`An expense has multiple savings withdrawals linked: "${s.expenseId}".`);
      }
      withdrawalByExpense.set(s.expenseId, s);
    }

    // Funding allocations validation
    const extraAllocated = (s.extraIncomeAllocations ?? []).reduce(
      (sum, item) => sum + (Number(item.amountPaise) || 0),
      0
    );
    const amountPaise = Math.round(s.amount * 100);
    if (s.type === 'contribution' && (s.salaryAllocationPaise ?? 0) + extraAllocated > amountPaise) {
      errors.push(`A savings contribution of ₹${s.amount} has funding allocations exceeding the total amount.`);
    }

    for (const alloc of s.extraIncomeAllocations ?? []) {
      if (extraIncome.length > 0 && !extraIncomeIds.has(alloc.extraIncomeRecordId)) {
        errors.push(`A savings contribution refers to a missing extra income funding ID: "${alloc.extraIncomeRecordId}".`);
      }
      if (!Number.isSafeInteger(alloc.amountPaise) || alloc.amountPaise < 0) {
        errors.push(`A savings contribution funding allocation has an invalid or negative amount.`);
      }
    }
  }

  // Extra income allocation ceiling validation
  const incomeAllocationTotals = new Map();
  for (const s of savings) {
    for (const alloc of s.extraIncomeAllocations ?? []) {
      incomeAllocationTotals.set(
        alloc.extraIncomeRecordId,
        (incomeAllocationTotals.get(alloc.extraIncomeRecordId) ?? 0) + alloc.amountPaise
      );
    }
  }
  for (const income of extraIncome) {
    const allocated = incomeAllocationTotals.get(income.id) ?? 0;
    const incomePaise = Math.round(income.amount * 100);
    if (allocated > incomePaise) {
      errors.push(`Allocations for extra income "${income.description || income.id}" exceed the total received amount.`);
    }
  }

  // Expense salary link validation
  for (const e of expenses) {
    if (e.salaryRecordId && salaries.length > 0 && !salaryIds.has(e.salaryRecordId)) {
      errors.push(`An expense refers to a missing salary record ID: "${e.salaryRecordId}".`);
    }
    if (e.paymentSource === 'savings' && !withdrawalByExpense.has(e.id)) {
      errors.push(`A savings-funded expense is missing its corresponding savings withdrawal record.`);
    }
  }

  // Overall derived savings balance
  if (savings.length > 0) {
    const computed = computeSavingsBalance(savings);
    if (computed.balancePaise < 0) {
      errors.push(`Restoring this backup would result in a negative savings balance: ₹${fromPaise(computed.balancePaise)}.`);
    }
  }

  if (errors.length > 0) {
    throw new BackupValidationError(
      `Backup validation failed with ${errors.length} error${errors.length === 1 ? '' : 's'}:\n• ${errors.slice(0, 5).join('\n• ')}`,
      errors
    );
  }

  // Prepare clean data
  const normalizedData = {
    expenses,
    salaries,
    savings,
    extraIncome,
    outbox: rawOutbox,
    meta: rawMeta
  };

  const summary = {
    app: BACKUP_APP_NAME,
    schemaVersion,
    exportedAt: parsed.exportedAt || null,
    account: backupAccount || { userId: null, email: null, isAnonymous: true },
    expenseCount: expenses.length,
    salaryCount: salaries.length,
    savingsCount: savings.length,
    extraIncomeCount: extraIncome.length,
    outboxCount: rawOutbox.length
  };

  return {
    ok: true,
    summary,
    data: normalizedData
  };
}
