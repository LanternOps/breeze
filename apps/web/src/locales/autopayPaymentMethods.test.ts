import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = dirname(fileURLToPath(import.meta.url));
const locales = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
const achLabel = (locale: string): unknown =>
  JSON.parse(readFileSync(join(root, locale, 'billing.json'), 'utf8')).invoiceDetail.paymentMethods.ach_debit;
describe('autopay payment method locale labels', () => {
  it('en labels ACH debit', () => {
    expect(achLabel('en')).toBe('ACH debit');
  });
  // A copied English value counts against translationCoverage's duplicate baseline.
  it.each(locales.filter(l => l !== 'en'))('%s translates the ACH debit label', locale => {
    const label = achLabel(locale);
    expect(typeof label === 'string' && label.includes('ACH')).toBe(true);
    expect(label).not.toBe('ACH debit');
    // Guards a double-encoded write ("DÃ©bito") slipping through as "translated".
    expect(label).not.toMatch(/Ã|Â/);
  });
});
