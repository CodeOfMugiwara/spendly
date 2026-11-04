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

import { formatMoney, summarize, toISODate, STORAGE_KEY } from '../js/core.js';
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
    const meta = stores.includes('meta') ? await readAll('meta') : [];
    db.close();
    return { records, meta, stores };
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
  await page.locator('[data-view="history"]').click();
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
  await page.locator('[data-view="history"]').click();
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
  assert.equal(parsedBackup.version, 2);
  assert.equal(parsedBackup.expenses.length, 1);
  assert.ok(parsedBackup.expenses[0].createdAt);

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
  await waitForToast(page, 'previous expenses are back');
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

  await page.locator('[data-view="history"]').click();
  await page.locator('#historyList .entry').first().waitFor();
  await page.locator('#search').fill('Petrol');
  await page.waitForTimeout(250);
  assert.equal(await page.locator('#historyList .entry').count(), 1, 'search works while offline');
  await page.locator('#clearSearch').click();
  await page.locator('[data-view="home"]').click();

  await addExpense(page, { amount: '42', description: 'Offline chai' });
  await waitForToast(page, 'Expense saved.');
  assert.equal((await dbSnapshot(page)).records.length, 5);

  await page.locator('[data-view="history"]').click();
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
/* 5. iOS install hint, responsive layout and screenshots                     */
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
  assert.equal(await page.locator('#recentList .entry').count(), 5, 'recent list is limited to five');
  await page.screenshot({ path: path.join(SHOTS, 'home-mobile.png') });

  await page.locator('[data-view="history"]').click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(SHOTS, 'history-mobile.png') });

  await page.locator('[data-view="home"]').click();
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
