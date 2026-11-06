/**
 * Spendly UI.
 *
 * All persistence goes through the repositories; this file never touches
 * IndexedDB directly. Four views share one render loop:
 *
 *   dashboard  expense analytics + the monthly salary/expense/savings balance
 *   expenses   the searchable expense ledger
 *   salary     one manual salary record per calendar month
 *   savings    this month's entries and the accumulated total
 */

import {
  PERIODS,
  addDays,
  computeMonthlyFinance,
  computeSalaryPool,
  computeSavingsBalance,
  extraIncomeRemaining,
  currentMonthKey,
  findActiveSalary,
  findSalaryForMonth,
  formatDate,
  formatMoney,
  formatMoneyParts,
  formatMonth,
  formatMonthKey,
  fromPaise,
  groupExpensesByMonth,
  groupSavingsByMonth,
  isMonthKey,
  localToday,
  matchesQuery,
  monthBounds,
  normalizeExpenseRecord,
  normalizeSalaryRecord,
  normalizeSavingRecord,
  normalizeQuery,
  relativeDayLabel,
  savingsForMonth,
  shiftMonth,
  shortMonthLabel,
  sortExpenses,
  sumSavings,
  summarize,
  toISODate,
  toPaise,
  sumSavingsPaise,
  validateExpenseInput
} from './core.js';
import {
  IndexedDBExpenseStore,
  IndexedDBSalaryStore,
  IndexedDBSavingsStore,
  IndexedDBExtraIncomeStore,
  openSpendlyDB
} from './db.js';
import {
  DuplicateMonthError,
  FinancialLedgerRepository,
  InsufficientSalaryBalanceError,
  InsufficientSavingsError,
  NoActiveSalaryError,
  ReferencedSalaryError,
  ExpenseRepository,
  NotFoundError,
  SalaryRepository,
  SavingsRepository,
  ValidationError
} from './repository.js';

const $ = id => document.getElementById(id);
const ICON = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const INSTALL_DISMISSED_KEY = 'spendly_install_tip_dismissed_v1';
const AVATAR_TINTS = ['#e8f3ec', '#f1f0e2', '#e8eef3', '#f4ebe5', '#edf2e6'];
const VIEWS = ['dashboard', 'expenses', 'salary', 'savings'];
const VIEW_TITLES = {
  dashboard: 'Spendly — Salary, Spending & Savings',
  expenses: 'Expenses — Spendly',
  salary: 'Salary — Spendly',
  savings: 'Savings — Spendly'
};
const EXPENSE_FIELDS = {
  amount: 'amountInput',
  description: 'descriptionInput',
  date: 'dateInput'
};
const SALARY_FIELDS = {
  amount: ['salaryAmountInput', 'salaryAmountError'],
  monthKey: ['salaryMonthSelect', 'salaryMonthError'],
  notes: ['salaryNotesInput', 'salaryNotesError']
};
const SAVING_FIELDS = {
  amount: ['savingAmountInput', 'savingAmountError'],
  date: ['savingDateInput', 'savingDateError'],
  description: ['savingDescriptionInput', 'savingDescriptionError']
};
const MONTH_NAMES = Array.from({ length: 12 }, (_, index) =>
  new Intl.DateTimeFormat('en-IN', { month: 'long' }).format(new Date(2026, index, 1)));

let offlineReady = Boolean(navigator.serviceWorker?.controller);

const state = {
  repo: null,
  ledgerRepo: null,
  salaryRepo: null,
  savingsRepo: null,
  expenses: [],
  salaries: [],
  savings: [],
  extraIncome: [],
  editingExtraIncomeId: null,
  selectedPeriod: 'month',
  view: 'dashboard',
  search: '',
  reviewExpensesOnly: false,
  editingExpenseId: null,
  editingSalaryId: null,
  editingSavingId: null,
  financeMonth: currentMonthKey(),
  salaryMonth: currentMonthKey(),
  savingsMonth: currentMonthKey(),
  savingsTab: 'month',
  dismissedTransferPromptId: null,
  ready: false,
  savingExpense: false,
  savingSalary: false,
  savingEntry: false,
  toastTimer: null,
  searchTimer: null,
  lastBackupAt: null,
  backupReminderDismissedUntil: null,
  storageMessage: 'Your data is stored in this browser and is not uploaded.',
  onboardingDone: false,
  installPrompt: null,
  installDismissed: readPreference(INSTALL_DISMISSED_KEY),
  registration: null,
  reloading: false,
  lastUpdateCheck: 0
};

const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[char]));

const truncate = (value, length) => {
  const characters = Array.from(String(value));
  return characters.length > length ? `${characters.slice(0, length - 1).join('')}…` : String(value);
};

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

bindEvents();
updateConnectionUI();
setupDialogs();
populateMonthOptions();
setupServiceWorker();
void initData();

async function initData() {
  try {
    const database = await openSpendlyDB();
    state.repo = new ExpenseRepository(new IndexedDBExpenseStore(database));
    state.salaryRepo = new SalaryRepository(new IndexedDBSalaryStore(database));
    state.savingsRepo = new SavingsRepository(new IndexedDBSavingsStore(database));
    state.extraIncomeStore = new IndexedDBExtraIncomeStore(database);
    state.ledgerRepo = new FinancialLedgerRepository(database);

    let migration;
    try {
      migration = await state.repo.migrateLegacy();
    } catch (error) {
      console.error('Legacy migration failed:', error);
      migration = { status: 'failed', imported: 0 };
    }

    let allocationMigration;
    try {
      allocationMigration = await state.ledgerRepo.migrateAllocations();
    } catch (error) {
      console.error('Salary allocation migration failed:', error);
      throw new Error('Spendly could not finish the safe salary-allocation upgrade. Your existing records are still saved.');
    }

    await refreshAll();
    state.lastBackupAt = await state.ledgerRepo.getMetadata('backup:last-download-request');
    state.backupReminderDismissedUntil = await state.ledgerRepo.getMetadata('backup:reminder-dismissed-until');
    state.onboardingDone = (await state.ledgerRepo.getMetadata('onboarding:completed')) === true;
    const initialRoute = readRoute();
    state.financeMonth = initialRoute.financeMonth;
    state.salaryMonth = initialRoute.salaryMonth;
    state.savingsTab = initialRoute.savingsTab;
    state.savingsMonth = initialRoute.savingsMonth;
    state.ready = true;
    document.documentElement.dataset.appReady = 'true';
    render();
    showView(initialRoute.view, { historyMode: 'replace', focus: false });
    applyLaunchParams();

    if (migration.status === 'migrated' && migration.imported > 0) {
      showToast(`Imported ${expenseWord(migration.imported)} into the new local database.`, { duration: 6000 });
    } else if (migration.status === 'failed') {
      showToast('Some existing expenses could not be imported. Your original data is still in this browser.', {
        tone: 'error',
        duration: 9000
      });
    }

    if (allocationMigration.status === 'migrated') {
      const needsReview = (allocationMigration.unresolvedExpenseIds?.length ?? 0) + (allocationMigration.unresolvedSavingIds?.length ?? 0);
      if (needsReview) showToast(`${needsReview} older transaction${needsReview === 1 ? '' : 's'} need salary-allocation review. Their records were preserved.`, { duration: 9000 });
    }

    void requestPersistentStorage();
  } catch (error) {
    console.error('Spendly could not start:', error);
    showFatal(error);
  }
}

function showFatal(error) {
  state.ready = false;
  $('fatalError').hidden = false;
  for (const view of VIEWS) $(`view-${view}`).hidden = true;
  $('addExpenseButton').disabled = true;
  $('dock').querySelectorAll('.dock__tab').forEach(tab => { tab.disabled = true; });

  const blocked = /another tab/i.test(error?.message ?? '');
  $('fatalMessage').textContent = blocked
    ? 'Spendly’s local database is open in another tab. Close the other Spendly tabs, then reload this page.'
    : 'Your data has not been deleted. Reload the page to try again, and check that Safari or your browser allows site data.';
}

async function requestPersistentStorage() {
  try {
    if (!navigator.storage) return;
    let persistent = typeof navigator.storage.persisted === 'function'
      ? await navigator.storage.persisted()
      : null;
    if (persistent === false && typeof navigator.storage.persist === 'function') {
      persistent = await navigator.storage.persist();
    }
    let usage = null;
    let quota = null;
    if (typeof navigator.storage.estimate === 'function') {
      const estimate = await navigator.storage.estimate();
      usage = Number.isFinite(estimate.usage) ? estimate.usage : null;
      quota = Number.isFinite(estimate.quota) ? estimate.quota : null;
    }
    state.storageMessage = storageMessage({ persistent, usage, quota });
    renderBackupHealth();
  } catch {
    // Best effort. The app works without persistent-storage permission.
    state.storageMessage = 'Your data stays in this browser. Download a backup to keep a separate copy.';
    renderBackupHealth();
  }
}

function storageMessage({ persistent, usage, quota }) {
  const size = bytes => bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  const usageText = usage !== null && quota !== null
    ? ` Using ${size(usage)} of about ${size(quota)} available.`
    : '';
  if (persistent === true) return `This browser is protecting Spendly’s local data from automatic cleanup.${usageText}`;
  if (persistent === false) return `This browser may clear local data when space is low. Keep a backup file.${usageText}`;
  return `Your data stays in this browser. Download a backup to keep a separate copy.${usageText}`;
}

async function refreshAll() {
  if (!state.repo) return;
  const [expenses, salaries, savings, extraIncome] = await Promise.all([
    state.repo.list(),
    state.salaryRepo.list(),
    state.savingsRepo.list(),
    state.extraIncomeStore.getAll()
  ]);
  state.expenses = expenses;
  state.salaries = salaries;
  state.savings = savings;
  state.extraIncome = extraIncome;
}

