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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatMonth, formatMoney, summarize, toISODate, STORAGE_KEY } from '../js/core.js';
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
    if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`);
  });
}

async function createContext(options = {}) {
  return browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'en-IN',
    timezoneId: 'Asia/Calcutta',
    acceptDownloads: true,
    ...options
  });
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

async function dbSnapshot(page) {
  return page.evaluate(async () => {
    const open = () => new Promise((resolve, reject) => {
      const request = indexedDB.open('spendly');
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
    const meta = stores.includes('meta') ? await readAll('meta') : [];
    db.close();
    return { records, salaries, savings, meta, stores };
  });
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

async function addExpense(page, { amount, description, date } = {}) {
  await page.locator('#addExpenseButton').click();
  await page.locator('#expenseSheet').waitFor({ state: 'visible' });
  await page.locator('#amountInput').fill(String(amount));
  await page.locator('#descriptionInput').fill(description);
  if (date) await page.locator('#dateInput').fill(date);
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

async function addSalary(page, { amount, monthKey, notes } = {}) {
  await page.locator('[data-view="salary"]').click();
  await page.locator('#salaryEditButton').click();
  await page.locator('#salarySheet').waitFor({ state: 'visible' });
  await page.locator('#salaryAmountInput').fill(String(amount));
  if (monthKey) await setSalaryMonth(page, monthKey);
  if (notes) await page.locator('#salaryNotesInput').fill(notes);
  await page.locator('#saveSalaryButton').click();
  await page.locator('#salarySheet').waitFor({ state: 'hidden', timeout: 8000 });
}

async function addSaving(page, { amount, description, fromTotalTab = false } = {}) {
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
  if (description) await page.locator('#savingDescriptionInput').fill(description);
  await page.locator('#saveSavingButton').click();
  await page.locator('#savingSheet').waitFor({ state: 'hidden', timeout: 8000 });
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

  await addExpense(page, { amount: '1,250.50', description: 'Team dinner' });
  await waitForToast(page, 'Expense saved.');
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
  await waitForToast(page, 'Expense updated.');
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

  const csv = await downloadFrom(page, () => page.locator('#exportCsv').click());
  assert.match(csv.filename, /^spendly-expenses-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.match(csv.text, /"Date","Description","Amount \(INR\)"/);
  assert.match(csv.text, /"Coffee ""with friends"""/);
  assert.match(csv.text, /"80\.00"/);

  const backup = await downloadFrom(page, () => page.locator('#downloadBackup').click());
  const parsedBackup = JSON.parse(backup.text);
  assert.equal(parsedBackup.app, 'Spendly');
  assert.equal(parsedBackup.version, 3);
  assert.equal(parsedBackup.expenses.length, 1);
  assert.ok(parsedBackup.expenses[0].createdAt);
  assert.deepEqual(parsedBackup.salaries, []);
  assert.deepEqual(parsedBackup.savings, []);

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
  assert.equal(await page.locator('#connectionText').innerText(), 'Offline');

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
  await waitForToast(page, 'Expense saved.');
  assert.equal((await dbSnapshot(page)).records.length, 5);

  await page.locator('[data-view="expenses"]').click();
  await page.locator('#historyList .entry').first().waitFor();
  await openRowMenu(page, '#historyList', 'Offline chai');
  await page.locator('#actionList .action__item').filter({ hasText: 'Edit expense' }).click();
  await page.locator('#expenseSheet').waitFor({ state: 'visible' });
  await page.locator('#amountInput').fill('45');
  await page.locator('#saveButton').click();
  await page.locator('#expenseSheet').waitFor({ state: 'hidden' });
  await waitForToast(page, 'Expense updated.');
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

  const csv = await downloadFrom(page, () => page.locator('#exportCsv').click());
  assert.match(csv.text, /Offline chai/);

  const backup = await downloadFrom(page, () => page.locator('#downloadBackup').click());
  assert.equal(JSON.parse(backup.text).expenses.length, 5);

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
  assert.equal(await reopened.locator('#connectionText').innerText(), 'Available offline');

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
    let page = context.pages()[0] ?? await context.newPage();
    watch(page);
    await gotoApp(page);
    await addExpense(page, { amount: '321', description: 'Survives a restart' });
    await waitForToast(page, 'Expense saved.');
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    assert.equal((await dbSnapshot(page)).records.length, 1);
    await context.close();

    context = await chromium.launchPersistentContext(profile, settings);
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

await run('salary, savings and expenses produce the monthly remaining balance', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);
  await gotoApp(page);
  const current = monthKeyNow();

  await addSalary(page, { amount: '50,000', notes: 'November pay' });
  await waitForToast(page, 'Salary saved.');
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(50000));
  assert.equal((await page.locator('#salaryHistoryCount').textContent()).trim(), '1 month');
  assert.equal(await page.locator('#salaryList .entry').count(), 1);
  assert.equal(await page.locator('#salaryNotes').innerText(), '“November pay”');

  await addSaving(page, { amount: '1000', description: 'Emergency fund' });
  await waitForToast(page, 'Savings added.');
  assert.equal(await page.locator('#savingsMonthTotal').innerText(), formatMoney(1000));

  await addSaving(page, { amount: '500', description: 'Gold' });
  assert.equal(await page.locator('#savingsMonthTotal').innerText(), formatMoney(1500));
  assert.equal(await page.locator('#savingsMonthList .entry').count(), 2);
  assert.match(await page.locator('#savingsMonthMeta').innerText(), /2 entries/);

  await page.locator('[data-view="dashboard"]').click();
  assert.equal(await page.locator('#financeMonthLabel').innerText(), formatMonth(current));
  assert.equal(await page.locator('#financeSalary').innerText(), formatMoney(50000));
  assert.equal(await page.locator('#financeExpenses').innerText(), formatMoney(0));
  assert.equal(await page.locator('#financeSavings').innerText(), formatMoney(1500));
  assert.equal(await page.locator('#financeRemainingValue').innerText(), formatMoney(48500));
  assert.equal(
    await page.locator('#financeBalance').evaluate(element => element.classList.contains('is-negative')),
    false
  );

  await addExpense(page, { amount: '1250.50', description: 'Team dinner' });
  assert.equal(await page.locator('#financeExpenses').innerText(), formatMoney(1250.5));
  assert.equal(await page.locator('#financeRemainingValue').innerText(), formatMoney(47249.5));

  await page.locator('[data-view="expenses"]').click();
  await page.locator('#historyList .entry').first().waitFor();
  await openRowMenu(page, '#historyList', 'Team dinner');
  await page.locator('#actionList .action__item').filter({ hasText: 'Edit expense' }).click();
  await page.locator('#expenseSheet').waitFor({ state: 'visible' });
  await page.locator('#amountInput').fill('1000');
  await page.locator('#saveButton').click();
  await page.locator('#expenseSheet').waitFor({ state: 'hidden' });
  await page.locator('[data-view="dashboard"]').click();
  assert.equal(await page.locator('#financeRemainingValue').innerText(), formatMoney(47500));

  await page.locator('[data-view="expenses"]').click();
  await openRowMenu(page, '#historyList', 'Team dinner');
  await page.locator('#actionList .action__item').filter({ hasText: 'Delete expense' }).click();
  await waitForToast(page, 'deleted');
  await page.locator('[data-view="dashboard"]').click();
  assert.equal(await page.locator('#financeRemainingValue').innerText(), formatMoney(48500));
  await page.locator('#toastAction').click();
  await waitForToast(page, 'Expense restored.');
  assert.equal(await page.locator('#financeRemainingValue').innerText(), formatMoney(47500));

  await page.locator('[data-view="savings"]').click();
  await page.locator('#savingsTabMonth').click();
  await page.locator('#savingsMonthList .entry').filter({ hasText: 'Emergency fund' }).locator('.entry__menu').click();
  await page.locator('#actionList .action__item').filter({ hasText: 'Edit savings' }).click();
  await page.locator('#savingSheet').waitFor({ state: 'visible' });
  await page.locator('#savingAmountInput').fill('1200');
  await page.locator('#saveSavingButton').click();
  await page.locator('#savingSheet').waitFor({ state: 'hidden' });
  await waitForToast(page, 'Savings updated.');
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
  await page.locator('[data-view="dashboard"]').click();
  // salary 50,000 - expense 1,000 - savings 1,700 (1,200 + 500)
  assert.equal(await page.locator('#financeRemainingValue').innerText(), formatMoney(47300));
  await page.locator('[data-view="salary"]').click();
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(50000));
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
  assert.equal(await page.locator('#salaryAmount').innerText(), 'Not configured');
  assert.match(await page.locator('#salaryStatus').innerText(), /No salary recorded/);
  assert.equal(await page.locator('#salaryClearButton').isHidden(), true);

  await page.locator('#salaryEditButton').click();
  await page.locator('#salarySheet').waitFor({ state: 'visible' });
  await page.locator('#salaryAmountInput').fill('45000');
  await page.locator('#saveSalaryButton').click();
  await page.locator('#salarySheet').waitFor({ state: 'hidden' });
  await waitForToast(page, 'Salary saved.');
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(45000));
  assert.equal(await page.locator('#salaryMonthLabel').innerText(), formatMonth(previous));

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
  assert.equal(await page.locator('#salaryAmount').innerText(), 'Not configured');

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
  assert.equal(await page.locator('#salarySplit .split__item--end strong').innerText(), formatMoney(45800));

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
  assert.equal(await page.locator('#salaryAmount').innerText(), 'Not configured');
  assert.equal(await page.locator('#salaryStatus').innerText().then(text => text.includes('No salary recorded')), true);
  assert.equal(await page.locator('#salarySplit .split__item--end strong').innerText(), '—');
  assert.equal(await page.locator('#salaryNowRow').isVisible(), true, 'shortcut appears off the current month');
  assert.equal(await page.locator('#salaryList .entry').count(), 1, 'history still lists only the real record');

  // Arrows keep working from the picker-selected month, including the future.
  await page.locator('#salaryNextMonth').click();
  await page.locator('#salaryNextMonth').click();
  await page.locator('#salaryNextMonth').click();
  assert.equal(await page.locator('#salaryMonthLabel').innerText(), formatMonth(future));
  assert.equal((await page.locator('#salaryMonthHint').textContent()).trim(), 'Future month');
  assert.equal(await page.locator('#salaryAmount').innerText(), 'Not configured');
  assert.equal(await page.locator('#salaryEditButton').innerText(), 'Add salary');

  const untouched = await dbSnapshot(page);
  assert.equal(untouched.salaries.length, 1, 'navigation never creates salary records');
  assert.equal(untouched.savings.length, 1);
  assert.equal(untouched.records.length, 1);

  // The Current month shortcut returns to today with the real numbers intact.
  await page.locator('#salaryCurrentMonth').click();
  assert.equal(await page.locator('#salaryMonthLabel').innerText(), formatMonth(current));
  assert.equal(await page.locator('#salaryNowRow').isHidden(), true);
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(50000));
  assert.equal(await page.locator('#salarySplit .split__item--end strong').innerText(), formatMoney(45800));

  await context.close();
});

await run('a sheet can be reopened while it is still closing', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);
  await gotoApp(page);
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

  await addExpense(page, { amount: '2000', description: 'Unexpected repair' });
  assert.equal(await page.locator('#financeSalary').innerText(), 'Not set');
  assert.equal(await page.locator('#financeRemainingValue').innerText(), '—');
  assert.match(await page.locator('#financeRemainingNote').innerText(), /No salary recorded/);
  assert.equal(
    await page.locator('#financeBalance').evaluate(element => element.classList.contains('is-unconfigured')),
    true
  );

  await addSalary(page, { amount: '1000' });
  await page.locator('[data-view="dashboard"]').click();
  assert.equal(await page.locator('#financeRemainingValue').innerText(), formatMoney(-1000));
  assert.equal(
    await page.locator('#financeBalance').evaluate(element => element.classList.contains('is-negative')),
    true
  );
  assert.match(await page.locator('#financeRemainingNote').innerText(), /more than this month’s salary/);

  await context.close();
});

await run('savings history spans months and stays out of expenses', async () => {
  const context = await createContext();
  const page = await context.newPage();
  globalThis.__activePage = page;
  watch(page);
  await gotoApp(page);
  const current = monthKeyNow();
  const previous = shiftMonthKey(current, -1);

  await addSaving(page, { amount: '1000', description: 'This month' });
  await waitForToast(page, 'Savings added.');

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
  await waitForToast(page, 'Savings added.');

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
  await page.evaluate(async record => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('spendly');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve();
    });

    await new Promise((resolve, reject) => {
      const request = indexedDB.open('spendly', 1);
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
      const request = indexedDB.open('spendly', 1);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('expenses', 'readwrite');
        transaction.objectStore('expenses').put(record);
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
      request.onerror = () => reject(request.error);
    });
  }, original);

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
  await waitForToast(page, 'Savings added.');
  assert.equal(await page.locator('#savingsMonthTotal').innerText(), formatMoney(1000));

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
  assert.equal(await page.locator('#offlineBanner').isVisible(), true);

  await page.locator('[data-view="salary"]').click();
  assert.equal(await page.locator('#salaryAmount').innerText(), formatMoney(50000));
  await page.locator('[data-view="savings"]').click();
  assert.equal(await page.locator('#savingsMonthTotal').innerText(), formatMoney(1000));
  await page.locator('[data-view="dashboard"]').click();
  assert.equal(await page.locator('#financeRemainingValue').innerText(), formatMoney(49000));

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
