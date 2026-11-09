import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addDays,
  elapsedDays,
  formatDate,
  formatMoney,
  formatMoneyParts,
  getMonthOverview,
  getPeriodBounds,
  getPeriodChartData,
  getQuarterOverview,
  getWeekOverview,
  getYearOverview,
  groupExpensesByMonth,
  matchesQuery,
  normalizeExpenseRecord,
  parseAmountInput,
  parseISODate,
  shortMonthLabel,
  sortExpenses,
  summarize,
  timestampFromLegacyId,
  toISODate,
  validateExpenseInput
} from '../../js/core.js';

const NOW = new Date(2026, 10, 4, 18, 30); // 4 November 2026, local time

const sample = [
  { id: 'a', amount: 100, description: 'Lunch', date: '2026-11-02', createdAt: '2026-11-02T06:30:00.000Z', updatedAt: '2026-11-02T06:30:00.000Z' },
  { id: 'b', amount: 250, description: 'Petrol', date: '2026-11-04', createdAt: '2026-11-04T06:30:00.000Z', updatedAt: '2026-11-04T06:30:00.000Z' },
  { id: 'c', amount: 500, description: 'Groceries', date: '2026-10-15', createdAt: '2026-10-15T06:30:00.000Z', updatedAt: '2026-10-15T06:30:00.000Z' },
  { id: 'd', amount: 200, description: 'Books', date: '2026-09-10', createdAt: '2026-09-10T06:30:00.000Z', updatedAt: '2026-09-10T06:30:00.000Z' },
  { id: 'e', amount: 1000, description: 'Rent', date: '2026-01-20', createdAt: '2026-01-20T06:30:00.000Z', updatedAt: '2026-01-20T06:30:00.000Z' },
  { id: 'f', amount: 300, description: 'Old purchase', date: '2025-12-31', createdAt: '2025-12-31T06:30:00.000Z', updatedAt: '2025-12-31T06:30:00.000Z' }
];

test('period bounds use local calendar dates and Monday weeks', () => {
  const week = getPeriodBounds('week', NOW);
  assert.equal(week.start, '2026-11-02');
  assert.equal(week.end, '2026-11-09');

  const month = getPeriodBounds('month', NOW);
  assert.equal(month.start, '2026-11-01');
  assert.equal(month.end, '2026-12-01');

  const quarter = getPeriodBounds('quarter', NOW);
  assert.equal(quarter.start, '2026-09-01');
  assert.equal(quarter.end, '2026-12-01');

  const year = getPeriodBounds('year', NOW);
  assert.equal(year.start, '2026-01-01');
  assert.equal(year.end, '2027-01-01');
});

test('quarter rolls across a year boundary', () => {
  const bounds = getPeriodBounds('quarter', new Date(2027, 0, 15, 12));
  assert.equal(bounds.start, '2026-11-01');
  assert.equal(bounds.end, '2027-02-01');
});

test('elapsedDays counts elapsed calendar days inclusively', () => {
  assert.equal(elapsedDays('2026-11-01', '2026-12-01', NOW), 4);
  assert.equal(elapsedDays('2026-11-02', '2026-11-09', NOW), 3);
  assert.equal(elapsedDays('2026-11-01', '2026-12-01', new Date(2026, 11, 20, 12)), 30);
  // A future period should not produce a zero divisor.
  assert.equal(elapsedDays('2026-12-01', '2027-01-01', NOW), 1);
});

test('date parsing validates real calendar dates', () => {
  assert.ok(parseISODate('2026-02-28'));
  assert.equal(parseISODate('2026-02-30'), null);
  assert.equal(parseISODate('2026-13-01'), null);
  assert.equal(parseISODate('26-01-01'), null);
  assert.equal(toISODate(addDays(parseISODate('2026-12-31'), 1)), '2027-01-01');
});

test('money parsing accepts Indian formatting and rejects junk', () => {
  assert.equal(parseAmountInput('₹ 1,234.5'), 1234.5);
  assert.equal(parseAmountInput('.75'), 0.75);
  assert.equal(parseAmountInput('100'), 100);
  assert.ok(Number.isNaN(parseAmountInput('1.234')));
  assert.ok(Number.isNaN(parseAmountInput('12abc')));
  assert.ok(Number.isNaN(parseAmountInput('')));
  assert.match(formatMoney(1234.5), /1,234\.50/);
  assert.equal(formatMoneyParts(1234.5).currency, '₹');
  assert.equal(formatMoneyParts(1234.5).integer, '1,234');
  assert.equal(formatMoneyParts(1234.5).fraction, '50');
});

