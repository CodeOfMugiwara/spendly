import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeMonthlyFinance,
  currentMonthKey,
  findSalaryForMonth,
  formatMonthKey,
  fromPaise,
  groupSavingsByMonth,
  isMonthKey,
  monthBounds,
  monthKeyOf,
  normalizeSalaryRecord,
  normalizeSavingRecord,
  savingsForMonth,
  shiftMonth,
  shortMonthLabel,
  sortSavings,
  sumSavings,
  toPaise,
  validateSalaryInput,
  validateSavingInput
} from '../../js/core.js';

const NOW = new Date(2026, 10, 5, 18, 30); // 5 November 2026, local time

const salary = (monthKey, amount, notes = '') => ({
  id: `salary-${monthKey}`,
  monthKey,
  amount,
  amountPaise: toPaise(amount),
  notes,
  createdAt: '2026-11-01T04:00:00.000Z',
  updatedAt: '2026-11-01T04:00:00.000Z'
});

const saving = (id, amount, date, description = '') => ({
  id,
  amount,
  amountPaise: toPaise(amount),
  date,
  monthKey: date.slice(0, 7),
  description,
  createdAt: `${date}T12:00:00.000Z`,
  updatedAt: `${date}T12:00:00.000Z`
});

const expense = (id, amount, date) => ({
  id,
  amount,
  description: id,
  date,
  createdAt: `${date}T12:00:00.000Z`,
  updatedAt: `${date}T12:00:00.000Z`
});

/* -------------------------------------------------------------------------- */
/* Month keys                                                                 */
/* -------------------------------------------------------------------------- */

test('month keys are validated, derived and shifted safely', () => {
  assert.equal(isMonthKey('2026-11'), true);
  assert.equal(isMonthKey('2026-13'), false);
  assert.equal(isMonthKey('2026-1'), false);
  assert.equal(isMonthKey('1899-12'), false);
  assert.equal(isMonthKey(null), false);

  assert.equal(monthKeyOf('2026-11-05'), '2026-11');
  assert.equal(monthKeyOf('2026-02-30'), null);
  assert.equal(monthKeyOf('nope'), null);

  assert.equal(currentMonthKey(NOW), '2026-11');
  assert.equal(shiftMonth('2026-11', 1), '2026-12');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-11', -14), '2025-09');
  assert.equal(shiftMonth('2026-11', 0), '2026-11');
  assert.equal(shiftMonth('bad', 1), currentMonthKey());

  const bounds = monthBounds('2028-02');
  assert.equal(bounds.start, '2028-02-01');
  assert.equal(bounds.lastDay, '2028-02-29');
  assert.equal(bounds.days, 29);

  assert.equal(formatMonthKey('2026-11'), 'November 2026');
  assert.equal(formatMonthKey('bad'), '');
  assert.equal(shortMonthLabel('2026-11', { withYear: true }), 'Nov 2026');
});

/* -------------------------------------------------------------------------- */
/* Integer paise                                                              */
/* -------------------------------------------------------------------------- */

test('money maths is done in integer paise', () => {
  assert.equal(toPaise(0.1), 10);
  assert.equal(toPaise(0.2), 20);
  assert.equal(toPaise(0.1) + toPaise(0.2), 30);
  assert.equal(fromPaise(30), 0.3);

  assert.equal(toPaise(1234.565), 123457);
  assert.equal(toPaise(999999999.99), 99999999999);
  assert.equal(fromPaise(toPaise(1234.56)), 1234.56);

  // 0.1 + 0.2 in floats is not 0.3; paise arithmetic is exact.
  assert.equal(fromPaise(toPaise(0.1) + toPaise(0.2)), 0.3);
});

/* -------------------------------------------------------------------------- */
/* Salary validation and normalisation                                        */
/* -------------------------------------------------------------------------- */

