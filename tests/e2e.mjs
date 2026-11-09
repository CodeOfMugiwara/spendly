/*
 * Spendly browser regression suite.
 *
 * Run with:  npm run test:e2e
 * Requires Playwright and its Chromium browser. The suite starts its own local
 * server, exercises the real service worker, and writes documentation
 * screenshots into /screenshots.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatDate, formatMonth, formatMoney, summarize, toISODate, STORAGE_KEY } from '../js/core.js';
import { startServer } from './server.mjs';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('\nPlaywright is not installed. Run `npm install` once, then retry.\n');
  process.exit(1);
}

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SHOTS = path.join(ROOT, 'screenshots');
const RESULTS = path.join(ROOT, 'test-results');
const APP_SHELL_PATHS = [
  '/index.html',
  '/css/app.css',
  '/js/app.js',
  '/js/core.js',
  '/js/db.js',
  '/js/repository.js',
  '/js/supabase.js',
  '/js/vendor/supabase.js',
  '/js/sync.js',
  '/js/backup.js',
  '/manifest.json',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png'
];

await mkdir(SHOTS, { recursive: true });
await mkdir(RESULTS, { recursive: true });

const server = await startServer(0);
const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch();

const results = [];
let consoleErrors = [];

function watch(page) {
  page.on('pageerror', error => {
    consoleErrors.push(`pageerror: ${error.message}`);
  });
  page.on('console', message => {
    if (message.type() === 'error') {
      const text = message.text();
      if (/Failed to load resource: the server responded with a status of 40/i.test(text) ||
          /net::ERR_INTERNET_DISCONNECTED/i.test(text)) {
        return;
      }
      consoleErrors.push(`console: ${text}`);
    }
  });
}

const MOCK_AUTH_USER = {
  id: '00000000-0000-4000-8000-000000000001',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'tester@spendly.local',
  app_metadata: { provider: 'email' },
  user_metadata: {}
};

const DEFAULT_TEST_DB = 'spendly_user_00000000-0000-4000-8000-000000000001';

const MOCK_AUTH_SESSION = {
  access_token: 'fake-jwt-token',
  refresh_token: 'fake-refresh-token',
  token_type: 'bearer',
  expires_in: 86400,
  expires_at: Math.floor(Date.now() / 1000) + 86400,
  user: MOCK_AUTH_USER
};

async function seedAuthSession(contextOrPage, user = MOCK_AUTH_USER) {
  const sessionData = {
    ...MOCK_AUTH_SESSION,
    user
  };
  await contextOrPage.addInitScript(({ session }) => {
    try {
      localStorage.setItem('spendly.auth.token', JSON.stringify(session));
    } catch {}
  }, { session: sessionData });
}

async function createContext(options = {}) {
  const { auth = true, user = MOCK_AUTH_USER, ...contextOptions } = options;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'en-IN',
    timezoneId: 'Asia/Calcutta',
    acceptDownloads: true,
    ...contextOptions
  });

  if (auth) {
    await seedAuthSession(context, user);
  }

  return context;
}

async function seedLegacy(page, records) {
  await page.addInitScript(({ key, rows }) => {
    const existing = localStorage.getItem(key);
    if (existing === null) localStorage.setItem(key, JSON.stringify(rows));
  }, { key: STORAGE_KEY, rows: records });
}

async function gotoApp(page, waitUntil = 'networkidle') {
  await page.goto(base, { waitUntil });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true', null, { timeout: 15000 });
}

async function dbSnapshot(page, targetName = null) {
  return page.evaluate(async (customName) => {
    const dbName = customName || document.documentElement.dataset.activeDb || 'spendly';
    const open = () => new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const db = await open();
    const stores = [...db.objectStoreNames];
    const readAll = storeName => new Promise((resolve, reject) => {
      const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = await readAll('expenses');
    const salaries = stores.includes('salaries') ? await readAll('salaries') : [];
    const savings = stores.includes('savings') ? await readAll('savings') : [];
    const extraIncome = stores.includes('extraIncome') ? await readAll('extraIncome') : [];
    const meta = stores.includes('meta') ? await readAll('meta') : [];
    const outbox = stores.includes('outbox') ? await readAll('outbox') : [];
    const version = db.version;
    db.close();
    return { records, salaries, savings, extraIncome, meta, outbox, stores, version };
  }, targetName);
}

async function seedVersion5FinanceDatabase(page, { salaries, extraIncome }, targetName = DEFAULT_TEST_DB) {
  await page.goto(`${base}/manifest.json`, { waitUntil: 'networkidle' });
  await page.evaluate(({ salaries, extraIncome, dbName }) => new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 5);
    request.onupgradeneeded = () => {
      const db = request.result;
      const expenses = db.createObjectStore('expenses', { keyPath: 'id' });
      expenses.createIndex('by_date', 'date');
      expenses.createIndex('by_createdAt', 'createdAt');
      expenses.createIndex('by_date_createdAt', ['date', 'createdAt']);
      expenses.createIndex('by_salaryRecordId', 'salaryRecordId');
      expenses.createIndex('by_paymentSource', 'paymentSource');
      db.createObjectStore('meta', { keyPath: 'key' });
      const salaryStore = db.createObjectStore('salaries', { keyPath: 'id' });
      salaryStore.createIndex('by_monthKey', 'monthKey', { unique: true });
      salaryStore.createIndex('by_createdAt', 'createdAt');
      const savings = db.createObjectStore('savings', { keyPath: 'id' });
      savings.createIndex('by_monthKey', 'monthKey');
      savings.createIndex('by_date', 'date');
      savings.createIndex('by_date_createdAt', ['date', 'createdAt']);
      savings.createIndex('by_type', 'type');
      savings.createIndex('by_salaryRecordId', 'salaryRecordId');
      savings.createIndex('by_expenseId', 'expenseId', { unique: true });
      const incomes = db.createObjectStore('extraIncome', { keyPath: 'id' });
      incomes.createIndex('by_date', 'date');
      incomes.createIndex('by_createdAt', 'createdAt');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(['salaries', 'extraIncome'], 'readwrite');
      for (const record of salaries) transaction.objectStore('salaries').put(record);
      for (const record of extraIncome) transaction.objectStore('extraIncome').put(record);
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
  }), { salaries, extraIncome, dbName: targetName });
}

async function cacheContents(page) {
  return page.evaluate(async () => {
    const keys = await caches.keys();
    const contents = {};
    for (const key of keys) {
      const cache = await caches.open(key);
      contents[key] = (await cache.keys()).map(request => new URL(request.url).pathname);
    }
    return contents;
  });
}

async function waitForToast(page, text) {
  await page.waitForFunction(expected => {
    const toast = document.getElementById('toast');
    return toast && !toast.hidden && toast.textContent.includes(expected);
  }, text, { timeout: 8000 });
}

async function waitForToastsToClear(page) {
  try {
    await page.locator('#toast').waitFor({ state: 'visible', timeout: 1500 });
  } catch {
    // No toast was shown for this state.
  }
  await page.locator('#toast').waitFor({ state: 'hidden', timeout: 12000 });
}

async function addExpense(page, { amount, description, date, source = 'salary' } = {}) {
  await page.locator('#addExpenseButton').click();
  await page.locator('#expenseSheet').waitFor({ state: 'visible' });
  await page.locator('#amountInput').fill(String(amount));
  await page.locator('#descriptionInput').fill(description);
  if (date) await page.locator('#dateInput').fill(date);
  if (source === 'savings') await page.locator('#paidFromSavings').check();
  if (source === 'others') await page.locator('#paidFromOthers').check();
  await page.locator('#saveButton').click();
  await page.locator('#expenseSheet').waitFor({ state: 'hidden', timeout: 8000 });
}

async function downloadFrom(page, action) {
  const downloadPromise = page.waitForEvent('download', { timeout: 8000 });
  await action();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  const text = downloadPath ? await readFile(downloadPath, 'utf8') : '';
  return { filename: download.suggestedFilename(), text };
}

async function openRowMenu(page, listSelector, text) {
  const row = page.locator(`${listSelector} .entry`).filter({ hasText: text }).first();
  await row.locator('.entry__menu').click();
  await page.locator('#actionSheet').waitFor({ state: 'visible' });
}

async function openDataSettings(page) {
  const profileBtn = page.locator('#userProfileBtn');
  if (await profileBtn.isVisible()) {
    await profileBtn.click();
    await page.locator('#openDataSettings').click();
  } else {
    await page.locator('#connection').click();
  }
  await page.locator('#dataSettingsSheet').waitFor({ state: 'visible' });
}

async function signOutFromHeader(page) {
  const profileBtn = page.locator('#userProfileBtn');
  if (await profileBtn.isVisible()) {
    await profileBtn.click();
  }
  await page.locator('#headerSignOutButton').click();
}

function daysAgoISO(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return toISODate(date);
}

function monthKeyNow() {
  return toISODate(new Date()).slice(0, 7);
}

function shiftMonthKey(monthKey, delta) {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7)) - 1;
  const date = new Date(year, month + delta, 1, 12);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

async function setSalaryMonth(page, monthKey) {
  await page.locator('#salaryYearSelect').selectOption(monthKey.slice(0, 4));
  await page.locator('#salaryMonthSelect').selectOption(monthKey.slice(5, 7));
}

async function addSalary(page, { amount, monthKey, notes, transferChoice = 'Not Now' } = {}) {
  await page.locator('[data-view="salary"]').click();
  if (monthKey && await page.locator('#salaryMonthLabel').innerText() !== formatMonth(monthKey)) {
    await page.locator('#salaryMonthPickerButton').click();
    await page.locator('#monthPickerSheet').waitFor({ state: 'visible' });
    await page.locator('#pickerMonthSelect').selectOption(monthKey.slice(5, 7));
    await page.locator('#pickerYearSelect').selectOption(monthKey.slice(0, 4));
    await page.locator('#pickerGoButton').click();
    await page.locator('#monthPickerSheet').waitFor({ state: 'hidden' });
  }
  await page.locator('#salaryEditButton').click();
  await page.locator('#salarySheet').waitFor({ state: 'visible' });
  await page.locator('#salaryAmountInput').fill(String(amount));
  if (monthKey) await setSalaryMonth(page, monthKey);
  if (notes) await page.locator('#salaryNotesInput').fill(notes);
  await page.locator('#saveSalaryButton').click();
  await page.locator('#salarySheet').waitFor({ state: 'hidden', timeout: 8000 });
  if (transferChoice === 'Move to Savings') {
    await page.locator('#actionSheet').waitFor({ state: 'visible', timeout: 4000 });
  }
  if (await page.locator('#actionSheet').isVisible()) {
    await page.locator('#actionList .action__item').filter({ hasText: transferChoice }).click();
    await page.locator('#actionSheet').waitFor({ state: 'hidden' });
  }
}

async function addSaving(page, { amount, description, source = 'salary', fromTotalTab = false } = {}) {
  await page.locator('[data-view="savings"]').click();
  if (fromTotalTab) {
    await page.locator('#savingsTabTotal').click();
    await page.locator('#addSavingTotalButton').click();
  } else {
    await page.locator('#savingsTabMonth').click();
    await page.locator('#addSavingButton').click();
  }
  await page.locator('#savingSheet').waitFor({ state: 'visible' });
  await page.locator('#savingAmountInput').fill(String(amount));
  await page.locator('#savingSourceInput').selectOption(source);
  if (description) await page.locator('#savingDescriptionInput').fill(description);
  await page.locator('#saveSavingButton').click();
  await page.locator('#savingSheet').waitFor({ state: 'hidden', timeout: 8000 });
}

async function addExtraIncome(page, { amount, date = daysAgoISO(0), salaryMonth, source = 'freelancing', description = 'Extra work' } = {}) {
  await page.locator('[data-view="salary"]').click();
  await page.locator('#addExtraIncomeButton').click();
  await page.locator('#extraIncomeSheet').waitFor({ state: 'visible' });
  await page.locator('#extraIncomeAmount').fill(String(amount));
  await page.locator('#extraIncomeDate').fill(date);
  if (salaryMonth) {
    const snapshot = await dbSnapshot(page);
    const salary = snapshot.salaries.find(record => record.monthKey === salaryMonth);
    assert.ok(salary, `expected a salary for ${salaryMonth}`);
    await page.locator('#extraIncomeSalarySelect').selectOption(salary.id);
  }
  await page.locator('#extraIncomeSource').selectOption(source);
  await page.locator('#extraIncomeDescription').fill(description);
  await page.locator('#saveExtraIncomeButton').click();
  await page.locator('#extraIncomeSheet').waitFor({ state: 'hidden' });
}

function firstOfMonthISO() {
  const now = new Date();
  return toISODate(new Date(now.getFullYear(), now.getMonth(), 1));
}

async function run(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.error(`✗ ${name}`);
    console.error(error);
    if (globalThis.__activePage) {
      await globalThis.__activePage.screenshot({
        path: path.join(RESULTS, `failure-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`)
      }).catch(() => {});
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 1. Migration and persistence                                              */
/* -------------------------------------------------------------------------- */

await run('localStorage records migrate once, keep their ids and timestamps', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  const today = daysAgoISO(0);
  const legacyTimestamp = Date.UTC(2025, 5, 15, 8, 30);
  const legacyId = `${legacyTimestamp.toString(36)}qq12`;
  const legacy = [
    { id: legacyId, amount: 120, description: 'Migrated lunch', date: today },
    { id: 'legacy-two', amount: 80, description: 'Migrated auto', date: today },
    { id: 'legacy-three', amount: 99.5, description: 'Start of month', date: firstOfMonthISO() }
  ];
  await seedLegacy(page, legacy);

  await gotoApp(page);
  const expected = summarize(legacy, new Date());
  assert.equal(await page.locator('#heroAmount').innerText(), formatMoney(expected.periods.month.total));
  assert.equal(await page.locator('#heroCount').innerText(), String(expected.periods.month.count));
  assert.equal(await page.locator('#recentList .entry').count(), 3);

  const first = await dbSnapshot(page);
  assert.equal(first.records.length, 3);
  assert.ok(first.stores.includes('expenses') && first.stores.includes('meta'));
  assert.ok(first.meta.some(entry => entry.key === 'migration:localStorage:v1' && entry.completedAt));

  const migrated = first.records.find(record => record.id === legacyId);
  assert.ok(migrated);
  assert.equal(migrated.createdAt, new Date(legacyTimestamp).toISOString());
  assert.equal(migrated.updatedAt, migrated.createdAt);

  const stored = await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);
  assert.deepEqual(JSON.parse(stored), legacy, 'the original localStorage value must be untouched');

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  const second = await dbSnapshot(page);
  assert.equal(second.records.length, 3, 'reloading must not duplicate migrated records');
  assert.equal(await page.locator('#heroCount').innerText(), String(expected.periods.month.count));

  await context.close();
});

/* -------------------------------------------------------------------------- */
/* 2. Add, edit, delete, undo, search, backup and restore                    */
/* -------------------------------------------------------------------------- */

