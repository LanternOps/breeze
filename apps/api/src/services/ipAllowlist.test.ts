import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  evaluateIpAllowlist,
  enforceIpAllowlist,
  readPartnerAllowlist,
  clearPartnerAllowlistCache,
} from './ipAllowlist';

const serviceMocks = vi.hoisted(() => ({
  getTrustedClientIpOrUndefined: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

vi.mock('../db', () => {
  const limit = vi.fn();
  return {
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit }) }) }),
      __limit: limit,
    },
    runOutsideDbContext: vi.fn(<T,>(fn: () => T): T => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('./clientIp', () => ({
  getTrustedClientIpOrUndefined: serviceMocks.getTrustedClientIpOrUndefined,
}));

vi.mock('./auditEvents', () => ({
  writeAuditEvent: serviceMocks.writeAuditEvent,
}));

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
  let limit: any;
  beforeEach(async () => {
    const mod = await import('../db');
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

  it('reads from the DB again after cache invalidation', async () => {
    limit
      .mockResolvedValueOnce([{ settings: { security: { ipAllowlist: ['10.0.0.0/8'] } } }])
      .mockResolvedValueOnce([{ settings: { security: { ipAllowlist: ['192.0.2.0/24'] } } }]);

    expect(await readPartnerAllowlist('p1')).toEqual(['10.0.0.0/8']);
    expect(limit).toHaveBeenCalledTimes(1);

    clearPartnerAllowlistCache('p1');

    expect(await readPartnerAllowlist('p1')).toEqual(['192.0.2.0/24']);
    expect(limit).toHaveBeenCalledTimes(2);
  });
});

describe('enforceIpAllowlist', () => {
  let limit: any;
  const c = { req: { header: vi.fn() } };

  beforeEach(async () => {
    const mod = await import('../db');
    limit = (mod.db as any).__limit;
    limit.mockReset();
    serviceMocks.getTrustedClientIpOrUndefined.mockReset();
    serviceMocks.writeAuditEvent.mockReset();
    delete process.env.IP_ALLOWLIST_ENFORCEMENT_MODE;
    clearPartnerAllowlistCache('partner-deny');
    clearPartnerAllowlistCache('partner-admin');
  });

  it('denies a non-matching trusted IP and writes an audit event', async () => {
    limit.mockResolvedValueOnce([{ settings: { security: { ipAllowlist: ['10.0.0.0/8'] } } }]);
    serviceMocks.getTrustedClientIpOrUndefined.mockReturnValue('203.0.113.10');

    const decision = await enforceIpAllowlist(c, {
      partnerId: 'partner-deny',
      isPlatformAdmin: false,
      actorId: 'user-1',
      actorEmail: 'admin@example.com',
    });

    expect(decision).toEqual({ decision: 'deny', reason: 'not_in_list' });
    expect(serviceMocks.writeAuditEvent).toHaveBeenCalledWith(
      c,
      expect.objectContaining({
        action: 'ip_allowlist.denied',
        resourceId: 'partner-deny',
        result: 'denied',
      }),
    );
  });

  it('skips for platform admins on non-matching IPs and writes a bypass audit event', async () => {
    limit.mockResolvedValueOnce([{ settings: { security: { ipAllowlist: ['10.0.0.0/8'] } } }]);
    serviceMocks.getTrustedClientIpOrUndefined.mockReturnValue('203.0.113.10');

    const decision = await enforceIpAllowlist(c, {
      partnerId: 'partner-admin',
      isPlatformAdmin: true,
      actorId: 'admin-1',
      actorEmail: 'platform@example.com',
    });

    expect(decision).toEqual({ decision: 'skip', reason: 'platform_admin' });
    expect(serviceMocks.writeAuditEvent).toHaveBeenCalledWith(
      c,
      expect.objectContaining({
        action: 'ip_allowlist.bypass_platform_admin',
        resourceId: 'partner-admin',
        result: 'success',
      }),
    );
  });

  it('reads the allowlist outside the request RLS context (system scope)', async () => {
    // Regression: org-scoped requests have an empty accessible_partner_ids,
    // so reading partners under the request context throws "partner not
    // found" and locks every customer-org user out. The read must exit the
    // request context and run under the system context instead.
    const mod = await import('../db');
    vi.mocked(mod.runOutsideDbContext).mockClear();
    vi.mocked(mod.withSystemDbAccessContext).mockClear();
    clearPartnerAllowlistCache('partner-ctx');
    limit.mockResolvedValueOnce([{ settings: { security: { ipAllowlist: ['10.0.0.0/8'] } } }]);
    serviceMocks.getTrustedClientIpOrUndefined.mockReturnValue('10.1.2.3');

    const decision = await enforceIpAllowlist(c, {
      partnerId: 'partner-ctx',
      isPlatformAdmin: false,
    });

    expect(decision).toEqual({ decision: 'allow' });
    expect(vi.mocked(mod.runOutsideDbContext)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mod.withSystemDbAccessContext)).toHaveBeenCalledTimes(1);
  });

  it('skips without reading the allowlist when partnerId is null', async () => {
    const decision = await enforceIpAllowlist(c, {
      partnerId: null,
      isPlatformAdmin: false,
    });

    expect(decision).toEqual({ decision: 'skip', reason: 'no_partner' });
    expect(limit).not.toHaveBeenCalled();
  });

  it('skips without reading the allowlist when enforcement mode is off', async () => {
    process.env.IP_ALLOWLIST_ENFORCEMENT_MODE = 'off';
    serviceMocks.getTrustedClientIpOrUndefined.mockReturnValue('203.0.113.10');

    const decision = await enforceIpAllowlist(c, {
      partnerId: 'partner-deny',
      isPlatformAdmin: false,
    });

    expect(decision).toEqual({ decision: 'skip', reason: 'mode_off' });
    expect(limit).not.toHaveBeenCalled();
  });
});