test('salary validation requires a positive amount and a real month', () => {
  const good = validateSalaryInput({ amount: ' 50,000.50 ', monthKey: '2026-11', notes: '  Diwali   bonus ' });
  assert.equal(good.ok, true);
  assert.equal(good.value.amount, 50000.5);
  assert.equal(good.value.amountPaise, 5000050);
  assert.equal(good.value.notes, 'Diwali bonus');

  const empty = validateSalaryInput({ amount: '', monthKey: '2026-11' });
  assert.equal(empty.ok, false);
  assert.match(empty.errors.amount, /greater than/i);

  const zero = validateSalaryInput({ amount: '0', monthKey: '2026-11' });
  assert.equal(zero.ok, false);

  const badMonth = validateSalaryInput({ amount: '1000', monthKey: '2026-13' });
  assert.equal(badMonth.ok, false);
  assert.ok(badMonth.errors.monthKey);

  const longNotes = validateSalaryInput({ amount: '1000', monthKey: '2026-11', notes: 'x'.repeat(201) });
  assert.equal(longNotes.ok, false);
  assert.ok(longNotes.errors.notes);
});

test('normalising a salary record derives integer paise and timestamps', () => {
  const record = normalizeSalaryRecord(
    { id: 's1', monthKey: '2026-11', amount: '48000', notes: '  ' },
    { now: () => NOW }
  );
  assert.equal(record.ok, true);
  assert.equal(record.value.amount, 48000);
  assert.equal(record.value.amountPaise, 4800000);
  assert.equal(record.value.notes, '');
  assert.equal(record.value.createdAt, NOW.toISOString());

  assert.equal(normalizeSalaryRecord({ monthKey: '2026-11', amount: -1 }).ok, false);
  assert.equal(normalizeSalaryRecord({ monthKey: '2026-99', amount: 100 }).ok, false);
  assert.equal(normalizeSalaryRecord(null).ok, false);
});

/* -------------------------------------------------------------------------- */
/* Savings validation                                                         */
/* -------------------------------------------------------------------------- */

test('savings validation allows an optional note and rejects future dates', () => {
  const good = validateSavingInput({ amount: '₹ 5,000', date: '2026-11-05' }, NOW);
  assert.equal(good.ok, true);
  assert.equal(good.value.amount, 5000);
  assert.equal(good.value.amountPaise, 500000);
  assert.equal(good.value.monthKey, '2026-11');
  assert.equal(good.value.description, '');

  const noted = validateSavingInput({ amount: '250', date: '2026-10-31', description: '  Gold  fund ' }, NOW);
  assert.equal(noted.ok, true);
  assert.equal(noted.value.description, 'Gold fund');
  assert.equal(noted.value.monthKey, '2026-10');

  const future = validateSavingInput({ amount: '100', date: '2026-11-06' }, NOW);
  assert.equal(future.ok, false);
  assert.ok(future.errors.date);

  const invalid = validateSavingInput({ amount: '100', date: '2026-02-30' }, NOW);
  assert.equal(invalid.ok, false);

  assert.equal(validateSavingInput({ amount: '0', date: '2026-11-05' }, NOW).ok, false);
});

test('normalising savings keeps monthKey in sync with the entry date', () => {
  const record = normalizeSavingRecord(
    {
      id: 'save-1',
      amount: '1000',
      date: '2026-10-31',
      monthKey: '2026-11',
      description: 'Emergency fund'
    },
    { now: () => NOW }
  );
  assert.equal(record.ok, true);
  assert.equal(record.value.monthKey, '2026-10');
  assert.equal(record.value.amountPaise, 100000);
  assert.equal(record.value.description, 'Emergency fund');

  assert.equal(normalizeSavingRecord({ amount: 10, date: '2026-02-30' }).ok, false);
});

/* -------------------------------------------------------------------------- */
/* Monthly calculation                                                        */
/* -------------------------------------------------------------------------- */

test('remaining balance is salary minus that month only', () => {
  const finances = computeMonthlyFinance('2026-11', {
    salary: salary('2026-11', 50000),
    expenses: [
      expense('nov-1', 12000, '2026-11-03'),
      expense('nov-2', 8000, '2026-11-28'),
      expense('oct-1', 99999, '2026-10-15'),
      expense('dec-1', 77777, '2026-12-01')
    ],
    savings: [
      saving('nov-save-1', 6000, '2026-11-02'),
      saving('nov-save-2', 4000, '2026-11-20'),
      saving('oct-save', 88888, '2026-10-10')
    ]
  });

  assert.equal(finances.hasSalary, true);
  assert.equal(finances.salaryPaise, 5000000);
  assert.equal(finances.expensePaise, 2000000);
  assert.equal(finances.savingsPaise, 1000000);
  assert.equal(finances.remainingPaise, 2000000);
  assert.equal(finances.remaining, 20000);
  assert.equal(finances.expenseCount, 2);
  assert.equal(finances.savingCount, 2);
  assert.equal(finances.isNegative, false);
  assert.equal(finances.label, 'November 2026');
});