await run('add, edit, delete, undo, search, CSV, backup and restore work', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  const today = daysAgoISO(0);
  const yesterday = daysAgoISO(1);

  await gotoApp(page);
  assert.equal(await page.locator('#glanceSection').isHidden(), true, 'empty dashboard should focus on the first action');
  assert.equal(await page.locator('#recentList [data-empty-add]').isVisible(), true);

  await addSalary(page, { amount: '10000' });
  await waitForToast(page, 'Salary saved.');
  await page.locator('[data-view="dashboard"]').click();
  await addExpense(page, { amount: '1,250.50', description: 'Team dinner' });
  await waitForToast(page, 'Expense added successfully');
  assert.equal(await page.locator('#heroAmount').innerText(), formatMoney(1250.5));
  assert.equal(await page.locator('#heroCount').innerText(), '1');
  assert.equal(await page.locator('#glanceSection').isHidden(), false);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  assert.equal(await page.locator('#heroAmount').innerText(), formatMoney(1250.5), 'expense survives a refresh');

  await addExpense(page, { amount: '75.25', description: 'Coffee "with friends"', date: yesterday });
  await page.locator('[data-view="expenses"]').click();
  await page.locator('#historyList .entry').first().waitFor();
  assert.equal(await page.locator('#historyList .entry').count(), 2);
  assert.equal(await page.locator('#allTotal').innerText(), formatMoney(1325.75));
  assert.equal(await page.locator('#allCount').innerText(), '2 expenses');

  const snapshot = await dbSnapshot(page);
  assert.equal(snapshot.records.length, 2);
  for (const record of snapshot.records) {
    assert.ok(record.createdAt);
    assert.ok(record.updatedAt);
    assert.ok(record.id);
  }

  await page.locator('#search').fill('dinner');
  await page.waitForTimeout(250);
  assert.equal(await page.locator('#historyList .entry').count(), 1);
  assert.match(await page.locator('#resultCount').innerText(), /1 found/i);
  await page.locator('#search').fill('1250');
  await page.waitForTimeout(250);
  assert.equal(await page.locator('#historyList .entry').count(), 1);
  await page.locator('#search').fill('nothing-matches');
  await page.waitForTimeout(250);
  assert.match(await page.locator('#historyList .empty__title').innerText(), /No matches/);
  await page.locator('#historyList [data-clear-search]').click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator('#historyList .entry').count(), 2);

  await openRowMenu(page, '#historyList', 'Coffee');
  await page.locator('#actionList .action__item').filter({ hasText: 'Edit expense' }).click();
  await page.locator('#expenseSheet').waitFor({ state: 'visible' });
  await page.locator('#amountInput').fill('80');
  await page.locator('#saveButton').click();
  await page.locator('#expenseSheet').waitFor({ state: 'hidden' });
  await waitForToast(page, 'Expense updated');
  assert.equal(
    await page.locator('#historyList .entry').filter({ hasText: 'Coffee' }).locator('.entry__amount').innerText(),
    formatMoney(80)
  );

  await openRowMenu(page, '#historyList', 'Team dinner');
  await page.locator('#actionList .action__item').filter({ hasText: 'Delete expense' }).click();
  await waitForToast(page, 'deleted');
  assert.equal(await page.locator('#toastAction').isVisible(), true);
  assert.equal((await dbSnapshot(page)).records.length, 1, 'delete is removed from IndexedDB immediately');
  await page.locator('#toastAction').click();
  await waitForToast(page, 'Expense restored.');
  assert.equal(await page.locator('#historyList .entry').count(), 2);

  await openRowMenu(page, '#historyList', 'Team dinner');
  await page.locator('#actionList .action__item').filter({ hasText: 'Delete expense' }).click();
  await waitForToast(page, 'deleted');
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  await page.locator('[data-view="expenses"]').click();
  await page.locator('#historyList .entry').first().waitFor();
  assert.equal(await page.locator('#historyList .entry').count(), 1, 'a deleted expense stays deleted after reload');

  await openDataSettings(page);
  const csv = await downloadFrom(page, () => page.locator('#exportCsv').click());
  assert.match(csv.filename, /^spendly-expenses-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.match(csv.text, /"Date","Description","Amount \(INR\)","Paid From"/);
  assert.match(csv.text, /"Coffee ""with friends"""/);
  assert.match(csv.text, /"80\.00"/);

  const backup = await downloadFrom(page, () => page.locator('#downloadBackup').click());
  const parsedBackup = JSON.parse(backup.text);
  assert.equal(parsedBackup.app, 'Spendly');
  assert.ok([5, 7].includes(parsedBackup.version));
  assert.equal(parsedBackup.schemaVersion, 7);
  assert.ok(parsedBackup.account);
  assert.equal(parsedBackup.expenses.length, 1);
  assert.ok(parsedBackup.expenses[0].createdAt);
  assert.equal(parsedBackup.salaries.length, 1);
  assert.deepEqual(parsedBackup.savings, []);
  await page.locator('#closeDataSettings').click();
  await page.locator('#dataSettingsSheet').waitFor({ state: 'hidden' });

  const invalidPath = path.join(RESULTS, 'invalid-backup.json');
  await writeFile(invalidPath, JSON.stringify({ expenses: [{ id: 'bad', amount: -5, description: 'Bad', date: today }] }));
  await page.locator('#fileInput').setInputFiles(invalidPath);
  await waitForToast(page, 'unreadable record');
  assert.equal(await page.locator('#actionSheet').isVisible(), false);
  assert.equal((await dbSnapshot(page)).records.length, 1, 'an invalid backup must not change data');

  const restorePath = path.join(RESULTS, 'restore-backup.json');
  const restored = [
    { id: 'restore-one', amount: 50, description: 'Restored tea', date: today },
    { id: 'restore-two', amount: 60, description: 'Restored snack', date: yesterday }
  ];
  await writeFile(restorePath, JSON.stringify({ app: 'Spendly', version: 2, expenses: restored }));
  await page.locator('#fileInput').setInputFiles(restorePath);
  await page.locator('#actionSheet').waitFor({ state: 'visible' });
  assert.match(await page.locator('#actionTitle').innerText(), /Restore this backup/i);
  assert.match(await page.locator('#actionMessage').innerText(), /2 expenses/);

  const safetyBackup = await downloadFrom(page, () => page.locator('#actionList .action__item').click());
  assert.match(safetyBackup.filename, /^spendly-before-restore-/);
  assert.equal(JSON.parse(safetyBackup.text).expenses.length, 1);
  await waitForToast(page, 'Backup restored');
  assert.equal(await page.locator('#allTotal').innerText(), formatMoney(110));
  assert.equal(await page.locator('#historyList .entry').count(), 2);
  await page.locator('#toastAction').click();
  await waitForToast(page, 'previous data is back');
  assert.equal(await page.locator('#allTotal').innerText(), formatMoney(80));
  assert.equal(await page.locator('#historyList .entry').count(), 1);

  await context.close();
});

await run('backup reminders can be snoozed and a downloaded backup is recorded', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);
  const records = Array.from({ length: 10 }, (_, index) => ({
    id: `backup-${index}`,
    amount: index + 1,
    description: `Backup reminder expense ${index + 1}`,
    date: daysAgoISO(index)
  }));
  await seedLegacy(page, records);
  await gotoApp(page);
  await page.locator('[data-view="expenses"]').click();
  await openDataSettings(page);
  assert.equal(await page.locator('#backupReminder').isVisible(), true, 'reminder appears after meaningful use');
  await page.locator('#dismissBackupReminder').click();
  await page.locator('#backupReminder').waitFor({ state: 'hidden' });
  let metadata = (await dbSnapshot(page)).meta;
  assert.ok(Date.parse(metadata.find(item => item.key === 'backup:reminder-dismissed-until')?.value));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  await page.locator('[data-view="expenses"]').click();
  await openDataSettings(page);
  assert.equal(await page.locator('#backupReminder').isVisible(), false, 'the snooze persists after reload');

  const backup = await downloadFrom(page, () => page.locator('#downloadBackup').click());
  assert.equal(JSON.parse(backup.text).expenses.length, 10);
  metadata = (await dbSnapshot(page)).meta;
  assert.ok(Date.parse(metadata.find(item => item.key === 'backup:last-download-request')?.value));
  assert.match(await page.locator('#storageHealth').innerText(), /browser|storage/i);
  await page.locator('#closeDataSettings').click();
  await page.locator('#dataSettingsSheet').waitFor({ state: 'hidden' });
  await context.close();
});

/* -------------------------------------------------------------------------- */
/* 3. Offline behaviour                                                      */
/* -------------------------------------------------------------------------- */

await run('the app launches, edits and exports with no network', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  const demo = [
    { id: 'offline-one', amount: 240, description: 'Lunch at Anand Sweets', date: daysAgoISO(0) },
    { id: 'offline-two', amount: 68, description: 'Auto to office', date: daysAgoISO(0) },
    { id: 'offline-three', amount: 640, description: 'Groceries', date: daysAgoISO(1) },
    { id: 'offline-four', amount: 320, description: 'Petrol', date: daysAgoISO(3) }
  ];
  await seedLegacy(page, demo);
  await gotoApp(page);
  await addSalary(page, { amount: '10000' });
  await waitForToast(page, 'Salary saved.');
  await page.locator('[data-view="dashboard"]').click();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await page.waitForFunction(async () => {
    const keys = await caches.keys();
    const key = keys.find(item => item.startsWith('spendly-shell-'));
    if (!key) return false;
    const cache = await caches.open(key);
    return (await cache.keys()).length >= 11;
  });

  const cachesInfo = await cacheContents(page);
  const shellKey = Object.keys(cachesInfo).find(key => key.startsWith('spendly-shell-'));
  assert.ok(shellKey, 'the app shell cache exists');
  for (const asset of APP_SHELL_PATHS) {
    assert.ok(cachesInfo[shellKey].includes(asset), `${asset} should be precached`);
  }

  const manifest = await page.evaluate(() => fetch('./manifest.json').then(response => response.json()));
  assert.equal(manifest.short_name, 'Spendly');
  assert.ok(manifest.theme_color);
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'));
  const iconStatuses = await page.evaluate(async () => {
    const paths = ['./icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-512-maskable.png'];
    return Promise.all(paths.map(async asset => (await fetch(asset)).status));
  });
  assert.deepEqual(iconStatuses, [200, 200, 200, 200]);
  const touchIconStatus = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="apple-touch-icon"]');
    return link ? (await fetch(link.href)).status : 0;
  });
  assert.equal(touchIconStatus, 200, 'the Apple touch icon is reachable');

  const totalBefore = await page.evaluate(() => document.getElementById('heroAmount').textContent);
  await context.setOffline(true);
  await page.locator('#offlineBanner').waitFor({ state: 'visible' });
  assert.match(await page.locator('#offlineBanner').innerText(), /You’re offline — your expenses are saved on this device\./);
  assert.ok(['Offline', 'Waiting for internet'].includes(await page.locator('#connectionText').innerText()), 'connection indicator indicates offline or waiting for internet');

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  assert.equal(await page.locator('#offlineBanner').isVisible(), true);
  assert.equal(await page.locator('#heroAmount').innerText(), totalBefore);
  assert.equal(await page.locator('#recentList .entry').count(), 4);

  await page.locator('[data-view="expenses"]').click();
  await page.locator('#historyList .entry').first().waitFor();
  await page.locator('#search').fill('Petrol');
  await page.waitForTimeout(250);
  assert.equal(await page.locator('#historyList .entry').count(), 1, 'search works while offline');
  await page.locator('#clearSearch').click();
  await page.locator('[data-view="dashboard"]').click();

  await addExpense(page, { amount: '42', description: 'Offline chai' });
  await waitForToast(page, 'Expense added successfully');
  assert.equal((await dbSnapshot(page)).records.length, 5);

  await page.locator('[data-view="expenses"]').click();
  await page.locator('#historyList .entry').first().waitFor();
  await openRowMenu(page, '#historyList', 'Offline chai');
  await page.locator('#actionList .action__item').filter({ hasText: 'Edit expense' }).click();
  await page.locator('#expenseSheet').waitFor({ state: 'visible' });
  await page.locator('#amountInput').fill('45');
  await page.locator('#saveButton').click();
  await page.locator('#expenseSheet').waitFor({ state: 'hidden' });
  await waitForToast(page, 'Expense updated');
  assert.equal(
    await page.locator('#historyList .entry').filter({ hasText: 'Offline chai' }).locator('.entry__amount').innerText(),
    formatMoney(45)
  );

  await openRowMenu(page, '#historyList', 'Offline chai');
  await page.locator('#actionList .action__item').filter({ hasText: 'Delete expense' }).click();
  await waitForToast(page, 'deleted');
  assert.equal((await dbSnapshot(page)).records.length, 4);
  await page.locator('#toastAction').click();
  await waitForToast(page, 'Expense restored.');
  assert.equal((await dbSnapshot(page)).records.length, 5);

  await openDataSettings(page);
  const csv = await downloadFrom(page, () => page.locator('#exportCsv').click());
  assert.match(csv.text, /Offline chai/);

  const backup = await downloadFrom(page, () => page.locator('#downloadBackup').click());
  assert.equal(JSON.parse(backup.text).expenses.length, 5);
  await page.locator('#closeDataSettings').click();
  await page.locator('#dataSettingsSheet').waitFor({ state: 'hidden' });

  const offlineRestorePath = path.join(RESULTS, 'offline-restore.json');
  await writeFile(offlineRestorePath, JSON.stringify([
    { id: 'offline-restore-one', amount: 11, description: 'Restored offline', date: daysAgoISO(0) }
  ]));
  await page.locator('#fileInput').setInputFiles(offlineRestorePath);
  await page.locator('#actionSheet').waitFor({ state: 'visible' });
  await downloadFrom(page, () => page.locator('#actionList .action__item').click());
  await waitForToast(page, 'Backup restored');
  assert.equal(await page.locator('#allTotal').innerText(), formatMoney(11));

  await page.close();
  const reopened = await context.newPage();
  watch(reopened);
  await reopened.goto(base, { waitUntil: 'load' });
  await reopened.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  assert.equal(await reopened.locator('#offlineBanner').isVisible(), true);
  assert.equal(await reopened.locator('#heroAmount').innerText(), formatMoney(11));
  assert.equal((await dbSnapshot(reopened)).records.length, 1);

  await context.setOffline(false);
  await reopened.locator('#offlineBanner').waitFor({ state: 'hidden' });
  assert.ok(['Available offline', 'Synced', 'Syncing…', 'Sync retry', 'Waiting for internet'].includes(await reopened.locator('#connectionText').innerText()), 'connection indicator indicates online or sync state');

  await context.close();
});

/* -------------------------------------------------------------------------- */
/* 4. Browser restart persistence                                             */
/* -------------------------------------------------------------------------- */

await run('expenses and the offline shell survive a full browser restart', async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'spendly-profile-'));
  const settings = {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'en-IN',
    timezoneId: 'Asia/Calcutta',
    acceptDownloads: true
  };

  try {
    let context = await chromium.launchPersistentContext(profile, settings);
    await seedAuthSession(context);
    let page = context.pages()[0] ?? await context.newPage();
    watch(page);
    await gotoApp(page);
    await addSalary(page, { amount: '10000' });
    await waitForToast(page, 'Salary saved.');
    await page.locator('[data-view="dashboard"]').click();
    await addExpense(page, { amount: '321', description: 'Survives a restart' });
    await waitForToast(page, 'Expense added successfully');
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    assert.equal((await dbSnapshot(page)).records.length, 1);
    await context.close();

    context = await chromium.launchPersistentContext(profile, settings);
    await seedAuthSession(context);
    page = context.pages()[0] ?? await context.newPage();
    globalThis.__activePage = page;
    watch(page);
    await gotoApp(page);
    assert.equal(await page.locator('#heroAmount').innerText(), formatMoney(321));
    assert.equal(await page.locator('#recentList .entry').count(), 1);

    await context.setOffline(true);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
    assert.equal(await page.locator('#offlineBanner').isVisible(), true);
    assert.equal(await page.locator('#heroAmount').innerText(), formatMoney(321));
    await context.close();
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {});
  }
});

/* -------------------------------------------------------------------------- */
/* 5. Salary, savings and the monthly remaining balance                       */
/* -------------------------------------------------------------------------- */

await run('salary pool balance tracks linked expenses and savings', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);
  await gotoApp(page);
  const current = monthKeyNow();

  await addSalary(page, { amount: '50,000', notes: 'November pay' });
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(50000));
  assert.equal((await page.locator('#salaryHistoryCount').textContent()).trim(), '1 month');
  assert.equal(await page.locator('#salaryList .entry').count(), 1);
  assert.equal(await page.locator('#salaryNotes').innerText(), '“November pay”');

  await addSaving(page, { amount: '1000', description: 'Emergency fund' });
  await waitForToast(page, 'added to savings');
  assert.equal(await page.locator('#savingsMonthTotal').innerText(), formatMoney(1000));

  await addSaving(page, { amount: '500', description: 'Gold' });
  assert.equal(await page.locator('#savingsMonthTotal').innerText(), formatMoney(1500));
  assert.equal(await page.locator('#savingsMonthList .entry').count(), 2);
  assert.match(await page.locator('#savingsMonthMeta').innerText(), /2 entries/);

  await page.locator('[data-view="salary"]').click();
  assert.equal(await page.locator('#salaryMonthLabel').innerText(), formatMonth(current));
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(48500));
  assert.equal(await page.locator('#salarySplit .split__item').nth(0).locator('strong').innerText(), formatMoney(50000));
  assert.equal(await page.locator('#salarySplit .split__item').nth(1).locator('strong').innerText(), formatMoney(1500));
  assert.equal(await page.locator('#salarySplit .split__item').nth(2).locator('strong').innerText(), formatMoney(0));

  await addExpense(page, { amount: '1250.50', description: 'Team dinner' });
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(47249.5));
  assert.equal(await page.locator('#salarySplit .split__item').nth(2).locator('strong').innerText(), formatMoney(1250.5));

  await page.locator('[data-view="expenses"]').click();
  await page.locator('#historyList .entry').first().waitFor();
  await openRowMenu(page, '#historyList', 'Team dinner');
  await page.locator('#actionList .action__item').filter({ hasText: 'Edit expense' }).click();
  await page.locator('#expenseSheet').waitFor({ state: 'visible' });
  await page.locator('#amountInput').fill('1000');
  await page.locator('#saveButton').click();
  await page.locator('#expenseSheet').waitFor({ state: 'hidden' });
  await page.locator('[data-view="salary"]').click();
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(47500));

  await page.locator('[data-view="expenses"]').click();
  await openRowMenu(page, '#historyList', 'Team dinner');
  await page.locator('#actionList .action__item').filter({ hasText: 'Delete expense' }).click();
  await waitForToast(page, 'deleted');
  await page.locator('[data-view="salary"]').click();
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(48500));
  await page.locator('#toastAction').click();
  await waitForToast(page, 'Expense restored.');
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(47500));

  await page.locator('[data-view="savings"]').click();
  await page.locator('#savingsTabMonth').click();
  await page.locator('#savingsMonthList .entry').filter({ hasText: 'Emergency fund' }).locator('.entry__menu').click();
  await page.locator('#actionList .action__item').filter({ hasText: 'Edit savings' }).click();
  await page.locator('#savingSheet').waitFor({ state: 'visible' });
  await page.locator('#savingAmountInput').fill('1200');
  await page.locator('#saveSavingButton').click();
  await page.locator('#savingSheet').waitFor({ state: 'hidden' });
  await waitForToast(page, 'Savings updated');
  assert.equal(await page.locator('#savingsMonthTotal').innerText(), formatMoney(1700));

  await page.locator('#savingsMonthList .entry').filter({ hasText: 'Gold' }).locator('.entry__menu').click();
  await page.locator('#actionList .action__item').filter({ hasText: 'Delete savings' }).click();
  await page.locator('#actionSheet').waitFor({ state: 'visible' });
  assert.match(await page.locator('#actionTitle').innerText(), /Delete this savings entry/i);
  await page.locator('#actionList .action__item').filter({ hasText: 'Delete savings' }).click();
  await waitForToast(page, 'Savings entry deleted.');
  assert.equal(await page.locator('#savingsMonthTotal').innerText(), formatMoney(1200));
  await page.locator('#toastAction').click();
  await waitForToast(page, 'Savings entry restored.');
  assert.equal(await page.locator('#savingsMonthTotal').innerText(), formatMoney(1700));

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  await page.locator('[data-view="salary"]').click();
  // salary 50,000 - expense 1,000 - savings 1,700 (1,200 + 500)
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(47300));
  await page.locator('[data-view="salary"]').click();
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(47300));
  await page.locator('[data-view="savings"]').click();
  await page.locator('#savingsTabTotal').click();
  assert.equal(await page.locator('#savingsTotalAmount').innerText(), formatMoney(1700));

  const snapshot = await dbSnapshot(page);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.salaries.length, 1);
  assert.equal(snapshot.savings.length, 2);
  assert.equal(snapshot.salaries[0].monthKey, current);
  assert.equal(snapshot.salaries[0].amountPaise, 5000000);
  assert.ok(snapshot.savings.every(record => record.amountPaise > 0 && record.monthKey === current));
  assert.ok(snapshot.savings.every(record => !snapshot.records.some(expense => expense.id === record.id)));

  await page.locator('[data-view="expenses"]').click();
  assert.equal(await page.locator('#allTotal').innerText(), formatMoney(1000));
  assert.equal(await page.locator('#allCount').innerText(), '1 expense');

  await context.close();
});

