import test from 'node:test';
import assert from 'node:assert/strict';
import { currencyScale, formatMinor, majorToMinor, minorToMajor, invoiceTotals } from '../shared/invoice-money.mjs';

test('currency minor units support zero, two and three decimal places', () => {
  for (const [currency, scale, major, minor] of [['JPY', 1, '1234', 1234], ['INR', 100, '1234.56', 123456], ['KWD', 1000, '1234.567', 1234567]]) {
    assert.equal(currencyScale(currency), scale);
    assert.equal(majorToMinor(major, currency), minor);
    assert.equal(minorToMajor(minor, currency), major);
    assert.equal(formatMinor(minor, currency), new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(Number(major)));
  }
});

test('decimal input is parsed without floating point multiplication', () => {
  assert.equal(majorToMinor('1.005', 'KWD'), 1005);
  assert.equal(majorToMinor('0.29', 'INR'), 29);
  assert.equal(majorToMinor(' .50 ', 'INR'), 50);
  assert.equal(majorToMinor('001.', 'INR'), 100);
  assert.equal(majorToMinor('1.', 'JPY'), 1);
  assert.equal(majorToMinor('', 'INR'), null);
  assert.equal(majorToMinor(' . ', 'INR'), null);
  for (const input of ['1.001', '1.000', '-1', '1e3', '1,000', 'NaN', 'Infinity']) assert.throws(() => majorToMinor(input, 'INR'), RangeError);
  assert.throws(() => majorToMinor('1.1', 'JPY'), RangeError);
  assert.throws(() => majorToMinor(1.25, 'INR'), RangeError);
});

test('safe integer boundaries round-trip and format exact final minor units', () => {
  assert.equal(majorToMinor('90071992547409.91'), Number.MAX_SAFE_INTEGER);
  assert.equal(minorToMajor(Number.MAX_SAFE_INTEGER), '90071992547409.91');
  assert.equal(formatMinor(Number.MAX_SAFE_INTEGER), '₹9,00,71,99,25,47,409.91');
  assert.throws(() => majorToMinor('90071992547409.92'), RangeError);
  for (const invalid of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.throws(() => minorToMajor(invalid), RangeError);
    assert.throws(() => formatMinor(invalid), RangeError);
  }
  assert.throws(() => currencyScale('inr'), RangeError);
  assert.throws(() => currencyScale('INVALID'), RangeError);
});

test('tax is rounded half up per line, not once on the combined subtotal', () => {
  const line = { quantity: 1, unitPriceMinor: 1, taxRateBps: 5000 };
  assert.deepEqual(invoiceTotals([line, line]), { subtotalMinor: 2, taxMinor: 2, totalMinor: 4 });
  assert.deepEqual(invoiceTotals([{ ...line, taxRateBps: 4999 }]), { subtotalMinor: 1, taxMinor: 0, totalMinor: 1 });
  assert.deepEqual(invoiceTotals([]), { subtotalMinor: 0, taxMinor: 0, totalMinor: 0 });
});

test('large valid invoice tax matches integer server arithmetic', () => {
  const line = { unitPriceMinor: 99_999_999_900, quantity: 901, taxRateBps: 950 };
  assert.equal(Math.round(line.unitPriceMinor * line.quantity * line.taxRateBps / 10000), 8_559_499_991_440);
  assert.deepEqual(invoiceTotals([line]), { subtotalMinor: 90_099_999_909_900, taxMinor: 8_559_499_991_441, totalMinor: 98_659_499_901_341 });
});

test('invoice amount limits reject unsupported input instead of displaying zero', () => {
  const valid = { quantity: 1, unitPriceMinor: 100, taxRateBps: 0 };
  for (const patch of [{ quantity: 0 }, { quantity: 10001 }, { quantity: 1.5 }, { unitPriceMinor: -1 }, { unitPriceMinor: 1_000_000_000_001 }, { taxRateBps: 10001 }, { taxRateBps: NaN }, { unitPriceMinor: null }]) {
    assert.throws(() => invoiceTotals([{ ...valid, ...patch }]), RangeError);
  }
  assert.throws(() => invoiceTotals(Array(101).fill(valid)), RangeError);
  assert.throws(() => invoiceTotals([{ ...valid, quantity: 101, unitPriceMinor: 1_000_000_000_000 }]), RangeError);
  assert.deepEqual(invoiceTotals([{ ...valid, quantity: 100, unitPriceMinor: 1_000_000_000_000 }]), { subtotalMinor: 100_000_000_000_000, taxMinor: 0, totalMinor: 100_000_000_000_000 });
});