test('a month without salary is reported as unconfigured, not a fake balance', () => {
  const finances = computeMonthlyFinance('2026-11', {
    salary: salary('2026-10', 45000),
    expenses: [expense('nov-1', 2000, '2026-11-03')],
    savings: []
  });

  assert.equal(finances.hasSalary, false);
  assert.equal(finances.salary, null);
  assert.equal(finances.salaryPaise, 0);
  assert.equal(finances.expensePaise, 200000);
  // The raw arithmetic is still exposed, but the UI relies on hasSalary.
  assert.equal(finances.remainingPaise, -200000);
  assert.equal(finances.isNegative, false);
});

test('overspending produces a negative balance without breaking the maths', () => {
  const finances = computeMonthlyFinance('2026-11', {
    salary: salary('2026-11', 10000),
    expenses: [expense('nov-1', 12000, '2026-11-03')],
    savings: [saving('nov-save', 500.25, '2026-11-04')]
  });

  assert.equal(finances.hasSalary, true);
  assert.equal(finances.remainingPaise, -250025);
  assert.equal(finances.remaining, -2500.25);
  assert.equal(finances.isNegative, true);
});

test('historical months stay independent and nothing carries forward', () => {
  const expenses = [
    expense('sep', 1000, '2026-09-15'),
    expense('oct', 2000, '2026-10-15'),
    expense('nov', 3000, '2026-11-15')
  ];
  const salaries = [salary('2026-09', 45000), salary('2026-10', 48000), salary('2026-11', 50000)];
  const savings = [saving('sep-save', 5000, '2026-09-20'), saving('oct-save', 7000, '2026-10-20')];

  const september = computeMonthlyFinance('2026-09', {
    salary: findSalaryForMonth(salaries, '2026-09'), expenses, savings
  });
  const october = computeMonthlyFinance('2026-10', {
    salary: findSalaryForMonth(salaries, '2026-10'), expenses, savings
  });
  const november = computeMonthlyFinance('2026-11', {
    salary: findSalaryForMonth(salaries, '2026-11'), expenses, savings
  });

  assert.equal(september.remaining, 39000);
  assert.equal(october.remaining, 39000);
  assert.equal(november.remaining, 47000);
});

test('savings month comes from the entry date, not a stale monthKey', () => {
  const finances = computeMonthlyFinance('2026-10', {
    salary: salary('2026-10', 10000),
    expenses: [],
    savings: [{ ...saving('mislabelled', 1000, '2026-11-02'), monthKey: '2026-10' }]
  });

  assert.equal(finances.savingsPaise, 0);
  assert.equal(finances.remainingPaise, 1000000);

  const november = computeMonthlyFinance('2026-11', {
    salary: salary('2026-11', 10000),
    expenses: [],
    savings: [{ ...saving('mislabelled', 1000, '2026-11-02'), monthKey: '2026-10' }]
  });
  assert.equal(november.savingsPaise, 100000);
  assert.equal(november.remainingPaise, 900000);
});

/* -------------------------------------------------------------------------- */
/* Savings aggregation                                                        */
/* -------------------------------------------------------------------------- */

test('savings are grouped by month with exact totals', () => {
  const savings = [
    saving('a', 1000.1, '2026-11-02', 'Emergency fund'),
    saving('b', 2000.2, '2026-11-20'),
    saving('c', 500.5, '2026-10-05'),
    saving('d', 0.2, '2026-10-06'),
    saving('e', 300, '2026-09-30')
  ];

  assert.equal(sortSavings(savings).map(record => record.id).join(','), 'b,a,d,c,e');
  assert.equal(savingsForMonth(savings, '2026-11').length, 2);
  assert.equal(sumSavings(savings), 3801);

  const groups = groupSavingsByMonth(savings);
  assert.deepEqual(groups.map(group => group.key), ['2026-11', '2026-10', '2026-09']);
  assert.equal(groups[0].total, 3000.3);
  assert.equal(groups[0].totalPaise, 300030);
  assert.equal(groups[0].count, 2);
  assert.equal(groups[1].total, 500.7);
  assert.equal(groups[2].total, 300);
});