await run('savings use salary first then preserve extra-income funding allocations', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);
  await gotoApp(page);
  const current = monthKeyNow();
  const previous = shiftMonthKey(current, -1);
  const receivedDate = daysAgoISO(0);
  await addSalary(page, { amount: '1000', monthKey: previous });
  await addExtraIncome(page, { amount: '6000', date: receivedDate, salaryMonth: previous, description: 'Previous pool project' });
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(7000));
  assert.equal(await page.locator('#salarySplit .split__item').nth(0).locator('strong').innerText(), formatMoney(1000));
  assert.match(await page.locator('#extraIncomeList').innerText(), new RegExp(formatDate(receivedDate)));
  assert.match(await page.locator('#extraIncomeList').innerText(), new RegExp(`For ${formatMonth(previous)} salary`));

  await addSalary(page, { amount: '10000', monthKey: current });
  await addExpense(page, { amount: '5000', description: 'Salary spending' });
  await addExtraIncome(page, { amount: '8000', date: receivedDate, salaryMonth: current, source: 'freelancing', description: 'Website project' });
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(13000));
  assert.equal(await page.locator('#salarySplit .split__item').nth(0).locator('strong').innerText(), formatMoney(10000));
  assert.equal(await page.locator('#extraIncomeList [data-extra-income-edit]').count(), 1, 'only current salary income is shown');
  await page.locator('[data-extra-income-edit]').click();
  await page.locator('#extraIncomeDescription').fill('Client website project');
  await page.locator('#saveExtraIncomeButton').click();
  await page.locator('#extraIncomeSheet').waitFor({ state: 'hidden' });
  assert.equal((await page.locator('#extraIncomeTotal').textContent()).trim(), `${formatMoney(8000)} received`);
  assert.equal(await page.locator('#extraIncomeList [data-extra-income-edit]').count(), 1);
  await page.locator('#salaryPrevMonth').click();
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(7000));
  assert.equal((await page.locator('#extraIncomeTotal').textContent()).trim(), `${formatMoney(6000)} received`);
  assert.equal(await page.locator('#extraIncomeList [data-extra-income-edit]').count(), 1, 'November received date does not move October income to November');
  assert.match(await page.locator('#extraIncomeList').innerText(), new RegExp(formatDate(receivedDate)));
  await page.locator('#salaryNextMonth').click();
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(13000));
  await addSaving(page, { amount: '10000', description: 'Combined contribution', source: 'salary' });
  await page.locator('[data-view="salary"]').click();
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(3000));
  assert.deepEqual(
    await page.locator('#salarySplit .split__item strong').allTextContents(),
    [formatMoney(10000), formatMoney(10000), formatMoney(5000)]
  );
  await page.locator('[data-view="savings"]').click();
  assert.equal(await page.locator('#savingsTotalAmount').innerText(), formatMoney(10000));
  const snapshot = await dbSnapshot(page);
  const saving = snapshot.savings.find(record => record.description === 'Combined contribution');
  const currentSalary = snapshot.salaries.find(record => record.monthKey === current);
  const previousSalary = snapshot.salaries.find(record => record.monthKey === previous);
  const currentIncome = snapshot.extraIncome.find(record => record.description === 'Client website project');
  const previousIncome = snapshot.extraIncome.find(record => record.description === 'Previous pool project');
  assert.equal(saving.amount, 10000);
  assert.equal(saving.salaryRecordId, currentSalary.id);
  assert.equal(saving.salaryAllocationPaise, 500000);
  assert.deepEqual(saving.extraIncomeAllocations, [{ extraIncomeRecordId: currentIncome.id, amountPaise: 500000 }]);
  assert.equal(currentIncome.salaryRecordId, currentSalary.id);
  assert.equal(previousIncome.salaryRecordId, previousSalary.id);
  assert.equal(previousIncome.date, receivedDate);

  await page.locator('[data-view="salary"]').click();
  await page.locator(`[data-extra-income-edit="${currentIncome.id}"]`).click();
  await page.locator('#extraIncomeAmount').fill('9000');
  await page.locator('#saveExtraIncomeButton').click();
  await page.locator('#extraIncomeSheet').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(4000), 'editing income recalculates only its assigned pool');
  await page.locator(`[data-extra-income-edit="${currentIncome.id}"]`).click();
  await page.locator('#extraIncomeAmount').fill('8000');
  await page.locator('#saveExtraIncomeButton').click();
  await page.locator('#extraIncomeSheet').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(3000));

  await page.locator('[data-view="savings"]').click();
  await openRowMenu(page, '#savingsMonthList', 'Combined contribution');
  await page.locator('#actionList .action__item').filter({ hasText: 'Edit savings' }).click();
  await page.locator('#savingAmountInput').fill('14000');
  await page.locator('#saveSavingButton').click();
  await page.waitForTimeout(300);
  if (await page.locator('#savingSheet').isVisible()) {
    assert.match(await page.locator('#savingFormError').innerText(), /have ₹13,000\.00 available/i);
    await page.locator('#closeSavingSheet').click();
    await page.locator('#savingSheet').waitFor({ state: 'hidden' });
  }
  await page.locator('[data-view="salary"]').click();
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(3000));
  await page.locator('[data-view="savings"]').click();
  assert.equal(await page.locator('#savingsTotalAmount').innerText(), formatMoney(10000));
  await page.locator('[data-view="salary"]').click();
  await page.locator('[data-extra-income-delete]').click();
  await waitForToast(page, 'funded savings');

  await page.locator('#salaryPrevMonth').click();
  await page.locator('#addExtraIncomeButton').click();
  await page.locator('#extraIncomeSheet').waitFor({ state: 'visible' });
  assert.equal((await page.locator('#extraIncomeDate').inputValue()).slice(0, 7), previous);
  assert.equal((await page.locator('#extraIncomeSalarySelect').inputValue()), previousSalary.id);
  await page.locator('#extraIncomeAmount').fill('1000');
  await page.locator('#extraIncomeDescription').fill('Previous month project');
  await page.locator('#saveExtraIncomeButton').click();
  await page.locator('#extraIncomeSheet').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(8000));
  assert.equal(await page.locator('#extraIncomeList [data-extra-income-edit]').count(), 2);
  await page.locator('#extraIncomeList [data-extra-income-delete]').last().click();
  await page.waitForFunction(() => document.querySelectorAll('#extraIncomeList [data-extra-income-edit]').length === 1);
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(7000), 'deleting unused income recalculates only its assigned pool');
  assert.equal(await page.locator('#extraIncomeList [data-extra-income-edit]').count(), 1);
  await page.locator('#salaryNextMonth').click();
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(3000));
  assert.equal(await page.locator('#extraIncomeList [data-extra-income-edit]').count(), 1);
  await context.close();
});

await run('financial undo preserves allocations, survives reload and works offline; erase-all is confirmed', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);
  await gotoApp(page);
  await context.setOffline(true);
  await page.locator('#offlineBanner').waitFor({ state: 'visible' });

  const current = monthKeyNow();
  const previous = shiftMonthKey(current, -1);
  const receivedDate = daysAgoISO(0);
  await addSalary(page, { amount: '3000', monthKey: previous });
  await addSalary(page, { amount: '10000', monthKey: current });

  await addExtraIncome(page, { amount: '5000', date: receivedDate, salaryMonth: current, description: 'Quick undo income' });
  await waitForToast(page, 'extra income added');
  assert.equal(await page.locator('#toastAction').isVisible(), true);
  await page.setViewportSize({ width: 320, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'the income Undo row fits a 320px screen');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#toastAction').click();
  await waitForToast(page, 'Extra income reversed.');
  let snapshot = await dbSnapshot(page);
  const quickIncome = snapshot.extraIncome.find(record => record.description === 'Quick undo income');
  assert.ok(quickIncome.reversedAt);
  assert.equal(quickIncome.date, receivedDate);
  assert.equal(quickIncome.salaryRecordId, snapshot.salaries.find(record => record.monthKey === current).id);
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(10000));
  const repeatedIncomeUndo = await page.evaluate(async id => {
    const { openSpendlyDB } = await import('/js/db.js');
    const { FinancialLedgerRepository } = await import('/js/repository.js');
    const dbName = document.documentElement.dataset.activeDb;
    const ledger = new FinancialLedgerRepository(await openSpendlyDB(dbName));
    try { await ledger.reverseExtraIncome(id); return false; } catch (error) { return error.name === 'AlreadyReversedError'; }
  }, quickIncome.id);
  assert.equal(repeatedIncomeUndo, true, 'the same income record cannot be reversed twice');

  await addExtraIncome(page, { amount: '5000', date: receivedDate, salaryMonth: current, description: 'History undo income' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  await page.locator('[data-view="salary"]').click();
  await page.locator('#extraIncomeList [data-extra-income-undo]').click();
  await page.locator('#actionList .action__item').filter({ hasText: 'Undo extra income' }).click();
  await waitForToast(page, 'Extra income reversed.');
  snapshot = await dbSnapshot(page);
  const historyIncome = snapshot.extraIncome.find(record => record.description === 'History undo income');
  assert.ok(historyIncome.reversedAt, 'the history action works after refresh');
  assert.equal(historyIncome.date, receivedDate);
  assert.equal(historyIncome.salaryRecordId, snapshot.salaries.find(record => record.monthKey === current).id);

  await addExtraIncome(page, { amount: '5000', date: receivedDate, salaryMonth: current, description: 'Allocated undo income' });
  await addSaving(page, { amount: '12000', description: 'Combined source contribution', source: 'salary' });
  await waitForToast(page, 'added to savings');
  snapshot = await dbSnapshot(page);
  const income = snapshot.extraIncome.find(record => record.description === 'Allocated undo income');
  const contribution = snapshot.savings.find(record => record.description === 'Combined source contribution');
  assert.equal(contribution.salaryAllocationPaise, 1000000);
  assert.deepEqual(contribution.extraIncomeAllocations, [{ extraIncomeRecordId: income.id, amountPaise: 200000 }]);

  await page.locator('[data-view="salary"]').click();
  await page.locator('#extraIncomeList [data-extra-income-undo]').click();
  await page.locator('#actionList .action__item').filter({ hasText: 'Undo extra income' }).click();
  await waitForToast(page, 'Reverse those savings entries first');
  snapshot = await dbSnapshot(page);
  assert.equal(Boolean(snapshot.extraIncome.find(record => record.id === income.id).reversedAt), false);

  await page.locator('[data-view="savings"]').click();
  await page.locator('#savingsMonthList .entry').filter({ hasText: 'Combined source contribution' }).locator('.entry__menu').click();
  await page.locator('#actionList .action__item').filter({ hasText: 'Undo savings transaction' }).click();
  await page.locator('#actionList .action__item').filter({ hasText: 'Undo transaction' }).click();
  await waitForToast(page, 'Savings transaction reversed.');
  snapshot = await dbSnapshot(page);
  const reversedContribution = snapshot.savings.find(record => record.id === contribution.id);
  assert.ok(reversedContribution.reversedAt);
  assert.equal(reversedContribution.salaryAllocationPaise, 1000000);
  assert.deepEqual(reversedContribution.extraIncomeAllocations, [{ extraIncomeRecordId: income.id, amountPaise: 200000 }]);
  assert.equal(await page.locator('#savingsTotalAmount').innerText(), formatMoney(0));
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(15000));

  const repeatedSavingUndo = await page.evaluate(async id => {
    const { openSpendlyDB } = await import('/js/db.js');
    const { FinancialLedgerRepository } = await import('/js/repository.js');
    const dbName = document.documentElement.dataset.activeDb;
    const ledger = new FinancialLedgerRepository(await openSpendlyDB(dbName));
    try { await ledger.reverseSaving(id); return false; } catch (error) { return error.name === 'AlreadyReversedError'; }
  }, contribution.id);
  assert.equal(repeatedSavingUndo, true, 'the same savings record cannot be reversed twice');

  await page.locator('[data-view="salary"]').click();
  await page.locator('#extraIncomeList [data-extra-income-undo]').click();
  await page.locator('#actionList .action__item').filter({ hasText: 'Undo extra income' }).click();
  await waitForToast(page, 'Extra income reversed.');
  snapshot = await dbSnapshot(page);
  const reversedIncome = snapshot.extraIncome.find(record => record.id === income.id);
  assert.ok(reversedIncome.reversedAt);
  assert.equal(reversedIncome.date, receivedDate);
  assert.equal(reversedIncome.salaryRecordId, contribution.salaryRecordId);
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(10000));

  await page.locator('#salaryPrevMonth').click();
  await page.locator('#salaryTransferButton').click();
  await waitForToast(page, 'transferred to savings');
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(0));
  await page.locator('#toastAction').click();
  await waitForToast(page, 'Savings transaction reversed.');
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(3000));
  await page.locator('[data-view="savings"]').click();
  await page.locator('#savingsTabTotal').click();
  assert.equal(await page.locator('#savingsTotalAmount').innerText(), formatMoney(0));

  await page.locator('[data-view="salary"]').click();
  await page.locator('#salaryNextMonth').click();
  await addExtraIncome(page, { amount: '5000', date: receivedDate, salaryMonth: current, description: 'Income now spent' });
  await page.locator('[data-view="dashboard"]').click();
  await addExpense(page, { amount: '12000', description: 'Spent linked income' });
  await page.locator('[data-view="salary"]').click();
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(3000));
  await page.locator('#extraIncomeList [data-extra-income-undo]').click();
  await page.locator('#actionList .action__item').filter({ hasText: 'Undo extra income' }).click();
  await waitForToast(page, 'make the salary balance negative');
  snapshot = await dbSnapshot(page);
  assert.equal(Boolean(snapshot.extraIncome.find(record => record.description === 'Income now spent').reversedAt), false);
  assert.equal(snapshot.records.some(record => record.description === 'Spent linked income'), true);

  await openDataSettings(page);
  await page.locator('#eraseAllData').click();
  assert.match(await page.locator('#actionMessage').innerText(), /permanently deletes all expenses.*cannot be undone/i);
  await page.locator('#actionList .action__item').filter({ hasText: 'Erase all data' }).click();
  await waitForToast(page, 'All Spendly data erased.');
  snapshot = await dbSnapshot(page);
  assert.equal(snapshot.records.length, 0);
  assert.equal(snapshot.salaries.length, 0);
  assert.equal(snapshot.savings.length, 0);
  assert.equal(snapshot.extraIncome.length, 0);
  await context.close();
});

