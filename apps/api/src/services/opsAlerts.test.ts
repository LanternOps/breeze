import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./urlSafety', () => ({
  safeFetch: vi.fn(),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));
vi.mock('./email', () => ({ getEmailService: vi.fn(() => null) }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./abuseMetrics', () => ({ recordOpsAlertDelivery: vi.fn() }));

import { safeFetch } from './urlSafety';
import { getEmailService } from './email';
import { captureException } from './sentry';
import { recordOpsAlertDelivery } from './abuseMetrics';
import { sendOpsAlert, isOpsAlertingConfigured, opsText, singleLine } from './opsAlerts';

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
    expect(recordOpsAlertDelivery).toHaveBeenCalledWith('webhook', 'success');
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
    expect(captureException).toHaveBeenCalled();
    expect(recordOpsAlertDelivery).toHaveBeenCalledWith('webhook', 'failure');
  });

  it('surfaces a non-2xx webhook response to Sentry and the delivery metric, with a body snippet', async () => {
    vi.mocked(safeFetch).mockResolvedValue(
      new Response('{"message":"rate limited"}', { status: 429 }),
    );
    const ok = await sendOpsAlert({ title: 'T', body: 'b' });
    expect(ok).toBe(false);
    expect(captureException).toHaveBeenCalledTimes(1);
    const err = vi.mocked(captureException).mock.calls[0]![0] as Error;
    expect(err.message).toContain('429');
    expect(err.message).toContain('rate limited');
    expect(recordOpsAlertDelivery).toHaveBeenCalledWith('webhook', 'failure');
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

describe('opsText (tenant-controlled text in a chat alert)', () => {
  const hostile = '**Acme** [click](https://evil.example/x) @everyone <@123456> `code` https://evil.example\n# header\n> quote';

  it('leaves no live markdown, link or mention syntax', () => {
    const out = opsText(hostile);
    expect(out).not.toMatch(/\n/);
    expect(out).not.toMatch(/(^|[^\\])[*_`~|>#\[\]()<]/);
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).not.toMatch(/@(?!\u200b)/);
    expect(out).toContain('Acme');
  });

  it('caps length with an ellipsis', () => {
    const out = opsText('a'.repeat(500), 80);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('…')).toBe(true);
  });

  it('passes plain names through untouched', () => {
    expect(opsText('Acme Managed IT')).toBe('Acme Managed IT');
  });
});

describe('sendOpsAlert mention suppression', () => {
  it('sends allowed_mentions with an empty parse list', async () => {
    vi.mocked(safeFetch).mockResolvedValue(new Response(null, { status: 204 }));
    await sendOpsAlert({ title: 'T', body: '@everyone' });
    const [, init] = vi.mocked(safeFetch).mock.calls[0]!;
    expect(JSON.parse(init!.body as string).allowed_mentions).toEqual({ parse: [] });
  });
});

describe('singleLine / opsText (forged-field defence)', () => {
  it.each(['\n', '\r\n', '\u2028', '\u2029', '\u0085', '\v', '\f', '\u202e'])(
    'collapses %j so "Risk: none" cannot start its own line',
    (nl) => {
      for (const out of [singleLine(`a${nl}Risk: none${nl}Verdict: approve`), opsText(`a${nl}Risk: none${nl}Verdict: approve`)]) {
        expect(out).toBe('a Risk: none Verdict: approve');
        expect(out).not.toMatch(/[\n\r\u2028\u2029\u0085\u202e]/);
      }
    },
  );

  it('caps singleLine length', () => {
    expect(singleLine('x'.repeat(500), 20)).toHaveLength(20);
  });
});