test('expense validation produces field errors', () => {
  assert.equal(validateExpenseInput({ amount: '0', description: 'Lunch', date: '2026-11-04' }).ok, false);
  assert.equal(validateExpenseInput({ amount: '50', description: '   ', date: '2026-11-04' }).ok, false);
  assert.equal(validateExpenseInput({ amount: '50', description: 'Lunch', date: '2026-02-30' }).ok, false);

  const good = validateExpenseInput({ amount: ' 1,250.555', description: '  Lunch   with team ', date: '2026-11-04' });
  assert.equal(good.ok, false); // three decimal places are rejected
  const rounded = validateExpenseInput({ amount: '1250.5', description: '  Lunch   with team ', date: '2026-11-04' });
  assert.equal(rounded.ok, true);
  assert.equal(rounded.value.amount, 1250.5);
  assert.equal(rounded.value.description, 'Lunch with team');
});

test('summaries match the required totals', () => {
  const summary = summarize(sample, NOW);
  assert.equal(summary.periods.week.total, 350);
  assert.equal(summary.periods.month.total, 350);
  assert.equal(summary.periods.quarter.total, 1050);
  assert.equal(summary.periods.year.total, 2050);
  assert.equal(summary.all.total, 2350);
  assert.equal(summary.all.count, 6);
  assert.equal(summary.periods.month.count, 2);
  assert.equal(summary.periods.month.dailyAverage, 87.5);
  assert.equal(summary.periods.week.dailyAverage, 116.67);
  assert.equal(summary.recent.length, 5);
  assert.equal(summary.recent[0].id, 'b');
  assert.equal(summary.recent[4].id, 'e');
});

test('week overview has Monday-first days and marks today', () => {
  const week = getWeekOverview(sample, NOW);
  assert.equal(week.days.length, 7);
  assert.equal(week.days[0].iso, '2026-11-02');
  assert.equal(week.days[0].amount, 100);
  assert.equal(week.days[1].amount, 0);
  assert.equal(week.days[2].amount, 250);
  assert.equal(week.days[2].isToday, true);
  assert.equal(week.days[6].isFuture, true);
  assert.equal(week.total, 350);
});

test('month overview groups days into weekly buckets and marks current bucket', () => {
  const month = getMonthOverview(sample, NOW);
  assert.equal(month.period, 'month');
  assert.equal(month.columns.length, 5); // Nov has 30 days -> 1-7, 8-14, 15-21, 22-28, 29-30
  assert.equal(month.columns[0].label, '1–7');
  assert.equal(month.columns[0].amount, 350); // Nov 2 (100) + Nov 4 (250)
  assert.equal(month.columns[0].isCurrent, true);
  assert.equal(month.columns[1].isCurrent, false);
  assert.equal(month.columns[1].isFuture, true);
  assert.equal(month.total, 350);
  assert.equal(month.max, 350);
});

test('quarter overview provides 3 rolling months and totals', () => {
  const quarter = getQuarterOverview(sample, NOW);
  assert.equal(quarter.period, 'quarter');
  assert.equal(quarter.columns.length, 3);
  assert.equal(quarter.columns[0].label, shortMonthLabel('2026-09'));
  assert.equal(quarter.columns[0].amount, 200);
  assert.equal(quarter.columns[1].label, shortMonthLabel('2026-10'));
  assert.equal(quarter.columns[1].amount, 500);
  assert.equal(quarter.columns[2].label, shortMonthLabel('2026-11'));
  assert.equal(quarter.columns[2].amount, 350);
  assert.equal(quarter.columns[2].isCurrent, true);
  assert.equal(quarter.total, 1050);
});

test('year overview provides 12 calendar months and highlights current month', () => {
  const year = getYearOverview(sample, NOW);
  assert.equal(year.period, 'year');
  assert.equal(year.columns.length, 12);
  assert.equal(year.columns[0].label, shortMonthLabel('2026-01'));
  assert.equal(year.columns[0].amount, 1000); // Rent
  assert.equal(year.columns[8].label, shortMonthLabel('2026-09'));
  assert.equal(year.columns[8].amount, 200);
  assert.equal(year.columns[9].label, shortMonthLabel('2026-10'));
  assert.equal(year.columns[9].amount, 500);
  assert.equal(year.columns[10].label, shortMonthLabel('2026-11'));
  assert.equal(year.columns[10].amount, 350);
  assert.equal(year.columns[10].isCurrent, true);
  assert.equal(year.columns[11].label, shortMonthLabel('2026-12'));
  assert.equal(year.columns[11].isFuture, true);
  assert.equal(year.total, 2050);
});