function hasAnyData() {
  return state.expenses.length > 0 || state.salaries.length > 0 || state.savings.length > 0 || state.extraIncome.length > 0;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function render() {
  if (!state.ready) return;
  const summary = summarize(state.expenses, new Date());
  $('view-dashboard').classList.toggle('is-empty', state.expenses.length === 0);
  renderHero(summary);
  renderFinance();
  renderGlance(summary);
  renderWeek(summary.week);
  renderRecent(summary.recent);
  renderExpensesPage(summary);
  renderSalaryPage();
  renderSavingsPage();
  renderBackupHealth();
  renderOnboarding();
  renderInstallPrompt();
}

function markOnboardingComplete() {
  if (state.onboardingDone) return;
  state.onboardingDone = true;
  void state.ledgerRepo?.setMetadata('onboarding:completed', true).catch(error => {
    console.error('Could not save onboarding progress:', error);
  });
}

function renderOnboarding() {
  if (state.salaries.length) markOnboardingComplete();
  $('onboardingCard').hidden = state.onboardingDone;
}

function renderBackupHealth() {
  const records = state.expenses.length + state.salaries.length + state.savings.length + state.extraIncome.length;
  const lastBackup = Date.parse(state.lastBackupAt ?? '');
  const dismissedUntil = Date.parse(state.backupReminderDismissedUntil ?? '');
  const due = records >= 10 && (!Number.isFinite(lastBackup) || Date.now() - lastBackup >= 30 * 86400000);
  const dismissed = Number.isFinite(dismissedUntil) && dismissedUntil > Date.now();
  $('backupReminder').hidden = !due || dismissed;
  $('storageHealth').textContent = state.storageMessage;
}

async function recordBackupDownload() {
  const backedUpAt = new Date().toISOString();
  try {
    await state.ledgerRepo.setMetadata('backup:last-download-request', backedUpAt);
    state.lastBackupAt = backedUpAt;
    state.backupReminderDismissedUntil = null;
    renderBackupHealth();
  } catch (error) {
    console.error('Could not save the backup date:', error);
    return false;
  }
  return true;
}

function amountMarkup(value) {
  const { currency, integer, fraction } = formatMoneyParts(value);
  return `<span class="amount__currency" aria-hidden="true">${currency}</span>${integer}<span class="amount__fraction" aria-hidden="true">.${fraction}</span>`;
}

function renderHero(summary) {
  const period = summary.periods[state.selectedPeriod];
  $('heroLabel').textContent = period.label;
  $('heroAmount').innerHTML = amountMarkup(period.total);
  $('heroAmount').setAttribute('aria-label', formatMoney(period.total));
  $('heroCount').textContent = String(period.count);
  $('heroAverage').textContent = formatMoney(period.dailyAverage);
}

/* -------------------------------------------------------------------------- */
/* Dashboard: monthly financial overview                                      */
/* -------------------------------------------------------------------------- */

function financeMonthStatus(monthKey) {
  const current = currentMonthKey();
  if (monthKey === current) return 'Current month';
  return monthKey < current ? 'Past month' : 'Future month';
}

function financeFor(monthKey) {
  const salary = findSalaryForMonth(state.salaries, monthKey);
  if (!salary) return computeMonthlyFinance(monthKey, { expenses: state.expenses, savings: state.savings });
  const pool = computeSalaryPool(salary, state.expenses, state.savings);
  const savingsPaise = pool.contributionPaise + pool.transferPaise;
  return {
    ...pool,
    monthKey,
    label: formatMonthKey(monthKey),
    salary,
    hasSalary: true,
    salaryPaise: Math.round(Number(salary.amount) * 100),
    salaryTotal: Number(salary.amount),
    savingsPaise,
    savingsTotal: savingsPaise / 100,
    remaining: pool.remaining,
    remainingPaise: pool.remainingPaise,
    isNegative: pool.remainingPaise < 0
  };
}

function renderFinance() {
  const key = state.financeMonth;
  const finance = financeFor(key);

  $('financeMonthLabel').textContent = formatMonthKey(key);
  $('financeMonthLabel').setAttribute('title', formatMonthKey(key));
  $('financeSalary').textContent = finance.hasSalary ? formatMoney(finance.salaryTotal) : 'Not set';
  $('financeSalary').classList.toggle('is-unset', !finance.hasSalary);
  $('financeExpenses').textContent = formatMoney(finance.expenseTotal);
  $('financeSavings').textContent = formatMoney(finance.savingsTotal);

  const balance = $('financeBalance');
  balance.classList.toggle('is-negative', finance.isNegative);
  balance.classList.toggle('is-unconfigured', !finance.hasSalary);

  if (!finance.hasSalary) {
    $('financeRemainingValue').textContent = '—';
    $('financeRemainingNote').textContent = `No salary recorded for ${formatMonthKey(key)}. Add one to see what is left.`;
    $('financeRemainingValue').setAttribute('aria-label', 'Remaining balance unavailable — no salary recorded');
  } else {
    $('financeRemainingValue').textContent = formatMoney(finance.remaining);
    $('financeRemainingValue').setAttribute('aria-label', `Remaining balance ${formatMoney(finance.remaining)}`);
    $('financeRemainingNote').textContent = finance.isNegative
      ? `Expenses and savings are ${formatMoney(Math.abs(finance.remaining))} more than this month’s salary.`
      : 'Salary minus this month’s expenses and savings.';
  }

  $('financeCard').setAttribute(
    'aria-label',
    finance.hasSalary
      ? `${formatMonthKey(key)}: salary ${formatMoney(finance.salaryTotal)}, expenses ${formatMoney(finance.expenseTotal)}, savings ${formatMoney(finance.savingsTotal)}, remaining ${formatMoney(finance.remaining)}.`
      : `${formatMonthKey(key)}: no salary recorded. Expenses ${formatMoney(finance.expenseTotal)}, savings ${formatMoney(finance.savingsTotal)}.`
  );

  const shortLabel = shortMonthLabel(key, { withYear: true });
  $('shortcutSalary').textContent = finance.hasSalary
    ? `${formatMoney(finance.salaryTotal)} recorded`
    : `Not set for ${shortLabel}`;
  $('shortcutSavings').textContent = `${formatMoney(finance.savingsTotal)} saved`;
}

/* -------------------------------------------------------------------------- */
/* Dashboard: expense analytics                                               */
/* -------------------------------------------------------------------------- */

function renderGlance(summary) {
  for (const period of PERIODS) {
    const tile = document.querySelector(`[data-period="${period}"]`);
    if (!tile) continue;
    tile.setAttribute('aria-pressed', String(period === state.selectedPeriod));
    const value = tile.querySelector(`[data-total="${period}"]`);
    if (value) value.textContent = formatMoney(summary.periods[period].total);
  }

  $('allTimeTotal').textContent = formatMoney(summary.all.total);
  $('allTimeCount').textContent = String(summary.all.count);
  $('allTimeButton').setAttribute(
    'aria-label',
    `All time: ${formatMoney(summary.all.total)} across ${expenseWord(summary.all.count)}. Open expenses.`
  );
}

function renderWeek(week) {
  $('weekTotal').textContent = formatMoney(week.total);
  $('weekEmpty').hidden = week.total > 0;

  $('weekBars').innerHTML = week.days.map(day => {
    const height = day.amount > 0 ? Math.max(6, Math.round((day.amount / week.max) * 100)) : 3;
    const classes = ['week__column'];
    if (day.isToday) classes.push('is-today');
    if (day.isFuture) classes.push('is-future');
    return `<div class="${classes.join(' ')}" title="${escapeHTML(`${day.weekday}: ${formatMoney(day.amount)}`)}">
      <div class="week__track"><span class="week__fill" style="height:${height}%"></span></div>
      <span class="week__day">${escapeHTML(day.weekday)}</span>
    </div>`;
  }).join('');

  $('weekBars').setAttribute(
    'aria-label',
    `Daily spending this week. ${week.days.map(day => `${day.weekday}: ${formatMoney(day.amount)}`).join('. ')}.`
  );
}

function renderRecent(recent) {
  $('recentList').innerHTML = recent.length
    ? recent.map(expense => entryMarkup(expense, { relative: true })).join('')
    : emptyMarkup({
        icon: 'wallet',
        title: 'No expenses yet',
        text: 'Add your first spend. It stays on this device and works offline.',
        action: 'Add your first expense',
        actionAttribute: 'data-empty-add="true"'
      });
}

/* -------------------------------------------------------------------------- */
/* Expenses page                                                              */
/* -------------------------------------------------------------------------- */

function renderExpensesPage(summary) {
  const query = normalizeQuery(state.search);
  const unresolved = state.expenses.filter(expense => expense.paymentSource === 'salary' &&
    (!expense.salaryRecordId || expense.allocationStatus === 'needs_review'));
  if (state.reviewExpensesOnly && unresolved.length === 0) state.reviewExpensesOnly = false;
  const baseExpenses = state.reviewExpensesOnly ? unresolved : state.expenses;
  const matching = query
    ? baseExpenses.filter(expense => matchesQuery(expense, query))
    : baseExpenses;

  $('sourceReviewCard').hidden = unresolved.length === 0;
  $('sourceReviewCount').textContent = `${unresolved.length} ${unresolved.length === 1 ? 'expense needs' : 'expenses need'} review`;
  $('sourceReviewButton').textContent = state.reviewExpensesOnly ? 'Show all expenses' : 'Review sources';
  $('sourceReviewButton').setAttribute('aria-pressed', String(state.reviewExpensesOnly));

  $('allTotal').innerHTML = amountMarkup(summary.all.total);
  $('allTotal').setAttribute('aria-label', formatMoney(summary.all.total));
  $('allCount').textContent = expenseWord(summary.all.count);
  $('allRange').textContent = summary.all.firstDate ? `Since ${formatMonth(summary.all.firstDate)}` : '';
  $('clearSearch').hidden = !query;
  $('resultCount').textContent = state.reviewExpensesOnly
    ? `${matching.length} to review`
    : query
    ? `${matching.length} found`
    : `${state.expenses.length} total`;
  $('resultCount').setAttribute('aria-live', 'polite');

  if (!matching.length) {
    if (state.reviewExpensesOnly && unresolved.length === 0) {
      $('historyList').innerHTML = emptyMarkup({
        icon: 'check',
        title: 'All expense sources are clear',
        text: 'Every salary-funded expense is linked to a salary pool.',
        action: 'Show all expenses',
        actionAttribute: 'data-clear-review="true"'
      });
    } else if (state.reviewExpensesOnly) {
      $('historyList').innerHTML = emptyMarkup({
        icon: 'search',
        title: `No matches for “${query}”`,
        text: 'Try a different description, date or amount.',
        action: 'Clear search',
        actionAttribute: 'data-clear-search="true"'
      });
    } else if (!state.expenses.length) {
      $('historyList').innerHTML = emptyMarkup({
        icon: 'wallet',
        title: 'No expenses yet',
        text: 'Your complete history will appear here once you add an expense.',
        action: 'Add your first expense',
        actionAttribute: 'data-empty-add="true"'
      });
    } else {
      $('historyList').innerHTML = emptyMarkup({
        icon: 'search',
        title: `No matches for “${query}”`,
        text: 'Try a different description, date or amount.',
        action: 'Clear search',
        actionAttribute: 'data-clear-search="true"'
      });
    }
    return;
  }

  $('historyList').innerHTML = groupExpensesByMonth(matching).map(group => `
    <section class="month" aria-label="${escapeHTML(group.label)}">
      <header class="month__head">
        <h3>${escapeHTML(group.label)}</h3>
        <span>${escapeHTML(formatMoney(group.total))}</span>
      </header>
      <div class="list-card">${group.items.map(expense => entryMarkup(expense)).join('')}</div>
    </section>
  `).join('');
}

function entryMarkup(expense, options = {}) {
  const dateLabel = options.relative ? relativeDayLabel(expense.date) : formatDate(expense.date);
  const safeId = escapeHTML(expense.id);
  const safeDescription = escapeHTML(expense.description);
  const safeDate = escapeHTML(dateLabel);
  const safeAmount = escapeHTML(formatMoney(expense.amount));
  const initial = escapeHTML(firstCharacter(expense.description));
  const tint = avatarTint(expense.id);
  const paidFrom = expense.paymentSource === 'savings' ? 'Savings'
    : expense.paymentSource === 'others' ? 'Others'
      : expense.allocationStatus === 'needs_review' || !expense.salaryRecordId ? 'Source needs review' : 'Salary';

  return `<article class="entry">
    <button class="entry__main" type="button" data-edit="${safeId}" aria-label="Edit ${safeDescription}, ${safeAmount}, ${safeDate}">
      <span class="entry__avatar" style="--avatar:${tint}" aria-hidden="true">${initial}</span>
      <span class="entry__text">
        <span class="entry__title">${safeDescription}</span>
        <span class="entry__meta">${safeDate} <span class="source-tag">${paidFrom}</span></span>
      </span>
      <span class="entry__amount">${safeAmount}</span>
    </button>
    <button class="entry__menu" type="button" data-menu="${safeId}" aria-label="More actions for ${safeDescription}" aria-haspopup="dialog">
      ${ICON('more')}
    </button>
  </article>`;
}

function emptyMarkup({ icon, title, text, action, actionAttribute }) {
  return `<div class="empty">
    <span class="empty__icon" aria-hidden="true">${ICON(icon)}</span>
    <p class="empty__title">${escapeHTML(title)}</p>
    <p class="empty__text">${escapeHTML(text)}</p>
    ${action ? `<button class="text-button empty__action" type="button" ${actionAttribute}>${escapeHTML(action)}</button>` : ''}
  </div>`;
}

function firstCharacter(value) {
  const characters = Array.from(String(value).trim());
  return characters[0] ? characters[0].toLocaleUpperCase() : '?';
}

function avatarTint(seed) {
  let hash = 0;
  for (const character of String(seed)) {
    hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  }
  return AVATAR_TINTS[hash % AVATAR_TINTS.length];
}

function expenseWord(count) {
  return `${count} ${count === 1 ? 'expense' : 'expenses'}`;
}

function savingWord(count) {
  return `${count} ${count === 1 ? 'entry' : 'entries'}`;
}

/* -------------------------------------------------------------------------- */
/* Salary page                                                                */
/* -------------------------------------------------------------------------- */

function renderSalaryPage() {
  const key = state.salaryMonth;
  const record = findSalaryForMonth(state.salaries, key);
  const finance = record
    ? { ...computeSalaryPool(record, state.expenses, state.savings), hasSalary: true }
    : { hasSalary: false, expenseTotal: 0, contributionTotal: 0, transferTotal: 0, remaining: null, remainingPaise: null };
  const label = formatMonthKey(key);

  $('salaryMonthLabel').textContent = label;
  $('salaryMonthHint').textContent = financeMonthStatus(key);
  $('salaryMonthPickerButton').setAttribute('aria-label', `Selected month: ${label}. ${$('salaryMonthHint').textContent}. Choose another month and year.`);
  $('salaryNowRow').hidden = key === currentMonthKey();

  $('salaryBalanceLabel').textContent = 'Remaining balance';
  $('salaryAmount').innerHTML = record ? amountMarkup(finance.remaining) : 'No salary pool';
  $('salaryAmount').classList.toggle('is-unset', !record);
  $('salaryAmount').classList.toggle('is-negative', Boolean(record && finance.remainingPaise < 0));
  $('salaryAmount').setAttribute('aria-label', record ? `Remaining balance ${formatMoney(finance.remaining)}` : 'No salary pool for this month');
  const monthExtraIncome = state.extraIncome.filter(entry => entry.date.slice(0, 7) === key);
  const extraBalance = monthExtraIncome.reduce((sum, entry) => sum + extraIncomeRemaining(entry, state.savings), 0);
  $('extraIncomeBalance').textContent = formatMoney(extraBalance);

  $('salaryNotes').hidden = !record?.notes;
  $('salaryNotes').textContent = record?.notes ? `“${record.notes}”` : '';

  $('salaryStatus').textContent = record
    ? `Salary pool added ${formatDate(record.createdAt.slice(0, 10))}. Expenses and savings follow the pool they were assigned to.`
    : `No salary pool for ${label}. Add salary to start a new pool.`;

  $('salarySplit').innerHTML = `
    <div class="split__item">
      <span>Salary</span>
      <strong>${escapeHTML(record ? formatMoney(record.amount) : '—')}</strong>
    </div>
    <div class="split__item">
      <span>Savings</span>
      <strong>${escapeHTML(record ? formatMoney(finance.contributionTotal + finance.transferTotal) : '—')}</strong>
    </div>
    <div class="split__item split__item--end${record && finance.remainingPaise < 0 ? ' is-negative' : ''}">
      <span>Expenses</span>
      <strong>${escapeHTML(record ? formatMoney(finance.expenseTotal) : '—')}</strong>
    </div>`;

  renderSalaryMonthTrend(key);

  const previousSalary = findSalaryForMonth(state.salaries, shiftMonth(key, -1));
  const copyButton = $('copyPreviousSalaryButton');
  copyButton.hidden = Boolean(record || !previousSalary);
  copyButton.textContent = previousSalary
    ? `Use ${formatMoney(previousSalary.amount)} from ${formatMonthKey(previousSalary.monthKey)}`
    : '';

  const activeSalary = findActiveSalary(state.salaries);
  const hasNewerSalary = Boolean(record && activeSalary && activeSalary.id !== record.id && Date.parse(activeSalary.createdAt) > Date.parse(record.createdAt));
  const transferEligible = hasNewerSalary && finance.remainingPaise > 0 && state.dismissedTransferPromptId !== record.id;
  const transferPrompt = $('salaryTransferPrompt');
  transferPrompt.hidden = !transferEligible;
  if (transferEligible) {
    $('salaryTransferMessage').textContent = `${formatMoney(finance.remaining)} remains from ${formatMonthKey(record.monthKey)}. Move it to Savings?`;
    $('salaryTransferButton').dataset.salaryTransfer = record.id;
    $('salaryTransferLater').dataset.salaryTransferLater = record.id;
  }

  const editButton = $('salaryEditButton');
  editButton.textContent = record ? 'Edit salary' : 'Add salary';
  $('salaryClearButton').hidden = !record;

  $('salaryHistoryCount').textContent = state.salaries.length
    ? `${state.salaries.length} ${state.salaries.length === 1 ? 'month' : 'months'}`
    : '';

  $('salaryList').innerHTML = state.salaries.length
    ? `<div class="list-card">${state.salaries.map(salaryRowMarkup).join('')}</div>`
    : emptyMarkup({
        icon: 'rupee',
        title: 'No salary records yet',
        text: `Add what you earned for ${label}. Each month keeps its own record.`,
        action: 'Add this month’s salary',
        actionAttribute: 'data-empty-salary="true"'
      });
  $('exportSalaryCsv').hidden = state.salaries.length === 0;
  const extraTotal = monthExtraIncome.reduce((sum, entry) => sum + Number(entry.amount), 0);
  $('extraIncomeTotal').textContent = `${formatMoney(extraTotal)} received`;
  $('extraIncomeList').innerHTML = monthExtraIncome.length
    ? `<div class="list-card">${[...monthExtraIncome].sort((a, b) => b.date.localeCompare(a.date)).map(extraIncomeRowMarkup).join('')}</div>`
    : `<p class="savings-month__empty">No other income added in ${escapeHTML(label)}.</p>`;
}

function renderSalaryMonthTrend(monthKey) {
  const previousKey = shiftMonth(monthKey, -1);
  const currentExpenses = state.expenses.filter(expense => expense.date.slice(0, 7) === monthKey);
  const previousExpenses = state.expenses.filter(expense => expense.date.slice(0, 7) === previousKey);
  const currentSavings = savingsForMonth(state.savings, monthKey);
  const previousSavings = savingsForMonth(state.savings, previousKey);
  const parts = [];

  if (previousExpenses.length) {
    const difference = currentExpenses.reduce((sum, item) => sum + Math.round(item.amount * 100), 0) -
      previousExpenses.reduce((sum, item) => sum + Math.round(item.amount * 100), 0);
    parts.push(difference === 0
      ? `Spending was the same as ${formatMonthKey(previousKey)}`
      : `Spent ${formatMoney(fromPaise(Math.abs(difference)))} ${difference > 0 ? 'more' : 'less'} than ${formatMonthKey(previousKey)}`);
  }

  if (previousSavings.length) {
    const difference = sumSavingsPaise(currentSavings) - sumSavingsPaise(previousSavings);
    parts.push(difference === 0
      ? `Savings activity matched ${formatMonthKey(previousKey)}`
      : `Saved ${formatMoney(fromPaise(Math.abs(difference)))} ${difference > 0 ? 'more' : 'less'} than ${formatMonthKey(previousKey)}`);
  }

  const trend = $('salaryMonthTrend');
  trend.textContent = parts.join(' · ');
  trend.hidden = parts.length === 0;
}

function usePreviousSalary() {
  const previous = findSalaryForMonth(state.salaries, shiftMonth(state.salaryMonth, -1));
  if (!previous || findSalaryForMonth(state.salaries, state.salaryMonth)) return;
  openSalarySheet(null, state.salaryMonth);
  $('salaryAmountInput').value = Number(previous.amount).toFixed(2);
  $('salaryNotesInput').value = previous.notes ?? '';
}

function extraIncomeRowMarkup(record) {
  const remaining = extraIncomeRemaining(record, state.savings);
  const desc = record.description || record.source;
  return `<article class="entry"><div class="entry__main"><span class="entry__avatar entry__avatar--income">${ICON('rupee')}</span><span class="entry__text"><span class="entry__title">${escapeHTML(desc)}</span><span class="entry__meta">${escapeHTML(formatDate(record.date))} · ${escapeHTML(record.source)}</span></span><span class="entry__amount">${escapeHTML(formatMoney(remaining))} left</span></div><button class="entry__menu" type="button" data-extra-income-edit="${escapeHTML(record.id)}" aria-label="Edit ${escapeHTML(desc)}">${ICON('pencil')}</button><button class="entry__menu" type="button" data-extra-income-delete="${escapeHTML(record.id)}" aria-label="Delete ${escapeHTML(desc)}">${ICON('trash')}</button></article>`;
}

function openExtraIncomeSheet(recordId = null) {
  const record = recordId ? state.extraIncome.find(item => item.id === recordId) : null;
  state.editingExtraIncomeId = record?.id ?? null;
  $('extraIncomeSheetTitle').textContent = record ? 'Edit extra income' : 'Add extra income';
  $('extraIncomeAmount').value = record ? Number(record.amount).toFixed(2) : '';
  $('extraIncomeDate').value = record?.date ?? defaultSavingDate(state.salaryMonth);
  $('extraIncomeDate').max = localToday();
  $('extraIncomeSource').value = record?.source ?? 'freelancing';
  $('extraIncomeDescription').value = record?.description ?? '';
  $('extraIncomeFormError').hidden = true;
  openDialog($('extraIncomeSheet'));
}

async function saveExtraIncome(event) {
  event.preventDefault();
  const id = state.editingExtraIncomeId;
  const input = { amount: $('extraIncomeAmount').value, date: $('extraIncomeDate').value, source: $('extraIncomeSource').value, description: $('extraIncomeDescription').value };
  const button = $('saveExtraIncomeButton');
  button.disabled = true;
  try {
    if (id) await state.ledgerRepo.updateExtraIncome(id, input);
    else await state.ledgerRepo.createExtraIncome(input);
    await refreshAll();
    closeDialog($('extraIncomeSheet'));
    render();
    showToast(id ? 'Extra income updated' : 'Extra income added', { tone: 'success' });
  } catch (error) {
    $('extraIncomeFormError').textContent = error.message || 'Unable to save extra income.';
    $('extraIncomeFormError').hidden = false;
    showToast('Unable to save extra income', { tone: 'error' });
  } finally { button.disabled = false; }
}

async function removeExtraIncome(id) {
  try {
    await state.ledgerRepo.deleteExtraIncome(id);
    await refreshAll();
    render();
    showToast('Extra income deleted', { tone: 'success' });
  } catch (error) {
    showToast(error.message || 'Unable to delete extra income', { tone: 'error', duration: 5000 });
  }
}

function salaryRowMarkup(record) {
  const safeId = escapeHTML(record.id);
  const label = formatMonthKey(record.monthKey);
  const amount = escapeHTML(formatMoney(record.amount));
  const meta = record.notes ? escapeHTML(truncate(record.notes, 46)) : 'Monthly salary';

  return `<article class="entry">
    <button class="entry__main" type="button" data-salary-edit="${safeId}" aria-label="Edit salary for ${escapeHTML(label)}, ${amount}">
      <span class="entry__avatar entry__avatar--income" aria-hidden="true">${ICON('rupee')}</span>
      <span class="entry__text">
        <span class="entry__title">${escapeHTML(label)}</span>
        <span class="entry__meta">${meta}</span>
      </span>
      <span class="entry__amount">${amount}</span>
    </button>
    <button class="entry__menu" type="button" data-salary-menu="${safeId}" aria-label="Actions for ${escapeHTML(label)}" aria-haspopup="dialog">
      ${ICON('more')}
    </button>
  </article>`;
}

/* -------------------------------------------------------------------------- */
/* Savings page                                                               */
/* -------------------------------------------------------------------------- */

function renderSavingsPage() {
  const currentKey = currentMonthKey();
  const monthEntries = savingsForMonth(state.savings, currentKey);
  const monthTotals = savingsActivity(monthEntries);
  const monthTotal = fromPaise(monthTotals.contributionPaise + monthTotals.transferPaise - monthTotals.withdrawalPaise);
  const totals = savingsActivity(state.savings);
  const total = fromPaise(totals.contributionPaise + totals.transferPaise + totals.externalPaise - totals.withdrawalPaise);
  const groups = groupSavingsByMonth(state.savings);

  $('savingsMonthLabel').textContent = formatMonthKey(currentKey);
  $('savingsMonthTotal').innerHTML = amountMarkup(monthTotal);
  $('savingsMonthTotal').setAttribute('aria-label', `${formatMoney(monthTotal)} saved this month`);
  $('savingsMonthMeta').textContent = monthEntries.length
    ? `${savingWord(monthEntries.length)} · net activity`
    : 'No entries yet this month';
  $('savingsMonthCount').textContent = monthEntries.length ? savingWord(monthEntries.length) : '';
  $('savingsMonthContributions').textContent = formatMoney(fromPaise(monthTotals.contributionPaise));
  $('savingsMonthExternal').textContent = formatMoney(fromPaise(monthTotals.externalPaise));
  $('savingsMonthTransfers').textContent = formatMoney(fromPaise(monthTotals.transferPaise));
  $('savingsMonthWithdrawals').textContent = formatMoney(fromPaise(monthTotals.withdrawalPaise));
  $('savingsTotalContributions').textContent = formatMoney(fromPaise(totals.contributionPaise));
  $('savingsTotalExternal').textContent = formatMoney(fromPaise(totals.externalPaise));
  $('savingsTotalTransfers').textContent = formatMoney(fromPaise(totals.transferPaise));
  $('savingsTotalWithdrawals').textContent = formatMoney(fromPaise(totals.withdrawalPaise));

  $('savingsMonthList').innerHTML = monthEntries.length
    ? `<div class="list-card">${monthEntries.map(savingRowMarkup).join('')}</div>`
    : emptyMarkup({
        icon: 'savings',
        title: 'Nothing saved yet this month',
        text: 'Money you set aside lives here. It is never treated as an expense.',
        action: 'Add savings',
        actionAttribute: 'data-empty-saving="true"'
      });

  renderSavingsTotal({ groups, total, currentKey });
  renderSavingsTab();
}

function renderSavingsTotal({ groups, total, currentKey }) {
  const previousKey = shiftMonth(currentKey, -1);
  const thisMonth = fromPaise(sumSavingsPaise(savingsForMonth(state.savings, currentKey)));
  const lastMonth = fromPaise(sumSavingsPaise(savingsForMonth(state.savings, previousKey)));
  const delta = toPaise(thisMonth) - toPaise(lastMonth);

  $('savingsTotalAmount').innerHTML = amountMarkup(total);
  $('savingsTotalAmount').setAttribute('aria-label', `${formatMoney(total)} total savings`);
  $('savingsMonthsCount').textContent = groups.length
    ? `Across ${groups.length} ${groups.length === 1 ? 'month' : 'months'}`
    : 'No savings recorded yet';

  const growth = $('savingsGrowth');
  growth.textContent = delta === 0
    ? formatMoney(0)
    : `${delta > 0 ? '+' : '−'}${formatMoney(Math.abs(fromPaise(delta)))}`;
  growth.classList.toggle('is-up', delta > 0);
  growth.classList.toggle('is-down', delta < 0);
  $('savingsGrowth').setAttribute('aria-label', delta === 0 ? 'No change' : `${delta > 0 ? 'Up' : 'Down'} ${formatMoney(Math.abs(fromPaise(delta)))}`);
  $('savingsGrowthMeta').textContent = `in ${formatMonthKey(currentKey)} compared with ${formatMonthKey(previousKey)}`;

  const detailLabel = formatMonthKey(state.savingsMonth);
  const detailEntries = savingsForMonth(state.savings, state.savingsMonth);
  const detailTotal = fromPaise(sumSavingsPaise(detailEntries));
  $('savingsTotalMonthLabel').textContent = detailLabel;
  $('savingsTotalMonthAmount').textContent = formatMoney(detailTotal);
  $('savingsTotalMonthMeta').textContent = detailEntries.length
    ? `${savingWord(detailEntries.length)} · net activity`
    : `No entries in ${detailLabel}`;
  $('savingsTotalMonthList').innerHTML = detailEntries.length
    ? `<div class="list-card">${detailEntries.map(savingRowMarkup).join('')}</div>`
    : `<p class="savings-month__empty">Navigate to another month or add savings.</p>`;

  $('savingsAllMonthsCount').textContent = groups.length ? `${groups.length} total` : '';
  $('savingsMonthGroups').innerHTML = groups.length
    ? `<div class="list-card">${groups.map(group => `
        <button class="month-row" type="button" data-savings-month="${escapeHTML(group.key)}" aria-pressed="${group.key === state.savingsMonth}">
          <span class="month-row__icon" aria-hidden="true">${ICON('calendar')}</span>
          <span class="month-row__text">
            <strong>${escapeHTML(group.label)}</strong>
            <small>${escapeHTML(savingWord(group.count))}</small>
          </span>
          <span class="month-row__amount">${escapeHTML(formatMoney(group.total))}</span>
          ${ICON('chevron')}
        </button>
      `).join('')}</div>`
    : emptyMarkup({
        icon: 'savings',
        title: 'No savings history',
        text: 'Add your first savings entry to start building the total.',
        action: 'Add savings',
        actionAttribute: 'data-empty-saving="true"'
      });
}

function savingsActivity(records) {
  return records.reduce((totals, record) => {
    const amount = Math.round(Number(record.amount) * 100);
    const type = record.type ?? 'contribution';
    if (type === 'salary_balance_transfer') totals.transferPaise += amount;
    else if (type === 'withdrawal') totals.withdrawalPaise += amount;
    else if (type === 'external_contribution') totals.externalPaise += amount;
    else totals.contributionPaise += amount;
    return totals;
  }, { contributionPaise: 0, transferPaise: 0, externalPaise: 0, withdrawalPaise: 0 });
}

function savingRowMarkup(record) {
  const safeId = escapeHTML(record.id);
  const type = record.type ?? 'contribution';
  const title = record.description ? escapeHTML(record.description) : type === 'salary_balance_transfer' ? 'Salary balance transfer' : type === 'withdrawal' ? 'Savings withdrawal' : type === 'external_contribution' ? `${record.sourceType ?? 'Other'} added` : 'Savings contribution';
  let sourceLabel = type === 'salary_balance_transfer' ? 'From salary balance' : type === 'withdrawal' ? 'Used for expense' : type === 'external_contribution' ? (record.sourceType ?? 'other') : record.allocationStatus === 'needs_review' ? 'Salary source needs review' : 'From salary balance';
  if (type === 'contribution' && Array.isArray(record.extraIncomeAllocations) && record.extraIncomeAllocations.length) {
    const extraIncomePaise = record.extraIncomeAllocations.reduce((sum, item) => sum + item.amountPaise, 0);
    const salaryPaise = Number.isSafeInteger(record.salaryAllocationPaise) ? record.salaryAllocationPaise : 0;
    sourceLabel = [
      salaryPaise ? `Salary ${formatMoney(fromPaise(salaryPaise))}` : '',
      extraIncomePaise ? `Other income ${formatMoney(fromPaise(extraIncomePaise))}` : ''
    ].filter(Boolean).join(' + ');
  }
  const meta = `${escapeHTML(formatDate(record.date))} · ${sourceLabel}`;
  const amount = escapeHTML(formatMoney(record.amount));
  const signedAmount = type === 'withdrawal' ? `−${amount}` : `+${amount}`;
  const action = type === 'withdrawal'
    ? `<button class="entry__main" type="button" data-saving-expense="${escapeHTML(record.expenseId ?? '')}" aria-label="Open linked expense, ${amount}, ${meta}">`
    : `<button class="entry__main" type="button" data-saving-edit="${safeId}" aria-label="Edit ${title}, ${amount}, ${meta}">`;

  return `<article class="entry">
    ${action}
      <span class="entry__avatar entry__avatar--saving" aria-hidden="true">${ICON('savings')}</span>
      <span class="entry__text">
        <span class="entry__title">${title}</span>
        <span class="entry__meta">${meta}</span>
      </span>
      <span class="entry__amount ${type === 'withdrawal' ? 'entry__amount--withdrawal' : 'entry__amount--saving'}">${signedAmount}</span>
    </button>
    <button class="entry__menu" type="button" data-saving-menu="${safeId}" aria-label="Actions for ${title}" aria-haspopup="dialog">
      ${ICON('more')}
    </button>
  </article>`;
}

function renderSavingsTab() {
  const monthTab = state.savingsTab === 'month';
  for (const [id, isMonth] of [['savingsTabMonth', true], ['savingsTabTotal', false]]) {
    const tab = $(id);
    tab.classList.toggle('is-active', isMonth === monthTab);
    tab.setAttribute('aria-selected', String(isMonth === monthTab));
    tab.tabIndex = isMonth === monthTab ? 0 : -1;
  }
  $('savingsMonthPanel').hidden = !monthTab;
  $('savingsTotalPanel').hidden = monthTab;
}

/* -------------------------------------------------------------------------- */
/* Views and months                                                           */
/* -------------------------------------------------------------------------- */

function showView(view, { historyMode = 'push', focus = true } = {}) {
  if (!VIEWS.includes(view)) return;
  const changedView = state.view !== view;
  state.view = view;
  for (const name of VIEWS) $(`view-${name}`).hidden = name !== view;

  document.querySelectorAll('.dock__tab').forEach(tab => {
    const active = tab.dataset.view === view;
    tab.classList.toggle('is-active', active);
    if (active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });

  document.title = VIEW_TITLES[view];

  if (view === 'expenses') {
    $('search').value = state.search;
    renderExpensesPage(summarize(state.expenses, new Date()));
  } else if (view === 'salary') {
    renderSalaryPage();
  } else if (view === 'savings') {
    renderSavingsPage();
  }

  if (changedView) window.scrollTo(0, 0);
  if (historyMode !== 'none') writeRoute(historyMode);
  if (focus && changedView) {
    const heading = view === 'dashboard' ? $('main') : $(`${view}Title`);
    if (heading) {
      heading.focus({ preventScroll: true });
    }
  }
}

function selectPeriod(period) {
  if (!PERIODS.includes(period) || period === state.selectedPeriod) return;
  state.selectedPeriod = period;
  const summary = summarize(state.expenses, new Date());
  renderHero(summary);
  renderGlance(summary);
}

function shiftFinanceMonth(delta) {
  state.financeMonth = shiftMonth(state.financeMonth, delta);
  renderFinance();
  writeRoute('replace');
}

function shiftSalaryMonth(delta, animate = true) {
  state.salaryMonth = shiftMonth(state.salaryMonth, delta);
  renderSalaryPage();
  writeRoute('replace');
  if (animate) pulseMonthChange(delta);
}

function setSalaryMonth(monthKey) {
  if (!isMonthKey(monthKey) || monthKey === state.salaryMonth) return;
  state.dismissedTransferPromptId = null;
  const direction = monthKey > state.salaryMonth ? 1 : -1;
  state.salaryMonth = monthKey;
  renderSalaryPage();
  writeRoute('push');
  pulseMonthChange(direction);
}

/** A short, restrained slide of the salary figure when the month changes. */
function pulseMonthChange(direction) {
  if (prefersReducedMotion()) return;
  const card = $('salaryAmount');
  card.classList.remove('is-shifting-left', 'is-shifting-right');
  void card.offsetWidth;
  card.classList.add(direction > 0 ? 'is-shifting-right' : 'is-shifting-left');
  window.setTimeout(() => card.classList.remove('is-shifting-left', 'is-shifting-right'), 260);
}

function populatePickerMonthOptions() {
  const currentYear = new Date().getFullYear();
  const pickerYears = new Set([currentYear]);
  for (let year = currentYear - 6; year <= currentYear + 3; year += 1) pickerYears.add(year);
  for (const salary of state.salaries) {
    const year = Number(salary.monthKey.slice(0, 4));
    if (Number.isInteger(year)) pickerYears.add(year);
  }
  const selectedYear = Number(state.salaryMonth.slice(0, 4));
  pickerYears.add(selectedYear);

  $('pickerYearSelect').innerHTML = [...pickerYears]
    .sort((a, b) => a - b)
    .map(year => `<option value="${year}">${year}</option>`)
    .join('');
  $('pickerMonthSelect').innerHTML = MONTH_NAMES
    .map((name, index) => `<option value="${String(index + 1).padStart(2, '0')}">${escapeHTML(name)}</option>`)
    .join('');
}

function openMonthPicker() {
  if (!state.ready) return;
  populatePickerMonthOptions();
  $('pickerYearSelect').value = state.salaryMonth.slice(0, 4);
  $('pickerMonthSelect').value = state.salaryMonth.slice(5, 7);
  openDialog($('monthPickerSheet'));
  $('pickerMonthSelect').focus();
}

function closeMonthPicker() {
  closeDialog($('monthPickerSheet'));
}

function handleMonthPickerSubmit(event) {
  event.preventDefault();
  const target = `${$('pickerYearSelect').value}-${$('pickerMonthSelect').value}`;
  closeMonthPicker();
  setSalaryMonth(target);
}

function shiftSavingsMonth(delta) {
  state.savingsMonth = shiftMonth(state.savingsMonth, delta);
  renderSavingsTotal({
    groups: groupSavingsByMonth(state.savings),
    total: sumSavings(state.savings),
    currentKey: currentMonthKey()
  });
  writeRoute('replace');
}

function selectSavingsTab(tab) {
  if (tab !== 'month' && tab !== 'total') return;
  if (state.savingsTab === tab) return;
  state.savingsTab = tab;
  renderSavingsTab();
  writeRoute('push');
}

function readRoute() {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/');
  const view = VIEWS.includes(parts[0]) ? parts[0] : 'dashboard';
  const month = value => isMonthKey(value) ? value : currentMonthKey();
  return {
    view,
    financeMonth: view === 'dashboard' ? month(parts[1]) : state.financeMonth,
    salaryMonth: view === 'salary' ? month(parts[1]) : state.salaryMonth,
    savingsTab: view === 'savings' && parts[1] === 'total' ? 'total' : 'month',
    savingsMonth: view === 'savings' ? month(parts[2]) : state.savingsMonth
  };
}

function routeUrl() {
  const route = state.view === 'dashboard'
    ? `#/dashboard/${state.financeMonth}`
    : state.view === 'salary'
      ? `#/salary/${state.salaryMonth}`
      : state.view === 'savings'
        ? `#/savings/${state.savingsTab}/${state.savingsMonth}`
        : '#/expenses';
  return `${window.location.pathname}${window.location.search}${route}`;
}

function writeRoute(mode = 'replace') {
  const url = routeUrl();
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (url === current) return;
  if (mode === 'push') window.history.pushState({ spendly: true }, '', url);
  else window.history.replaceState({ spendly: true }, '', url);
}

function restoreRouteFromLocation() {
  const route = readRoute();
  state.financeMonth = route.financeMonth;
  state.salaryMonth = route.salaryMonth;
  state.savingsTab = route.savingsTab;
  state.savingsMonth = route.savingsMonth;
  showView(route.view, { historyMode: 'none', focus: true });
}

function applyLaunchParams() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  const action = params.get('action');

  if (view === 'history') showView('expenses', { historyMode: 'replace', focus: false });
  else if (VIEWS.includes(view)) showView(view, { historyMode: 'replace', focus: false });

  if (action === 'add') openExpenseSheet();
  else if (action === 'add-salary') openSalarySheet();
  else if (action === 'add-saving') openSavingSheet();

  if (view || action) {
    const remaining = new URLSearchParams(window.location.search);
    remaining.delete('view');
    remaining.delete('action');
    const remainingQuery = remaining.toString();
    const search = remainingQuery ? `?${remainingQuery}` : '';
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}${window.location.hash}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Expense form                                                               */
/* -------------------------------------------------------------------------- */

function openExpenseSheet(id = null) {
  if (!state.ready || !state.repo) return;

  const record = id ? state.expenses.find(expense => expense.id === id) : null;
  if (id && !record) {
    showToast('That expense is no longer here.', { tone: 'error' });
    return;
  }

  state.editingExpenseId = record?.id ?? null;
  $('expenseSheetTitle').textContent = record ? 'Edit expense' : 'Add expense';
  $('expenseSheetSub').textContent = record ? 'Changes stay on this device' : 'Saved on this device';
  setExpenseSaving(false, Boolean(record));

  $('expenseForm').reset();
  $('amountInput').value = record ? Number(record.amount).toFixed(2) : '';
  $('descriptionInput').value = record?.description ?? '';
  $('dateInput').value = record?.date ?? localToday();
  $('paidFromSalary').checked = (record?.paymentSource ?? 'salary') === 'salary';
  $('paidFromSavings').checked = record?.paymentSource === 'savings';
  $('paidFromOthers').checked = record?.paymentSource === 'others';
  updateExpenseSourceOptions(record);
  clearExpenseErrors();
  syncQuickDates();

  const sheet = $('expenseSheet');
  openDialog(sheet);
  $('expenseSheet').querySelector('.sheet__body').scrollTop = 0;

  if (!record) {
    $('amountInput').focus();
    $('amountInput').select();
  }
}

function updateExpenseSourceOptions(record = state.expenses.find(item => item.id === state.editingExpenseId) ?? null) {
  const activeSalary = findActiveSalary(state.salaries);
  const salaryPool = activeSalary ? computeSalaryPool(activeSalary, state.expenses, state.savings) : null;
  const linkedWithdrawal = record ? state.savings.find(item => item.type === 'withdrawal' && item.expenseId === record.id) : null;
  const savingsBalance = computeSavingsBalance(state.savings).balancePaise + Math.round(Number(linkedWithdrawal?.amount ?? 0) * 100);
  $('salaryAvailableLabel').textContent = salaryPool
    ? `${formatMoney(salaryPool.remaining)} available`
    : 'No salary pool';
  $('savingsAvailableLabel').textContent = `${formatMoney(fromPaise(savingsBalance))} available`;
  $('paidFromSalary').disabled = !activeSalary && !(record?.salaryRecordId);
}

function closeExpenseSheet() {
  closeDialog($('expenseSheet'));
}

async function handleExpenseSubmit(event) {
  event.preventDefault();
  if (state.savingExpense || !state.repo) return;

  clearExpenseErrors();
  const editingId = state.editingExpenseId;
  const wasEditing = Boolean(editingId);
  const checked = validateExpenseInput({
    amount: $('amountInput').value,
    description: $('descriptionInput').value,
    date: $('dateInput').value,
    paymentSource: $('paidFromSavings').checked ? 'savings' : $('paidFromOthers').checked ? 'others' : 'salary'
  });

  if (!checked.ok) {
    showExpenseErrors(checked.errors);
    return;
  }

  state.savingExpense = true;
  setExpenseSaving(true, wasEditing);
  const session = $('expenseSheet').dataset.session;
  const expenseInput = { ...checked.value, paymentSource: $('paidFromSavings').checked ? 'savings' : $('paidFromOthers').checked ? 'others' : 'salary' };

  try {
    if (wasEditing) await state.ledgerRepo.updateExpense(editingId, expenseInput);
    else await state.ledgerRepo.createExpense(expenseInput);

    await refreshAll();
    // Only close the sheet the save came from; a fast second tap may have reopened it.
    if (isSameDialogSession($('expenseSheet'), session)) closeExpenseSheet();
    render();
    showToast(wasEditing ? 'Expense updated' : expenseInput.paymentSource === 'others' ? 'Expense recorded under Others' : expenseInput.paymentSource === 'savings' ? 'Expense added using Savings' : 'Expense added successfully', { tone: 'success' });
  } catch (error) {
    if (error instanceof ValidationError) {
      showExpenseErrors(error.errors);
    } else if (error instanceof InsufficientSavingsError) {
      $('savingsAvailableLabel').textContent = `${formatMoney(fromPaise(error.availablePaise))} available`;
      showFormError('formError', `Insufficient savings balance. ${formatMoney(fromPaise(error.availablePaise))} is available.`);
      showToast('Insufficient savings balance', { tone: 'warning' });
    } else if (error instanceof NoActiveSalaryError) {
      showFormError('formError', 'No salary pool is available. Choose Savings or add a salary first.');
    } else if (error instanceof NotFoundError) {
      showFormError('formError', 'That expense no longer exists. Close this sheet and try again.');
    } else {
      console.error('Could not save expense:', error);
      showFormError('formError', 'Couldn’t save to this device. Check browser storage and try again.');
    }
  } finally {
    state.savingExpense = false;
    setExpenseSaving(false, wasEditing);
  }
}

function setExpenseSaving(isSaving, wasEditing) {
  $('saveButton').disabled = isSaving;
  $('saveButton').setAttribute('aria-busy', String(isSaving));
  $('saveButton').textContent = isSaving
    ? 'Saving…'
    : (wasEditing ? 'Update expense' : 'Save expense');
}

function clearExpenseErrors() {
  $('formError').hidden = true;
  $('formError').textContent = '';
  for (const name of Object.keys(EXPENSE_FIELDS)) {
    const input = $(EXPENSE_FIELDS[name]);
    const error = $(`${name}Error`);
    if (input) input.removeAttribute('aria-invalid');
    if (error) {
      error.hidden = true;
      error.textContent = '';
    }
  }
}

function showExpenseErrors(errors) {
  let first = null;
  for (const [name, message] of Object.entries(errors)) {
    const input = $(EXPENSE_FIELDS[name]);
    const error = $(`${name}Error`);
    if (!input || !error) continue;
    input.setAttribute('aria-invalid', 'true');
    error.textContent = message;
    error.hidden = false;
    if (!first) first = input;
  }
  first?.focus();
}

function showFormError(id, message) {
  const element = $(id);
  element.textContent = message;
  element.hidden = false;
}

function clearFieldGroup(fields) {
  for (const [inputId, errorId] of Object.values(fields)) {
    const input = $(inputId);
    const error = $(errorId);
    if (input) input.removeAttribute('aria-invalid');
    if (error) {
      error.hidden = true;
      error.textContent = '';
    }
  }
}

function showFieldGroupErrors(fields, errors) {
  let first = null;
  for (const [name, message] of Object.entries(errors)) {
    const pair = fields[name];
    if (!pair) continue;
    const [inputId, errorId] = pair;
    const input = $(inputId);
    const error = $(errorId);
    if (!input || !error) continue;
    input.setAttribute('aria-invalid', 'true');
    error.textContent = message;
    error.hidden = false;
    if (!first) first = input;
  }
  first?.focus();
}

function syncQuickDates() {
  const value = $('dateInput').value;
  const today = localToday();
  const yesterday = toISODate(addDays(new Date(), -1));
  document.querySelectorAll('[data-quick-date]').forEach(button => {
    const expected = button.dataset.quickDate === 'today' ? today : yesterday;
    button.setAttribute('aria-pressed', String(value === expected));
  });
}

/* -------------------------------------------------------------------------- */
/* Salary form                                                                */
/* -------------------------------------------------------------------------- */

function populateMonthOptions() {
  const currentYear = new Date().getFullYear();
  const years = [];
  for (let year = currentYear - 6; year <= currentYear + 3; year += 1) years.push(year);

  $('salaryYearSelect').innerHTML = years
    .map(year => `<option value="${year}">${year}</option>`)
    .join('');
  $('salaryMonthSelect').innerHTML = MONTH_NAMES
    .map((name, index) => `<option value="${String(index + 1).padStart(2, '0')}">${escapeHTML(name)}</option>`)
    .join('');
}

function setSalaryMonthSelects(monthKey) {
  const year = monthKey.slice(0, 4);
  if (![...$('salaryYearSelect').options].some(option => option.value === year)) {
    const option = document.createElement('option');
    option.value = year;
    option.textContent = year;
    $('salaryYearSelect').appendChild(option);
  }
  $('salaryYearSelect').value = year;
  $('salaryMonthSelect').value = monthKey.slice(5, 7);
}

function readSalaryMonthKey() {
  return `${$('salaryYearSelect').value}-${$('salaryMonthSelect').value}`;
}

function openSalarySheet(id = null, monthKey = state.salaryMonth) {
  if (!state.ready || !state.salaryRepo) return;

  const record = id ? state.salaries.find(item => item.id === id) : null;
  if (id && !record) {
    showToast('That salary record is no longer here.', { tone: 'error' });
    return;
  }

  state.editingSalaryId = record?.id ?? null;
  $('salarySheetTitle').textContent = record ? 'Edit salary' : 'Add salary';
  $('salarySheetSub').textContent = record ? 'Changes stay on this device' : 'One record per month';
  setSalarySaving(false, Boolean(record));

  $('salaryForm').reset();
  $('salaryAmountInput').value = record ? Number(record.amount).toFixed(2) : '';
  setSalaryMonthSelects(record?.monthKey ?? (monthKey || currentMonthKey()));
  $('salaryNotesInput').value = record?.notes ?? '';
  clearSalaryErrors();

  const sheet = $('salarySheet');
  openDialog(sheet);
  sheet.querySelector('.sheet__body').scrollTop = 0;

  if (!record) {
    $('salaryAmountInput').focus();
    $('salaryAmountInput').select();
  }
}

function closeSalarySheet() {
  closeDialog($('salarySheet'));
}

function clearSalaryErrors() {
  $('salaryFormError').hidden = true;
  $('salaryFormError').textContent = '';
  clearFieldGroup(SALARY_FIELDS);
}

async function handleSalarySubmit(event) {
  event.preventDefault();
  if (state.savingSalary || !state.salaryRepo) return;

  clearSalaryErrors();
  const editingId = state.editingSalaryId;
  const wasEditing = Boolean(editingId);
  const previousActiveSalary = wasEditing ? null : findActiveSalary(state.salaries);
  const input = {
    amount: $('salaryAmountInput').value,
    monthKey: readSalaryMonthKey(),
    notes: $('salaryNotesInput').value
  };

  if (!isMonthKey(input.monthKey)) {
    showFieldGroupErrors(SALARY_FIELDS, { monthKey: 'Choose a valid month.' });
    return;
  }

  state.savingSalary = true;
  setSalarySaving(true, wasEditing);
  const session = $('salarySheet').dataset.session;

  try {
    const saved = wasEditing
      ? await state.salaryRepo.update(editingId, input)
      : await state.salaryRepo.create(input);

    await refreshAll();
    state.salaryMonth = input.monthKey;
    state.financeMonth = input.monthKey;
    writeRoute('replace');
    if (isSameDialogSession($('salarySheet'), session)) closeSalarySheet();
    render();
    showToast(wasEditing ? 'Salary updated.' : 'Salary saved.');
    if (!wasEditing && previousActiveSalary && previousActiveSalary.id !== saved.id) {
      const pool = computeSalaryPool(previousActiveSalary, state.expenses, state.savings);
      if (pool.remainingPaise > 0) promptSalaryBalanceTransfer(previousActiveSalary, pool.remainingPaise);
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      showFieldGroupErrors(SALARY_FIELDS, error.errors);
    } else if (error instanceof DuplicateMonthError) {
      showFormError('salaryFormError', error.message);
      $('salaryMonthSelect').focus();
    } else if (error instanceof NotFoundError) {
      showFormError('salaryFormError', 'That salary record no longer exists. Close this sheet and try again.');
    } else {
      console.error('Could not save salary:', error);
      showFormError('salaryFormError', 'Couldn’t save to this device. Check browser storage and try again.');
    }
  } finally {
    state.savingSalary = false;
    setSalarySaving(false, wasEditing);
  }
}

function promptSalaryBalanceTransfer(salary, amountPaise) {
  const amount = fromPaise(amountPaise);
  openActionSheet({
    title: 'Move leftover salary to Savings?',
    message: `You have ${formatMoney(amount)} remaining from ${formatMonthKey(salary.monthKey)}. Would you like to move it to Savings?`,
    actions: [
      { label: 'Move to Savings', icon: 'savings', onSelect: () => moveSalaryBalanceToSavings(salary.id) },
      { label: 'Not Now', onSelect: () => { state.dismissedTransferPromptId = salary.id; } }
    ]
  });
}

async function moveSalaryBalanceToSavings(salaryId) {
  try {
    const record = await state.ledgerRepo.transferSalaryBalance(salaryId);
    await refreshAll();
    render();
    showToast(`${formatMoney(record.amount)} moved to Savings.`);
  } catch (error) {
    const message = error instanceof InsufficientSalaryBalanceError
      ? 'There is no positive balance left to transfer.'
      : 'The salary balance could not be moved. No records were changed.';
    showToast(message, { tone: 'error', duration: 7000 });
  }
}

function setSalarySaving(isSaving, wasEditing) {
  $('saveSalaryButton').disabled = isSaving;
  $('saveSalaryButton').setAttribute('aria-busy', String(isSaving));
  $('saveSalaryButton').textContent = isSaving
    ? 'Saving…'
    : (wasEditing ? 'Update salary' : 'Save salary');
}

/* -------------------------------------------------------------------------- */
/* Savings form                                                               */
/* -------------------------------------------------------------------------- */

function defaultSavingDate(monthKey) {
  const today = localToday();
  const bounds = monthBounds(monthKey);
  if (!bounds) return today;
  if (bounds.start > today) return today;
  return bounds.lastDay < today ? bounds.lastDay : today;
}

function openSavingSheet(id = null, options = {}) {
  if (!state.ready || !state.savingsRepo) return;

  const record = id ? state.savings.find(item => item.id === id) : null;
  if (id && !record) {
    showToast('That savings entry is no longer here.', { tone: 'error' });
    return;
  }

  state.editingSavingId = record?.id ?? null;
  $('savingSheetTitle').textContent = record ? 'Edit savings' : 'Add savings';
  $('savingSheetSub').textContent = record ? 'Changes stay on this device' : 'Kept separate from expenses';
  setSavingSaving(false, Boolean(record));

  $('savingForm').reset();
  $('savingAmountInput').value = record ? Number(record.amount).toFixed(2) : '';
  $('savingDateInput').max = localToday();
  $('savingDateInput').value = record?.date ?? defaultSavingDate(options.monthKey ?? state.savingsMonth);
  $('savingDescriptionInput').value = record?.description ?? '';
  $('savingSourceInput').value = record?.sourceType ?? (record?.type === 'external_contribution' ? 'other' : 'salary');
  $('savingSourceInput').disabled = record?.type === 'salary_balance_transfer';
  updateSavingSourceHint();
  clearSavingErrors();

  const sheet = $('savingSheet');
  openDialog(sheet);
  sheet.querySelector('.sheet__body').scrollTop = 0;

  if (!record) {
    $('savingAmountInput').focus();
    $('savingAmountInput').select();
  }
}

function closeSavingSheet() {
  closeDialog($('savingSheet'));
}

function clearSavingErrors() {
  $('savingFormError').hidden = true;
  $('savingFormError').textContent = '';
  clearFieldGroup(SAVING_FIELDS);
}

async function handleSavingSubmit(event) {
  event.preventDefault();
  if (state.savingEntry || !state.savingsRepo) return;

  clearSavingErrors();
  const editingId = state.editingSavingId;
  const wasEditing = Boolean(editingId);
  const input = {
    amount: $('savingAmountInput').value,
    date: $('savingDateInput').value,
    description: $('savingDescriptionInput').value,
    sourceType: $('savingSourceInput').value
  };

  state.savingEntry = true;
  setSavingSaving(true, wasEditing);
  const session = $('savingSheet').dataset.session;

  try {
    const saved = wasEditing
      ? await state.ledgerRepo.updateSaving(editingId, input)
      : input.sourceType === 'salary'
        ? await state.ledgerRepo.createContribution(input)
        : await state.ledgerRepo.createExternalContribution(input);

    await refreshAll();
    if (saved?.monthKey) state.savingsMonth = saved.monthKey;
    writeRoute('replace');
    if (isSameDialogSession($('savingSheet'), session)) closeSavingSheet();
    render();
    showToast(wasEditing ? 'Savings updated' : input.sourceType === 'salary' ? 'Salary contribution saved' : `${input.sourceType[0].toUpperCase()}${input.sourceType.slice(1)} added to savings`, { tone: 'success' });
  } catch (error) {
    if (error instanceof ValidationError) {
      showFieldGroupErrors(SAVING_FIELDS, error.errors);
    } else if (error instanceof NoActiveSalaryError) {
      showFormError('savingFormError', 'Add a salary first. Savings contributions are allocated to the active salary balance.');
    } else if (error instanceof InsufficientSalaryBalanceError) {
      const amount = error.availablePaise === null ? null : formatMoney(fromPaise(error.availablePaise));
      showFormError('savingFormError', amount ? `Insufficient balance. You have ${amount} available from salary and extra income.` : error.message);
      showToast('Insufficient salary and extra income balance', { tone: 'warning' });
    } else if (error instanceof InsufficientSalaryBalanceError) {
      showFormError('savingFormError', 'Insufficient salary balance for this contribution.');
      showToast('Insufficient salary balance', { tone: 'warning' });
    } else if (error instanceof NotFoundError) {
      showFormError('savingFormError', 'That savings entry no longer exists. Close this sheet and try again.');
    } else {
      console.error('Could not save savings:', error);
      showFormError('savingFormError', 'Couldn’t save to this device. Check browser storage and try again.');
      showToast('Unable to save savings', { tone: 'error' });
    }
  } finally {
    state.savingEntry = false;
    setSavingSaving(false, wasEditing);
  }
}

function setSavingSaving(isSaving, wasEditing) {
  $('saveSavingButton').disabled = isSaving;
  $('saveSavingButton').setAttribute('aria-busy', String(isSaving));
  $('saveSavingButton').textContent = isSaving
    ? 'Saving…'
    : (wasEditing ? 'Update savings' : 'Save savings');
}

function updateSavingSourceHint() {
  const salary = $('savingSourceInput').value === 'salary';
  const salaryRemaining = findActiveSalary(state.salaries)
    ? Math.max(0, computeSalaryPool(findActiveSalary(state.salaries), state.expenses, state.savings).remaining)
    : 0;
  const extraRemaining = state.extraIncome.reduce((sum, item) => sum + extraIncomeRemaining(item, state.savings), 0);
  $('savingSourceHint').textContent = salary
    ? `Salary is used first, then extra income. ${formatMoney(salaryRemaining + extraRemaining)} available.`
    : 'This adds to Savings without changing your salary balance.';
}

/* -------------------------------------------------------------------------- */
/* Row actions, delete and undo                                               */
/* -------------------------------------------------------------------------- */

function openExpenseActions(id) {
  const expense = state.expenses.find(item => item.id === id);
  if (!expense) {
    showToast('That expense is no longer here.', { tone: 'error' });
    return;
  }

  openActionSheet({
    title: expense.description,
    message: `${formatDate(expense.date)} · ${formatMoney(expense.amount)}`,
    actions: [
      { label: 'Edit expense', icon: 'pencil', onSelect: () => openExpenseSheet(expense.id) },
      { label: 'Delete expense', icon: 'trash', tone: 'danger', onSelect: () => deleteExpense(expense.id) }
    ]
  });
}

async function deleteExpense(id) {
  const expense = state.expenses.find(item => item.id === id);
  if (!expense || !state.ledgerRepo) return;

  try {
    await state.ledgerRepo.removeExpense(id);
    await refreshAll();
    render();
    showToast(`“${truncate(expense.description, 34)}” deleted.`, {
      actionLabel: 'Undo',
      duration: 7000,
      onAction: async () => {
        await state.ledgerRepo.restoreExpense(expense);
        await refreshAll();
        render();
        showToast('Expense restored.');
      }
    });
  } catch (error) {
    console.error('Could not delete expense:', error);
    showToast('Couldn’t delete that expense. It is still saved.', { tone: 'error', duration: 6000 });
  }
}

function openSalaryActions(id) {
  const record = state.salaries.find(item => item.id === id);
  if (!record) {
    showToast('That salary record is no longer here.', { tone: 'error' });
    return;
  }

  openActionSheet({
    title: formatMonthKey(record.monthKey),
    message: `${formatMoney(record.amount)}${record.notes ? ` · ${record.notes}` : ''}`,
    actions: [
      { label: 'Edit salary', icon: 'pencil', onSelect: () => openSalarySheet(record.id) },
      {
        label: 'Remove salary',
        icon: 'trash',
        tone: 'danger',
        onSelect: () => confirmDeleteSalary(record)
      }
    ]
  });
}

function confirmDeleteSalary(record) {
  openActionSheet({
    title: 'Remove this salary?',
    message: `The ${formatMonthKey(record.monthKey)} salary pool can only be removed when no expenses or savings are allocated to it.`,
    actions: [{
      label: 'Remove salary',
      icon: 'trash',
      tone: 'danger',
      onSelect: () => deleteSalary(record)
    }]
  });
}

async function deleteSalary(record) {
  if (!state.ledgerRepo || !state.salaryRepo) return;
  try {
    await state.ledgerRepo.deleteSalaryIfUnused(record.id);
    await refreshAll();
    render();
    showToast(`Salary for ${formatMonthKey(record.monthKey)} removed.`, {
      actionLabel: 'Undo',
      duration: 7000,
      onAction: async () => {
        await state.salaryRepo.restore(record);
        await refreshAll();
        render();
        showToast('Salary restored.');
      }
    });
  } catch (error) {
    if (error instanceof ReferencedSalaryError) {
      showToast(error.message, { tone: 'error', duration: 7000 });
      return;
    }
    console.error('Could not remove salary:', error);
    showToast('Couldn’t remove that salary. It is still saved.', { tone: 'error', duration: 6000 });
  }
}

function openSavingActions(id) {
  const record = state.savings.find(item => item.id === id);
  if (!record) {
    showToast('That savings entry is no longer here.', { tone: 'error' });
    return;
  }

  const type = record.type ?? 'contribution';
  if (type === 'withdrawal') {
    showToast('This withdrawal follows its linked expense. Edit or delete that expense to change it.');
    return;
  }

  openActionSheet({
    title: record.description || (type === 'salary_balance_transfer' ? 'Salary balance transfer' : 'Savings contribution'),
    message: `${formatDate(record.date)} · ${formatMoney(record.amount)}`,
    actions: [
      { label: 'Edit savings', icon: 'pencil', onSelect: () => openSavingSheet(record.id) },
      {
        label: 'Delete savings',
        icon: 'trash',
        tone: 'danger',
        onSelect: () => confirmDeleteSaving(record)
      }
    ]
  });
}

function confirmDeleteSaving(record) {
  openActionSheet({
    title: 'Delete this savings entry?',
    message: `${formatMoney(record.amount)} saved on ${formatDate(record.date)} will be removed from your savings. You can undo straight after.`,
    actions: [{
      label: 'Delete savings',
      icon: 'trash',
      tone: 'danger',
      onSelect: () => deleteSaving(record)
    }]
  });
}

async function deleteSaving(record) {
  if (!state.ledgerRepo) return;
  try {
    await state.ledgerRepo.removeSaving(record.id);
    await refreshAll();
    render();
    showToast('Savings entry deleted.', {
      actionLabel: 'Undo',
      duration: 7000,
      onAction: async () => {
        await state.ledgerRepo.restoreSaving(record);
        await refreshAll();
        render();
        showToast('Savings entry restored.');
      }
    });
  } catch (error) {
    if (error instanceof InsufficientSavingsError) {
      showToast(`This transfer cannot be removed because only ${formatMoney(fromPaise(error.availablePaise))} remains in Savings.`, { tone: 'error', duration: 7000 });
      return;
    }
    console.error('Could not delete savings:', error);
    showToast('Couldn’t delete that entry. It is still saved.', { tone: 'error', duration: 6000 });
  }
}

/* -------------------------------------------------------------------------- */
/* Data management                                                            */
/* -------------------------------------------------------------------------- */

function csvCell(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportCsv() {
  const rows = [
    ['Date', 'Description', 'Amount (INR)', 'Paid From'],
    ...sortExpenses(state.expenses).map(expense => [
      expense.date,
      expense.description,
      Number(expense.amount).toFixed(2),
      expense.paymentSource === 'savings' ? 'Savings' : expense.paymentSource === 'others' ? 'Others' : expense.salaryRecordId ? 'Salary' : 'Needs review'
    ])
  ];
  const csv = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  downloadBlob(
    new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }),
    `spendly-expenses-${localToday()}.csv`
  );
  showToast('CSV downloaded.');
}

function exportSalaryCsv() {
  const rows = [
    ['Month', 'Salary (INR)', 'Expenses (INR)', 'Savings from salary (INR)', 'Remaining (INR)'],
    ...[...state.salaries].sort((a, b) => a.monthKey.localeCompare(b.monthKey)).map(salary => {
      const pool = computeSalaryPool(salary, state.expenses, state.savings);
      return [
        formatMonthKey(salary.monthKey),
        Number(salary.amount).toFixed(2),
        pool.expenseTotal.toFixed(2),
        fromPaise(pool.contributionPaise + pool.transferPaise).toFixed(2),
        pool.remaining.toFixed(2)
      ];
    })
  ];
  const csv = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  downloadBlob(
    new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }),
    `spendly-salary-summary-${localToday()}.csv`
  );
  showToast('Salary summary downloaded.');
}

