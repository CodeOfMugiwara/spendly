/**
 * Spendly UI.
 *
 * All persistence goes through ExpenseRepository; this file never touches
 * IndexedDB directly. That keeps the interface replaceable and leaves a clean
 * seam for a future remote adapter.
 */

import {
  PERIODS,
  addDays,
  expenseWord,
  formatDate,
  formatMoney,
  formatMoneyParts,
  formatMonth,
  groupExpensesByMonth,
  localToday,
  matchesQuery,
  normalizeExpenseRecord,
  normalizeQuery,
  relativeDayLabel,
  sortExpenses,
  summarize,
  toISODate,
  validateExpenseInput
} from './core.js';
import { openExpenseDB, IndexedDBExpenseStore } from './db.js';
import { ExpenseRepository, NotFoundError, ValidationError } from './repository.js';

const $ = id => document.getElementById(id);
const ICON = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const INSTALL_DISMISSED_KEY = 'spendly_install_tip_dismissed_v1';
const AVATAR_TINTS = ['#e8f3ec', '#f1f0e2', '#e8eef3', '#f4ebe5', '#edf2e6'];
const FIELD_INPUTS = {
  amount: 'amountInput',
  description: 'descriptionInput',
  date: 'dateInput'
};

let offlineReady = Boolean(navigator.serviceWorker?.controller);