test('getPeriodChartData unifies chart properties across all 4 periods', () => {
  const weekData = getPeriodChartData(sample, 'week', NOW);
  assert.equal(weekData.period, 'week');
  assert.equal(weekData.columns.length, 7);

  const monthData = getPeriodChartData(sample, 'month', NOW);
  assert.equal(monthData.period, 'month');
  assert.equal(monthData.columns.length, 5);

  const quarterData = getPeriodChartData(sample, 'quarter', NOW);
  assert.equal(quarterData.period, 'quarter');
  assert.equal(quarterData.columns.length, 3);

  const yearData = getPeriodChartData(sample, 'year', NOW);
  assert.equal(yearData.period, 'year');
  assert.equal(yearData.columns.length, 12);
});

test('sorting is newest first with a stable tie-break', () => {
  const sorted = sortExpenses([
    { id: 'x', amount: 1, description: 'x', date: '2026-11-04', createdAt: '2026-11-04T01:00:00.000Z' },
    { id: 'y', amount: 1, description: 'y', date: '2026-11-04', createdAt: '2026-11-04T02:00:00.000Z' },
    { id: 'z', amount: 1, description: 'z', date: '2026-11-05', createdAt: '2026-11-05T01:00:00.000Z' }
  ]);
  assert.deepEqual(sorted.map(item => item.id), ['z', 'y', 'x']);
});

test('search matches descriptions, dates, months and amounts', () => {
  assert.equal(sample.filter(item => matchesQuery(item, 'petrol')).length, 1);
  assert.equal(sample.filter(item => matchesQuery(item, 'nov')).length, 2);
  assert.equal(sample.filter(item => matchesQuery(item, '2026-10')).length, 1);
  assert.equal(sample.filter(item => matchesQuery(item, '250')).length, 1);
  assert.equal(sample.filter(item => matchesQuery(item, '  ')).length, sample.length);
  assert.equal(sample.filter(item => matchesQuery(item, 'lunch 100')).length, 1);
});

test('history groups by calendar month with subtotals', () => {
  const groups = groupExpensesByMonth(sortExpenses(sample));
  assert.equal(groups[0].key, '2026-11');
  assert.equal(groups[0].label, 'November 2026');
  assert.equal(groups[0].total, 350);
  assert.equal(groups[0].count, 2);
  assert.equal(groups.at(-1).key, '2025-12');
});

test('legacy ids retain their original creation timestamp', () => {
  const timestamp = Date.UTC(2025, 4, 2, 8, 0, 0);
  const id = `${timestamp.toString(36)}abc123`;
  assert.equal(timestampFromLegacyId(id), new Date(timestamp).toISOString());
  assert.equal(timestampFromLegacyId('not-a-time-abc'), null);

  const record = normalizeExpenseRecord({
    id,
    amount: '99.999',
    description: '  Coffee  ',
    date: '2025-05-02'
  });
  assert.equal(record.ok, true);
  assert.equal(record.value.amount, 100);
  assert.equal(record.value.description, 'Coffee');
  assert.equal(record.value.createdAt, new Date(timestamp).toISOString());
  assert.equal(record.value.updatedAt, record.value.createdAt);
});

test('normalisation generates missing ids and rejects corrupt records', () => {
  let counter = 0;
  const makeId = () => `generated-${++counter}`;
  const record = normalizeExpenseRecord({ amount: 10, description: 'Tea', date: '2026-11-04' }, { makeId });
  assert.equal(record.ok, true);
  assert.equal(record.value.id, 'generated-1');
  assert.equal(record.value.createdAt, new Date(2026, 10, 4, 12).toISOString());

  assert.equal(normalizeExpenseRecord({ amount: -2, description: 'Tea', date: '2026-11-04' }).ok, false);
  assert.equal(normalizeExpenseRecord(null).ok, false);
  assert.equal(normalizeExpenseRecord({ id: 'x', amount: 10, description: 'Tea', date: '2026-11-31' }).ok, false);
});

test('display dates stay on the same local calendar day', () => {
  assert.equal(formatDate('2026-11-04'), '4 Nov 2026');
});
