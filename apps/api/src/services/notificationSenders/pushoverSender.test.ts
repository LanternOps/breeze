import { describe, expect, it, vi, afterEach } from 'vitest';
import { sendPushoverNotification, validatePushoverConfig } from './pushoverSender';

const basePayload = {
  alertId: 'alert-1',
  alertName: 'Disk full',
  severity: 'high' as const,
  summary: 'Disk usage 95%',
  orgId: 'org-1',
  triggeredAt: new Date().toISOString(),
};

describe('validatePushoverConfig', () => {
  it('rejects config without token', () => {
    const result = validatePushoverConfig({ user: 'u'.repeat(30) });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('token');
  });

  it('rejects config without user', () => {
    const result = validatePushoverConfig({ token: 't'.repeat(30) });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('user');
  });

  it('rejects token/user longer than 30 chars', () => {
    const result = validatePushoverConfig({ token: 't'.repeat(31), user: 'u'.repeat(31) });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('30 characters');
  });

  it('rejects invalid priority', () => {
    const result = validatePushoverConfig({ token: 't'.repeat(30), user: 'u'.repeat(30), priority: 5 as never });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('priority');
  });

  it('rejects emergency retry below 30 seconds', () => {
    const result = validatePushoverConfig({
      token: 't'.repeat(30),
      user: 'u'.repeat(30),
      priority: 2,
      retry: 10,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('retry');
  });

  it('rejects emergency expire above 10800 seconds', () => {
    const result = validatePushoverConfig({
      token: 't'.repeat(30),
      user: 'u'.repeat(30),
      priority: 2,
      expire: 20000,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('expire');
  });

  it('accepts a minimal valid config', () => {
    const result = validatePushoverConfig({ token: 't'.repeat(30), user: 'u'.repeat(30) });
    expect(result.valid).toBe(true);
  });
});

describe('sendPushoverNotification', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails closed without calling fetch when config is invalid', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await sendPushoverNotification({}, basePayload);
    expect(result.success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps severity → priority when config does not pin one', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 1, request: 'r-1' }), { status: 200 })
    );

    await sendPushoverNotification(
      { token: 't'.repeat(30), user: 'u'.repeat(30) },
      { ...basePayload, severity: 'critical' }
    );

    const body = new URLSearchParams((fetchSpy.mock.calls[0]?.[1]?.body as string) || '');
    expect(body.get('priority')).toBe('2');
    expect(body.get('retry')).toBe('60');
    expect(body.get('expire')).toBe('3600');
  });

  it('honors config-pinned priority over severity mapping', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 1, request: 'r-2' }), { status: 200 })
    );

    await sendPushoverNotification(
      { token: 't'.repeat(30), user: 'u'.repeat(30), priority: -1 },
      { ...basePayload, severity: 'critical' }
    );

    const lastFetch = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    const body = new URLSearchParams((lastFetch?.[1]?.body as string) || '');
    expect(body.get('priority')).toBe('-1');
    expect(body.get('retry')).toBeNull();
  });

  it('returns success when Pushover replies status=1', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 1, request: 'r-3' }), { status: 200 })
    );
    const result = await sendPushoverNotification(
      { token: 't'.repeat(30), user: 'u'.repeat(30) },
      basePayload
    );
    expect(result.success).toBe(true);
    expect(result.request).toBe('r-3');
  });

  it('returns failure with API error string when Pushover replies status=0', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 0, errors: ['user not found'], request: 'r-4' }), { status: 400 })
    );
    const result = await sendPushoverNotification(
      { token: 't'.repeat(30), user: 'u'.repeat(30) },
      basePayload
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('user not found');
    expect(result.statusCode).toBe(400);
  });

  it('reports timeout on AbortError', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    const result = await sendPushoverNotification(
      { token: 't'.repeat(30), user: 'u'.repeat(30) },
      basePayload
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });
});
