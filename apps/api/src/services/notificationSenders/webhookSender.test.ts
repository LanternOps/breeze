import { afterEach, describe, expect, it } from 'vitest';
import {
  sendWebhookNotification,
  validateWebhookConfig,
  validateWebhookUrlSafety,
  redactUrlForLogs
} from './webhookSender';
import { __setLookupForTests } from '../urlSafety';

const basePayload = {
  alertId: 'alert-1',
  alertName: 'Test Alert',
  severity: 'high',
  summary: 'summary',
  orgId: 'org-1',
  triggeredAt: new Date().toISOString()
};

describe('webhook sender safety', () => {
  afterEach(() => {
    __setLookupForTests(null);
  });

  it('rejects non-https and private URLs during config validation', () => {
    const result = validateWebhookConfig({
      url: 'http://127.0.0.1/webhook',
      method: 'POST'
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('HTTPS');
  });

  it('returns safety errors for loopback targets', () => {
    const errors = validateWebhookUrlSafety('https://127.0.0.1/webhook');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('fails closed before any network I/O when webhook URL is a literal private IP', async () => {
    // Swap in a lookup hook that throws if called, so we can prove the static
    // check shortcuts before DNS.
    __setLookupForTests(async () => {
      throw new Error('DNS should not have been invoked');
    });

    const result = await sendWebhookNotification(
      { url: 'http://169.254.169.254/latest/meta-data', method: 'POST' },
      basePayload
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unsafe webhook URL');
  });

  it('rejects when DNS resolves to a private address (post-validation TOCTOU defense)', async () => {
    __setLookupForTests(async () => [{ address: '10.0.0.1', family: 4 }]);

    const result = await sendWebhookNotification(
      { url: 'https://sneaky-rebind.example/hook', method: 'POST' },
      basePayload
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unsafe webhook URL');
  });
});

describe('redactUrlForLogs', () => {
  it('strips query params and credentials', () => {
    expect(redactUrlForLogs('https://user:pass@example.com/hook?secret=abc'))
      .toBe('https://example.com/hook');
  });

  it('preserves path without sensitive parts', () => {
    expect(redactUrlForLogs('https://example.com/webhook/v2'))
      .toBe('https://example.com/webhook/v2');
  });

  it('returns [invalid-url] for garbage input', () => {
    expect(redactUrlForLogs('not-a-url')).toBe('[invalid-url]');
  });

  it('preserves port numbers', () => {
    expect(redactUrlForLogs('https://example.com:8443/hook'))
      .toBe('https://example.com:8443/hook');
  });

  it('strips hash fragments', () => {
    expect(redactUrlForLogs('https://example.com/hook#section'))
      .toBe('https://example.com/hook');
  });
});