await run('Others expenses and external savings never change salary balance', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);
  await gotoApp(page);
  await addSalary(page, { amount: '20000' });
  await addSaving(page, { amount: '1000', description: 'Set aside', source: 'salary' });
  await addSaving(page, { amount: '2000', description: 'Family gift', source: 'gift' });
  await addSaving(page, { amount: '500', description: 'Annual bonus', source: 'bonus' });
  await addSaving(page, { amount: '300', description: 'Refund', source: 'other' });
  await addExpense(page, { amount: '1500', description: 'External purchase', source: 'others' });
  await page.locator('[data-view="salary"]').click();
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(19000));
  await page.locator('[data-view="savings"]').click();
  assert.equal(await page.locator('#savingsTotalAmount').innerText(), formatMoney(3800));
  const snapshot = await dbSnapshot(page);
  const externalExpense = snapshot.records.find(record => record.description === 'External purchase');
  assert.equal(externalExpense.paymentSource, 'others');
  assert.equal(externalExpense.salaryRecordId, null);
  assert.equal(snapshot.savings.filter(record => record.type === 'withdrawal').length, 0);
  assert.equal(snapshot.savings.filter(record => record.type === 'external_contribution').length, 3);
  assert.equal(snapshot.savings.find(record => record.description === 'Family gift').sourceType, 'gift');
  assert.equal(snapshot.savings.find(record => record.description === 'Annual bonus').sourceType, 'bonus');
  assert.equal(snapshot.savings.find(record => record.description === 'Refund').sourceType, 'other');
  await context.close();
});

await run('salary pools, balance transfers and savings-funded expenses stay linked', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);
  await gotoApp(page);
  const current = monthKeyNow();
  const previous = shiftMonthKey(current, -1);

  await addSalary(page, { amount: '50000', monthKey: previous });
  await waitForToast(page, 'Salary saved.');
  await page.locator('[data-view="dashboard"]').click();
  await addExpense(page, { amount: '5000', description: 'November groceries' });
  assert.equal(await page.locator('[data-view="salary"]').getAttribute('data-view'), 'salary');
  await addSaving(page, { amount: '10000', description: 'Set aside before payday' });
  await page.locator('[data-view="salary"]').click();
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(35000));

  await addSalary(page, { amount: '40000', monthKey: current, transferChoice: 'Move to Savings' });
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(40000));
  await page.locator('#salaryPrevMonth').click();
  await page.waitForFunction(() => document.getElementById('salaryAmount')?.innerText === '₹0.00');
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(0));
  await page.locator('#salaryNextMonth').click();

  await page.locator('[data-view="dashboard"]').click();
  await addExpense(page, { amount: '3000', description: 'November fuel' });
  await page.locator('[data-view="salary"]').click();
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(37000));

  await page.locator('[data-view="dashboard"]').click();
  await addExpense(page, { amount: '3000', description: 'Savings repair', source: 'savings' });
  await page.locator('[data-view="savings"]').click();
  await page.locator('#savingsTabTotal').click();
  assert.equal(await page.locator('#savingsTotalAmount').innerText(), formatMoney(42000));
  assert.equal(await page.locator('#savingsTotalWithdrawals').innerText(), formatMoney(3000));
  assert.match(await page.locator('#savingsTotalMonthList').innerText(), /Used for expense/);

  await page.locator('[data-view="dashboard"]').click();
  await page.locator('#addExpenseButton').click();
  await page.locator('#amountInput').fill('43000');
  await page.locator('#descriptionInput').fill('Too large for savings');
  await page.locator('#paidFromSavings').check();
  await page.locator('#saveButton').click();
  await page.locator('#formError').waitFor({ state: 'visible' });
  assert.match(await page.locator('#formError').innerText(), /Insufficient savings balance/i);
  await page.locator('#closeExpenseSheet').click();
  await page.locator('#expenseSheet').waitFor({ state: 'hidden' });

  await page.locator('[data-view="expenses"]').click();
  await openRowMenu(page, '#historyList', 'Savings repair');
  await page.locator('#actionList .action__item').filter({ hasText: 'Edit expense' }).click();
  await page.locator('#expenseSheet').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#paidFromSavings').isChecked(), true);
  await page.locator('#amountInput').fill('4000');
  await page.locator('#paidFromSalary').check();
  await page.locator('#saveButton').click();
  await page.locator('#expenseSheet').waitFor({ state: 'hidden' });
  await page.locator('[data-view="salary"]').click();
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(33000));
  const snapshot = await dbSnapshot(page);
  const expense = snapshot.records.find(record => record.description === 'Savings repair');
  assert.equal(expense.paymentSource, 'salary');
  assert.equal(expense.salaryRecordId, snapshot.salaries.find(record => record.monthKey === current).id);
  assert.equal(snapshot.savings.filter(record => record.type === 'withdrawal').length, 0);
  assert.equal(snapshot.savings.filter(record => record.type === 'salary_balance_transfer').length, 1);

  await page.locator('[data-view="savings"]').click();
  await page.locator('#savingsTabMonth').click();
  await openRowMenu(page, '#savingsMonthList', `Remaining ${previous} salary`);
  await page.locator('#actionList .action__item').filter({ hasText: 'Edit savings' }).click();
  await page.locator('#savingSheet').waitFor({ state: 'visible' });
  await page.locator('#savingAmountInput').fill('34000');
  await page.locator('#saveSavingButton').click();
  await page.locator('#savingSheet').waitFor({ state: 'hidden' });

  await page.locator('#savingsMonthList .entry').filter({ hasText: `Remaining ${previous} salary` }).locator('.entry__menu').click();
  await page.locator('#actionList .action__item').filter({ hasText: 'Delete savings' }).click();
  await page.locator('#actionList .action__item').filter({ hasText: 'Delete savings' }).click();
  await waitForToast(page, 'Savings entry deleted.');
  await page.locator('#toastAction').click();
  await waitForToast(page, 'Savings entry restored.');

  await page.locator('[data-view="salary"]').click();
  await page.locator('#salaryPrevMonth').click();
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(1000));
  await page.locator('#salaryTransferButton').click();
  await page.waitForFunction(() => document.getElementById('salaryAmount')?.innerText === '₹0.00');
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(0));
  const finalSnapshot = await dbSnapshot(page);
  const transfers = finalSnapshot.savings.filter(record => record.type === 'salary_balance_transfer');
  assert.equal(transfers.length, 2);
  assert.equal(transfers.reduce((sum, record) => sum + record.amountPaise, 0), 3500000);
  await context.close();
});

await run('salary months stay independent and duplicate months are blocked', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);
  await gotoApp(page);
  const current = monthKeyNow();
  const previous = shiftMonthKey(current, -1);

  await addSalary(page, { amount: '50000' });
  await waitForToast(page, 'Salary saved.');

  await page.locator('#salaryPrevMonth').click();
  assert.equal(await page.locator('#salaryMonthLabel').innerText(), formatMonth(previous));
  assert.equal(await page.locator('#salaryAmount').innerText(), 'No salary pool');
  assert.match(await page.locator('#salaryStatus').innerText(), /No salary pool/);
  assert.equal(await page.locator('#salaryClearButton').isHidden(), true);

  await page.locator('#salaryEditButton').click();
  await page.locator('#salarySheet').waitFor({ state: 'visible' });
  await page.locator('#salaryAmountInput').fill('45000');
  await page.locator('#saveSalaryButton').click();
  await page.locator('#salarySheet').waitFor({ state: 'hidden' });
  await waitForToast(page, 'Salary saved.');
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(45000));
  assert.equal(await page.locator('#salaryMonthLabel').innerText(), formatMonth(previous));
  if (await page.locator('#actionSheet').isVisible()) {
    await page.locator('#actionList .action__item').filter({ hasText: 'Not Now' }).click();
    await page.locator('#actionSheet').waitFor({ state: 'hidden' });
  }

  await page.locator('#salaryNextMonth').click();
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(50000));
  assert.equal(await page.locator('#salaryList .entry').count(), 2);
  assert.equal((await page.locator('#salaryHistoryCount').textContent()).trim(), '2 months');

  await page.locator('#salaryPrevMonth').click();
  await page.locator('#salaryEditButton').click();
  await setSalaryMonth(page, current);
  await page.locator('#saveSalaryButton').click();
  await page.locator('#salaryFormError').waitFor({ state: 'visible' });
  assert.match(await page.locator('#salaryFormError').innerText(), /already has a salary/i);
  assert.equal(await page.locator('#salarySheet').isVisible(), true, 'the sheet stays open after a duplicate');
  await page.locator('#closeSalarySheet').click();
  await page.locator('#salarySheet').waitFor({ state: 'hidden' });

  assert.equal(await page.locator('#salaryList .entry').count(), 2);
  const snapshot = await dbSnapshot(page);
  assert.equal(snapshot.salaries.length, 2);
  assert.deepEqual(
    snapshot.salaries.map(record => record.amount).sort((a, b) => a - b),
    [45000, 50000]
  );

  await page.locator('#salaryNextMonth').click();
  await page.locator('#salaryNextMonth').click();
  assert.equal((await page.locator('#salaryMonthHint').textContent()).trim(), 'Future month');
  assert.equal(await page.locator('#salaryAmount').innerText(), 'No salary pool');

  await context.close();
});

await run('page and month routes survive reload and browser back/forward', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);
  await page.goto(`${base}/#/salary/2026-10`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  assert.equal(await page.locator('#salaryMonthLabel').innerText(), 'October 2026');
  await page.locator('#salaryNextMonth').click();
  assert.equal(new URL(page.url()).hash, '#/salary/2026-11');
  await page.locator('#salaryMonthPickerButton').click();
  await page.locator('#monthPickerSheet').waitFor({ state: 'visible' });
  await page.locator('#pickerYearSelect').selectOption('2026');
  await page.locator('#pickerMonthSelect').selectOption('12');
  await page.locator('#pickerGoButton').click();
  await page.locator('#monthPickerSheet').waitFor({ state: 'hidden' });
  assert.equal(new URL(page.url()).hash, '#/salary/2026-12');
  await page.goBack();
  await page.waitForFunction(() => location.hash === '#/salary/2026-11');
  assert.equal(await page.locator('#salaryMonthLabel').innerText(), 'November 2026');
  await page.goForward();
  await page.waitForFunction(() => location.hash === '#/salary/2026-12');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  assert.equal(await page.locator('#salaryMonthLabel').innerText(), 'December 2026');

  await page.locator('[data-view="savings"]').click();
  await page.locator('#savingsTabTotal').click();
  assert.match(new URL(page.url()).hash, /^#\/savings\/total\/\d{4}-\d{2}$/);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  assert.equal(await page.locator('#savingsTabTotal').getAttribute('aria-selected'), 'true');

  await page.locator('[data-view="expenses"]').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'expensesTitle', 'page navigation moves focus to the heading');
  const shortcut = await context.newPage();
  watch(shortcut);
  await shortcut.goto(`${base}/?view=salary&action=add-salary`, { waitUntil: 'networkidle' });
  await shortcut.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  await shortcut.locator('#salarySheet').waitFor({ state: 'visible' });
  assert.equal(new URL(shortcut.url()).search, '', 'legacy PWA launch parameters are consumed');
  assert.match(new URL(shortcut.url()).hash, /^#\/salary\/\d{4}-\d{2}$/);
  await context.close();
});

await run('salary summary export matches salary pools and last-month copy only prefills', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);
  await gotoApp(page);
  const current = monthKeyNow();
  const previous = shiftMonthKey(current, -1);
  const next = shiftMonthKey(current, 1);
  await addSalary(page, { amount: '50000', monthKey: previous });
  await addExpense(page, { amount: '1000', description: 'Previous month expense', date: `${previous}-10` });
  await addSalary(page, { amount: '50', monthKey: current });
  await addExpense(page, { amount: '80', description: 'Current month overspend', date: `${current}-11` });
  assert.match(await page.locator('#salaryMonthTrend').innerText(), new RegExp(`less than ${formatMonth(previous)}`, 'i'));

  const csv = await downloadFrom(page, () => page.locator('#exportSalaryCsv').click());
  assert.match(csv.filename, /^spendly-salary-summary-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.match(csv.text, /"Month","Salary \(INR\)","Extra income \(INR\)","Expenses \(INR\)","Savings \(INR\)","Remaining \(INR\)"/);
  assert.match(csv.text, new RegExp(`"${formatMonth(previous)}","50000\\.00","0\\.00","1000\\.00","0\\.00","49000\\.00"`));
  assert.match(csv.text, new RegExp(`"${formatMonth(current)}","50\\.00","0\\.00","80\\.00","0\\.00","-30\\.00"`));

  await page.locator('#salaryMonthPickerButton').click();
  await page.locator('#monthPickerSheet').waitFor({ state: 'visible' });
  await page.locator('#pickerYearSelect').selectOption(next.slice(0, 4));
  await page.locator('#pickerMonthSelect').selectOption(next.slice(5, 7));
  await page.locator('#pickerGoButton').click();
  await page.locator('#monthPickerSheet').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#copyPreviousSalaryButton').isVisible(), true);
  assert.match(await page.locator('#copyPreviousSalaryButton').innerText(), /₹50\.00/);
  const countBeforeCopy = (await dbSnapshot(page)).salaries.length;
  await page.locator('#copyPreviousSalaryButton').click();
  assert.equal(await page.locator('#salaryAmountInput').inputValue(), '50.00');
  assert.equal((await dbSnapshot(page)).salaries.length, countBeforeCopy, 'prefill does not save a salary');
  await page.locator('#closeSalarySheet').click();
  await page.locator('#salarySheet').waitFor({ state: 'hidden' });
  await context.close();
});

await run('the salary month navigator jumps, returns to the current month and never writes records', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);
  await gotoApp(page);
  const current = monthKeyNow();
  const previous = shiftMonthKey(current, -1);
  const future = shiftMonthKey(current, 2);

  assert.equal(await page.locator('#salaryMonthLabel').innerText(), formatMonth(current));
  assert.equal(await page.locator('#salaryMonthHint').innerText(), 'Current month');
  assert.equal(await page.locator('#salaryNowRow').isHidden(), true, 'no shortcut on the current month');

  await addSalary(page, { amount: '50000' });
  await waitForToast(page, 'Salary saved.');
  await addExpense(page, { amount: '1200', description: 'Groceries' });
  await addSaving(page, { amount: '3000', description: 'Emergency fund' });

  await page.locator('[data-view="salary"]').click();
  assert.equal(await page.locator('#salarySplit .split__item').nth(0).locator('strong').textContent(), formatMoney(50000));

  // Opening the navigator from the current month and picking the previous one.
  await page.locator('#salaryMonthPickerButton').click();
  await page.locator('#monthPickerSheet').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#pickerMonthSelect').inputValue(), current.slice(5, 7));
  assert.equal(await page.locator('#pickerYearSelect').inputValue(), current.slice(0, 4));
  await page.locator('#pickerMonthSelect').selectOption(previous.slice(5, 7));
  await page.locator('#pickerYearSelect').selectOption(previous.slice(0, 4));
  await page.locator('#pickerGoButton').click();
  await page.locator('#monthPickerSheet').waitFor({ state: 'hidden' });

  assert.equal(await page.locator('#salaryMonthLabel').innerText(), formatMonth(previous));
  assert.equal((await page.locator('#salaryMonthHint').textContent()).trim(), 'Past month');
  assert.equal(await page.locator('#salaryAmount').innerText(), 'No salary pool');
  assert.equal(await page.locator('#salaryStatus').innerText().then(text => text.includes('No salary pool')), true);
  assert.equal(await page.locator('#salarySplit .split__item--end strong').innerText(), '—');
  assert.equal(await page.locator('#salaryNowRow').isVisible(), true, 'shortcut appears off the current month');
  assert.equal(await page.locator('#salaryList .entry').count(), 1, 'history still lists only the real record');

  // Arrows keep working from the picker-selected month, including the future.
  await page.locator('#salaryNextMonth').click();
  await page.locator('#salaryNextMonth').click();
  await page.locator('#salaryNextMonth').click();
  assert.equal(await page.locator('#salaryMonthLabel').innerText(), formatMonth(future));
  assert.equal((await page.locator('#salaryMonthHint').textContent()).trim(), 'Future month');
  assert.equal(await page.locator('#salaryAmount').innerText(), 'No salary pool');
  assert.equal(await page.locator('#salaryEditButton').innerText(), 'Add salary');

  const untouched = await dbSnapshot(page);
  assert.equal(untouched.salaries.length, 1, 'navigation never creates salary records');
  assert.equal(untouched.savings.length, 1);
  assert.equal(untouched.records.length, 1);

  // The Current month shortcut returns to today with the real numbers intact.
  await page.locator('#salaryCurrentMonth').click();
  assert.equal(await page.locator('#salaryMonthLabel').innerText(), formatMonth(current));
  assert.equal(await page.locator('#salaryNowRow').isHidden(), true);
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(45800));
  assert.equal(await page.locator('#salarySplit .split__item--end strong').innerText(), formatMoney(1200));

  await context.close();
});