function snapshotData() {
  return {
    expenses: state.expenses.map(record => ({ ...record })),
    salaries: state.salaries.map(record => ({ ...record })),
    savings: state.savings.map(record => ({ ...record })),
    extraIncome: state.extraIncome.map(record => ({ ...record }))
  };
}

function backupPayload(data = snapshotData()) {
  return {
    app: 'Spendly',
    version: 5,
    exportedAt: new Date().toISOString(),
    expenses: sortExpenses(data.expenses ?? []),
    salaries: [...(data.salaries ?? [])],
    savings: [...(data.savings ?? [])],
    extraIncome: [...(data.extraIncome ?? [])]
  };
}

function downloadBackup(filename = `spendly-backup-${localToday()}.json`, data = snapshotData()) {
  downloadBlob(
    new Blob([JSON.stringify(backupPayload(data), null, 2)], { type: 'application/json' }),
    filename
  );
}

function generateImportId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `sp_import_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function applyBackup(data) {
  await state.ledgerRepo.replaceCollections({
    expenses: data.expenses ?? [],
    salaries: data.salaries ?? [],
    savings: data.savings ?? [],
    ...(Array.isArray(data.extraIncome) ? { extraIncome: data.extraIncome } : {})
  });
}

async function handleRestoreFile(file) {
  if (!file) return;

  try {
    if (file.size > 10 * 1024 * 1024) {
      showToast('That file is too large to be a Spendly backup.', { tone: 'error', duration: 6000 });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      showToast('That file isn’t valid JSON. Nothing was changed.', { tone: 'error', duration: 7000 });
      return;
    }

    const candidate = Array.isArray(parsed) ? parsed : parsed?.expenses;
    if (!Array.isArray(candidate)) {
      showToast('That file doesn’t contain a Spendly backup. Nothing was changed.', { tone: 'error', duration: 7000 });
      return;
    }

    const options = { now: () => new Date(), makeId: generateImportId };
    const checkedExpenses = candidate.map(record => normalizeExpenseRecord(record, options));
    const checkedSalaries = Array.isArray(parsed?.salaries)
      ? parsed.salaries.map(record => normalizeSalaryRecord(record, options))
      : null;
    const checkedSavings = Array.isArray(parsed?.savings)
      ? parsed.savings.map(record => normalizeSavingRecord(record, options))
      : null;
    const checkedExtraIncome = Array.isArray(parsed?.extraIncome) ? parsed.extraIncome.map(record => normalizeSavingRecord(record, options)) : null;

    const invalid = [
      ...checkedExpenses.filter(result => !result.ok),
      ...(checkedSalaries ?? []).filter(result => !result.ok),
      ...(checkedSavings ?? []).filter(result => !result.ok),
      ...(checkedExtraIncome ?? []).filter(result => !result.ok)
    ].length;
    if (invalid) {
      showToast(
        `That backup has ${invalid} unreadable record${invalid === 1 ? '' : 's'}. Nothing was changed.`,
        { tone: 'error', duration: 8000 }
      );
      return;
    }

    const salaries = checkedSalaries ? checkedSalaries.map(result => result.value) : null;
    if (salaries) {
      const months = new Set(salaries.map(record => record.monthKey));
      if (months.size !== salaries.length) {
        showToast('That backup has two salaries for the same month. Nothing was changed.', { tone: 'error', duration: 8000 });
        return;
      }
    }

    const records = checkedExpenses.map(result => result.value);
    const savings = checkedSavings ? checkedSavings.map(result => result.value) : null;
    const extraIncome = checkedExtraIncome ? checkedExtraIncome.map((result, index) => ({ ...result.value, source: parsed.extraIncome[index]?.source ?? 'other' })) : null;
    const uniqueIds = new Set(records.map(record => record.id));
    const countLabel = expenseWord(uniqueIds.size);
    const currentCount = expenseWord(state.expenses.length);
    const snapshot = snapshotData();
    const financeNote = salaries || savings || extraIncome
      ? ` Salary, savings${extraIncome ? ' and extra income' : ''} in this file replace the matching data on this device.`
      : ' Your salary, savings and extra income stay as they are.';

    openActionSheet({
      title: 'Restore this backup?',
      message: `This replaces the ${currentCount} on this device with ${countLabel} from “${file.name}”.${financeNote} A safety copy downloads first, and you can undo this restore straight away.`,
      actions: [
        {
          label: `Replace with ${countLabel}`,
          icon: 'upload',
          tone: 'danger',
          onSelect: async () => {
            try {
              downloadBackup(`spendly-before-restore-${localToday()}.json`, snapshot);
            } catch (error) {
              console.error('Could not create the safety backup:', error);
              showToast('A safety copy could not be downloaded, so nothing was replaced.', { tone: 'error', duration: 7000 });
              return;
            }

            try {
              const result = await state.ledgerRepo.replaceCollections({
                expenses: records,
                ...(salaries ? { salaries } : {}),
                ...(savings ? { savings } : {}),
                ...(extraIncome ? { extraIncome } : {})
              });
              await refreshAll();
              render();
              showView('expenses');
              showToast(`Backup restored — ${expenseWord(result.expenseCount)}.`, {
                actionLabel: 'Undo',
                duration: 9000,
                onAction: async () => {
                  await applyBackup(snapshot);
                  await refreshAll();
                  render();
                  showView('expenses');
                  showToast('Your previous data is back.');
                }
              });
            } catch (error) {
              console.error('Could not restore backup:', error);
              try {
                await applyBackup(snapshot);
                await refreshAll();
                render();
              } catch (rollbackError) {
                console.error('Could not roll back the partial restore:', rollbackError);
              }
              showToast('That backup couldn’t be saved. Your existing data was not changed.', {
                tone: 'error',
                duration: 8000
              });
            }
          }
        }
      ]
    });
  } finally {
    $('fileInput').value = '';
  }
}

/* -------------------------------------------------------------------------- */
/* Toast                                                                      */
/* -------------------------------------------------------------------------- */

function showToast(message, options = {}) {
  const { tone = 'success', actionLabel = null, onAction = null } = options;
  const duration = options.duration ?? (actionLabel ? 7000 : tone === 'error' || tone === 'warning' ? 4500 : tone === 'info' ? 3000 : 2800);
  const toast = $('toast');

  if (!toast.hidden && $('toastMessage').textContent === message && toast.dataset.tone === tone) return;

  window.clearTimeout(state.toastTimer);
  toast.dataset.tone = tone;
  toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  toast.hidden = false;
  $('toastMessage').textContent = message;
  toast.querySelector('.toast__icon use').setAttribute('href', tone === 'error' ? '#i-x' : tone === 'warning' || tone === 'info' ? '#i-info' : '#i-check');

  const action = $('toastAction');
  action.hidden = !actionLabel;
  action.textContent = actionLabel ?? '';
  action.onclick = actionLabel
    ? async () => {
        const callback = onAction;
        hideToast();
        if (!callback) return;
        try {
          await callback();
        } catch (error) {
          console.error('Toast action failed:', error);
          showToast('That action could not be completed.', { tone: 'error' });
        }
      }
    : null;

  $('toastDismiss').onclick = hideToast;

  state.toastTimer = window.setTimeout(hideToast, duration);
}

function hideToast() {
  window.clearTimeout(state.toastTimer);
  const toast = $('toast');
  toast.hidden = true;
  toast.querySelector('.toast__icon use').setAttribute('href', '#i-check');
  const action = $('toastAction');
  action.hidden = true;
  action.onclick = null;
  $('toastDismiss').onclick = null;
}

/* -------------------------------------------------------------------------- */
/* Action sheet and dialogs                                                   */
/* -------------------------------------------------------------------------- */

function openActionSheet({ title, message, actions }) {
  const sheet = $('actionSheet');
  if (sheet.open) sheet.close();

  $('actionTitle').textContent = title;
  $('actionMessage').textContent = message ?? '';
  $('actionMessage').hidden = !message;

  const list = $('actionList');
  list.replaceChildren();
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `action__item${action.tone === 'danger' ? ' action__item--danger' : ''}`;
    button.innerHTML = `${action.icon ? ICON(action.icon) : ''}<span>${escapeHTML(action.label)}</span>`;
    button.addEventListener('click', async () => {
      sheet.close();
      syncScrollLock();
      try {
        await action.onSelect?.();
      } catch (error) {
        console.error('Action failed:', error);
        showToast('That action could not be completed.', { tone: 'error' });
      }
    }, { once: true });
    list.appendChild(button);
  }

  openDialog(sheet);
  $('actionCancel').focus();
}

function closeDialog(dialog) {
  if (!dialog.open || dialog.dataset.closing === '1') return;
  dialog.dataset.closing = '1';
  const finish = () => {
    dialog._closeTimer = 0;
    if (dialog.open) dialog.close();
  };

  if (prefersReducedMotion()) {
    finish();
    return;
  }

  dialog.classList.add('is-closing');
  dialog._closeTimer = window.setTimeout(finish, 210);
}

/**
 * Show a dialog, cancelling any close animation still in flight. Without this,
 * reopening a sheet during its 210 ms close leaves it translated off-screen with
 * `is-closing` applied, and the pending timer closes it again right after.
 */
let dialogSession = 0;

function openDialog(dialog) {
  window.clearTimeout(dialog._closeTimer);
  dialog._closeTimer = 0;
  const wasClosing = dialog.open &&
    (dialog.dataset.closing === '1' || dialog.classList.contains('is-closing'));
  delete dialog.dataset.closing;
  dialog.classList.remove('is-closing');

  if (wasClosing) {
    // The close animation uses `animation-fill-mode: forwards`, so a dialog
    // reopened mid-close stays parked off-screen. Replaying showModal() restarts
    // the open animation from a clean state.
    dialog.close();
  }
  if (!dialog.open) dialog.showModal();

  dialog.dataset.session = String(++dialogSession);
  syncScrollLock();
}

/** True when the sheet has not been reopened since `session` was captured. */
function isSameDialogSession(dialog, session) {
  return dialog.dataset.session === session;
}

function syncScrollLock() {
  const anyOpen = Boolean(document.querySelector('dialog[open]'));
  document.body.classList.toggle('sheet-open', anyOpen);
}

function setupDialogs() {
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('close', () => {
      window.clearTimeout(dialog._closeTimer);
      dialog._closeTimer = 0;
      dialog.classList.remove('is-closing');
      delete dialog.dataset.closing;
      syncScrollLock();
    });

    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      closeDialog(dialog);
    });

    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const outside = event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom;
      if (outside) closeDialog(dialog);
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Connectivity                                                               */
/* -------------------------------------------------------------------------- */

function updateConnectionUI() {
  const online = navigator.onLine;
  $('connection').dataset.state = online ? 'online' : 'offline';
  $('connectionText').textContent = online
    ? (offlineReady ? 'Available offline' : 'On this device')
    : 'Offline';
  $('connection').title = online
    ? 'Saved on this device — available offline after the first visit'
    : 'Offline — your data is saved on this device';
  $('offlineBanner').hidden = online;
}

function markOfflineReady() {
  offlineReady = true;
  updateConnectionUI();
}

/* -------------------------------------------------------------------------- */
/* Install prompt                                                             */
/* -------------------------------------------------------------------------- */

const isIOSDevice = () => /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches ||
  window.navigator.standalone === true;

function renderInstallPrompt() {
  const card = $('installCard');
  if (!state.ready) {
    card.hidden = true;
    return;
  }

  const eligible = !isStandalone() &&
    !state.installDismissed &&
    hasAnyData() &&
    (Boolean(state.installPrompt) || isIOSDevice());

  card.hidden = !eligible;
  if (!eligible) return;

  const button = $('installButton');
  if (state.installPrompt) {
    $('installTitle').textContent = 'Install Spendly';
    $('installText').textContent = 'Add it to your Home Screen or app list. It opens offline and needs no account.';
    button.hidden = false;
  } else {
    $('installTitle').textContent = 'Keep Spendly on your Home Screen';
    $('installText').textContent = 'In Safari, tap Share, then “Add to Home Screen”.';
    button.hidden = true;
  }
}

function dismissInstallPrompt() {
  state.installDismissed = true;
  writePreference(INSTALL_DISMISSED_KEY);
  $('installCard').hidden = true;
}

/* -------------------------------------------------------------------------- */
/* Preferences                                                                */
/* -------------------------------------------------------------------------- */

function readPreference(key) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writePreference(key) {
  try {
    localStorage.setItem(key, '1');
  } catch {
    // A preference, not data. It is safe to continue without it.
  }
}

/* -------------------------------------------------------------------------- */
/* Service worker                                                             */
/* -------------------------------------------------------------------------- */

function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const localHosts = ['localhost', '127.0.0.1', '[::1]'];
  if (!(window.location.protocol === 'https:' || localHosts.includes(window.location.hostname))) return;

  if (navigator.serviceWorker.controller) markOfflineReady();

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (state.reloading) window.location.reload();
  });

  window.addEventListener('load', () => {
    void registerServiceWorker();
  });
}

async function registerServiceWorker() {
  try {
    const registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    state.registration = registration;
    showUpdateIfWaiting(registration);

    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateIfWaiting(registration);
        }
      });
    });

    navigator.serviceWorker.ready.then(() => {
      markOfflineReady();
      showUpdateIfWaiting(registration);
    }).catch(() => {});
  } catch (error) {
    console.warn('Offline support could not be enabled:', error);
  }
}

function showUpdateIfWaiting(registration) {
  if (registration.waiting && navigator.serviceWorker.controller) {
    state.registration = registration;
    $('updateBanner').hidden = false;
  }
}

function applyUpdate() {
  const registration = state.registration;
  if (registration?.waiting) {
    state.reloading = true;
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    window.setTimeout(() => {
      if (state.reloading) window.location.reload();
    }, 2800);
  } else {
    window.location.reload();
  }
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  window.addEventListener('popstate', restoreRouteFromLocation);

  $('periodTiles').addEventListener('click', event => {
    const tile = event.target.closest('[data-period]');
    if (tile) selectPeriod(tile.dataset.period);
  });

  for (const list of [$('recentList'), $('historyList')]) {
    list.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const edit = target.closest('[data-edit]');
      if (edit) {
        openExpenseSheet(edit.dataset.edit);
        return;
      }

      const menu = target.closest('[data-menu]');
      if (menu) {
        openExpenseActions(menu.dataset.menu);
        return;
      }

      if (target.closest('[data-empty-add]')) {
        openExpenseSheet();
        return;
      }

      if (target.closest('[data-clear-search]')) {
        state.search = '';
        $('search').value = '';
        renderExpensesPage(summarize(state.expenses, new Date()));
        $('search').focus();
        return;
      }

      if (target.closest('[data-clear-review]')) {
        state.reviewExpensesOnly = false;
        renderExpensesPage(summarize(state.expenses, new Date()));
      }
    });
  }

  $('addExpenseButton').addEventListener('click', () => openExpenseSheet());
  $('onboardingAddExpense').addEventListener('click', () => openExpenseSheet());
  $('onboardingAddSavings').addEventListener('click', () => openSavingSheet());
  for (const source of document.querySelectorAll('input[name="paymentSource"]')) {
    source.addEventListener('change', () => updateExpenseSourceOptions());
  }
  $('amountInput').addEventListener('input', () => updateExpenseSourceOptions());
  $('savingSourceInput').addEventListener('change', updateSavingSourceHint);
  $('seeAllButton').addEventListener('click', () => showView('expenses'));
  $('allTimeButton').addEventListener('click', () => showView('expenses'));

  $('dock').addEventListener('click', event => {
    const tab = event.target.closest('[data-view]');
    if (tab) showView(tab.dataset.view);
  });

  document.querySelector('.shortcuts').addEventListener('click', event => {
    const button = event.target.closest('[data-goto]');
    if (button) showView(button.dataset.goto);
  });

  $('financePrevMonth').addEventListener('click', () => shiftFinanceMonth(-1));
  $('financeNextMonth').addEventListener('click', () => shiftFinanceMonth(1));

  $('salaryPrevMonth').addEventListener('click', () => shiftSalaryMonth(-1));
  $('salaryNextMonth').addEventListener('click', () => shiftSalaryMonth(1));
  $('salaryMonthPickerButton').addEventListener('click', openMonthPicker);
  $('salaryCurrentMonth').addEventListener('click', () => setSalaryMonth(currentMonthKey()));
  $('copyPreviousSalaryButton').addEventListener('click', usePreviousSalary);
  $('exportSalaryCsv').addEventListener('click', exportSalaryCsv);

  $('closeMonthPicker').addEventListener('click', closeMonthPicker);
  $('monthPickerForm').addEventListener('submit', handleMonthPickerSubmit);

  // Arrow keys move between months while the navigator has focus.
  $('salaryMonthPickerButton').parentElement.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      shiftSalaryMonth(-1);
      $('salaryMonthPickerButton').focus();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      shiftSalaryMonth(1);
      $('salaryMonthPickerButton').focus();
    }
  });

  $('salaryEditButton').addEventListener('click', () => {
    const record = findSalaryForMonth(state.salaries, state.salaryMonth);
    openSalarySheet(record?.id ?? null, state.salaryMonth);
  });

  $('salaryClearButton').addEventListener('click', () => {
    const record = findSalaryForMonth(state.salaries, state.salaryMonth);
    if (record) confirmDeleteSalary(record);
  });

  $('salaryTransferButton').addEventListener('click', () => {
    const salaryId = $('salaryTransferButton').dataset.salaryTransfer;
    if (salaryId) void moveSalaryBalanceToSavings(salaryId);
  });
  $('salaryTransferLater').addEventListener('click', () => {
    state.dismissedTransferPromptId = $('salaryTransferLater').dataset.salaryTransferLater || null;
    renderSalaryPage();
  });

  $('salaryList').addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const edit = target.closest('[data-salary-edit]');
    if (edit) {
      openSalarySheet(edit.dataset.salaryEdit);
      return;
    }
    const menu = target.closest('[data-salary-menu]');
    if (menu) {
      openSalaryActions(menu.dataset.salaryMenu);
      return;
    }
    if (target.closest('[data-empty-salary]')) openSalarySheet();
  });
  $('addExtraIncomeButton').addEventListener('click', () => openExtraIncomeSheet());
  $('extraIncomeList').addEventListener('click', event => {
    const button = event.target.closest('[data-extra-income-edit]');
    if (button) openExtraIncomeSheet(button.dataset.extraIncomeEdit);
    const remove = event.target.closest('[data-extra-income-delete]');
    if (remove) void removeExtraIncome(remove.dataset.extraIncomeDelete);
  });

  const savingsTablist = $('savingsTabMonth').parentElement;
  savingsTablist.addEventListener('click', event => {
    const tab = event.target.closest('[data-savings-tab]');
    if (tab) selectSavingsTab(tab.dataset.savingsTab);
  });

  savingsTablist.addEventListener('keydown', event => {
    const tabs = [...savingsTablist.querySelectorAll('[data-savings-tab]')];
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;

    let next = null;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next === null) return;

    event.preventDefault();
    selectSavingsTab(tabs[next].dataset.savingsTab);
    tabs[next].focus();
  });

  $('savingsPrevMonth').addEventListener('click', () => shiftSavingsMonth(-1));
  $('savingsNextMonth').addEventListener('click', () => shiftSavingsMonth(1));
  $('addSavingButton').addEventListener('click', () => openSavingSheet());
  $('addSavingTotalButton').addEventListener('click', () => openSavingSheet(null, { monthKey: state.savingsMonth }));

  for (const list of [$('savingsMonthList'), $('savingsTotalMonthList')]) {
    list.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const edit = target.closest('[data-saving-edit]');
      if (edit) {
        openSavingSheet(edit.dataset.savingEdit);
        return;
      }
      const linkedExpense = target.closest('[data-saving-expense]');
      if (linkedExpense) {
        if (linkedExpense.dataset.savingExpense) openExpenseSheet(linkedExpense.dataset.savingExpense);
        return;
      }
      const menu = target.closest('[data-saving-menu]');
      if (menu) {
        openSavingActions(menu.dataset.savingMenu);
        return;
      }
      if (target.closest('[data-empty-saving]')) openSavingSheet();
    });
  }

  $('savingsMonthGroups').addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('[data-empty-saving]')) {
      openSavingSheet();
      return;
    }
    const row = target.closest('[data-savings-month]');
    if (!row) return;
    state.savingsMonth = row.dataset.savingsMonth;
    renderSavingsTotal({
      groups: groupSavingsByMonth(state.savings),
      total: sumSavings(state.savings),
      currentKey: currentMonthKey()
    });
    writeRoute('push');
  });

  $('search').addEventListener('input', event => {
    state.search = event.target.value;
    $('clearSearch').hidden = !normalizeQuery(state.search);
    window.clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(() => {
      renderExpensesPage(summarize(state.expenses, new Date()));
    }, 90);
  });

  $('clearSearch').addEventListener('click', () => {
    state.search = '';
    $('search').value = '';
    $('clearSearch').hidden = true;
    renderExpensesPage(summarize(state.expenses, new Date()));
    $('search').focus();
  });

  $('sourceReviewButton').addEventListener('click', () => {
    state.reviewExpensesOnly = !state.reviewExpensesOnly;
    if (state.reviewExpensesOnly) {
      state.search = '';
      $('search').value = '';
      $('clearSearch').hidden = true;
    }
    renderExpensesPage(summarize(state.expenses, new Date()));
  });

  $('exportCsv').addEventListener('click', exportCsv);
  $('downloadBackup').addEventListener('click', async () => {
    try {
      downloadBackup();
      const recorded = await recordBackupDownload();
      showToast(recorded ? 'Backup downloaded.' : 'Backup downloaded, but its date could not be saved.', {
        tone: recorded ? 'success' : 'warning', duration: recorded ? 2800 : 5000
      });
    } catch (error) {
      console.error('Could not download the backup:', error);
      showToast('Couldn’t download the backup. Try again.', { tone: 'error' });
    }
  });
  $('backupNow').addEventListener('click', () => $('downloadBackup').click());
  $('dismissBackupReminder').addEventListener('click', async () => {
    const until = new Date(Date.now() + 30 * 86400000).toISOString();
    try {
      await state.ledgerRepo.setMetadata('backup:reminder-dismissed-until', until);
      state.backupReminderDismissedUntil = until;
      renderBackupHealth();
    } catch (error) {
      console.error('Could not dismiss the backup reminder:', error);
      showToast('Couldn’t save that reminder setting.', { tone: 'error' });
    }
  });
  $('restoreBackup').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', event => {
    void handleRestoreFile(event.target.files?.[0]);
  });

  $('expenseForm').addEventListener('submit', event => {
    void handleExpenseSubmit(event);
  });
  $('salaryForm').addEventListener('submit', event => {
    void handleSalarySubmit(event);
  });
  $('savingForm').addEventListener('submit', event => {
    void handleSavingSubmit(event);
  });
  $('extraIncomeForm').addEventListener('submit', event => { void saveExtraIncome(event); });

  $('closeExpenseSheet').addEventListener('click', closeExpenseSheet);
  $('closeSalarySheet').addEventListener('click', closeSalarySheet);
  $('closeSavingSheet').addEventListener('click', closeSavingSheet);
  $('closeExtraIncomeSheet').addEventListener('click', () => closeDialog($('extraIncomeSheet')));
  $('actionCancel').addEventListener('click', () => closeDialog($('actionSheet')));

  for (const button of document.querySelectorAll('[data-quick-date]')) {
    button.addEventListener('click', () => {
      $('dateInput').value = button.dataset.quickDate === 'today'
        ? localToday()
        : toISODate(addDays(new Date(), -1));
      setFieldError('date', null);
      syncQuickDates();
    });
  }

  $('dateInput').addEventListener('change', () => {
    setFieldError('date', null);
    $('formError').hidden = true;
    syncQuickDates();
  });

  $('amountInput').addEventListener('input', () => {
    setFieldError('amount', null);
    $('formError').hidden = true;
  });
  $('descriptionInput').addEventListener('input', () => {
    setFieldError('description', null);
    $('formError').hidden = true;
  });

  for (const [inputId, errorId] of Object.values(SALARY_FIELDS)) {
    $(inputId).addEventListener('input', () => {
      $(errorId).hidden = true;
      $(inputId).removeAttribute('aria-invalid');
      $('salaryFormError').hidden = true;
    });
    $(inputId).addEventListener('change', () => {
      $(errorId).hidden = true;
      $(inputId).removeAttribute('aria-invalid');
      $('salaryFormError').hidden = true;
    });
  }

  for (const [inputId, errorId] of Object.values(SAVING_FIELDS)) {
    $(inputId).addEventListener('input', () => {
      $(errorId).hidden = true;
      $(inputId).removeAttribute('aria-invalid');
      $('savingFormError').hidden = true;
    });
    $(inputId).addEventListener('change', () => {
      $(errorId).hidden = true;
      $(inputId).removeAttribute('aria-invalid');
      $('savingFormError').hidden = true;
    });
  }

  $('installClose').addEventListener('click', dismissInstallPrompt);
  $('installButton').addEventListener('click', async () => {
    const prompt = state.installPrompt;
    if (!prompt) return;
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch (error) {
      console.warn('Install prompt was not available:', error);
    } finally {
      state.installPrompt = null;
      dismissInstallPrompt();
      renderInstallPrompt();
    }
  });

  $('reloadButton').addEventListener('click', () => window.location.reload());
  $('updateButton').addEventListener('click', applyUpdate);

  window.addEventListener('online', () => {
    updateConnectionUI();
    if (state.ready) {
      showToast('You’re back online. Everything is still saved on this device.');
    }
  });

  window.addEventListener('offline', updateConnectionUI);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    updateConnectionUI();
    if (state.ready) render();
    if (!navigator.onLine) return;
    const now = Date.now();
    if (state.registration && now - state.lastUpdateCheck > 300000) {
      state.lastUpdateCheck = now;
      state.registration.update().catch(() => {});
    }
  });

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    state.installPrompt = event;
    renderInstallPrompt();
  });

  window.addEventListener('appinstalled', () => {
    state.installPrompt = null;
    dismissInstallPrompt();
  });

  window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', renderInstallPrompt);
}

function setFieldError(name, message) {
  const input = $(EXPENSE_FIELDS[name]);
  const error = $(`${name}Error`);
  if (!input || !error) return;

  if (message) {
    input.setAttribute('aria-invalid', 'true');
    error.textContent = message;
    error.hidden = false;
  } else {
    input.removeAttribute('aria-invalid');
    error.textContent = '';
    error.hidden = true;
  }
}

