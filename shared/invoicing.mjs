export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const normalizeGstin = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
// This checks the optional identifier's structure, not registration or tax treatment.
export const validGstin = value => typeof value === 'string' && (value.trim() === '' || GSTIN_PATTERN.test(normalizeGstin(value)));
export const isProforma = value => (typeof value === 'string' ? value : value?.documentType) === 'proforma';
export const documentLabel = value => isProforma(value) ? 'Proforma Invoice' : 'Invoice';
export function formatPartyAddress(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const text = key => typeof value[key] === 'string' ? value[key].trim() : '';
  return [text('address'), ['city','region','postal'].map(text).filter(Boolean).join(', '), text('country')].filter(Boolean).join('\n');
}