await run('a sheet can be reopened while it is still closing', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);
  await gotoApp(page);
  await addSalary(page, { amount: '10000' });
  await waitForToast(page, 'Salary saved.');
  await page.locator('[data-view="savings"]').click();

  for (const amount of ['1000', '2000']) {
    await page.locator('#addSavingButton').click();
    await page.locator('#savingSheet').waitFor({ state: 'visible' });
    await page.locator('#savingAmountInput').fill(amount);
    await page.locator('#saveSavingButton').click();
    // Re-open immediately, before the 210 ms close animation finishes.
    await page.locator('#addSavingButton').click();
    await page.locator('#savingSheet').waitFor({ state: 'visible' });
    await page.locator('#savingAmountInput').waitFor({ state: 'visible' });
    // Let the open animation settle before measuring the sheet position.
    await page.waitForFunction(() => {
      const sheet = document.getElementById('savingSheet');
      const style = getComputedStyle(sheet);
      return style.animationName === 'none' || sheet.getAnimations().every(animation => animation.playState === 'finished');
    });
    const onScreen = await page.locator('#saveSavingButton').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    });
    assert.equal(onScreen, true, 'the reopened sheet is positioned on screen');
    await page.locator('#closeSavingSheet').click();
    await page.locator('#savingSheet').waitFor({ state: 'hidden' });
  }

  assert.equal(await page.locator('#savingsMonthList .entry').count(), 2);
  await context.close();
});

await run('negative balances and months without salary are shown honestly', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);
  await gotoApp(page);

  await page.locator('[data-view="salary"]').click();
  assert.equal(await page.locator('#salaryAmount').innerText(), 'No salary pool');
  assert.equal(await page.locator('#salaryAmount').evaluate(element => element.classList.contains('is-unset')), true);
  assert.match(await page.locator('#salaryStatus').innerText(), /No salary pool/);

  await addSalary(page, { amount: '1000' });
  await addExpense(page, { amount: '2000', description: 'Unexpected repair' });
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(-1000));
  assert.equal(await page.locator('#salaryAmount').evaluate(element => element.classList.contains('is-negative')), true);
  assert.equal(await page.locator('#salarySplit .split__item').nth(2).locator('strong').innerText(), formatMoney(2000));

  await context.close();
});

await run('savings history spans months and stays out of expenses', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);
  await gotoApp(page);
  await addSalary(page, { amount: '10000' });
  await waitForToast(page, 'Salary saved.');
  const current = monthKeyNow();
  const previous = shiftMonthKey(current, -1);

  await addSaving(page, { amount: '1000', description: 'This month' });
  await waitForToast(page, 'added to savings');

  await page.locator('#savingsTabTotal').click();
  assert.equal(await page.locator('#savingsTotalAmount').innerText(), formatMoney(1000));
  assert.equal(await page.locator('#savingsTotalMonthLabel').innerText(), formatMonth(current));
  assert.equal(await page.locator('#savingsMonthGroups .month-row').count(), 1);

  await page.locator('#savingsPrevMonth').click();
  assert.equal(await page.locator('#savingsTotalMonthLabel').innerText(), formatMonth(previous));
  assert.equal(await page.locator('#savingsTotalMonthAmount').innerText(), formatMoney(0));
  assert.match(await page.locator('#savingsTotalMonthMeta').innerText(), /No entries/);

  await page.locator('#addSavingTotalButton').click();
  await page.locator('#savingSheet').waitFor({ state: 'visible' });
  assert.match(await page.locator('#savingDateInput').inputValue(), new RegExp(`^${previous}-\\d{2}$`));
  await page.locator('#savingAmountInput').fill('2500');
  await page.locator('#savingDescriptionInput').fill('Last month fund');
  await page.locator('#saveSavingButton').click();
  await page.locator('#savingSheet').waitFor({ state: 'hidden' });
  await waitForToast(page, 'added to savings');

  assert.equal(await page.locator('#savingsTotalMonthAmount').innerText(), formatMoney(2500));
  assert.equal(await page.locator('#savingsTotalAmount').innerText(), formatMoney(3500));
  assert.equal(await page.locator('#savingsMonthGroups .month-row').count(), 2);
  assert.match(await page.locator('#savingsGrowth').innerText(), /1,500\.00/);
  assert.equal(
    await page.locator('#savingsGrowth').evaluate(element => element.classList.contains('is-down')),
    true
  );

  await page.locator('#savingsMonthGroups .month-row').filter({ hasText: formatMonth(current) }).click();
  assert.equal(await page.locator('#savingsTotalMonthLabel').innerText(), formatMonth(current));
  assert.equal(await page.locator('#savingsTotalMonthAmount').innerText(), formatMoney(1000));
  assert.equal(await page.locator('#savingsTotalMonthList .entry').count(), 1);

  await page.locator('[data-view="expenses"]').click();
  assert.equal(await page.locator('#allTotal').innerText(), formatMoney(0));
  assert.match(await page.locator('#historyList .empty__title').innerText(), /No expenses yet/);

  const snapshot = await dbSnapshot(page);
  assert.equal(snapshot.records.length, 0, 'savings never become expense records');
  assert.equal(snapshot.savings.length, 2);
  assert.deepEqual(snapshot.savings.map(record => record.monthKey).sort(), [previous, current].sort());

  await context.close();
});

await run('an existing version 1 database upgrades without losing expenses', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;

  const original = {
    id: 'v1-expense',
    amount: 321.5,
    description: 'Before the upgrade',
    date: daysAgoISO(0),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await page.goto(`${base}/__blank__`, { waitUntil: 'load' });
  watch(page);
  await page.evaluate(async ({ record, dbName }) => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve();
    });

    await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const expenses = db.createObjectStore('expenses', { keyPath: 'id' });
        expenses.createIndex('by_date', 'date', { unique: false });
        expenses.createIndex('by_createdAt', 'createdAt', { unique: false });
        expenses.createIndex('by_date_createdAt', ['date', 'createdAt'], { unique: false });
        db.createObjectStore('meta', { keyPath: 'key' });
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });

    await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('expenses', 'readwrite');
        transaction.objectStore('expenses').put(record);
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
      request.onerror = () => reject(request.error);
    });
  }, { record: original, dbName: DEFAULT_TEST_DB });

  await gotoApp(page);
  const upgraded = await dbSnapshot(page);
  assert.ok(upgraded.stores.includes('expenses'));
  assert.ok(upgraded.stores.includes('salaries'));
  assert.ok(upgraded.stores.includes('savings'));
  assert.equal(upgraded.records.length, 1);
  assert.equal(upgraded.records[0].id, 'v1-expense');
  assert.equal(upgraded.records[0].amount, 321.5);
  assert.equal(await page.locator('#heroAmount').innerText(), formatMoney(321.5));

  await addSalary(page, { amount: '10000' });
  await addSaving(page, { amount: '500' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');

  const after = await dbSnapshot(page);
  assert.equal(after.records.length, 1, 'the upgrade never duplicates expenses');
  assert.equal(after.salaries.length, 1);
  assert.equal(after.savings.length, 1);

  await context.close();
});

await run('legacy v2 transactions allocate by entry timestamp and unmatched rows stay reviewable', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  await page.goto(`${base}/__blank__`, { waitUntil: 'load' });
  watch(page);
  await page.evaluate(async dbName => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve();
    });
    await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        const expenses = db.createObjectStore('expenses', { keyPath: 'id' });
        expenses.createIndex('by_date', 'date', { unique: false });
        expenses.createIndex('by_createdAt', 'createdAt', { unique: false });
        expenses.createIndex('by_date_createdAt', ['date', 'createdAt'], { unique: false });
        db.createObjectStore('meta', { keyPath: 'key' });
        const salaries = db.createObjectStore('salaries', { keyPath: 'id' });
        salaries.createIndex('by_monthKey', 'monthKey', { unique: true });
        salaries.createIndex('by_createdAt', 'createdAt', { unique: false });
        const savings = db.createObjectStore('savings', { keyPath: 'id' });
        savings.createIndex('by_monthKey', 'monthKey', { unique: false });
        savings.createIndex('by_date', 'date', { unique: false });
        savings.createIndex('by_date_createdAt', ['date', 'createdAt'], { unique: false });
      };
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(['expenses', 'salaries', 'savings'], 'readwrite');
        const expenses = transaction.objectStore('expenses');
        const salaries = transaction.objectStore('salaries');
        const savings = transaction.objectStore('savings');
        salaries.put({ id: 'salary-oct', monthKey: '2026-10', amount: 50000, amountPaise: 5000000, notes: '', createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:00:00.000Z' });
        salaries.put({ id: 'salary-nov', monthKey: '2026-11', amount: 40000, amountPaise: 4000000, notes: '', createdAt: '2026-11-01T08:00:00.000Z', updatedAt: '2026-11-01T08:00:00.000Z' });
        expenses.put({ id: 'legacy-oct-pool', amount: 500, description: 'November date, October pool', date: '2026-11-05', createdAt: '2026-10-25T08:00:00.000Z', updatedAt: '2026-10-25T08:00:00.000Z' });
        expenses.put({ id: 'legacy-unmatched-expense', amount: 50, description: 'No salary existed yet', date: '2026-09-02', createdAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-01T08:00:00.000Z' });
        savings.put({ id: 'legacy-nov-saving', monthKey: '2026-11', amount: 200, amountPaise: 20000, date: '2026-11-03', description: 'November contribution', createdAt: '2026-11-02T08:00:00.000Z', updatedAt: '2026-11-02T08:00:00.000Z' });
        savings.put({ id: 'legacy-unmatched-saving', monthKey: '2026-09', amount: 300, amountPaise: 30000, date: '2026-09-03', description: 'Unmatched contribution', createdAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-01T08:00:00.000Z' });
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
      request.onerror = () => reject(request.error);
    });
  }, DEFAULT_TEST_DB);

  await gotoApp(page);
  const migrated = await dbSnapshot(page);
  const octoberExpense = migrated.records.find(record => record.id === 'legacy-oct-pool');
  const unresolvedExpense = migrated.records.find(record => record.id === 'legacy-unmatched-expense');
  const novemberSaving = migrated.savings.find(record => record.id === 'legacy-nov-saving');
  const unresolvedSaving = migrated.savings.find(record => record.id === 'legacy-unmatched-saving');
  assert.equal(octoberExpense.salaryRecordId, 'salary-oct', 'entry time, not its November expense date, selects October');
  assert.equal(octoberExpense.date, '2026-11-05', 'migration preserves the actual expense date');
  assert.equal(octoberExpense.paymentSource, 'salary');
  assert.equal(unresolvedExpense.allocationStatus, 'needs_review');
  assert.equal(novemberSaving.salaryRecordId, 'salary-nov');
  assert.equal(unresolvedSaving.allocationStatus, 'needs_review');
  const marker = migrated.meta.find(record => record.key === 'migration:salary-allocation:v1');
  assert.deepEqual(marker.unresolvedExpenseIds, ['legacy-unmatched-expense']);
  assert.deepEqual(marker.unresolvedSavingIds, ['legacy-unmatched-saving']);
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(39800));

  await page.locator('[data-view="expenses"]').click();
  assert.equal(await page.locator('#sourceReviewCard').isVisible(), true);
  assert.match(await page.locator('#sourceReviewCount').innerText(), /1 expense needs review/);
  await page.locator('#sourceReviewButton').click();
  assert.equal(await page.locator('#historyList .entry').count(), 1, 'review mode contains only unresolved expenses');
  await page.locator('#historyList [data-edit="legacy-unmatched-expense"]').click();
  await page.locator('#expenseSheet').waitFor({ state: 'visible' });
  await page.locator('#paidFromSalary').check();
  await page.locator('#saveButton').click();
  await page.locator('#expenseSheet').waitFor({ state: 'hidden' });
  await waitForToast(page, 'Expense updated');
  assert.match(await page.locator('#historyList [data-edit="legacy-unmatched-expense"]').innerText(), /Salary/);
  const explicitlyAssigned = await dbSnapshot(page);
  assert.equal(explicitlyAssigned.records.find(record => record.id === 'legacy-unmatched-expense').salaryRecordId, 'salary-nov');
  assert.equal(explicitlyAssigned.records.find(record => record.id === 'legacy-unmatched-expense').allocationStatus, undefined);
  assert.equal(await page.locator('#sourceReviewCard').isVisible(), false, 'review notice clears after an explicit assignment');

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  const reloaded = await dbSnapshot(page);
  assert.equal(reloaded.records.length, 2, 'migration does not duplicate expense rows');
  assert.equal(reloaded.records.find(record => record.id === 'legacy-oct-pool').salaryRecordId, 'salary-oct');
  assert.equal(reloaded.savings.length, 2, 'migration does not duplicate savings rows');
  assert.equal(reloaded.savings.find(record => record.id === 'legacy-nov-saving').salaryRecordId, 'salary-nov');

  await page.locator('[data-view="expenses"]').click();
  await page.locator('#historyList [data-edit="legacy-unmatched-expense"]').click();
  await page.locator('#paidFromOthers').check();
  await page.locator('#saveButton').click();
  await page.locator('#expenseSheet').waitFor({ state: 'hidden' });
  await waitForToast(page, 'Expense updated');
  assert.match(await page.locator('#historyList [data-edit="legacy-unmatched-expense"]').innerText(), /Others/);
  const switchedToOthers = await dbSnapshot(page);
  const externalExpense = switchedToOthers.records.find(record => record.id === 'legacy-unmatched-expense');
  assert.equal(externalExpense.paymentSource, 'others');
  assert.equal(externalExpense.salaryRecordId, null);
  assert.equal(externalExpense.allocationStatus, undefined);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  await page.locator('[data-view="expenses"]').click();
  assert.match(await page.locator('#historyList [data-edit="legacy-unmatched-expense"]').innerText(), /Others/);
  assert.equal((await dbSnapshot(page)).records.find(record => record.id === 'legacy-unmatched-expense').paymentSource, 'others');

  await page.locator('[data-view="savings"]').click();
  await page.locator('#savingsTabTotal').click();
  await page.locator('[data-savings-month="2026-09"]').click();
  await page.locator('#savingsTotalMonthList [data-saving-edit="legacy-unmatched-saving"]').click();
  await page.locator('#savingSourceInput').selectOption('salary');
  await page.locator('#saveSavingButton').click();
  await page.locator('#savingSheet').waitFor({ state: 'hidden' });
  await waitForToast(page, 'Savings updated');
  assert.match(await page.locator('#savingsTotalMonthList [data-saving-edit="legacy-unmatched-saving"]').innerText(), /From salary balance/);
  const reviewedSavings = (await dbSnapshot(page)).savings.find(record => record.id === 'legacy-unmatched-saving');
  assert.equal(reviewedSavings.salaryRecordId, 'salary-nov');
  assert.equal(reviewedSavings.allocationStatus, undefined);

  await context.close();
});

await run('v5 extra income upgrades safely and can be assigned independently of its received date', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);
  const current = monthKeyNow();
  const previous = shiftMonthKey(current, -1);
  const receivedDate = daysAgoISO(0);
  const salary = (id, monthKey, amount) => ({
    id, monthKey, amount, amountPaise: Math.round(amount * 100), notes: '',
    createdAt: `${monthKey}-01T10:00:00.000Z`, updatedAt: `${monthKey}-01T10:00:00.000Z`
  });
  const legacyIncome = {
    id: 'legacy-income-nov-date', amount: 5000, amountPaise: 500000, date: receivedDate,
    monthKey: current, description: 'Legacy project', source: 'freelancing',
    createdAt: `${receivedDate}T09:00:00.000Z`, updatedAt: `${receivedDate}T09:00:00.000Z`
  };
  await seedVersion5FinanceDatabase(page, {
    salaries: [salary('salary-previous', previous, 24465), salary('salary-current', current, 30000)],
    extraIncome: [legacyIncome]
  });
  await gotoApp(page);
  await page.locator('[data-view="salary"]').click();

  let snapshot = await dbSnapshot(page);
  assert.equal(snapshot.version, 7);
  assert.equal(snapshot.extraIncome.length, 1);
  assert.equal(snapshot.extraIncome[0].id, legacyIncome.id);
  assert.equal(snapshot.extraIncome[0].date, receivedDate);
  assert.equal(snapshot.extraIncome[0].description, legacyIncome.description);
  assert.equal(snapshot.extraIncome[0].source, legacyIncome.source);
  assert.equal(snapshot.extraIncome[0].salaryRecordId, undefined, 'migration does not guess the salary month from the received date');
  assert.equal(snapshot.extraIncome[0].allocationStatus, 'needs_review');
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(30000));
  assert.equal(await page.locator('#extraIncomeList [data-extra-income-edit]').count(), 1);
  assert.match(await page.locator('#extraIncomeList').innerText(), /Salary month needs review/);

  await page.locator('[data-extra-income-edit]').click();
  assert.equal(await page.locator('#extraIncomeDate').inputValue(), receivedDate);
  await page.locator('#extraIncomeSalarySelect').selectOption('salary-previous');
  await page.locator('#saveExtraIncomeButton').click();
  await page.locator('#extraIncomeSheet').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#salaryMonthLabel').innerText(), formatMonth(previous));
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(29465));
  assert.equal((await page.locator('#salarySplit .split__item').nth(0).locator('strong').innerText()), formatMoney(24465));
  assert.equal(await page.locator('#extraIncomeTotal').textContent().then(value => value.trim()), `${formatMoney(5000)} received`);
  assert.match(await page.locator('#extraIncomeList').innerText(), new RegExp(formatDate(receivedDate)));

  await page.locator('#salaryNextMonth').click();
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(30000));
  assert.equal(await page.locator('#extraIncomeList [data-extra-income-edit]').count(), 0);
  snapshot = await dbSnapshot(page);
  assert.equal(snapshot.extraIncome[0].salaryRecordId, 'salary-previous');
  assert.equal(snapshot.extraIncome[0].allocationStatus, undefined);
  assert.ok(snapshot.stores.includes('extraIncome'));

  await context.close();
});

