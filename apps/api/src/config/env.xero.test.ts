import { afterEach, describe, expect, it } from 'vitest';
import { xeroDailyCallLimit, xeroOAuthConfig, xeroWebhookKey, XERO_DEFAULT_DAILY_CALL_LIMIT } from './env';

const KEYS = ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'XERO_REDIRECT_URI', 'XERO_WEBHOOK_KEY', 'XERO_DAILY_CALL_LIMIT'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('Xero env readers (W02)', () => {
  it('reads OAuth credentials at call time, trimmed, empty when unset', () => {
    for (const k of KEYS) delete process.env[k];
    expect(xeroOAuthConfig()).toEqual({ clientId: '', clientSecret: '', redirectUri: '' });
    process.env.XERO_CLIENT_ID = '  abc  ';
    process.env.XERO_CLIENT_SECRET = 's';
    process.env.XERO_REDIRECT_URI = 'https://breeze.example.com/api/v1/accounting/xero/callback';
    expect(xeroOAuthConfig()).toEqual({ clientId: 'abc', clientSecret: 's', redirectUri: 'https://breeze.example.com/api/v1/accounting/xero/callback' });
  });

  it('webhook key is empty when unset', () => {
    delete process.env.XERO_WEBHOOK_KEY;
    expect(xeroWebhookKey()).toBe('');
  });

  it.each([
    [undefined, 1000], ['', 1000], ['5000', 5000], ['0', 1000], ['-3', 1000], ['lots', 1000], ['12.5', 1000],
  ])('XERO_DAILY_CALL_LIMIT=%s → %d', (raw, expected) => {
    if (raw === undefined) delete process.env.XERO_DAILY_CALL_LIMIT; else process.env.XERO_DAILY_CALL_LIMIT = raw;
    expect(xeroDailyCallLimit()).toBe(expected);
    expect(XERO_DEFAULT_DAILY_CALL_LIMIT).toBe(1000);
  });
});
