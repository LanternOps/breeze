import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const files = ['components/auth/PartnerRegisterForm.tsx', 'components/auth/PartnerRegisterPage.tsx', 'lib/signupOffer.ts'];

describe('register page holds no price', () => {
  it.each(files)('%s has no LAUNCH_ constant and no 999', (file) => {
    const source = readFileSync(resolve(__dirname, '../..', file), 'utf8');
    expect(source).not.toMatch(/LAUNCH_/);
    expect(source).not.toContain('999');
  });
});
