import { afterEach, describe, expect, it, vi } from 'vitest';

// `validateWebhookUrlSafetyWithDns` resolves the hostname via a dynamic
// `import('dns/promises')`, which `__setLookupForTests` (a urlSafety/safeFetch
// hook) does NOT intercept. Without this mock the lookup simply fails and the
// "rejects" assertions pass for the wrong reason.
const { dnsLookupMock } = vi.hoisted(() => ({ dnsLookupMock: vi.fn() }));
vi.mock('dns/promises', () => ({
  lookup: dnsLookupMock,
  default: { lookup: dnsLookupMock },
}));
import {
  sendWebhookNotification,
  validateWebhookConfig,
  validateWebhookUrlSafety,
  validateWebhookUrlSafetyWithDns,
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

  it('rejects reserved outbound headers in channel config', () => {
    const result = validateWebhookConfig({
      url: 'https://example.com/webhook',
      method: 'POST',
      headers: {
        Host: '169.254.169.254',
        'X-Breeze-Event-Type': 'forged'
      }
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('reserved');
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

/**
 * Self-hosted private-network opt-in (#2293 gate, reused).
 *
 * A self-hosted operator's webhook receiver — SIEM, log collector, ticketing —
 * normally lives on their own LAN and often speaks plain http. Hosted SaaS must
 * never dial those, so the gate is `selfHostAllowsPrivateNetwork()` from
 * config/env: it opens ONLY on an affirmative IS_HOSTED self-host declaration.
 *
 * The security-relevant half of this block is the "still rejected" cases: the
 * opt-in must widen the target space to RFC1918/ULA only, and must NOT become a
 * general SSRF escape hatch. Loopback, link-local, cloud metadata and CGNAT stay
 * blocked in both modes.
 */
describe('webhook URL safety — self-hosted private-network opt-in', () => {
  afterEach(() => {
    delete process.env.IS_HOSTED;
    dnsLookupMock.mockReset();
    __setLookupForTests(null);
  });

  describe('hosted / undeclared (default) stays strict', () => {
    it('rejects plain http even to an RFC1918 address', () => {
      delete process.env.IS_HOSTED;
      expect(validateWebhookUrlSafety('http://10.1.2.3/collector').join(' ')).toContain('HTTPS');
    });

    it('rejects an RFC1918 target over https', () => {
      delete process.env.IS_HOSTED;
      expect(validateWebhookUrlSafety('https://10.1.2.3/hook').length).toBeGreaterThan(0);
    });

    it.each(['true', '1', 'yes', 'on', '', 'garbage'])(
      'stays strict when IS_HOSTED=%j (fail-closed)',
      (value) => {
        process.env.IS_HOSTED = value;
        expect(validateWebhookUrlSafety('https://10.1.2.3/hook').length).toBeGreaterThan(0);
      }
    );
  });

  describe('affirmatively self-hosted opens RFC1918/ULA + http', () => {
    it.each(['false', '0', 'no', 'off', 'FALSE', ' off '])(
      'accepts an on-LAN http receiver when IS_HOSTED=%j',
      (value) => {
        process.env.IS_HOSTED = value;
        expect(validateWebhookUrlSafety('http://10.1.2.3/collector')).toEqual([]);
      }
    );

    it('accepts the other RFC1918 ranges and ULA over https', () => {
      process.env.IS_HOSTED = 'false';
      expect(validateWebhookUrlSafety('https://192.168.1.10/hook')).toEqual([]);
      expect(validateWebhookUrlSafety('https://172.16.4.4/hook')).toEqual([]);
      expect(validateWebhookUrlSafety('https://[fd00::1]/hook')).toEqual([]);
    });
  });

  describe('the opt-in is NOT an SSRF escape hatch', () => {
    it.each([
      ['loopback v4', 'https://127.0.0.1/hook'],
      ['loopback v6', 'https://[::1]/hook'],
      ['link-local', 'https://169.254.1.1/hook'],
      ['cloud metadata', 'https://169.254.169.254/latest/meta-data/'],
      ['alibaba metadata', 'https://100.100.100.200/hook'],
      ['CGNAT / tailnet', 'https://100.64.5.5/hook'],
      ['localhost name', 'https://localhost/hook'],
    ])('still rejects %s when self-hosted', (_label, url) => {
      process.env.IS_HOSTED = 'false';
      expect(validateWebhookUrlSafety(url).length).toBeGreaterThan(0);
    });
  });

  describe('DNS-resolved targets honour the same policy', () => {
    it('accepts a hostname resolving to RFC1918 when self-hosted', async () => {
      process.env.IS_HOSTED = 'false';
      dnsLookupMock.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
      await expect(validateWebhookUrlSafetyWithDns('https://logs.internal.example/hook')).resolves.toEqual([]);
    });

    it('still refuses a hostname resolving to cloud metadata when self-hosted', async () => {
      process.env.IS_HOSTED = 'false';
      dnsLookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
      const errors = await validateWebhookUrlSafetyWithDns('https://sneaky.example/hook');
      // Not vacuous: the same stub returning 10.1.2.3 above yields [].
      expect(errors.join(' ')).toContain('blocked address space');
    });

    it('refuses a hostname resolving to RFC1918 when NOT self-hosted', async () => {
      delete process.env.IS_HOSTED;
      dnsLookupMock.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
      const errors = await validateWebhookUrlSafetyWithDns('https://logs.internal.example/hook');
      expect(errors.join(' ')).toContain('blocked address space');
    });
  });
});
