/**
 * Spendly core: pure date, money, validation and summary helpers.
 *
 * Nothing in this file touches the DOM, IndexedDB or localStorage. Keeping the
 * rules here means the UI and the storage layer can be tested against exactly
 * the same behaviour.
 */

export const STORAGE_KEY = 'spendly_expenses_v1';
export const DB_NAME = 'spendly';
export const DB_VERSION = 1;

export const PERIODS = Object.freeze(['week', 'month', 'quarter', 'year']);

export const PERIOD_LABELS = Object.freeze({
  week: 'This week',
  month: 'This month',
  quarter: 'Last 3 months',
  year: 'This year'
});

export const PERIOD_TILE_LABELS = Object.freeze({
  week: 'This week',
  month: 'This month',
  quarter: '3 months',
  year: 'This year'
});

export const MAX_AMOUNT = 999999999.99;
export const MAX_DESCRIPTION = 100;

const moneyFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const dayMonthYear = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric'
});

const monthYear = new Intl.DateTimeFormat('en-IN', {
  month: 'long',
  year: 'numeric'
});

const weekdayFormatter = new Intl.DateTimeFormat('en-IN', { weekday: 'short' });

/* -------------------------------------------------------------------------- */
/* Dates                                                                      */
/* -------------------------------------------------------------------------- */

export function toISODate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Parse a YYYY-MM-DD calendar date into a local noon Date, or null. */
export function parseISODate(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

export function localToday(now = new Date()) {
  return toISODate(now);
}

export function addDays(date, days) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
  next.setDate(next.getDate() + days);
  return next;
}

export function startOfWeek(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // Monday
  return start;
}

export function getPeriodBounds(period, now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth();
  let start;
  let end;

  if (period === 'week') {
    start = startOfWeek(now);
    end = addDays(start, 7);
  } else if (period === 'month') {
    start = new Date(year, month, 1, 12);
    end = new Date(year, month + 1, 1, 12);
  } else if (period === 'quarter') {
    // Rolling three calendar months including the current one.
    start = new Date(year, month - 2, 1, 12);
    end = new Date(year, month + 1, 1, 12);
  } else if (period === 'year') {
    start = new Date(year, 0, 1, 12);
    end = new Date(year + 1, 0, 1, 12);
  } else {
    throw new Error(`Unknown period: ${period}`);
  }

  return {
    period,
    start: toISODate(start),
    end: toISODate(end),
    startDate: start,
    endDate: end,
    label: PERIOD_LABELS[period]
  };
}

/** Inclusive count of calendar days elapsed in a period, capped at its end. */
export function elapsedDays(startISO, endISO, now = new Date()) {
  const start = parseISODate(startISO);
  const end = parseISODate(endISO);
  if (!start || !end) return 1;

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const lastPossible = addDays(end, -1);
  const last = today < lastPossible ? today : lastPossible;

  if (last < start) return 1;

  const utcDay = date => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = Math.round((utcDay(last) - utcDay(start)) / 86400000) + 1;
  return Math.max(1, diff);
}

export function formatDate(value) {
  const date = parseISODate(typeof value === 'string' && value.length === 7 ? `${value}-01` : value);
  if (!date) return '';
  return dayMonthYear.format(date);
}

export function formatMonth(value) {
  const iso = typeof value === 'string' && value.length === 7 ? `${value}-01` : value;
  const date = parseISODate(iso);
  if (!date) return '';
  return monthYear.format(date);
}

export function weekdayShort(date) {
  return weekdayFormatter.format(date);
}

export function relativeDayLabel(iso, now = new Date()) {
  const today = localToday(now);
  if (iso === today) return 'Today';
  const yesterday = toISODate(addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12), -1));
  if (iso === yesterday) return 'Yesterday';
  return formatDate(iso);
}

/* -------------------------------------------------------------------------- */
/* Money                                                                      */
/* -------------------------------------------------------------------------- */

export function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function formatMoney(value) {
  const amount = Number(value);
  return moneyFormatter.format(Number.isFinite(amount) ? amount : 0);
}

