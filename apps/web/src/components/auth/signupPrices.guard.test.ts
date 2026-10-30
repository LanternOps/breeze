import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const files = ['components/auth/PartnerRegisterForm.tsx', 'components/auth/PartnerRegisterPage.tsx', 'lib/signupOffer.ts'];
// A dollar amount, or a bare figure such as 9900 or 19900 (cents) or 100000.
const PRICE = /\$\s?\d|\b\d{3,}00\b/;

const localesDir = resolve(__dirname, '../../locales');
const locales = readdirSync(localesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

describe('register page holds no price', () => {
  it.each(files)('%s has no LAUNCH_ constant, no 999 and no price figure', (file) => {
    const source = readFileSync(resolve(__dirname, '../..', file), 'utf8');
    expect(source).not.toMatch(/LAUNCH_/);
    expect(source).not.toContain('999');
    expect(source).not.toMatch(PRICE);
  });

  it('checks all eight locales', () => {
    expect(locales).toHaveLength(8);
  });

  it.each(locales)('%s partnerRegister.purchase strings hold no price figure', (locale) => {
    const auth = JSON.parse(readFileSync(resolve(localesDir, locale, 'auth.json'), 'utf8'));
    const purchase = auth.partnerRegister.purchase as Record<string, string>;
    expect(Object.keys(purchase).length).toBeGreaterThan(0);
    for (const [key, text] of Object.entries(purchase)) {
      expect(text, `${locale} partnerRegister.purchase.${key}`).not.toMatch(PRICE);
    }
  });
});
