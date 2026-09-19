import { describe, expect, it, vi } from 'vitest';

vi.mock('./secretCrypto', () => ({
  // Mirrors the real contract: returns the plaintext, and THROWS on a value
  // that looks encrypted but cannot be decrypted.
  decryptForColumn: vi.fn((_t: string, _c: string, value: string) => {
    if (value.startsWith('enc:bad')) throw new Error('decrypt failed: AAD mismatch');
    return value.startsWith('enc:') ? value.slice(4) : value;
  })
}));

vi.mock('./notificationChannelSecrets', () => ({
  // NOT identity. An identity mock cannot tell whether `toWebhookConfig`
  // actually WRAPS the headers in decryptWebhookHeaders — dropping that wrap
  // (and shipping still-ENCRYPTED header values to the customer's endpoint)
  // stayed green. This transforms, so the assertion can see the difference.
  decryptWebhookHeaders: vi.fn((headers: unknown) => {
    if (Array.isArray(headers)) {
      return headers.map((h) => (h && typeof h === 'object' && typeof (h as { value?: unknown }).value === 'string'
        ? { ...h, value: (h as { value: string }).value.replace(/^enc:/, '') }
        : h));
    }
    if (headers && typeof headers === 'object') {
      return Object.fromEntries(
        Object.entries(headers as Record<string, unknown>).map(([k, v]) => [
          k,
          typeof v === 'string' ? v.replace(/^enc:/, '') : v
        ])
      );
    }
    return headers;
  })
}));

import { headersToRecord, toWebhookConfig } from './webhookConfig';
import { decryptWebhookHeaders } from './notificationChannelSecrets';

const base = {
  id: 'webhook-1',
  orgId: 'org-1',
  name: 'Ops hook',
  url: 'enc:https://example.test/hook',
  secret: null as string | null,
  events: ['*'],
  headers: null as unknown,
  retryPolicy: null as unknown
};

describe('headersToRecord', () => {
  it('flattens the {key,value} array shape the UI editor writes', () => {
    expect(headersToRecord([
      { key: 'X-Token', value: 'abc' },
      { key: 'X-Other', value: 'def' }
    ])).toEqual({ 'X-Token': 'abc', 'X-Other': 'def' });
  });

  it('passes through the plain-object shape', () => {
    expect(headersToRecord({ 'X-Token': 'abc' })).toEqual({ 'X-Token': 'abc' });
  });

  it('drops entries whose value is not a string rather than coercing them', () => {
    // A coerced non-string lands in the outbound request as "[object Object]",
    // which the customer sees and cannot explain.
    expect(headersToRecord({ ok: 'yes', bad: { nested: true }, alsoBad: 42 }))
      .toEqual({ ok: 'yes' });
    expect(headersToRecord([
      { key: 'ok', value: 'yes' },
      { key: 'bad', value: { nested: true } },
      { novalue: 'x' }
    ])).toEqual({ ok: 'yes' });
  });

  it('treats absent or non-object headers as empty', () => {
    expect(headersToRecord(null)).toEqual({});
    expect(headersToRecord(undefined)).toEqual({});
    expect(headersToRecord('nonsense')).toEqual({});
  });
});

describe('toWebhookConfig', () => {
  it('decrypts the url and leaves an absent secret undefined', () => {
    const config = toWebhookConfig({ ...base });

    expect(config.url).toBe('https://example.test/hook');
    expect(config.secret).toBeUndefined();
  });

  it('decrypts a present secret', () => {
    // The truthy `secret` branch: this is the HMAC signing key, and shipping it
    // still-encrypted would make every signature the customer verifies wrong.
    const config = toWebhookConfig({ ...base, secret: 'enc:shh' });

    expect(config.secret).toBe('shh');
  });

  it('DECRYPTS headers, not merely normalises their shape', () => {
    const config = toWebhookConfig({
      ...base,
      headers: [{ key: 'X-Token', value: 'enc:abc' }]
    });

    // The `enc:` prefix is gone, which is only true if the decrypt wrap ran.
    // Shipping the raw stored value here would send an encrypted credential to
    // the customer's endpoint as a live header.
    expect(config.headers).toEqual({ 'X-Token': 'abc' });
    expect(vi.mocked(decryptWebhookHeaders)).toHaveBeenCalledWith([
      { key: 'X-Token', value: 'enc:abc' }
    ]);
  });

  it('decrypts headers in the plain-object shape too', () => {
    const config = toWebhookConfig({ ...base, headers: { 'X-Token': 'enc:abc' } });

    expect(config.headers).toEqual({ 'X-Token': 'abc' });
  });

  it('falls back to the stored value for legacy plaintext', () => {
    const config = toWebhookConfig({ ...base, url: 'https://plain.test/hook' });

    expect(config.url).toBe('https://plain.test/hook');
  });

  it('THROWS on an undecryptable row rather than delivering with bad credentials', () => {
    // Both callers rely on this to isolate the row: delivering with unusable
    // credentials is worse than not delivering.
    expect(() => toWebhookConfig({ ...base, url: 'enc:bad' })).toThrow(/AAD mismatch/);
  });

  it('normalises a missing events array to empty', () => {
    expect(toWebhookConfig({ ...base, events: null }).events).toEqual([]);
  });
});