/** Split a formatted amount into currency / integer / fraction for display. */
export function formatMoneyParts(value) {
  const amount = Number(value);
  const parts = moneyFormatter.formatToParts(Number.isFinite(amount) ? amount : 0);
  const currency = parts.find(part => part.type === 'currency')?.value ?? '₹';
  const integer = parts
    .filter(part => part.type === 'integer' || part.type === 'group')
    .map(part => part.value)
    .join('');
  const fraction = parts.find(part => part.type === 'fraction')?.value ?? '00';
  return { currency, integer, fraction };
}

export function expenseWord(count) {
  return `${count} ${count === 1 ? 'expense' : 'expenses'}`;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export function parseAmountInput(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  if (typeof raw !== 'string') return NaN;
  const cleaned = raw.replace(/[₹,\s]/g, '');
  if (!/^(?:\d+|\d*\.\d{1,2})$/.test(cleaned)) return NaN;
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? amount : NaN;
}

/** Stored records may have more decimal places; normalise them on the way in. */
function parseStoredAmount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  if (typeof raw !== 'string') return NaN;
  const cleaned = raw.replace(/[₹,\s]/g, '');
  if (!/^(?:\d+|\d*\.\d+)$/.test(cleaned)) return NaN;
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? amount : NaN;
}

export function validateExpenseInput(input) {
  const errors = {};
  const amount = parseAmountInput(input?.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    errors.amount = 'Enter an amount greater than ₹0.';
  } else if (amount > MAX_AMOUNT) {
    errors.amount = 'That amount is too large.';
  }

  const description = String(input?.description ?? '').trim().replace(/\s+/g, ' ');
  if (!description) {
    errors.description = 'Add a short description.';
  } else if (description.length > MAX_DESCRIPTION) {
    errors.description = `Keep it to ${MAX_DESCRIPTION} characters or fewer.`;
  }

  const date = typeof input?.date === 'string' && parseISODate(input.date) ? input.date : null;
  if (!date) errors.date = 'Choose a valid date.';

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    errors: {},
    value: { amount: roundMoney(amount), description, date }
  };
}