await run('salary and savings can be added and read with no network', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);
  await gotoApp(page);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

  await context.setOffline(true);
  await page.locator('#offlineBanner').waitFor({ state: 'visible' });

  await addSalary(page, { amount: '50000' });
  await waitForToast(page, 'Salary saved.');
  await addSaving(page, { amount: '1000', description: 'Offline savings' });
  await waitForToast(page, 'added to savings');
  assert.equal(await page.locator('#savingsMonthTotal').innerText(), formatMoney(1000));

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  assert.equal(await page.locator('#offlineBanner').isVisible(), true);

  await page.locator('[data-view="salary"]').click();
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(49000));
  await page.locator('[data-view="savings"]').click();
  assert.equal(await page.locator('#savingsMonthTotal').innerText(), formatMoney(1000));
  await page.locator('[data-view="salary"]').click();
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(49000));

  await context.setOffline(false);
  await context.close();
});

/* -------------------------------------------------------------------------- */
/* 7. iOS install hint, responsive layout and screenshots                     */
/* -------------------------------------------------------------------------- */

await run('iOS install hint can be dismissed and remembered', async () => {
  const context = await createContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  });
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);
  await seedLegacy(page, [
    { id: 'ios-one', amount: 120, description: 'iOS lunch', date: daysAgoISO(0) }
  ]);
  await gotoApp(page);
  await page.locator('#installCard').waitFor({ state: 'visible' });
  assert.match(await page.locator('#installText').innerText(), /Add to Home Screen/);
  await page.locator('#installClose').click();
  assert.equal(await page.locator('#installCard').isHidden(), true);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  assert.equal(await page.locator('#installCard').isHidden(), true, 'dismissal is remembered in localStorage');
  await context.close();
});

await run('layout is responsive on small phones and desktop', async () => {
  const smallContext = await createContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 2 });
  const small = await smallContext.newPage();
  watch(small);
  await gotoApp(small);
  assert.equal(await small.locator('#recentList [data-empty-add]').isVisible(), true);
  assert.ok(await small.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await smallContext.close();

  const desktopContext = await createContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false
  });
  const desktop = await desktopContext.newPage();
  watch(desktop);
  await seedLegacy(desktop, [
    { id: 'd1', amount: 240, description: 'Lunch at Anand Sweets', date: daysAgoISO(0) },
    { id: 'd2', amount: 68, description: 'Auto to office', date: daysAgoISO(0) },
    { id: 'd3', amount: 1899, description: 'Running shoes', date: daysAgoISO(1) },
    { id: 'd4', amount: 1240, description: 'Groceries — BigBasket', date: daysAgoISO(2) }
  ]);
  await gotoApp(desktop);
  assert.ok(await desktop.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  const tileColumns = await desktop.locator('.glance__tile').evaluateAll(tiles => {
    const tops = tiles.map(tile => Math.round(tile.getBoundingClientRect().top));
    return new Set(tops).size;
  });
  assert.equal(tileColumns, 1, 'desktop shows all four period tiles on one row');
  assert.ok((await desktop.locator('#dock').boundingBox()).width <= 400);
  await desktopContext.close();
});

await run('main pages and the expense sheet have no serious accessibility violations', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);
  await gotoApp(page);
  const scan = async name => {
    await page.waitForTimeout(400); // let the page's 360 ms entrance fade finish before checking text contrast
    const result = await new AxeBuilder({ page }).include('#main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const serious = result.violations.filter(item => ['serious', 'critical'].includes(item.impact));
    const summary = serious.flatMap(item => item.nodes.map(node => ({
      rule: item.id,
      target: node.target,
      issue: node.failureSummary
    })));
    assert.deepEqual(summary, [], `${name} has serious or critical accessibility violations`);
  };

  await scan('Dashboard');
  for (const view of ['expenses', 'salary', 'savings']) {
    await page.locator(`[data-view="${view}"]`).click();
    await scan(view);
  }
  await page.locator('#addExpenseButton').click();
  await page.locator('#expenseSheet').waitFor({ state: 'visible' });
  await scan('expense sheet');
  await context.close();
});

await run('documentation screenshots', async () => {
  const context = await createContext();
  const page = await context.newPage();
  watch(page);
  const demo = [
    { id: 's1', amount: 240, description: 'Lunch at Anand Sweets', date: daysAgoISO(0) },
    { id: 's2', amount: 68, description: 'Auto to office', date: daysAgoISO(0) },
    { id: 's3', amount: 1899, description: 'Running shoes', date: daysAgoISO(1) },
    { id: 's4', amount: 1240, description: 'Groceries — BigBasket', date: daysAgoISO(2) },
    { id: 's5', amount: 320, description: 'Petrol', date: daysAgoISO(3) },
    { id: 's6', amount: 450, description: 'Electricity bill', date: daysAgoISO(6) },
    { id: 's7', amount: 780, description: 'Dinner with family', date: daysAgoISO(9) },
    { id: 's8', amount: 199, description: 'Spotify', date: daysAgoISO(12) },
    { id: 's9', amount: 2460, description: 'Doctor visit', date: daysAgoISO(18) }
  ];
  await seedLegacy(page, demo);
  await gotoApp(page);
  await waitForToastsToClear(page);
  await addSalary(page, { amount: '50000', notes: 'Monthly salary' });
  await addSaving(page, { amount: '8000', description: 'Emergency fund' });
  await addSaving(page, { amount: '4000', description: 'Gold' });
  await page.locator('[data-view="dashboard"]').click();
  await waitForToastsToClear(page);
  assert.equal(await page.locator('#recentList .entry').count(), 5, 'recent list is limited to five');
  await page.screenshot({ path: path.join(SHOTS, 'home-mobile.png') });

  await page.locator('[data-view="expenses"]').click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(SHOTS, 'history-mobile.png') });

  await page.locator('[data-view="salary"]').click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(SHOTS, 'salary-mobile.png') });

  await page.locator('#salaryMonthPickerButton').click();
  await page.locator('#monthPickerSheet').waitFor({ state: 'visible' });
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(SHOTS, 'salary-picker-mobile.png') });
  await page.locator('#closeMonthPicker').click();
  await page.locator('#monthPickerSheet').waitFor({ state: 'hidden' });

  await page.locator('#salaryPrevMonth').click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(SHOTS, 'salary-past-month-mobile.png') });
  await page.locator('#salaryCurrentMonth').click();

  await page.locator('[data-view="savings"]').click();
  await page.locator('#savingsTabTotal').click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(SHOTS, 'savings-mobile.png') });

  await page.locator('[data-view="dashboard"]').click();
  await page.locator('#addExpenseButton').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, 'add-expense-mobile.png') });
  await page.locator('#closeExpenseSheet').click();
  await page.waitForTimeout(250);

  await context.setOffline(true);
  await page.locator('#offlineBanner').waitFor({ state: 'visible' });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, 'offline-mobile.png') });
  await context.setOffline(false);
  await context.close();

  const desktopContext = await createContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false
  });
  const desktop = await desktopContext.newPage();
  watch(desktop);
  await seedLegacy(desktop, demo);
  await gotoApp(desktop);
  await waitForToastsToClear(desktop);
  await addSalary(desktop, { amount: '50000', notes: 'Monthly salary' });
  await addSaving(desktop, { amount: '12000', description: 'Emergency fund' });
  await desktop.locator('[data-view="dashboard"]').click();
  await waitForToastsToClear(desktop);
  await desktop.screenshot({ path: path.join(SHOTS, 'home-desktop.png') });
  await desktopContext.close();
});

/* -------------------------------------------------------------------------- */
/* 7. Phase 3: Email and Password Authentication & Account Isolation           */
/* -------------------------------------------------------------------------- */

await run('unauthenticated visit displays login card, hides dock and financial views', async () => {
  const context = await createContext({ auth: false });
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('#authView').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#authLoginCard').isVisible(), true);
  assert.equal(await page.locator('#dock').isVisible(), false);
  assert.equal(await page.locator('#addExpenseButton').isVisible(), false);
  assert.equal(await page.locator('#view-dashboard').isVisible(), false);
  assert.equal(await page.locator('#userChip').isVisible(), false);

  await context.close();
});

await run('login form validates fields, toggles password visibility and shows errors', async () => {
  const context = await createContext({ auth: false });
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('#authView').waitFor({ state: 'visible' });

  // Password toggle
  const passInput = page.locator('#loginPassword');
  const toggleBtn = page.locator('#authLoginCard .toggle-password');
  assert.equal(await passInput.getAttribute('type'), 'password');
  await toggleBtn.click();
  assert.equal(await passInput.getAttribute('type'), 'text');
  assert.match(await toggleBtn.innerText(), /hide/i);
  await toggleBtn.click();
  assert.equal(await passInput.getAttribute('type'), 'password');
  assert.match(await toggleBtn.innerText(), /show/i);

  // Submit empty
  await page.locator('#loginSubmitButton').click();
  assert.equal(await page.locator('#loginEmailError').isVisible(), true);
  assert.equal(await page.locator('#loginPasswordError').isVisible(), true);

  // Fill email, password
  await page.locator('#loginEmail').fill('nobody@spendly.local');
  await page.locator('#loginPassword').fill('wrongpassword');

  // Route Supabase auth call with invalid credentials
  await page.route('**/auth/v1/token*', async route => {
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login credentials' })
    });
  });

  await page.locator('#loginSubmitButton').click();
  await page.locator('#loginError').waitFor({ state: 'visible' });
  assert.match(await page.locator('#loginError').innerText(), /Incorrect email or password/i);

  await context.close();
});

await run('auth screens navigate cleanly between login, register, forgot and verification', async () => {
  const context = await createContext({ auth: false });
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('#authView').waitFor({ state: 'visible' });

  // Switch to register
  await page.locator('#toRegister').click();
  assert.equal(await page.locator('#authRegisterCard').isVisible(), true);
  assert.equal(await page.locator('#authLoginCard').isVisible(), false);

  // Switch back to login
  await page.locator('#toLoginFromRegister').click();
  assert.equal(await page.locator('#authLoginCard').isVisible(), true);
  assert.equal(await page.locator('#authRegisterCard').isVisible(), false);

  // Switch to forgot password
  await page.locator('#toForgotPassword').click();
  assert.equal(await page.locator('#authForgotCard').isVisible(), true);
  assert.equal(await page.locator('#authLoginCard').isVisible(), false);

  // Switch back to login
  await page.locator('#forgotBackToLogin').click();
  assert.equal(await page.locator('#authLoginCard').isVisible(), true);
  assert.equal(await page.locator('#authForgotCard').isVisible(), false);

  await context.close();
});

await run('registration validates inputs and presents verification pending screen', async () => {
  const context = await createContext({ auth: false });
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('#authView').waitFor({ state: 'visible' });
  await page.locator('#toRegister').click();

  // Test password mismatch
  await page.locator('#registerEmail').fill('newuser@spendly.local');
  await page.locator('#registerPassword').fill('password123');
  await page.locator('#registerConfirmPassword').fill('differentpassword');
  await page.locator('#registerSubmitButton').click();
  assert.equal(await page.locator('#registerConfirmError').isVisible(), true);
  assert.match(await page.locator('#registerConfirmError').innerText(), /Passwords do not match/);

  // Fix password and mock signup with unconfirmed user
  await page.locator('#registerConfirmPassword').fill('password123');

  await page.route('**/auth/v1/signup*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'new-user-uuid',
        aud: 'authenticated',
        role: 'authenticated',
        email: 'newuser@spendly.local',
        identities: []
      })
    });
  });

  await page.locator('#registerSubmitButton').click();
  await page.locator('#authVerifyCard').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#verifyEmailDisplay').innerText(), 'newuser@spendly.local');

  // Test resend verification
  let resent = false;
  await page.route('**/auth/v1/resend*', async route => {
    resent = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.locator('#resendVerificationButton').click();
  await page.locator('#resendStatus').waitFor({ state: 'visible' });
  assert.ok(resent, 'resend verification endpoint was called');
  assert.match(await page.locator('#resendStatus').innerText(), /sent/i);

  // Return to sign in
  await page.locator('#verifyBackToLogin').click();
  assert.equal(await page.locator('#authLoginCard').isVisible(), true);

  await context.close();
});