const state = {
  repo: null,
  expenses: [],
  selectedPeriod: 'month',
  view: 'home',
  search: '',
  editingId: null,
  ready: false,
  saving: false,
  savingEdit: false,
  toastTimer: null,
  searchTimer: null,
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
setupServiceWorker();
void initData();

async function initData() {
  try {
    const database = await openExpenseDB();
    const store = new IndexedDBExpenseStore(database);
    state.repo = new ExpenseRepository(store);

    let migration;
    try {
      migration = await state.repo.migrateLegacy();
    } catch (error) {
      console.error('Legacy migration failed:', error);
      migration = { status: 'failed', imported: 0 };
    }

    state.expenses = await state.repo.list();
    state.ready = true;
    document.documentElement.dataset.appReady = 'true';
    render();
    showView('home');
    applyLaunchParams();

    if (migration.status === 'migrated' && migration.imported > 0) {
      showToast(`Imported ${expenseWord(migration.imported)} into the new local database.`, { duration: 6000 });
    } else if (migration.status === 'failed') {
      showToast('Some existing expenses could not be imported. Your original data is still in this browser.', {
        tone: 'error',
        duration: 9000
      });
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
  $('view-home').hidden = true;
  $('view-history').hidden = true;
  $('addExpenseButton').disabled = true;

  const blocked = /another tab/i.test(error?.message ?? '');
  $('fatalMessage').textContent = blocked
    ? 'Spendly’s local database is open in another tab. Close the other Spendly tabs, then reload this page.'
    : 'Your expenses have not been deleted. Reload the page to try again, and check that Safari or your browser allows site data.';
}

async function requestPersistentStorage() {
  try {
    if (!navigator.storage?.persist) return;
    if (await navigator.storage.persisted()) return;
    await navigator.storage.persist();
  } catch {
    // Best effort. The app works without persistent-storage permission.
  }
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function render() {
  if (!state.ready) return;
  $('view-home').classList.toggle('is-empty', state.expenses.length === 0);
  const summary = summarize(state.expenses, new Date());
  renderHero(summary);
  renderGlance(summary);
  renderWeek(summary.week);
  renderRecent(summary.recent);
  renderHistory(summary);
  renderInstallPrompt();
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
    `All time: ${formatMoney(summary.all.total)} across ${expenseWord(summary.all.count)}. Open history.`
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

function renderHistory(summary) {
  const query = normalizeQuery(state.search);
  const matching = query
    ? state.expenses.filter(expense => matchesQuery(expense, query))
    : state.expenses;

  $('allTotal').innerHTML = amountMarkup(summary.all.total);
  $('allTotal').setAttribute('aria-label', formatMoney(summary.all.total));
  $('allCount').textContent = expenseWord(summary.all.count);
  $('allRange').textContent = summary.all.firstDate ? `Since ${formatMonth(summary.all.firstDate)}` : '';
  $('clearSearch').hidden = !query;
  $('resultCount').textContent = query
    ? `${matching.length} found`
    : `${state.expenses.length} total`;
  $('resultCount').setAttribute('aria-live', 'polite');

  if (!matching.length) {
    if (!state.expenses.length) {
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

  return `<article class="entry">
    <button class="entry__main" type="button" data-edit="${safeId}" aria-label="Edit ${safeDescription}, ${safeAmount}, ${safeDate}">
      <span class="entry__avatar" style="--avatar:${tint}" aria-hidden="true">${initial}</span>
      <span class="entry__text">
        <span class="entry__title">${safeDescription}</span>
        <span class="entry__meta">${safeDate}</span>
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

/* -------------------------------------------------------------------------- */
/* Views and periods                                                          */
/* -------------------------------------------------------------------------- */

function showView(view) {
  if (view !== 'home' && view !== 'history') return;
  state.view = view;
  $('view-home').hidden = view !== 'home';
  $('view-history').hidden = view !== 'history';

  document.querySelectorAll('.dock__tab').forEach(tab => {
    const active = tab.dataset.view === view;
    tab.classList.toggle('is-active', active);
    if (active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });

  document.title = view === 'history' ? 'History — Spendly' : 'Spendly — Expense Tracker';
  if (view === 'history') {
    $('search').value = state.search;
    renderHistory(summarize(state.expenses, new Date()));
  }
  window.scrollTo(0, 0);
}

function selectPeriod(period) {
  if (!PERIODS.includes(period) || period === state.selectedPeriod) return;
  state.selectedPeriod = period;
  const summary = summarize(state.expenses, new Date());
  renderHero(summary);
  renderGlance(summary);
}

function applyLaunchParams() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  const action = params.get('action');

  if (view === 'history') showView('history');
  if (action === 'add') openExpenseSheet();
  if (view || action) {
    window.history.replaceState({}, '', window.location.pathname + window.location.hash);
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

  state.editingId = record?.id ?? null;
  $('expenseSheetTitle').textContent = record ? 'Edit expense' : 'Add expense';
  $('expenseSheetSub').textContent = record ? 'Changes stay on this device' : 'Saved on this device';
  setSaving(false, Boolean(record));

  $('expenseForm').reset();
  $('amountInput').value = record ? Number(record.amount).toFixed(2) : '';
  $('descriptionInput').value = record?.description ?? '';
  $('dateInput').value = record?.date ?? localToday();
  clearFormErrors();
  syncQuickDates();

  const sheet = $('expenseSheet');
  if (!sheet.open) sheet.showModal();
  syncScrollLock();
  $('expenseSheet').querySelector('.sheet__body').scrollTop = 0;

  if (!record) {
    $('amountInput').focus();
    $('amountInput').select();
  }
}

function closeExpenseSheet() {
  closeDialog($('expenseSheet'));
}

async function handleExpenseSubmit(event) {
  event.preventDefault();
  if (state.saving || !state.repo) return;

  clearFormErrors();
  const editingId = state.editingId;
  const wasEditing = Boolean(editingId);
  const checked = validateExpenseInput({
    amount: $('amountInput').value,
    description: $('descriptionInput').value,
    date: $('dateInput').value
  });

  if (!checked.ok) {
    showFieldErrors(checked.errors);
    return;
  }

  state.saving = true;
  setSaving(true, wasEditing);

  try {
    if (wasEditing) await state.repo.update(editingId, checked.value);
    else await state.repo.create(checked.value);

    await refreshExpenses();
    closeExpenseSheet();
    render();
    showToast(wasEditing ? 'Expense updated.' : 'Expense saved.');
  } catch (error) {
    console.error('Could not save expense:', error);
    if (error instanceof ValidationError) {
      showFieldErrors(error.errors);
    } else if (error instanceof NotFoundError) {
      showFormError('That expense no longer exists. Close this sheet and try again.');
    } else {
      showFormError('Couldn’t save to this device. Check browser storage and try again.');
    }
  } finally {
    state.saving = false;
    setSaving(false, wasEditing);
  }
}

function setSaving(isSaving, wasEditing) {
  $('saveButton').disabled = isSaving;
  $('saveButton').setAttribute('aria-busy', String(isSaving));
  $('saveButton').textContent = isSaving
    ? 'Saving…'
    : (wasEditing ? 'Update expense' : 'Save expense');
}

function clearFormErrors() {
  $('formError').hidden = true;
  $('formError').textContent = '';
  for (const name of Object.keys(FIELD_INPUTS)) {
    const input = $(FIELD_INPUTS[name]);
    const error = $(`${name}Error`);
    if (input) input.removeAttribute('aria-invalid');
    if (error) {
      error.hidden = true;
      error.textContent = '';
    }
  }
}

function showFieldErrors(errors) {
  let first = null;
  for (const [name, message] of Object.entries(errors)) {
    const input = $(FIELD_INPUTS[name]);
    const error = $(`${name}Error`);
    if (!input || !error) continue;
    input.setAttribute('aria-invalid', 'true');
    error.textContent = message;
    error.hidden = false;
    if (!first) first = input;
  }
  first?.focus();
}

function showFormError(message) {
  $('formError').textContent = message;
  $('formError').hidden = false;
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
  if (!expense || !state.repo) return;

  try {
    await state.repo.remove(id);
    await refreshExpenses();
    render();
    showToast(`“${truncate(expense.description, 34)}” deleted.`, {
      actionLabel: 'Undo',
      duration: 7000,
      onAction: async () => {
        await state.repo.restore(expense);
        await refreshExpenses();
        render();
        showToast('Expense restored.');
      }
    });
  } catch (error) {
    console.error('Could not delete expense:', error);
    showToast('Couldn’t delete that expense. It is still saved.', { tone: 'error', duration: 6000 });
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
    ['Date', 'Description', 'Amount (INR)'],
    ...sortExpenses(state.expenses).map(expense => [expense.date, expense.description, Number(expense.amount).toFixed(2)])
  ];
  const csv = rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  downloadBlob(
    new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }),
    `spendly-expenses-${localToday()}.csv`
  );
  showToast('CSV downloaded.');
}

function backupPayload(expenses = state.expenses) {
  return {
    app: 'Spendly',
    version: 2,
    exportedAt: new Date().toISOString(),
    expenses: sortExpenses(expenses)
  };
}

function downloadBackup(filename = `spendly-backup-${localToday()}.json`, expenses = state.expenses) {
  downloadBlob(
    new Blob([JSON.stringify(backupPayload(expenses), null, 2)], { type: 'application/json' }),
    filename
  );
}

function generateImportId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `sp_import_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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

    const checked = candidate.map(record => normalizeExpenseRecord(record, {
      now: () => new Date(),
      makeId: generateImportId
    }));
    const invalid = checked.filter(result => !result.ok).length;
    if (invalid) {
      showToast(
        `That backup has ${invalid} unreadable record${invalid === 1 ? '' : 's'}. Nothing was changed.`,
        { tone: 'error', duration: 8000 }
      );
      return;
    }

    const records = checked.map(result => result.value);
    const uniqueIds = new Set(records.map(record => record.id));
    const countLabel = expenseWord(uniqueIds.size);
    const currentCount = expenseWord(state.expenses.length);
    const snapshot = state.expenses.map(expense => ({ ...expense }));

    openActionSheet({
      title: 'Restore this backup?',
      message: `This replaces the ${currentCount} on this device with ${countLabel} from “${file.name}”. A safety copy of your current expenses downloads first, and you can undo this restore straight away.`,
      actions: [
        {
          label: `Replace with ${countLabel}`,
          icon: 'upload',
          tone: 'danger',
          onSelect: async () => {
            try {
              downloadBackup(`spendly-before-restore-${localToday()}.json`, snapshot);
            } catch (error) {
              console.warn('Could not create the safety backup:', error);
            }

            try {
              const result = await state.repo.replaceAll(records);
              await refreshExpenses();
              render();
              showView('history');
              showToast(`Backup restored — ${expenseWord(result.count)}.`, {
                actionLabel: 'Undo',
                duration: 9000,
                onAction: async () => {
                  await state.repo.replaceAll(snapshot);
                  await refreshExpenses();
                  render();
                  showView('history');
                  showToast('Your previous expenses are back.');
                }
              });
            } catch (error) {
              console.error('Could not restore backup:', error);
              showToast('That backup couldn’t be saved. Your existing expenses were not changed.', {
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
  const { tone = 'default', actionLabel = null, onAction = null } = options;
  const duration = options.duration ?? (actionLabel ? 7000 : 4200);
  const toast = $('toast');

  window.clearTimeout(state.toastTimer);
  toast.dataset.tone = tone;
  toast.hidden = false;
  $('toastMessage').textContent = message;
  toast.querySelector('use').setAttribute('href', tone === 'error' ? '#i-x' : '#i-check');

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

  state.toastTimer = window.setTimeout(hideToast, duration);
}

function hideToast() {
  window.clearTimeout(state.toastTimer);
  const toast = $('toast');
  toast.hidden = true;
  toast.querySelector('use').setAttribute('href', '#i-check');
  const action = $('toastAction');
  action.hidden = true;
  action.onclick = null;
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

  sheet.showModal();
  syncScrollLock();
  $('actionCancel').focus();
}

function closeDialog(dialog) {
  if (!dialog.open || dialog.dataset.closing === '1') return;
  dialog.dataset.closing = '1';
  const finish = () => {
    if (dialog.open) dialog.close();
  };

  if (prefersReducedMotion()) {
    finish();
    return;
  }

  dialog.classList.add('is-closing');
  window.setTimeout(finish, 210);
}

function syncScrollLock() {
  const anyOpen = Boolean(document.querySelector('dialog[open]'));
  document.body.classList.toggle('sheet-open', anyOpen);
}

function setupDialogs() {
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('close', () => {
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
    : 'Offline — your expenses are saved on this device';
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
    state.expenses.length > 0 &&
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
/* Data refresh                                                               */
/* -------------------------------------------------------------------------- */

async function refreshExpenses() {
  if (!state.repo) return;
  state.expenses = await state.repo.list();
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

function bindEvents() {
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
        renderHistory(summarize(state.expenses, new Date()));
        $('search').focus();
      }
    });
  }

  $('addExpenseButton').addEventListener('click', () => openExpenseSheet());
  $('seeAllButton').addEventListener('click', () => showView('history'));
  $('allTimeButton').addEventListener('click', () => showView('history'));

  $('dock').addEventListener('click', event => {
    const tab = event.target.closest('[data-view]');
    if (tab) showView(tab.dataset.view);
  });

  $('search').addEventListener('input', event => {
    state.search = event.target.value;
    $('clearSearch').hidden = !normalizeQuery(state.search);
    window.clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(() => {
      renderHistory(summarize(state.expenses, new Date()));
    }, 90);
  });

  $('clearSearch').addEventListener('click', () => {
    state.search = '';
    $('search').value = '';
    $('clearSearch').hidden = true;
    renderHistory(summarize(state.expenses, new Date()));
    $('search').focus();
  });

  $('exportCsv').addEventListener('click', exportCsv);
  $('downloadBackup').addEventListener('click', () => {
    downloadBackup();
    showToast('Backup downloaded.');
  });
  $('restoreBackup').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', event => {
    void handleRestoreFile(event.target.files?.[0]);
  });

  $('expenseForm').addEventListener('submit', event => {
    void handleExpenseSubmit(event);
  });
  $('closeExpenseSheet').addEventListener('click', closeExpenseSheet);
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
  const input = $(FIELD_INPUTS[name]);
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
