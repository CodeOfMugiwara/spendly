/**
 * Spendly core: pure date, money, validation and summary helpers.
 *
 * Nothing in this file touches the DOM, IndexedDB or localStorage. Keeping the
 * rules here means the UI and the storage layer can be tested against exactly
 * the same behaviour.
 */

export const STORAGE_KEY = 'spendly_expenses_v1';
export const DB_NAME = 'spendly';
// v1: expenses + meta. v2 adds salaries/savings, v3 relationship indexes and
// v4 supports external funding labels without rewriting existing records.
export const DB_VERSION = 5;

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
export const MAX_NOTES = 200;

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
      ...(raw.paymentSource === 'savings' || raw.paymentSource === 'salary' || raw.paymentSource === 'others' ? { paymentSource: raw.paymentSource } : {}),
      ...(typeof raw.salaryRecordId === 'string' ? { salaryRecordId: raw.salaryRecordId } : {}),
      ...(raw.allocationStatus === 'needs_review' ? { allocationStatus: 'needs_review' } : {}),
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

/* -------------------------------------------------------------------------- */
/* Months (YYYY-MM)                                                           */
/* -------------------------------------------------------------------------- */

/** A calendar month key. Lexical order matches chronological order. */
export function isMonthKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  return year >= 1900 && year <= 2200 && month >= 1 && month <= 12;
}

/** Month key for a stored YYYY-MM-DD calendar date, or null. */
export function monthKeyOf(value) {
  if (typeof value !== 'string' || !parseISODate(value)) return null;
  return value.slice(0, 7);
}

export function currentMonthKey(now = new Date()) {
  return toISODate(now).slice(0, 7);
}

/** Shift a month key by a number of calendar months (negative goes back). */
export function shiftMonth(monthKey, delta) {
  if (!isMonthKey(monthKey)) return currentMonthKey();
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7)) - 1;
  const date = new Date(year, month + Number(delta || 0), 1, 12);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** First and last calendar day of a month, with an exclusive end bound. */
export function monthBounds(monthKey) {
  if (!isMonthKey(monthKey)) return null;
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7)) - 1;
  const start = new Date(year, month, 1, 12);
  const end = new Date(year, month + 1, 1, 12);
  return {
    monthKey,
    label: formatMonth(monthKey),
    start: toISODate(start),
    end: toISODate(end),
    lastDay: toISODate(addDays(end, -1)),
    days: Math.round((Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()) -
      Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / 86400000)
  };
}

/** Human label such as "November 2026", or an empty string for bad input. */
export function formatMonthKey(monthKey) {
  return isMonthKey(monthKey) ? formatMonth(monthKey) : '';
}

/** Compact label such as "Nov" for tight spaces. */
const shortMonthFormatter = new Intl.DateTimeFormat('en-IN', { month: 'short' });
const shortMonthYearFormatter = new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric' });

export function shortMonthLabel(monthKey, { withYear = false } = {}) {
  if (!isMonthKey(monthKey)) return '';
  const date = parseISODate(`${monthKey}-01`);
  if (!date) return '';
  return (withYear ? shortMonthYearFormatter : shortMonthFormatter).format(date);
}

/* -------------------------------------------------------------------------- */
/* Integer paise                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Money is entered and displayed in rupees but every arithmetic step in the
 * finance features happens on integer paise. That keeps 0.1 + 0.2 style float
 * drift out of salary, savings and remaining-balance calculations.
 */
export function toPaise(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(roundMoney(amount) * 100);
}

export function fromPaise(paise) {
  const value = Number(paise);
  if (!Number.isFinite(value)) return 0;
  return roundMoney(Math.round(value) / 100);
}

/* -------------------------------------------------------------------------- */
/* Salary records                                                             */
/* -------------------------------------------------------------------------- */

/** One salary per calendar month, entered by hand. */
export function validateSalaryInput(input) {
  const errors = {};
  const amount = parseAmountInput(input?.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    errors.amount = 'Enter a salary greater than ₹0.';
  } else if (amount > MAX_AMOUNT) {
    errors.amount = 'That salary is too large.';
  }

  const monthKey = isMonthKey(input?.monthKey) ? input.monthKey : null;
  if (!monthKey) errors.monthKey = 'Choose a valid month.';

  const notes = String(input?.notes ?? '').trim().replace(/\s+/g, ' ');
  if (notes.length > MAX_NOTES) {
    errors.notes = `Keep notes to ${MAX_NOTES} characters or fewer.`;
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    errors: {},
    value: { monthKey, amount: roundMoney(amount), amountPaise: toPaise(amount), notes }
  };
}