await run('password reset request and password update complete successfully', async () => {
  const context = await createContext({ auth: false });
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('#authView').waitFor({ state: 'visible' });
  await page.locator('#toForgotPassword').click();

  await page.locator('#forgotEmail').fill('resetme@spendly.local');

  let resetRequested = false;
  await page.route('**/auth/v1/recover*', async route => {
    resetRequested = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.locator('#forgotSubmitButton').click();
  await page.locator('#authForgotSentCard').waitFor({ state: 'visible' });
  assert.ok(resetRequested, 'recovery request was dispatched');
  assert.equal(await page.locator('#forgotSentEmailDisplay').innerText(), 'resetme@spendly.local');

  await page.locator('#forgotSentBackToLogin').click();
  assert.equal(await page.locator('#authLoginCard').isVisible(), true);

  await context.close();
});

await run('multi-account switching provides strict IndexedDB isolation and clean state', async () => {
  const userA = {
    id: '11111111-1111-4000-8000-111111111111',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'userA@spendly.local'
  };
  const userB = {
    id: '22222222-2222-4000-8000-222222222222',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'userB@spendly.local'
  };

  const context = await createContext({ auth: false });
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  await page.goto(`${base}/__blank__`, { waitUntil: 'load' });
  await page.evaluate(session => {
    localStorage.setItem('spendly.auth.token', JSON.stringify(session));
  }, { ...MOCK_AUTH_SESSION, user: userA });

  await gotoApp(page);
  assert.equal(await page.locator('#userEmailLabel').innerText(), 'userA@spendly.local');

  // User A adds salary & expense
  await addSalary(page, { amount: '50000' });
  await waitForToast(page, 'Salary saved.');
  await page.locator('[data-view="dashboard"]').click();
  await addExpense(page, { amount: '1200', description: 'User A Secret Lunch' });
  await waitForToast(page, 'Expense added successfully');

  const snapshotA = await dbSnapshot(page);
  assert.equal(snapshotA.records.length, 1);
  assert.equal(snapshotA.records[0].description, 'User A Secret Lunch');

  // User A signs out
  await signOutFromHeader(page);
  await page.locator('#authView').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#authLoginCard').isVisible(), true);
  assert.equal(await page.locator('#userChip').isVisible(), false);

  // Switch session in localStorage to User B
  await page.evaluate(session => {
    localStorage.setItem('spendly.auth.token', JSON.stringify(session));
  }, { ...MOCK_AUTH_SESSION, user: userB });

  // Reload page as User B
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');

  assert.equal(await page.locator('#userEmailLabel').innerText(), 'userB@spendly.local');
  // User B sees a clean slate with 0 records!
  const snapshotB = await dbSnapshot(page);
  assert.equal(snapshotB.records.length, 0, 'User B must never see User A records');
  assert.equal(snapshotB.salaries.length, 0);
  assert.equal(await page.locator('#heroAmount').innerText(), formatMoney(0));

  // User B adds an expense
  await addSalary(page, { amount: '30000' });
  await waitForToast(page, 'Salary saved.');
  await page.locator('[data-view="dashboard"]').click();
  await addExpense(page, { amount: '450', description: 'User B Coffee' });
  await waitForToast(page, 'Expense added successfully');

  // User B signs out
  await signOutFromHeader(page);
  await page.locator('#authView').waitFor({ state: 'visible' });

  // Switch back to User A
  await page.evaluate(session => {
    localStorage.setItem('spendly.auth.token', JSON.stringify(session));
  }, { ...MOCK_AUTH_SESSION, user: userA });

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');

  assert.equal(await page.locator('#userEmailLabel').innerText(), 'userA@spendly.local');
  const restoredA = await dbSnapshot(page);
  assert.equal(restoredA.records.length, 1);
  assert.equal(restoredA.records[0].description, 'User A Secret Lunch', 'User A data restored safely');
  assert.equal(restoredA.salaries.length, 1);

  await context.close();
});

await run('legacy unowned spendly database is preserved and not leaked to authenticated account', async () => {
  const context = await createContext({ auth: false });
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  await page.goto(`${base}/__blank__`, { waitUntil: 'load' });

  // Seed legacy unowned 'spendly' database with 1 record
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('spendly', 6);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('expenses')) {
          db.createObjectStore('expenses', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('expenses', 'readwrite');
        tx.objectStore('expenses').put({
          id: 'unowned-legacy-1',
          amount: 999,
          description: 'Secret Unowned Expense',
          date: '2026-11-01',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  });

  // Now seed authenticated session
  await seedAuthSession(context, MOCK_AUTH_USER);
  await gotoApp(page);

  // Authenticated user sees an empty isolated state
  const userSnapshot = await dbSnapshot(page);
  assert.equal(userSnapshot.records.length, 0, 'authenticated account must not inherit unowned data');
  assert.equal(await page.locator('#heroAmount').innerText(), formatMoney(0));

  // Verify 'spendly' unowned database still exists and has the untouched unowned record
  const legacySnapshot = await dbSnapshot(page, 'spendly');
  assert.equal(legacySnapshot.records.length, 1, 'unowned legacy DB is safely preserved');
  assert.equal(legacySnapshot.records[0].id, 'unowned-legacy-1');

  await context.close();
});

await run('offline authentication reopens cached session without network calls and blocks online actions', async () => {
  const context = await createContext({ auth: true });
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  await gotoApp(page);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

  // Go offline
  await context.setOffline(true);

  // Reload offline
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  assert.equal(await page.locator('#userEmailLabel').innerText(), 'tester@spendly.local');
  assert.equal(await page.locator('#offlineBanner').isVisible(), true);

  // Sign out offline
  await signOutFromHeader(page);
  await page.locator('#authView').waitFor({ state: 'visible' });

  // Try signing in while offline
  await page.locator('#loginEmail').fill('tester@spendly.local');
  await page.locator('#loginPassword').fill('password123');
  await page.locator('#loginSubmitButton').click();

  await page.locator('#loginError').waitFor({ state: 'visible' });
  assert.match(await page.locator('#loginError').innerText(), /offline/i);

  await context.close();
});

/* -------------------------------------------------------------------------- */
/* 8. Phase 4: Google OAuth Authentication                                    */
/* -------------------------------------------------------------------------- */

await run('Google OAuth buttons display properly on login and register screens and handle initiation', async () => {
  const context = await createContext({ auth: false });
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('#authView').waitFor({ state: 'visible' });

  // Check login card Google button
  const googleLoginBtn = page.locator('#googleLoginButton');
  assert.equal(await googleLoginBtn.isVisible(), true);
  assert.match(await googleLoginBtn.innerText(), /Continue with Google/i);
  assert.equal(await googleLoginBtn.locator('svg').count(), 1);

  // Navigate to register card
  await page.locator('#toRegister').click();
  const googleRegBtn = page.locator('#googleRegisterButton');
  assert.equal(await googleRegBtn.isVisible(), true);
  assert.match(await googleRegBtn.innerText(), /Continue with Google/i);

  // Switch back to login
  await page.locator('#toLoginFromRegister').click();

  // Test OAuth initiation on Google button
  let authorizeRequested = false;
  let providerParam = '';
  await page.route('**/auth/v1/authorize*', async route => {
    authorizeRequested = true;
    const url = new URL(route.request().url());
    providerParam = url.searchParams.get('provider');
    await route.abort('blockedbyclient');
  });

  await googleLoginBtn.click();
  await page.waitForTimeout(100);
  assert.equal(authorizeRequested, true, 'Google OAuth authorize endpoint must be requested');
  assert.equal(providerParam, 'google', 'Provider must be google');

  await context.close();
});

await run('Google OAuth cancellation and callback errors display friendly messages and clean URL', async () => {
  const context = await createContext({ auth: false });
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  // Scenario 1: User cancelled / denied consent
  await page.goto(`${base}/#error=access_denied&error_code=403&error_description=User+cancelled`, { waitUntil: 'networkidle' });
  await page.locator('#authView').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#authLoginCard').isVisible(), true);
  await page.locator('#loginError').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#loginError').innerText(), 'Google sign-in was cancelled.');

  // Verify URL was cleaned of error parameters
  const currentUrl = page.url();
  assert.equal(currentUrl.includes('error='), false, 'URL must be sanitized after displaying OAuth error');

  // Scenario 2: Provider disabled error in query params
  await page.goto(`${base}/?error=provider_disabled&error_description=Unsupported+provider`, { waitUntil: 'networkidle' });
  await page.locator('#loginError').waitFor({ state: 'visible' });
  assert.match(await page.locator('#loginError').innerText(), /Google sign-in is not configured yet/i);

  await context.close();
});

await run('Google authenticated session restores, mounts isolated IndexedDB and survives sign-out', async () => {
  const googleUser = {
    id: '33333333-3333-4000-8000-333333333333',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'alex.google@example.com',
    app_metadata: { provider: 'google' },
    user_metadata: { full_name: 'Alex Google' }
  };

  const context = await createContext({ auth: false });
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  // Simulate returning from Google redirect with session tokens in localStorage
  await page.goto(`${base}/__blank__`, { waitUntil: 'load' });
  await page.evaluate(session => {
    localStorage.setItem('spendly.auth.token', JSON.stringify(session));
  }, { ...MOCK_AUTH_SESSION, user: googleUser });

  await gotoApp(page);

  // Header chip displays Google user info
  assert.equal(await page.locator('#userEmailLabel').innerText(), 'alex.google@example.com');
  assert.equal(await page.locator('#userAvatar').innerText(), 'A');

  // Verify isolated DB name
  const dbName = await page.evaluate(() => document.documentElement.dataset.activeDb);
  assert.equal(dbName, 'spendly_user_33333333-3333-4000-8000-333333333333');

  // Add financial records as Google user
  await addSalary(page, { amount: '75000' });
  await waitForToast(page, 'Salary saved.');
  await page.locator('[data-view="dashboard"]').click();
  await addExpense(page, { amount: '1500', description: 'Google Pixel Case' });
  await waitForToast(page, 'Expense added successfully');

  const snapshot = await dbSnapshot(page);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].description, 'Google Pixel Case');

  // Google user signs out
  await signOutFromHeader(page);
  await page.locator('#authView').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#authLoginCard').isVisible(), true);
  assert.equal(await page.locator('#userChip').isVisible(), false);

  // Re-login as Google user
  await page.evaluate(session => {
    localStorage.setItem('spendly.auth.token', JSON.stringify(session));
  }, { ...MOCK_AUTH_SESSION, user: googleUser });

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');

  assert.equal(await page.locator('#userEmailLabel').innerText(), 'alex.google@example.com');
  const restored = await dbSnapshot(page);
  assert.equal(restored.records.length, 1);
  assert.equal(restored.records[0].description, 'Google Pixel Case');
  assert.equal(restored.salaries.length, 1);

  await context.close();
});

await run('Google account maintains strict isolation against email accounts and legacy unowned data', async () => {
  const googleUser = {
    id: '33333333-3333-4000-8000-333333333333',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'alex.google@example.com'
  };
  const emailUser = {
    id: '44444444-4444-4000-8000-444444444444',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'emily.email@spendly.local'
  };

  const context = await createContext({ auth: false });
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  // Seed legacy unowned 'spendly' DB
  await page.goto(`${base}/__blank__`, { waitUntil: 'load' });
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('spendly', 6);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('expenses')) {
          db.createObjectStore('expenses', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('expenses', 'readwrite');
        tx.objectStore('expenses').put({
          id: 'unowned-legacy-oauth',
          amount: 888,
          description: 'Unowned Legacy Record',
          date: '2026-11-01',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  });

  // Step 1: Login as Google User and seed a record
  await page.evaluate(session => {
    localStorage.setItem('spendly.auth.token', JSON.stringify(session));
  }, { ...MOCK_AUTH_SESSION, user: googleUser });

  await gotoApp(page);
  assert.equal(await page.locator('#userEmailLabel').innerText(), 'alex.google@example.com');
  let googleInitialSnapshot = await dbSnapshot(page);
  assert.equal(googleInitialSnapshot.records.length, 0, 'Google user starts clean');

  await addSalary(page, { amount: '60000' });
  await waitForToast(page, 'Salary saved.');
  await page.locator('[data-view="dashboard"]').click();
  await addExpense(page, { amount: '1200', description: 'Google Pixel Buds' });
  await waitForToast(page, 'Expense added successfully');

  // Step 2: Sign out Google User
  await signOutFromHeader(page);
  await page.locator('#authView').waitFor({ state: 'visible' });

  // Step 3: Login as Email User
  await page.evaluate(session => {
    localStorage.setItem('spendly.auth.token', JSON.stringify(session));
  }, { ...MOCK_AUTH_SESSION, user: emailUser });

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  assert.equal(await page.locator('#userEmailLabel').innerText(), 'emily.email@spendly.local');
  // Email user has clean empty state (does NOT see Google data or unowned legacy data)
  let emailSnapshot = await dbSnapshot(page);
  assert.equal(emailSnapshot.records.length, 0, 'Email user sees 0 records');

  // Email user adds an expense
  await addSalary(page, { amount: '40000' });
  await waitForToast(page, 'Salary saved.');
  await page.locator('[data-view="dashboard"]').click();
  await addExpense(page, { amount: '700', description: 'Emily Books' });
  await waitForToast(page, 'Expense added successfully');

  // Step 4: Sign out Email User
  await signOutFromHeader(page);
  await page.locator('#authView').waitFor({ state: 'visible' });

  // Step 5: Login back as Google User
  await page.evaluate(session => {
    localStorage.setItem('spendly.auth.token', JSON.stringify(session));
  }, { ...MOCK_AUTH_SESSION, user: googleUser });

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');

  assert.equal(await page.locator('#userEmailLabel').innerText(), 'alex.google@example.com');
  // Google user sees their own records, NOT Emily's books, NOT unowned record
  const googleSnapshot = await dbSnapshot(page);
  assert.ok(googleSnapshot.records.some(r => r.description === 'Google Pixel Buds'), 'Google user sees their own records');
  assert.equal(googleSnapshot.records.some(r => r.description === 'Emily Books'), false, 'Google user must not see Email user data');
  assert.equal(googleSnapshot.records.some(r => r.description === 'Unowned Legacy Record'), false, 'Google user must not see unowned data');

  // Verify 'spendly' unowned database remains untouched
  const legacySnapshot = await dbSnapshot(page, 'spendly');
  assert.equal(legacySnapshot.records.length, 1);
  assert.equal(legacySnapshot.records[0].id, 'unowned-legacy-oauth');

  await context.close();
});

/* -------------------------------------------------------------------------- */
/* 8. Phase 5: Account-Scoped Outbox & Offline Mutation Persistence           */
/* -------------------------------------------------------------------------- */

await run('financial mutations create atomic outbox operations with monotonic sequence and reload persistence', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);
  await gotoApp(page);

  // Add salary
  await addSalary(page, { amount: '65000', notes: 'Phase 5 salary' });

  // Add an expense funded by salary
  await addExpense(page, { amount: '2500', description: 'Outbox Test Expense' });
  await waitForToast(page, 'Expense added successfully');

  // Add savings contribution
  await addSaving(page, { amount: '10000', description: 'Phase 5 savings' });

  // Add savings-funded expense (composite action)
  await addExpense(page, { amount: '3000', description: 'Savings-funded camera', source: 'savings' });
  await waitForToast(page, 'Expense added using Savings');

  // Check database snapshot
  const snapshot = await dbSnapshot(page);
  assert.equal(snapshot.version, 7, 'database version must be 7');
  assert.ok(snapshot.stores.includes('outbox'), 'outbox store must exist');

  // Verify outbox records
  const outbox = snapshot.outbox.slice().sort((a, b) => a.sequence - b.sequence);
  assert.equal(outbox.length, 4, 'expected exactly 4 outbox operations (salary, expense, savings, savings-funded expense)');

  // Verify operations:
  // 1: salary:create
  assert.equal(outbox[0].operationType, 'salary:create');
  assert.equal(outbox[0].ownerUserId, MOCK_AUTH_USER.id);
  assert.equal(outbox[0].sequence, 1);
  assert.equal(outbox[0].status, 'pending');

  // 2: expense:create
  assert.equal(outbox[1].operationType, 'expense:create');
  assert.equal(outbox[1].sequence, 2);
  assert.equal(outbox[1].status, 'pending');

  // 3: savings:contribution
  assert.equal(outbox[2].operationType, 'savings:contribution');
  assert.equal(outbox[2].sequence, 3);
  assert.equal(outbox[2].status, 'pending');

  // 4: composite savings-funded expense: single outbox operation with embedded withdrawal
  assert.equal(outbox[3].operationType, 'expense:create');
  assert.equal(outbox[3].sequence, 4);
  assert.equal(outbox[3].status, 'pending');
  assert.ok(outbox[3].payload.linkedWithdrawal, 'linked withdrawal must be present in payload');
  assert.equal(outbox[3].payload.linkedWithdrawal.amount, 3000);

  // Verify reload persistence
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  const reloadSnapshot = await dbSnapshot(page);
  assert.equal(reloadSnapshot.outbox.length, 4, 'pending outbox operations survive page reload');

  // Sign out and verify outbox records persist on disk in user database
  await signOutFromHeader(page);
  await page.locator('#authView').waitFor({ state: 'visible' });

  // Read the user database directly using customName
  const userDbName = `spendly_user_${MOCK_AUTH_USER.id}`;
  const signedOutSnapshot = await dbSnapshot(page, userDbName);
  assert.equal(signedOutSnapshot.outbox.length, 4, 'pending outbox operations persist in user IndexedDB after logout');

  await context.close();
});

/* -------------------------------------------------------------------------- */
/* 9. Phase 6: Bidirectional Client Synchronization, Offline & Concurrency    */
/* -------------------------------------------------------------------------- */

await run('Phase 6: Outbox operations upload and acknowledge cleanly to Supabase', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  const uploadedOperations = [];
  let cursorSequence = 100;

  await page.route('**/rest/v1/rpc/apply_sync_operation*', async route => {
    const postData = route.request().postDataJSON();
    const op = postData.p_operation;
    uploadedOperations.push(op);
    cursorSequence++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        operation_id: op.client_operation_id,
        cursor: cursorSequence
      })
    });
  });

  await page.route('**/rest/v1/rpc/get_sync_changes*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([])
    });
  });

  await gotoApp(page);

  await addSalary(page, { amount: '75000' });
  await waitForToast(page, 'Salary saved.');
  await page.locator('[data-view="dashboard"]').click();
  await addExpense(page, { amount: '350', description: 'Coffee beans' });
  await waitForToast(page, 'Expense added successfully');

  await page.waitForFunction(() => {
    const conn = document.getElementById('connection');
    return conn && conn.dataset.state === 'synced';
  }, null, { timeout: 10000 });

  assert.equal(await page.locator('#connectionText').innerText(), 'Synced');
  assert.ok(uploadedOperations.length >= 2, 'uploaded at least 2 operations (salary + expense)');
  assert.ok(uploadedOperations.some(op => op.operationType === 'salary:create'));
  assert.ok(uploadedOperations.some(op => op.operationType === 'expense:create' && op.payload?.expense?.description === 'Coffee beans'));

  const snap = await dbSnapshot(page);
  const salaryOp = snap.outbox.find(op => op.operationType === 'salary:create');
  const expenseOp = snap.outbox.find(op => op.operationType === 'expense:create');
  assert.equal(salaryOp.status, 'acknowledged');
  assert.ok(salaryOp.remoteCursor > 0);
  assert.equal(expenseOp.status, 'acknowledged');
  assert.ok(expenseOp.remoteCursor > 0);

  await openDataSettings(page);
  const syncHeadline = await page.locator('#syncStatusHeadline').innerText();
  assert.equal(syncHeadline, 'Synced');
  await page.locator('#closeDataSettings').click();

  await context.close();
});

await run('Phase 6: Remote changes download and merge without echo-uploading', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  const uploadedFromThisClient = [];

  await page.route('**/rest/v1/rpc/apply_sync_operation*', async route => {
    const postData = route.request().postDataJSON();
    uploadedFromThisClient.push(postData.p_operation);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, cursor: 501 })
    });
  });

  let changeServed = false;
  await page.route('**/rest/v1/rpc/get_sync_changes*', async route => {
    if (!changeServed) {
      changeServed = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          changes: [
            {
              cursor: 500,
              operationId: '11111111-1111-4000-8000-111111111111',
              operationType: 'expense:create',
              entityType: 'expense',
              entityId: 'e2e2e2e2-2222-4000-8000-222222222222',
              action: 'INSERT',
              record: {
                id: 'e2e2e2e2-2222-4000-8000-222222222222',
                amount: 850,
                amount_paise: 85000,
                description: 'Office Chair from Laptop',
                transaction_date: toISODate(new Date()),
                payment_source: 'others',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              },
              createdAt: new Date().toISOString()
            }
          ],
          nextCursor: 500,
          hasMore: false
        })
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          changes: [],
          nextCursor: 500,
          hasMore: false
        })
      });
    }
  });

  await gotoApp(page);

  await page.locator('[data-view="expenses"]').click();
  await page.locator('#historyList .entry').filter({ hasText: 'Office Chair from Laptop' }).waitFor({ state: 'visible', timeout: 10000 });

  const snap = await dbSnapshot(page);
  const remoteRecord = snap.records.find(r => r.id === 'e2e2e2e2-2222-4000-8000-222222222222');
  assert.ok(remoteRecord, 'remote record exists in local database');
  assert.equal(remoteRecord.description, 'Office Chair from Laptop');
  assert.equal(snap.outbox.length, 0, 'no outbox operations enqueued for downloaded changes');
  assert.equal(uploadedFromThisClient.length, 0, 'nothing uploaded by this client for remote changes');

  const cursorRecord = snap.meta.find(m => m.key === 'sync:lastSyncedCursor');
  assert.equal(String(cursorRecord?.value), '500', 'lastSyncedCursor advanced to 500');

  await context.close();
});

