import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./urlSafety', () => ({
  safeFetch: vi.fn(),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));
vi.mock('./email', () => ({ getEmailService: vi.fn(() => null) }));

import { safeFetch } from './urlSafety';
import { getEmailService } from './email';
import { sendOpsAlert, isOpsAlertingConfigured } from './opsAlerts';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPS_ALERT_WEBHOOK_URL = 'https://discord.example.com/api/webhooks/x/y';
  delete process.env.OPS_ALERT_EMAIL;
  delete process.env.OPS_ALERT_LABEL;
});
afterEach(() => {
  delete process.env.OPS_ALERT_WEBHOOK_URL;
});

describe('sendOpsAlert', () => {
  it('POSTs Discord-format content and returns true on 2xx', async () => {
    vi.mocked(safeFetch).mockResolvedValue(new Response(null, { status: 204 }));
    const ok = await sendOpsAlert({ title: 'Test alert', body: 'evidence here' });
    expect(ok).toBe(true);
    const [url, init] = vi.mocked(safeFetch).mock.calls[0]!;
    expect(url).toBe(process.env.OPS_ALERT_WEBHOOK_URL);
    expect(JSON.parse(init!.body as string).content).toContain('Test alert');
  });

  it('prefixes the title with OPS_ALERT_LABEL when set', async () => {
    process.env.OPS_ALERT_LABEL = 'US';
    vi.mocked(safeFetch).mockResolvedValue(new Response(null, { status: 204 }));
    await sendOpsAlert({ title: 'Test', body: 'b' });
    const [, init] = vi.mocked(safeFetch).mock.calls[0]!;
    expect(JSON.parse(init!.body as string).content).toContain('[US]');
  });

  it('truncates content to Discord 2000-char limit', async () => {
    vi.mocked(safeFetch).mockResolvedValue(new Response(null, { status: 204 }));
    await sendOpsAlert({ title: 'T', body: 'x'.repeat(3000) });
    const [, init] = vi.mocked(safeFetch).mock.calls[0]!;
    expect(JSON.parse(init!.body as string).content.length).toBeLessThanOrEqual(2000);
  });

  it('returns false when no channel is configured, warning once', async () => {
    delete process.env.OPS_ALERT_WEBHOOK_URL;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await sendOpsAlert({ title: 'T', body: 'b' })).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('returns false on webhook failure and does not throw', async () => {
    vi.mocked(safeFetch).mockRejectedValue(new Error('network down'));
    expect(await sendOpsAlert({ title: 'T', body: 'b' })).toBe(false);
  });

  it('falls back to email channel when configured', async () => {
    delete process.env.OPS_ALERT_WEBHOOK_URL;
    process.env.OPS_ALERT_EMAIL = 'ops@example.com';
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getEmailService).mockReturnValue({ sendEmail } as never);
    expect(await sendOpsAlert({ title: 'T', body: 'b' })).toBe(true);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'ops@example.com' }));
  });
});

describe('isOpsAlertingConfigured', () => {
  it('reflects env state', () => {
    expect(isOpsAlertingConfigured()).toBe(true);
    delete process.env.OPS_ALERT_WEBHOOK_URL;
    expect(isOpsAlertingConfigured()).toBe(false);
  });

  it('treats whitespace-only values as unconfigured', () => {
    process.env.OPS_ALERT_WEBHOOK_URL = '   ';
    expect(isOpsAlertingConfigured()).toBe(false);
  });
});

describe('sendOpsAlert unconfigured warning latch', () => {
  it('warns only once across multiple calls within the same module instance', async () => {
    vi.resetModules();
    const urlSafety = await import('./urlSafety');
    vi.mocked(urlSafety.safeFetch).mockResolvedValue(new Response(null, { status: 204 }));
    delete process.env.OPS_ALERT_WEBHOOK_URL;
    delete process.env.OPS_ALERT_EMAIL;
    const { sendOpsAlert: freshSendOpsAlert } = await import('./opsAlerts');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opsAlertsCallCount = () =>
      warn.mock.calls.filter((call) => String(call[0]).includes('[OpsAlerts]')).length;
    expect(await freshSendOpsAlert({ title: 'T', body: 'b' })).toBe(false);
    expect(opsAlertsCallCount()).toBe(1);
    expect(await freshSendOpsAlert({ title: 'T2', body: 'b2' })).toBe(false);
    expect(opsAlertsCallCount()).toBe(1);
  });
});
