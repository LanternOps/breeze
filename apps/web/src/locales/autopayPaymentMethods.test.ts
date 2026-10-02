import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = dirname(fileURLToPath(import.meta.url));
describe('autopay payment method locale labels', () => {
  it.each(readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name))('%s includes an ACH debit label', locale => {
    const data = JSON.parse(readFileSync(join(root, locale, 'billing.json'), 'utf8'));
    expect(data.invoiceDetail.paymentMethods.ach_debit).toBe('ACH debit');
  });
});
