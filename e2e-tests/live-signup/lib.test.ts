import { describe, it, expect } from 'vitest';
import { makeIdentity } from './identity';
import { extractVerifyToken } from './resendClient';

describe('makeIdentity', () => {
  it('produces a canary-prefixed @2breeze.app email matching the API latch', () => {
    const id = makeIdentity('run123', 'ui');
    expect(id.email).toMatch(/^signup-canary\+run123-ui@2breeze\.app$/);
    expect(id.companyName.length).toBeGreaterThanOrEqual(2);
    expect(id.password.length).toBeGreaterThanOrEqual(12);
  });
});

describe('extractVerifyToken', () => {
  it('pulls the 48-char token out of a verify-email link', () => {
    const tok = 'A'.repeat(48);
    const html = `<a href="https://us.2breeze.app/auth/verify-email?token=${tok}">Verify</a>`;
    expect(extractVerifyToken(html)).toBe(tok);
  });
  it('returns null when no token present', () => {
    expect(extractVerifyToken('<p>no link here</p>')).toBeNull();
  });
});