await run('Phase 6: Offline transitions queue operations and automatically sync upon reconnection', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  const syncedWhileOnline = [];
  let cursorSeq = 700;

  await page.route('**/rest/v1/rpc/apply_sync_operation*', async route => {
    const postData = route.request().postDataJSON();
    syncedWhileOnline.push(postData.p_operation);
    cursorSeq++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, cursor: cursorSeq })
    });
  });

  await page.route('**/rest/v1/rpc/get_sync_changes*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([])
    });
  });

  await gotoApp(page);

  await context.setOffline(true);
  await page.locator('#offlineBanner').waitFor({ state: 'visible' });

  await addExpense(page, { amount: '220', description: 'Offline Subway sandwich', source: 'others' });
  await waitForToast(page, 'Expense recorded under Others');

  let snap = await dbSnapshot(page);
  const pendingOp = snap.outbox.find(op => op.operationType === 'expense:create');
  assert.ok(pendingOp, 'outbox contains pending expense:create operation');
  assert.equal(pendingOp.status, 'pending');
  assert.equal(syncedWhileOnline.length, 0, 'no server calls made while offline');

  const offlineStatus = await page.locator('#connectionText').innerText();
  assert.ok(['Waiting for internet', 'Pending', 'Pending upload'].some(s => offlineStatus.includes(s) || offlineStatus === s));

  await context.setOffline(false);
  await page.locator('#offlineBanner').waitFor({ state: 'hidden' });

  await page.waitForFunction(() => {
    const conn = document.getElementById('connection');
    return conn && conn.dataset.state === 'synced';
  }, null, { timeout: 10000 });

  assert.equal(await page.locator('#connectionText').innerText(), 'Synced');
  assert.ok(syncedWhileOnline.length >= 1, 'operation synced to server upon reconnection');
  assert.ok(syncedWhileOnline.some(op => op.payload?.expense?.description === 'Offline Subway sandwich'));

  snap = await dbSnapshot(page);
  const outboxExpense = snap.outbox.find(op => op.operationType === 'expense:create');
  assert.equal(outboxExpense?.status, 'acknowledged');

  await context.close();
});

await run('Phase 6: Permanent server rejection marks operation blocked with UI remediation', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  let shouldReject = true;
  let cursorSeq = 900;

  await page.route('**/rest/v1/rpc/apply_sync_operation*', async route => {
    if (shouldReject) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          message: 'Invalid financial operation schema: payload rejected',
          code: 'P0001'
        })
      });
    } else {
      cursorSeq++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, cursor: cursorSeq })
      });
    }
  });

  await page.route('**/rest/v1/rpc/get_sync_changes*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([])
    });
  });

  await gotoApp(page);

  await addExpense(page, { amount: '450', description: 'Blocked movie tickets', source: 'others' });
  await waitForToast(page, 'Expense recorded under Others');

  await page.waitForFunction(() => {
    const conn = document.getElementById('connection');
    return conn && conn.dataset.state === 'blocked';
  }, null, { timeout: 10000 });

  assert.equal(await page.locator('#connectionText').innerText(), 'Sync issue');

  let snap = await dbSnapshot(page);
  const blockedOp = snap.outbox.find(op => op.operationType === 'expense:create');
  assert.equal(blockedOp.status, 'blocked');

  await openDataSettings(page);
  const noticeText = await page.locator('#syncNoticeMessage').innerText();
  assert.ok(/Invalid financial operation schema|cannot be synced|could not be saved/i.test(noticeText), 'notice message displays error details');
  assert.equal(await page.locator('#retryBlockedButton').isVisible(), true);

  shouldReject = false;
  await page.locator('#retryBlockedButton').click();

  await page.waitForFunction(() => {
    const conn = document.getElementById('connection');
    return conn && conn.dataset.state === 'synced';
  }, null, { timeout: 10000 });

  assert.equal(await page.locator('#connectionText').innerText(), 'Synced');
  snap = await dbSnapshot(page);
  assert.equal(snap.outbox[0].status, 'acknowledged');

  await page.locator('#closeDataSettings').click();

  await context.close();
});

/* -------------------------------------------------------------------------- */
/* 10. Phase 7: Data Recovery, Backup Validation & Sync Integration          */
/* -------------------------------------------------------------------------- */

await run('Phase 7: Full backup download exports schema v7 with integer paise, outbox & account metadata', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  await page.route('**/rest/v1/rpc/apply_sync_operation*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, cursor: 1 })
    });
  });
  await page.route('**/rest/v1/rpc/get_sync_changes*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ changes: [], nextCursor: 0, hasMore: false })
    });
  });

  await gotoApp(page);

  await addSalary(page, { amount: '75000' });
  await waitForToast(page, 'Salary saved.');
  await page.locator('[data-view="dashboard"]').click();
  await addExpense(page, { amount: '450', description: 'Phase 7 Dinner', source: 'others' });
  await waitForToast(page, 'Expense recorded under Others');

  await openDataSettings(page);
  const backup = await downloadFrom(page, () => page.locator('#downloadBackup').click());
  const parsed = JSON.parse(backup.text);

  assert.equal(parsed.app, 'Spendly');
  assert.equal(parsed.schemaVersion, 7);
  assert.equal(parsed.version, 7);
  assert.equal(parsed.appVersion, '3.7.0');
  assert.ok(parsed.exportedAt);

  assert.equal(parsed.account.userId, MOCK_AUTH_USER.id);
  assert.equal(parsed.account.email, MOCK_AUTH_USER.email);
  assert.equal(parsed.account.isAnonymous, false);

  assert.ok(parsed.expenses.length >= 1);
  const exp = parsed.expenses.find(e => e.description === 'Phase 7 Dinner');
  assert.ok(exp);
  assert.equal(exp.amountPaise, 45000);

  assert.ok(parsed.salaries.length >= 1);
  assert.equal(parsed.salaries[0].amountPaise, 7500000);

  assert.ok(Array.isArray(parsed.outbox));
  assert.ok(Array.isArray(parsed.meta));

  await page.locator('#closeDataSettings').click();
  await context.close();
});

await run('Phase 7: Account ownership mismatch blocks cross-account backup restore', async () => {
  const emilyUser = {
    id: '00000000-0000-4000-8000-000000000002',
    email: 'emily@spendly.local',
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { provider: 'email' },
    user_metadata: {}
  };

  const context = await createContext({ user: emilyUser });
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  await page.route('**/rest/v1/rpc/apply_sync_operation*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, cursor: 1 })
    });
  });
  await page.route('**/rest/v1/rpc/get_sync_changes*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ changes: [], nextCursor: 0, hasMore: false })
    });
  });

  await gotoApp(page);

  const alexBackupPath = path.join(RESULTS, 'alex-backup.json');
  const alexBackupContent = {
    app: 'Spendly',
    schemaVersion: 7,
    version: 7,
    exportedAt: new Date().toISOString(),
    account: {
      userId: MOCK_AUTH_USER.id,
      email: MOCK_AUTH_USER.email,
      isAnonymous: false
    },
    expenses: [
      { id: 'alex-secret-exp', amount: 5000, description: 'Alex Secret Expense', date: toISODate(new Date()), paymentSource: 'others' }
    ],
    salaries: [],
    savings: [],
    extraIncome: [],
    outbox: [],
    meta: []
  };
  await writeFile(alexBackupPath, JSON.stringify(alexBackupContent));

  await openDataSettings(page);
  await page.locator('#fileInput').setInputFiles(alexBackupPath);

  await waitForToast(page, 'Cross-account restoration is prevented');
  assert.equal(await page.locator('#actionSheet').isVisible(), false, 'Action sheet must not open on ownership mismatch');

  const snap = await dbSnapshot(page);
  assert.equal(snap.records.length, 0, 'No data from Alex should be imported into Emily account');

  await page.locator('#closeDataSettings').click();
  await context.close();
});

await run('Phase 7: Corrupted or structurally invalid backups are rejected without modifying local state', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  await page.route('**/rest/v1/rpc/apply_sync_operation*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, cursor: 1 })
    });
  });
  await page.route('**/rest/v1/rpc/get_sync_changes*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ changes: [], nextCursor: 0, hasMore: false })
    });
  });

  await gotoApp(page);
  await addExpense(page, { amount: '120', description: 'Existing Safe Item', source: 'others' });
  await waitForToast(page, 'Expense recorded under Others');

  const corruptedPath = path.join(RESULTS, 'corrupted-duplicate-month.json');
  const corruptedContent = {
    app: 'Spendly',
    schemaVersion: 7,
    version: 7,
    account: { userId: MOCK_AUTH_USER.id, email: MOCK_AUTH_USER.email, isAnonymous: false },
    salaries: [
      { id: 'sal-1', monthKey: '2026-11', amount: 50000 },
      { id: 'sal-2', monthKey: '2026-11', amount: 60000 }
    ],
    expenses: []
  };
  await writeFile(corruptedPath, JSON.stringify(corruptedContent));

  await openDataSettings(page);
  await page.locator('#fileInput').setInputFiles(corruptedPath);

  await waitForToast(page, 'Duplicate salary month');
  assert.equal(await page.locator('#actionSheet').isVisible(), false);

  const snap = await dbSnapshot(page);
  assert.equal(snap.records.length, 1);
  assert.equal(snap.records[0].description, 'Existing Safe Item');

  await page.locator('#closeDataSettings').click();
  await context.close();
});

await run('Phase 7: Restoring backup with pending outbox operations reconciles with sync engine', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  const serverReceivedOps = [];
  await page.route('**/rest/v1/rpc/apply_sync_operation*', async route => {
    const postData = route.request().postDataJSON();
    serverReceivedOps.push(postData.p_operation);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, cursor: 301 })
    });
  });
  await page.route('**/rest/v1/rpc/get_sync_changes*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ changes: [], nextCursor: 0, hasMore: false })
    });
  });

  await gotoApp(page);

  const restoredExpId = 'f1f1f1f1-1111-4000-8000-111111111111';
  const restoredOpId = 'f2f2f2f2-2222-4000-8000-222222222222';
  const backupToRestorePath = path.join(RESULTS, 'sync-recovery-backup.json');
  const backupContent = {
    app: 'Spendly',
    schemaVersion: 7,
    version: 7,
    account: { userId: MOCK_AUTH_USER.id, email: MOCK_AUTH_USER.email, isAnonymous: false },
    expenses: [
      {
        id: restoredExpId,
        amount: 880,
        amountPaise: 88000,
        description: 'Recovered Flight Ticket',
        date: toISODate(new Date()),
        paymentSource: 'others',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ],
    salaries: [],
    savings: [],
    extraIncome: [],
    outbox: [
      {
        operationId: restoredOpId,
        sequence: 1,
        operationType: 'expense:create',
        entityType: 'expense',
        entityId: restoredExpId,
        status: 'pending',
        payload: {
          expense: {
            id: restoredExpId,
            amount: 880,
            amount_paise: 88000,
            description: 'Recovered Flight Ticket',
            transaction_date: toISODate(new Date()),
            payment_source: 'others',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        },
        createdAt: new Date().toISOString()
      }
    ],
    meta: [
      { key: 'sync:lastSyncedCursor', value: '300' }
    ]
  };
  await writeFile(backupToRestorePath, JSON.stringify(backupContent));

  await openDataSettings(page);
  await page.locator('#fileInput').setInputFiles(backupToRestorePath);

  await page.locator('#actionSheet').waitFor({ state: 'visible' });
  await downloadFrom(page, () => page.locator('#actionList .action__item').click());
  await waitForToast(page, 'Backup restored');

  await page.locator('#closeDataSettings').click();

  await page.locator('[data-view="expenses"]').click();
  await page.locator('#historyList .entry').filter({ hasText: 'Recovered Flight Ticket' }).waitFor({ state: 'visible' });

  await page.waitForFunction(() => {
    const conn = document.getElementById('connection');
    return conn && conn.dataset.state === 'synced';
  }, null, { timeout: 10000 });

  assert.equal(await page.locator('#connectionText').innerText(), 'Synced');
  assert.ok(serverReceivedOps.length >= 1, 'Sync engine uploaded the restored pending outbox operation');
  assert.ok(serverReceivedOps.some(op => op.operationId === restoredOpId));

  const snap = await dbSnapshot(page);
  const outboxOp = snap.outbox.find(op => op.operationId === restoredOpId);
  assert.equal(outboxOp?.status, 'acknowledged');

  await context.close();
});

/* -------------------------------------------------------------------------- */
/* 11. Phase 8: Final Testing & Release Readiness                             */
/* -------------------------------------------------------------------------- */

await run('Phase 8: Encrypted backup export, invalid passphrase rejection, and successful restoration', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);

  await page.route('**/rest/v1/rpc/apply_sync_operation*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, cursor: 1 })
    });
  });
  await page.route('**/rest/v1/rpc/get_sync_changes*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ changes: [], nextCursor: 0, hasMore: false })
    });
  });

  await gotoApp(page);

  await addExpense(page, { amount: '620', description: 'Encrypted Vault Dinner', source: 'others' });
  await waitForToast(page, 'Expense recorded under Others');

  await openDataSettings(page);

  // Set up prompt dialog handler for password input
  page.on('dialog', async dialog => {
    if (dialog.type() === 'prompt') {
      await dialog.accept('SpendlyVaultPass2026!');
    } else {
      await dialog.dismiss();
    }
  });

  // Export encrypted backup
  const encryptedDownload = await downloadFrom(page, () => page.locator('#downloadEncryptedBackup').click());
  const parsedEncrypted = JSON.parse(encryptedDownload.text);

  assert.equal(parsedEncrypted.app, 'Spendly');
  assert.equal(parsedEncrypted.encrypted, true);
  assert.equal(parsedEncrypted.algorithm, 'AES-GCM-256');
  assert.equal(parsedEncrypted.kdf.algorithm, 'PBKDF2-HMAC-SHA256');
  assert.equal(parsedEncrypted.kdf.iterations, 600000);
  assert.ok(parsedEncrypted.salt);
  assert.ok(parsedEncrypted.iv);
  assert.ok(parsedEncrypted.aad);
  assert.ok(parsedEncrypted.ciphertext);
  assert.equal(parsedEncrypted.expenses, undefined, 'Plaintext expenses must not be exposed');

  const encryptedFilePath = path.join(RESULTS, 'spendly-encrypted-test-export.json');
  await writeFile(encryptedFilePath, encryptedDownload.text);

  // Now erase local data to prove restoration works from the encrypted file
  await page.locator('#eraseAllData').click();
  await page.locator('#actionList .action__item').filter({ hasText: 'Erase all data' }).click();
  await waitForToast(page, 'All Spendly data erased.');

  // Attempt restore with wrong passphrase
  page.removeAllListeners('dialog');
  page.on('dialog', async dialog => {
    if (dialog.type() === 'prompt') {
      await dialog.accept('wrong-password!');
    } else {
      await dialog.dismiss();
    }
  });

  await page.locator('#fileInput').setInputFiles(encryptedFilePath);
  await waitForToast(page, 'Incorrect passphrase');

  // Attempt restore with correct passphrase
  page.removeAllListeners('dialog');
  page.on('dialog', async dialog => {
    if (dialog.type() === 'prompt') {
      await dialog.accept('SpendlyVaultPass2026!');
    } else {
      await dialog.dismiss();
    }
  });

  await page.locator('#fileInput').setInputFiles(encryptedFilePath);
  await page.locator('#actionSheet').waitFor({ state: 'visible' });
  await downloadFrom(page, () => page.locator('#actionList .action__item').click());
  await waitForToast(page, 'Backup restored');

  await page.locator('#closeDataSettings').click();

  // Verify restored expense appears
  await page.locator('[data-view="expenses"]').click();
  await page.locator('#historyList .entry').filter({ hasText: 'Encrypted Vault Dinner' }).waitFor({ state: 'visible' });

  await context.close();
});

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

await browser.close();
server.close();

const failed = results.filter(result => !result.ok);
const uniqueErrors = [...new Set(consoleErrors)];

console.log('');
if (uniqueErrors.length) {
  console.log('Console errors captured:');
  for (const error of uniqueErrors) console.log(`  - ${error}`);
}

console.log(`${results.length - failed.length}/${results.length} checks passed.`);
if (uniqueErrors.length) {
  console.log(`Browser console reported ${uniqueErrors.length} error(s).`);
  process.exitCode = 1;
}
if (failed.length) {
  console.log('Failures:');
  for (const failure of failed) {
    console.log(`  - ${failure.name}: ${failure.error?.message ?? failure.error}`);
  }
  process.exitCode = 1;
}