export function normalizeTimestamp(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Recover the creation time encoded in the original Spendly id, if present. */
export function timestampFromLegacyId(id) {
  if (typeof id !== 'string' || id.length < 7) return null;
  for (const length of [8, 7, 9]) {
    if (id.length < length) continue;
    const chunk = id.slice(0, length);
    if (!/^[0-9a-z]+$/i.test(chunk)) continue;
    const timestamp = parseInt(chunk, 36);
    if (!Number.isFinite(timestamp)) continue;
    if (timestamp >= Date.UTC(2015, 0, 1) && timestamp <= Date.UTC(2100, 0, 1)) {
      return new Date(timestamp).toISOString();
    }
  }
  return null;
}

/**
 * Validate and normalise one stored/imported record.
 * Returns { ok, value } or { ok: false, reasons, errors }.
 */
export function normalizeExpenseRecord(raw, options = {}) {
  const { now = () => new Date(), makeId } = options;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reasons: ['Not an expense record.'], errors: { record: 'Not an expense record.' } };
  }

  const errors = {};
  const amount = parseStoredAmount(raw.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    errors.amount = 'Invalid amount.';
  }

  const description = typeof raw.description === 'string'
    ? raw.description.trim().replace(/\s+/g, ' ')
    : '';
  if (!description || description.length > MAX_DESCRIPTION) {
    errors.description = 'Invalid description.';
  }

  const date = typeof raw.date === 'string' && parseISODate(raw.date) ? raw.date : null;
  if (!date) errors.date = 'Invalid date.';

  let id = '';
  if (typeof raw.id === 'string') id = raw.id.trim();
  else if (typeof raw.id === 'number' && Number.isFinite(raw.id)) id = String(raw.id);

  if (!id) {
    if (typeof makeId === 'function') id = makeId();
    else errors.id = 'Missing id.';
  }
  if (id.length > 128) errors.id = 'Invalid id.';

  if (Object.keys(errors).length) {
    return { ok: false, reasons: Object.values(errors), errors };
  }

  const parsedDate = parseISODate(date);
  const fallbackCreatedAt = timestampFromLegacyId(id) ||
    new Date(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate(), 12).toISOString();

  const createdAt = normalizeTimestamp(raw.createdAt) || fallbackCreatedAt;
  let updatedAt = normalizeTimestamp(raw.updatedAt);
  if (!updatedAt || updatedAt < createdAt) updatedAt = createdAt;

  return {
    ok: true,
    value: {
      id,
      amount: roundMoney(amount),
      description,
      date,
      createdAt,
      updatedAt
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Queries and summaries                                                      */
/* -------------------------------------------------------------------------- */

export function sumExpenses(expenses) {
  return roundMoney(expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0));
}

export function compareExpenses(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if ((a.createdAt || '') !== (b.createdAt || '')) {
    return (a.createdAt || '') < (b.createdAt || '') ? 1 : -1;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

export function sortExpenses(expenses) {
  return [...expenses].sort(compareExpenses);
}

export function normalizeQuery(query) {
  return String(query ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
}

export function matchesQuery(expense, query) {
  const tokens = normalizeQuery(query).split(' ').filter(Boolean);
  if (!tokens.length) return true;
  const haystack = [
    expense.description,
    expense.date,
    formatDate(expense.date),
    formatMonth(expense.date),
    String(expense.amount),
    Number(expense.amount).toFixed(2),
    formatMoney(expense.amount)
  ].join(' ').toLowerCase();
  return tokens.every(token => haystack.includes(token));
}

export function groupExpensesByMonth(expenses) {
  const groups = new Map();
  for (const expense of expenses) {
    const key = expense.date.slice(0, 7);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: formatMonth(key),
        total: 0,
        count: 0,
        items: []
      });
    }
    const group = groups.get(key);
    group.items.push(expense);
    group.total = roundMoney(group.total + Number(expense.amount));
    group.count += 1;
  }
  return [...groups.values()];
}

export function summarizePeriod(expenses, period, now = new Date()) {
  const bounds = getPeriodBounds(period, now);
  const items = expenses.filter(expense => expense.date >= bounds.start && expense.date < bounds.end);
  const total = sumExpenses(items);
  const days = elapsedDays(bounds.start, bounds.end, now);
  return {
    ...bounds,
    total,
    count: items.length,
    days,
    dailyAverage: roundMoney(total / days)
  };
}

export function getWeekOverview(expenses, now = new Date()) {
  const bounds = getPeriodBounds('week', now);
  const totals = new Map();
  for (const expense of expenses) {
    if (expense.date >= bounds.start && expense.date < bounds.end) {
      totals.set(expense.date, (totals.get(expense.date) || 0) + Number(expense.amount));
    }
  }

  const today = localToday(now);
  const days = [];
  for (let index = 0; index < 7; index += 1) {
    const date = addDays(bounds.startDate, index);
    const iso = toISODate(date);
    days.push({
      iso,
      weekday: weekdayShort(date),
      dayNumber: date.getDate(),
      amount: roundMoney(totals.get(iso) || 0),
      isToday: iso === today,
      isFuture: iso > today
    });
  }

  const total = roundMoney(days.reduce((sum, day) => sum + day.amount, 0));
  const max = Math.max(1, ...days.map(day => day.amount));
  return { ...bounds, total, days, max, today };
}

export function summarize(expenses, now = new Date()) {
  const periods = {};
  for (const period of PERIODS) {
    periods[period] = summarizePeriod(expenses, period, now);
  }

  const sorted = sortExpenses(expenses);
  return {
    periods,
    all: {
      total: sumExpenses(expenses),
      count: expenses.length,
      firstDate: sorted.length ? sorted[sorted.length - 1].date : null,
      lastDate: sorted.length ? sorted[0].date : null
    },
    week: getWeekOverview(expenses, now),
    recent: sorted.slice(0, 5)
  };
}
