// Invoice amounts use the currency's minor units; tax rates use basis points.
// Keep arithmetic in integers until formatting, including half-up tax rounding.
const MAX_DOCUMENT_MINOR = 100_000_000_000_000n;
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

function formatter(currency = 'INR') {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new RangeError('Use a three-letter uppercase currency code.');
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency });
}

export function currencyScale(currency = 'INR') {
  return 10 ** formatter(currency).resolvedOptions().maximumFractionDigits;
}

function integer(value, name, maximum = Number.MAX_SAFE_INTEGER, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${name} is outside the supported range.`);
  return BigInt(value);
}

export function minorToMajor(value, currency = 'INR') {
  const minor = integer(value, 'Amount');
  const scale = BigInt(currencyScale(currency));
  const digits = scale.toString().length - 1;
  return `${minor / scale}${digits ? `.${(minor % scale).toString().padStart(digits, '0')}` : ''}`;
}

// Empty input and a lone decimal point are incomplete edits, not zero amounts.
// All other invalid values throw; callers must keep the input or show an error.
export function majorToMinor(value, currency = 'INR') {
  const scale = BigInt(currencyScale(currency));
  if (typeof value !== 'string') throw new RangeError('Enter the amount as a decimal string.');
  const input = value.trim();
  if (input === '' || input === '.') return null;
  const match = /^(\d*)(?:\.(\d*))?$/.exec(input);
  if (!match || (!match[1] && !match[2])) throw new RangeError('Enter a nonnegative decimal amount without separators.');
  const digits = scale.toString().length - 1;
  const fraction = match[2] || '';
  if (fraction.length > digits) throw new RangeError(`${currency} supports ${digits} decimal places.`);
  const result = BigInt(match[1] || '0') * scale + BigInt(fraction.padEnd(digits, '0') || '0');
  if (result > MAX_SAFE_MINOR) throw new RangeError('Amount is outside the supported range.');
  return Number(result);
}

export function formatMinor(value, currency = 'INR') {
  const minor = integer(value, 'Amount');
  const format = formatter(currency);
  const digits = format.resolvedOptions().maximumFractionDigits;
  const scale = 10n ** BigInt(digits);
  const fraction = (minor % scale).toString().padStart(digits, '0');
  // Formatting the whole portion as BigInt avoids losing a cent at large values.
  return format.formatToParts(minor / scale).map(part => part.type === 'fraction' ? fraction : part.value).join('');
}

export function invoiceTotals(items) {
  if (!Array.isArray(items) || items.length > 100) throw new RangeError('An invoice supports up to 100 line items.');
  let subtotal = 0n;
  let tax = 0n;
  for (const item of items) {
    if (!item || typeof item !== 'object') throw new RangeError('Enter a valid line item.');
    const quantity = integer(item.quantity, 'Quantity', 10_000, 1);
    const price = integer(item.unitPriceMinor, 'Unit price', 1_000_000_000_000);
    const rate = integer(item.taxRateBps, 'Tax rate', 10_000);
    const line = quantity * price;
    subtotal += line;
    tax += (line * rate + 5000n) / 10000n;
  }
  if (subtotal + tax > MAX_DOCUMENT_MINOR) throw new RangeError('Document total exceeds the supported amount.');
  return { subtotalMinor: Number(subtotal), taxMinor: Number(tax), totalMinor: Number(subtotal + tax) };
}
