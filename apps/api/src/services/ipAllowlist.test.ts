import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluateIpAllowlist } from './ipAllowlist';
import { readPartnerAllowlist, clearPartnerAllowlistCache } from './ipAllowlist';

vi.mock('../db', () => {
  const limit = vi.fn();
  return {
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit }) }) }),
      __limit: limit,
    },
    hasDbAccessContext: vi.fn(() => true),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

describe('evaluateIpAllowlist', () => {
  const base = {
    mode: 'enforce' as const,
    allowlist: ['203.0.113.0/24'],
    clientIp: '203.0.113.10' as string | undefined,
    isPlatformAdmin: false,
  };

  it('allows when the client IP matches', () => {
    expect(evaluateIpAllowlist(base)).toEqual({ decision: 'allow' });
  });

  it('denies when the client IP does not match', () => {
    expect(evaluateIpAllowlist({ ...base, clientIp: '198.51.100.1' })).toEqual({
      decision: 'deny',
      reason: 'not_in_list',
    });
  });

  it('skips when mode is off', () => {
    expect(evaluateIpAllowlist({ ...base, mode: 'off', clientIp: '198.51.100.1' })).toEqual({
      decision: 'skip',
      reason: 'mode_off',
    });
  });

  it('skips when the allowlist is empty or undefined', () => {
    expect(evaluateIpAllowlist({ ...base, allowlist: [] })).toEqual({ decision: 'skip', reason: 'empty_list' });
    expect(evaluateIpAllowlist({ ...base, allowlist: undefined })).toEqual({ decision: 'skip', reason: 'empty_list' });
  });

  it('skips (fail-open) when the client IP is not trustable', () => {
    expect(evaluateIpAllowlist({ ...base, clientIp: undefined })).toEqual({
      decision: 'skip',
      reason: 'untrusted_ip',
    });
  });

  it('skips for platform admins (break-glass), even on a non-matching IP', () => {
    expect(evaluateIpAllowlist({ ...base, clientIp: '198.51.100.1', isPlatformAdmin: true })).toEqual({
      decision: 'skip',
      reason: 'platform_admin',
    });
  });
});

describe('readPartnerAllowlist caching', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let limit: any;
  beforeEach(async () => {
    const mod = await import('../db');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    limit = (mod.db as any).__limit;
    limit.mockReset();
    clearPartnerAllowlistCache('p1');
  });

  it('caches the result and serves the second call without a DB read', async () => {
    limit.mockResolvedValueOnce([{ settings: { security: { ipAllowlist: ['10.0.0.0/8'] } } }]);
    expect(await readPartnerAllowlist('p1')).toEqual(['10.0.0.0/8']);
    expect(await readPartnerAllowlist('p1')).toEqual(['10.0.0.0/8']);
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it('returns [] when no allowlist is set', async () => {
    limit.mockResolvedValueOnce([{ settings: {} }]);
    expect(await readPartnerAllowlist('p1')).toEqual([]);
  });

  it('throws and does not cache when the partner row is missing', async () => {
    limit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ settings: { security: { ipAllowlist: ['10.0.0.0/8'] } } }]);

    await expect(readPartnerAllowlist('p1')).rejects.toThrow('ipAllowlist: partner p1 not found');
    expect(await readPartnerAllowlist('p1')).toEqual(['10.0.0.0/8']);
    expect(limit).toHaveBeenCalledTimes(2);
  });
});