/** Normalise a stored or imported salary record. */
export function normalizeSalaryRecord(raw, options = {}) {
  const { now = () => new Date(), makeId } = options;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reasons: ['Not a salary record.'], errors: { record: 'Not a salary record.' } };
  }

  const errors = {};
  const amount = parseStoredAmount(raw.amount);
  const fallbackPaise = Number(raw.amountPaise);
  const resolved = Number.isFinite(amount) ? amount : (Number.isFinite(fallbackPaise) ? fromPaise(fallbackPaise) : NaN);
  if (!Number.isFinite(resolved) || resolved <= 0 || resolved > MAX_AMOUNT) {
    errors.amount = 'Invalid amount.';
  }

  const monthKey = isMonthKey(raw.monthKey) ? raw.monthKey : null;
  if (!monthKey) errors.monthKey = 'Invalid month.';

  const notes = typeof raw.notes === 'string' ? raw.notes.trim().replace(/\s+/g, ' ') : '';
  if (notes.length > MAX_NOTES) errors.notes = 'Notes are too long.';

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

  const createdAt = normalizeTimestamp(raw.createdAt) || now().toISOString();
  let updatedAt = normalizeTimestamp(raw.updatedAt);
  if (!updatedAt || updatedAt < createdAt) updatedAt = createdAt;

  return {
    ok: true,
    value: {
      id,
      monthKey,
      amount: roundMoney(resolved),
      amountPaise: toPaise(resolved),
      notes,
      createdAt,
      updatedAt
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Savings records                                                            */
/* -------------------------------------------------------------------------- */

/** A single amount moved into savings on a calendar date. */
export function validateSavingInput(input, now = new Date()) {
  const errors = {};
  const amount = parseAmountInput(input?.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    errors.amount = 'Enter an amount greater than ₹0.';
  } else if (amount > MAX_AMOUNT) {
    errors.amount = 'That amount is too large.';
  }

  const date = typeof input?.date === 'string' && parseISODate(input.date) ? input.date : null;
  if (!date) {
    errors.date = 'Choose a valid date.';
  } else if (date > localToday(now)) {
    errors.date = 'Choose today or an earlier date.';
  }

  const description = String(input?.description ?? '').trim().replace(/\s+/g, ' ');
  if (description.length > MAX_DESCRIPTION) {
    errors.description = `Keep it to ${MAX_DESCRIPTION} characters or fewer.`;
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    errors: {},
    value: {
      monthKey: monthKeyOf(date),
      amount: roundMoney(amount),
      amountPaise: toPaise(amount),
      date,
      description
    }
  };
}

/** Normalise a stored or imported savings record; monthKey always follows date. */
export function normalizeSavingRecord(raw, options = {}) {
  const { now = () => new Date(), makeId } = options;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reasons: ['Not a savings record.'], errors: { record: 'Not a savings record.' } };
  }

  const errors = {};
  const amount = parseStoredAmount(raw.amount);
  const fallbackPaise = Number(raw.amountPaise);
  const resolved = Number.isFinite(amount) ? amount : (Number.isFinite(fallbackPaise) ? fromPaise(fallbackPaise) : NaN);
  if (!Number.isFinite(resolved) || resolved <= 0 || resolved > MAX_AMOUNT) {
    errors.amount = 'Invalid amount.';
  }

  const date = typeof raw.date === 'string' && parseISODate(raw.date) ? raw.date : null;
  if (!date) errors.date = 'Invalid date.';

  const description = typeof raw.description === 'string'
    ? raw.description.trim().replace(/\s+/g, ' ')
    : '';
  if (description.length > MAX_DESCRIPTION) errors.description = 'Description is too long.';

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

  const fallbackCreatedAt = new Date(...date.split('-').map((part, index) => (
    index === 1 ? Number(part) - 1 : Number(part)
  )), 12).toISOString();
  const createdAt = normalizeTimestamp(raw.createdAt) || fallbackCreatedAt;
  let updatedAt = normalizeTimestamp(raw.updatedAt);
  if (!updatedAt || updatedAt < createdAt) updatedAt = createdAt;

  return {
    ok: true,
    value: {
      id,
      monthKey: monthKeyOf(date),
      amount: roundMoney(resolved),
      amountPaise: toPaise(resolved),
      date,
      description,
      ...(typeof raw.type === 'string' && ['contribution', 'salary_balance_transfer', 'withdrawal', 'external_contribution'].includes(raw.type) ? { type: raw.type } : {}),
      ...(typeof raw.sourceType === 'string' && ['salary', 'gift', 'bonus', 'other'].includes(raw.sourceType) ? { sourceType: raw.sourceType } : {}),
      ...(typeof raw.salaryRecordId === 'string' ? { salaryRecordId: raw.salaryRecordId } : {}),
      ...(typeof raw.expenseId === 'string' ? { expenseId: raw.expenseId } : {}),
      ...(Number.isSafeInteger(raw.salaryAllocationPaise) && raw.salaryAllocationPaise >= 0 ? { salaryAllocationPaise: raw.salaryAllocationPaise } : {}),
      ...(Array.isArray(raw.extraIncomeAllocations) ? { extraIncomeAllocations: raw.extraIncomeAllocations.filter(item => item && typeof item.extraIncomeRecordId === 'string' && Number.isSafeInteger(item.amountPaise) && item.amountPaise >= 0).map(item => ({ extraIncomeRecordId: item.extraIncomeRecordId, amountPaise: item.amountPaise })) } : {}),
      ...(raw.allocationStatus === 'needs_review' ? { allocationStatus: 'needs_review' } : {}),
      createdAt,
      updatedAt
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Monthly finance                                                            */
/* -------------------------------------------------------------------------- */

export function findSalaryForMonth(salaries, monthKey) {
  if (!Array.isArray(salaries)) return null;
  return salaries.find(record => record.monthKey === monthKey) ?? null;
}

export function sumSavingsPaise(savings) {
  return savings.reduce((sum, record) => {
    const amount = toPaise(record.amount);
    return sum + (record.type === 'withdrawal' ? -amount : amount);
  }, 0);
}

export function sumSavings(savings) {
  return fromPaise(sumSavingsPaise(savings));
}

/**
 * The month a savings record belongs to. The entry date is authoritative (the
 * month at the time the money was saved); `monthKey` is only a fallback for a
 * record whose date is unreadable.
 */
function savingsMonthKey(record) {
  return monthKeyOf(record?.date) ?? (isMonthKey(record?.monthKey) ? record.monthKey : null);
}

export function compareSavings(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if ((a.createdAt || '') !== (b.createdAt || '')) {
    return (a.createdAt || '') < (b.createdAt || '') ? 1 : -1;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

export function sortSavings(savings) {
  return [...savings].sort(compareSavings);
}

/** Savings in one month, newest first. */
export function savingsForMonth(savings, monthKey) {
  return sortSavings(savings.filter(record => savingsMonthKey(record) === monthKey));
}

/** Savings grouped by month, newest month first. */
export function groupSavingsByMonth(savings) {
  const groups = new Map();
  for (const record of savings) {
    const key = savingsMonthKey(record);
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, { key, label: formatMonth(key), total: 0, totalPaise: 0, count: 0, items: [] });
    }
    const group = groups.get(key);
    group.items.push(record);
    group.totalPaise += record.type === 'withdrawal' ? -toPaise(record.amount) : toPaise(record.amount);
    group.count += 1;
  }

  return [...groups.values()]
    .map(group => ({
      ...group,
      total: fromPaise(group.totalPaise),
      items: sortSavings(group.items)
    }))
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

/** The salary pool most recently added by the user is the active pool. */
export function findActiveSalary(salaries) {
  if (!Array.isArray(salaries) || !salaries.length) return null;
  return [...salaries].sort((a, b) => {
    const time = String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
    if (time) return time;
    const month = String(b.monthKey ?? '').localeCompare(String(a.monthKey ?? ''));
    return month || String(b.id ?? '').localeCompare(String(a.id ?? ''));
  })[0] ?? null;
}

/** Calculate one salary pool from its linked expenses and savings ledger. */
export function computeSalaryPool(salary, expenses = [], savings = []) {
  if (!salary) return { salary, expensePaise: 0, contributionPaise: 0, transferPaise: 0, remainingPaise: 0, remaining: 0 };
  const allocatedExpenses = expenses.filter(record => record.paymentSource !== 'savings' && record.salaryRecordId === salary.id);
  const allocatedSavings = savings.filter(record => record.salaryRecordId === salary.id);
  const expensePaise = allocatedExpenses.reduce((sum, record) => sum + toPaise(record.amount), 0);
  const contributionPaise = allocatedSavings
    .filter(record => (record.type ?? 'contribution') === 'contribution')
    .reduce((sum, record) => sum + (Number.isInteger(record.salaryAllocationPaise)
      ? record.salaryAllocationPaise
      : toPaise(record.amount)), 0);
  const transferPaise = allocatedSavings
    .filter(record => record.type === 'salary_balance_transfer')
    .reduce((sum, record) => sum + toPaise(record.amount), 0);
  const remainingPaise = toPaise(salary.amount) - expensePaise - contributionPaise - transferPaise;
  return {
    salary,
    expensePaise,
    contributionPaise,
    transferPaise,
    remainingPaise,
    remaining: fromPaise(remainingPaise),
    expenseTotal: fromPaise(expensePaise),
    contributionTotal: fromPaise(contributionPaise),
    transferTotal: fromPaise(transferPaise),
    expenses: allocatedExpenses,
    savings: allocatedSavings
  };
}

/** Savings balance is credits less expense-linked withdrawals. */
export function computeSavingsBalance(savings = []) {
  const contributionPaise = savings
    .filter(record => (record.type ?? 'contribution') === 'contribution' || (record.type === 'contribution' && record.sourceType === 'salary'))
    .reduce((sum, record) => sum + toPaise(record.amount), 0);
  const externalPaise = savings.filter(record => record.type === 'external_contribution')
    .reduce((sum, record) => sum + toPaise(record.amount), 0);
  const transferPaise = savings
    .filter(record => record.type === 'salary_balance_transfer')
    .reduce((sum, record) => sum + toPaise(record.amount), 0);
  const withdrawalPaise = savings
    .filter(record => record.type === 'withdrawal')
    .reduce((sum, record) => sum + toPaise(record.amount), 0);
  return {
    contributionPaise,
    transferPaise,
    withdrawalPaise,
    externalPaise,
    balancePaise: contributionPaise + transferPaise + externalPaise - withdrawalPaise,
    contributionTotal: fromPaise(contributionPaise),
    transferTotal: fromPaise(transferPaise),
    withdrawalTotal: fromPaise(withdrawalPaise),
    balance: fromPaise(contributionPaise + transferPaise + externalPaise - withdrawalPaise)
  };
}

export function extraIncomeRemaining(record, savings = []) {
  const used = savings.reduce((sum, entry) => sum + (entry.extraIncomeAllocations ?? [])
    .filter(item => item.extraIncomeRecordId === record.id)
    .reduce((subtotal, item) => subtotal + Number(item.amountPaise ?? toPaise(item.amount ?? 0)), 0), 0);
  return fromPaise(toPaise(record.amount) - used);
}

/**
 * The one financial rule of the app:
 *
 *   remaining = monthly salary - that month's expenses - that month's savings
 *
 * Only records dated inside `monthKey` participate. Nothing is carried forward,
 * and a month without a salary record is reported as `hasSalary: false` so the
 * UI never shows a misleading balance.
 */
export function computeMonthlyFinance(monthKey, { salary = null, expenses = [], savings = [] } = {}) {
  const key = isMonthKey(monthKey) ? monthKey : currentMonthKey();

  const monthExpenses = expenses.filter(record => monthKeyOf(record.date) === key);
  const monthSavings = savings.filter(record => savingsMonthKey(record) === key);

  const expensePaise = monthExpenses.reduce((sum, record) => sum + toPaise(record.amount), 0);
  const savingsPaise = sumSavingsPaise(monthSavings);
  const salaryRecord = salary && salary.monthKey === key ? salary : findSalaryForMonth([salary].filter(Boolean), key);
  const salaryPaise = salaryRecord ? toPaise(salaryRecord.amount) : 0;
  const hasSalary = Boolean(salaryRecord);
  const remainingPaise = salaryPaise - expensePaise - savingsPaise;

  return {
    monthKey: key,
    label: formatMonth(key),
    salary: salaryRecord,
    hasSalary,
    salaryPaise,
    expensePaise,
    savingsPaise,
    remainingPaise,
    salaryTotal: fromPaise(salaryPaise),
    expenseTotal: fromPaise(expensePaise),
    savingsTotal: fromPaise(savingsPaise),
    remaining: fromPaise(remainingPaise),
    expenseCount: monthExpenses.length,
    savingCount: monthSavings.length,
    isNegative: hasSalary && remainingPaise < 0
  };
}
