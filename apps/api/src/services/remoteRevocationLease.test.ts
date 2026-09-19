import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./redis', () => ({ getRedis: vi.fn(() => null) }));
vi.mock('./remoteSessionTeardown', () => ({
  teardownDisconnectedSessions: vi.fn(async () => {}),
}));
vi.mock('./remoteAccessPolicy', () => ({
  resolveDesktopSessionPolicy: vi.fn(async () => ({
    clipboard: { hostToViewer: true, viewerToHost: true },
    idleTimeoutMinutes: 5,
    maxSessionDurationHours: 8,
  })),
}));
vi.mock('./mfaPolicy', () => ({
  getEffectiveMfaPolicy: vi.fn(async () => ({ required: false })),
}));
vi.mock('../db', () => ({
  db: {},
  runOutsideDbContext: vi.fn(async (fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

import {
  REVOCATION_LEASE_TTL_MS,
  REVOCATION_LEASE_RENEW_EVERY_MS,
  REVOCATION_LEASE_GRACE_MS,
  REVOCATION_LEASE_HARD_CAP_MS,
  REVOCATION_LEASE_PROTOCOL_VERSION,
  clampHardDeadline,
  evaluateRevocationRecheck,
  prepareRevocationLeaseForStart,
  renewRevocationLease,
  revocationLeaseRedisKey,
  type RevocationRecheckRow,
} from './remoteRevocationLease';
import { teardownDisconnectedSessions } from './remoteSessionTeardown';
import { getEffectiveMfaPolicy } from './mfaPolicy';
import { afterEach } from 'vitest';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');

function row(overrides: Partial<RevocationRecheckRow> = {}): RevocationRecheckRow {
  const base: RevocationRecheckRow = {
    session: {
      id: 'sess-1',
      type: 'desktop',
      status: 'active',
      userId: 'user-1',
      deviceId: 'dev-1',
      orgId: 'org-1',
      startedAt: new Date(NOW - 60_000),
      createdAt: new Date(NOW - 120_000),
      permissionsEpochSnapshot: 7,
      desktopStartGeneration: 4n,
      terminalGeneration: null,
      terminationPhase: 'none',
    },
    device: {
      id: 'dev-1',
      orgId: 'org-1',
      siteId: 'site-1',
      agentId: 'agent-1',
      revocationLeaseProtocolVersion: 1,
      desktopFenceProtocolVersion: 1,
    },
    user: {
      status: 'active',
      permissionsEpoch: 7,
      orgId: 'org-1',
      partnerId: 'partner-1',
      mfaProtected: true,
    },
    orgMembership: { roleId: 'role-1', siteIds: null },
    partnerMembership: null,
    sessionOrgUsable: true,
  };
  return { ...base, ...overrides } as RevocationRecheckRow;
}

describe('revocation lease constants', () => {
  it('owns its own timings and does not borrow the WS shared-lease values', () => {
    expect(REVOCATION_LEASE_TTL_MS).toBe(60_000);
    expect(REVOCATION_LEASE_RENEW_EVERY_MS).toBe(25_000);
    expect(REVOCATION_LEASE_GRACE_MS).toBe(90_000);
    expect(REVOCATION_LEASE_HARD_CAP_MS).toBe(12 * 60 * 60 * 1000);
    expect(REVOCATION_LEASE_PROTOCOL_VERSION).toBe(1);
  });

  it('namespaces the Redis key per session', () => {
    expect(revocationLeaseRedisKey('abc')).toBe('remote:revocation-lease:abc');
  });
});

describe('clampHardDeadline', () => {
  const start = Date.parse('2026-10-15T00:00:00.000Z');

  it('clamps a policy of 0 ("unlimited") to the 12h hard cap', () => {
    expect(clampHardDeadline(start, 0)).toBe(start + REVOCATION_LEASE_HARD_CAP_MS);
  });

  it('clamps a policy above 12h down to the 12h hard cap', () => {
    expect(clampHardDeadline(start, 168)).toBe(start + REVOCATION_LEASE_HARD_CAP_MS);
  });

  it('lets a policy shorten the cap', () => {
    expect(clampHardDeadline(start, 4)).toBe(start + 4 * 60 * 60 * 1000);
  });

  it('treats a non-finite / negative policy value as the hard cap', () => {
    expect(clampHardDeadline(start, Number.NaN)).toBe(start + REVOCATION_LEASE_HARD_CAP_MS);
    expect(clampHardDeadline(start, -3)).toBe(start + REVOCATION_LEASE_HARD_CAP_MS);
  });
});

describe('evaluateRevocationRecheck', () => {
  it('renews the happy path', () => {
    expect(evaluateRevocationRecheck(row(), NOW, NOW + 60_000)).toEqual({ ok: true });
  });

  it('revokes when the session row is missing', () => {
    expect(evaluateRevocationRecheck(null, NOW, NOW + 60_000)).toEqual({
      ok: false,
      reason: 'session_ended',
    });
  });

  it.each(['disconnected', 'failed', 'denied'] as const)(
    'revokes a session already in terminal status %s',
    (status) => {
      expect(
        evaluateRevocationRecheck(row({ session: { ...row().session, status } }), NOW, NOW + 60_000),
      ).toEqual({ ok: false, reason: 'session_ended' });
    },
  );

  it('accepts pending and connecting alongside active', () => {
    for (const status of ['pending', 'connecting', 'active'] as const) {
      expect(
        evaluateRevocationRecheck(row({ session: { ...row().session, status } }), NOW, NOW + 60_000),
      ).toEqual({ ok: true });
    }
  });

  it('revokes an inactive user', () => {
    expect(
      evaluateRevocationRecheck(
        row({ user: { ...row().user, status: 'suspended' } }),
        NOW,
        NOW + 60_000,
      ),
    ).toEqual({ ok: false, reason: 'user_inactive' });
  });

  it('revokes when the epoch baseline was never captured', () => {
    expect(
      evaluateRevocationRecheck(
        row({ session: { ...row().session, permissionsEpochSnapshot: null } }),
        NOW,
        NOW + 60_000,
      ),
    ).toEqual({ ok: false, reason: 'epoch_baseline_missing' });
  });

  it('revokes on a permissions-epoch mismatch (role change, site scope, force_mfa flip)', () => {
    expect(
      evaluateRevocationRecheck(
        row({ user: { ...row().user, permissionsEpoch: 8 } }),
        NOW,
        NOW + 60_000,
      ),
    ).toEqual({ ok: false, reason: 'permissions_changed' });
  });

  it('revokes when the org membership is gone', () => {
    expect(evaluateRevocationRecheck(row({ orgMembership: null }), NOW, NOW + 60_000)).toEqual({
      ok: false,
      reason: 'membership_removed',
    });
  });

  it('revokes when the device left the caller site ceiling', () => {
    expect(
      evaluateRevocationRecheck(
        row({ orgMembership: { roleId: 'role-1', siteIds: ['site-9'] } }),
        NOW,
        NOW + 60_000,
      ),
    ).toEqual({ ok: false, reason: 'site_scope_lost' });
  });

  it('revokes when the device has no site at all but the caller is site-restricted', () => {
    expect(
      evaluateRevocationRecheck(
        row({
          device: { ...row().device, siteId: null },
          orgMembership: { roleId: 'role-1', siteIds: ['site-1'] },
        }),
        NOW,
        NOW + 60_000,
      ),
    ).toEqual({ ok: false, reason: 'site_scope_lost' });
  });

  it('allows an unrestricted (null siteIds) membership onto any device', () => {
    expect(
      evaluateRevocationRecheck(
        row({ device: { ...row().device, siteId: null } }),
        NOW,
        NOW + 60_000,
      ),
    ).toEqual({ ok: true });
  });

  // #6107: the evaluator no longer reads the role's raw force_mfa. "MFA is
  // required" is the effective-policy verdict (kill switch, enrolment grace,
  // org/partner requireMfa) resolved by the caller, so the lease and login
  // cannot disagree.
  it('revokes when policy requires MFA and the user holds no factor', () => {
    expect(
      evaluateRevocationRecheck(
        row({ user: { ...row().user, mfaProtected: false } }),
        NOW,
        NOW + 60_000,
        true,
      ),
    ).toEqual({ ok: false, reason: 'mfa_required' });
  });

  it('keeps a factorless user renewing while policy does not require MFA', () => {
    expect(
      evaluateRevocationRecheck(
        row({ user: { ...row().user, mfaProtected: false } }),
        NOW,
        NOW + 60_000,
        false,
      ),
    ).toEqual({ ok: true });
  });

  it('keeps renewing under required MFA while the user still holds a factor', () => {
    expect(evaluateRevocationRecheck(row(), NOW, NOW + 60_000, true)).toEqual({ ok: true });
  });

  it('revokes once the hard deadline has passed', () => {
    expect(evaluateRevocationRecheck(row(), NOW, NOW - 1)).toEqual({
      ok: false,
      reason: 'hard_deadline',
    });
  });

  it('revokes when the device drifted to another org', () => {
    expect(
      evaluateRevocationRecheck(
        row({ device: { ...row().device, orgId: 'org-other' } }),
        NOW,
        NOW + 60_000,
      ),
    ).toEqual({ ok: false, reason: 'membership_removed' });
  });

  describe('partner-scoped caller', () => {
    const partnerRow = () =>
      row({
        user: {
          status: 'active',
          permissionsEpoch: 7,
          orgId: null,
          partnerId: 'partner-1',
          mfaProtected: true,
        },
        orgMembership: null,
        partnerMembership: {
          roleId: 'role-p',
          orgAccess: 'all',
          orgIds: null,
        },
        sessionOrgUsable: true,
      });

    it('renews an all-org partner membership', () => {
      expect(evaluateRevocationRecheck(partnerRow(), NOW, NOW + 60_000)).toEqual({ ok: true });
    });

    it('revokes when partner org access was narrowed to none', () => {
      const r = partnerRow();
      r.partnerMembership!.orgAccess = 'none';
      expect(evaluateRevocationRecheck(r, NOW, NOW + 60_000)).toEqual({
        ok: false,
        reason: 'membership_removed',
      });
    });

    it('revokes when a selected-org partner no longer selects this org', () => {
      const r = partnerRow();
      r.partnerMembership!.orgAccess = 'selected';
      r.partnerMembership!.orgIds = ['org-other'];
      expect(evaluateRevocationRecheck(r, NOW, NOW + 60_000)).toEqual({
        ok: false,
        reason: 'membership_removed',
      });
    });

    it('revokes when the session org is no longer usable under this partner', () => {
      const r = partnerRow();
      r.sessionOrgUsable = false;
      expect(evaluateRevocationRecheck(r, NOW, NOW + 60_000)).toEqual({
        ok: false,
        reason: 'membership_removed',
      });
    });

    it('revokes when the partner membership row is gone entirely', () => {
      const r = partnerRow();
      r.partnerMembership = null;
      expect(evaluateRevocationRecheck(r, NOW, NOW + 60_000)).toEqual({
        ok: false,
        reason: 'membership_removed',
      });
    });
  });
});

describe('renewRevocationLease fence resync fields (SEC-038 W05)', () => {
  const liveRedis = () => ({
    eval: vi.fn(async () =>
      JSON.stringify({
        userId: 'user-1',
        deviceId: 'dev-1',
        permissionsEpoch: 7,
        issuedAt: NOW - 25_000,
        hardDeadline: NOW + 3_600_000,
      }),
    ),
  });

  it('reports the session start generation as a canonical decimal string', async () => {
    const result = await renewRevocationLease('sess-1', {
      loadRow: async () =>
        row({
          session: {
            ...row().session,
            // Above 2^53: must not round-trip through a JS number anywhere.
            desktopStartGeneration: 9007199254740993n,
          },
        } as never),
      redis: liveRedis() as never,
      now: () => NOW,
    });
    expect(result.status).toBe('renewed');
    if (result.status !== 'renewed') return;
    expect(result.startGeneration).toBe('9007199254740993');
    expect(result.terminationPhase).toBe('none');
  });

  it('carries the terminal generation onto a revoked verdict', async () => {
    const result = await renewRevocationLease('sess-1', {
      loadRow: async () =>
        row({
          session: {
            ...row().session,
            status: 'ended',
            terminalGeneration: 12n,
            terminationPhase: 'pending',
          },
        } as never),
      redis: liveRedis() as never,
      markRevoked: async () => null,
      now: () => NOW,
    });
    expect(result.status).toBe('revoked');
    if (result.status !== 'revoked') return;
    expect(result.terminalGeneration).toBe('12');
  });

  it('leaves the terminal generation undefined when the session row is unknown', async () => {
    const result = await renewRevocationLease('sess-1', {
      loadRow: async () => null,
      redis: liveRedis() as never,
      markRevoked: async () => null,
      now: () => NOW,
    });
    expect(result.status).toBe('revoked');
    if (result.status !== 'revoked') return;
    expect(result.terminalGeneration).toBeUndefined();
  });

  it('never reveals another device\'s session generation on a forbidden renew', async () => {
    const result = await renewRevocationLease('sess-1', {
      loadRow: async () => row(),
      expectDeviceId: 'someone-else',
      redis: liveRedis() as never,
      now: () => NOW,
    });
    expect(result).toEqual({ status: 'forbidden' });
  });
});

describe('renewRevocationLease', () => {
  beforeEach(() => {
    vi.mocked(teardownDisconnectedSessions).mockClear();
  });

  const leaseValue = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      userId: 'user-1',
      deviceId: 'dev-1',
      permissionsEpoch: 7,
      issuedAt: NOW - 25_000,
      hardDeadline: NOW + 3_600_000,
      ...over,
    });

  function fakeRedis(initial: string | null) {
    let stored = initial;
    return {
      stored: () => stored,
      eval: vi.fn(async (script: string) => {
        if (script.includes('PEXPIRE')) {
          if (stored === null) return null;
          return stored;
        }
        if (script.includes('DEL')) {
          stored = null;
          return 1;
        }
        return null;
      }),
    };
  }

  it('renews and returns the lease window when the recheck passes', async () => {
    const redis = fakeRedis(leaseValue());
    const result = await renewRevocationLease('sess-1', {
      loadRow: async () => row(),
      redis: redis as never,
      now: () => NOW,
    });
    expect(result).toEqual({
      status: 'renewed',
      expiresAt: NOW + REVOCATION_LEASE_TTL_MS,
      hardDeadline: NOW + 3_600_000,
      renewEverySec: REVOCATION_LEASE_RENEW_EVERY_MS / 1000,
      graceSec: REVOCATION_LEASE_GRACE_MS / 1000,
      startGeneration: '4',
      terminationPhase: 'none',
    });
    expect(teardownDisconnectedSessions).not.toHaveBeenCalled();
  });

  it('revokes, marks the row and tears the stream down when the recheck fails', async () => {
    const redis = fakeRedis(leaseValue());
    const markRow = vi.fn(async () => ({
      id: 'sess-1', type: 'desktop', deviceId: 'dev-1', orgId: 'org-1', userId: 'user-1', promptMode: null,
      status: 'disconnected', terminalGeneration: 7n, terminationPhase: 'pending' as const,
    }));
    const result = await renewRevocationLease('sess-1', {
      loadRow: async () => row({ user: { ...row().user, status: 'suspended' } }),
      redis: redis as never,
      now: () => NOW,
      markRevoked: markRow,
    });
    expect(result).toEqual({ status: 'revoked', reason: 'user_inactive' });
    expect(markRow).toHaveBeenCalledWith('sess-1', 'user_inactive');
    expect(teardownDisconnectedSessions).toHaveBeenCalledWith([
      {
        id: 'sess-1', type: 'desktop', deviceId: 'dev-1', orgId: 'org-1', userId: 'user-1', promptMode: null,
        status: 'disconnected', terminalGeneration: 7n, terminationPhase: 'pending',
      },
    ]);
  });

  describe('MFA through the effective policy (#6107)', () => {
    const factorless = (over: Partial<RevocationRecheckRow> = {}) =>
      row({ user: { ...row().user, mfaProtected: false }, ...over });

    beforeEach(() => {
      vi.mocked(getEffectiveMfaPolicy).mockReset();
      vi.mocked(getEffectiveMfaPolicy).mockResolvedValue({ required: false } as never);
    });

    it('renews a factorless user when the policy does not require MFA (kill switch / grace)', async () => {
      const markRow = vi.fn();
      const result = await renewRevocationLease('sess-1', {
        loadRow: async () => factorless(),
        redis: fakeRedis(leaseValue()) as never,
        now: () => NOW,
        markRevoked: markRow,
      });
      expect(result.status).toBe('renewed');
      expect(markRow).not.toHaveBeenCalled();
      expect(getEffectiveMfaPolicy).toHaveBeenCalledWith({
        scope: 'organization',
        userId: 'user-1',
        orgId: 'org-1',
        partnerId: 'partner-1',
      });
    });

    it('revokes a factorless user when the policy requires MFA', async () => {
      vi.mocked(getEffectiveMfaPolicy).mockResolvedValue({ required: true } as never);
      const markRow = vi.fn(async () => null);
      const result = await renewRevocationLease('sess-1', {
        loadRow: async () => factorless(),
        redis: fakeRedis(leaseValue()) as never,
        now: () => NOW,
        markRevoked: markRow,
      });
      expect(result).toEqual({ status: 'revoked', reason: 'mfa_required' });
      expect(markRow).toHaveBeenCalledWith('sess-1', 'mfa_required');
    });

    it('asks the policy at partner scope for a partner-scoped user', async () => {
      await renewRevocationLease('sess-1', {
        loadRow: async () =>
          factorless({
            user: { ...row().user, orgId: null, mfaProtected: false },
            orgMembership: null,
            partnerMembership: { roleId: 'prole-1', orgAccess: 'all', orgIds: null },
            sessionOrgUsable: true,
          }),
        redis: fakeRedis(leaseValue()) as never,
        now: () => NOW,
      });
      expect(getEffectiveMfaPolicy).toHaveBeenCalledWith({
        scope: 'partner',
        userId: 'user-1',
        orgId: null,
        partnerId: 'partner-1',
      });
    });

    it('never consults the policy for a user who holds a factor', async () => {
      await renewRevocationLease('sess-1', {
        loadRow: async () => row(),
        redis: fakeRedis(leaseValue()) as never,
        now: () => NOW,
      });
      expect(getEffectiveMfaPolicy).not.toHaveBeenCalled();
    });

    it('never consults the policy (no grace-grant write) for a session that is revoked anyway', async () => {
      const result = await renewRevocationLease('sess-1', {
        loadRow: async () => factorless({ user: { ...row().user, status: 'suspended', mfaProtected: false } }),
        redis: fakeRedis(leaseValue()) as never,
        now: () => NOW,
        markRevoked: vi.fn(async () => null),
      });
      expect(result).toEqual({ status: 'revoked', reason: 'user_inactive' });
      expect(getEffectiveMfaPolicy).not.toHaveBeenCalled();
    });

    it('returns lease_unavailable and does NOT revoke when the policy read throws', async () => {
      vi.mocked(getEffectiveMfaPolicy).mockRejectedValue(new Error('db down'));
      const markRow = vi.fn();
      const result = await renewRevocationLease('sess-1', {
        loadRow: async () => factorless(),
        redis: fakeRedis(leaseValue()) as never,
        now: () => NOW,
        markRevoked: markRow,
      });
      expect(result).toEqual({ status: 'unavailable' });
      expect(markRow).not.toHaveBeenCalled();
    });
  });

  it('returns lease_unavailable and does NOT mark the session when the recheck query throws', async () => {
    const redis = fakeRedis(leaseValue());
    const markRow = vi.fn();
    const result = await renewRevocationLease('sess-1', {
      loadRow: async () => {
        throw new Error('db down');
      },
      redis: redis as never,
      now: () => NOW,
      markRevoked: markRow as never,
    });
    expect(result).toEqual({ status: 'unavailable' });
    expect(markRow).not.toHaveBeenCalled();
    expect(teardownDisconnectedSessions).not.toHaveBeenCalled();
  });

  it('returns lease_unavailable and does NOT mark the session when Redis throws', async () => {
    const markRow = vi.fn();
    const result = await renewRevocationLease('sess-1', {
      loadRow: async () => row(),
      redis: { eval: vi.fn(async () => { throw new Error('redis down'); }) } as never,
      now: () => NOW,
      markRevoked: markRow as never,
    });
    expect(result).toEqual({ status: 'unavailable' });
    expect(markRow).not.toHaveBeenCalled();
  });

  it('re-derives the hard deadline from the session row when the Redis lease is gone', async () => {
    const redis = fakeRedis(null);
    const result = await renewRevocationLease('sess-1', {
      loadRow: async () => row(),
      redis: redis as never,
      now: () => NOW,
    });
    // startedAt (NOW - 60s) + policy 8h, clamped to <=12h.
    expect(result).toEqual({
      status: 'renewed',
      expiresAt: NOW + REVOCATION_LEASE_TTL_MS,
      hardDeadline: NOW - 60_000 + 8 * 60 * 60 * 1000,
      renewEverySec: REVOCATION_LEASE_RENEW_EVERY_MS / 1000,
      graceSec: REVOCATION_LEASE_GRACE_MS / 1000,
      startGeneration: '4',
      terminationPhase: 'none',
    });
  });

  it('refuses a caller whose device does not own the session, without touching the row', async () => {
    const redis = fakeRedis(leaseValue());
    const markRow = vi.fn();
    const result = await renewRevocationLease('sess-1', {
      loadRow: async () => row(),
      redis: redis as never,
      now: () => NOW,
      markRevoked: markRow as never,
      expectDeviceId: 'dev-other',
    });
    expect(result).toEqual({ status: 'forbidden' });
    expect(markRow).not.toHaveBeenCalled();
  });

  it('refuses a caller who does not own the session, without touching the row', async () => {
    const redis = fakeRedis(leaseValue());
    const markRow = vi.fn();
    const result = await renewRevocationLease('sess-1', {
      loadRow: async () => row(),
      redis: redis as never,
      now: () => NOW,
      markRevoked: markRow as never,
      expectUserId: 'user-other',
    });
    expect(result).toEqual({ status: 'forbidden' });
    expect(markRow).not.toHaveBeenCalled();
  });

  it('revokes a session whose hard deadline elapsed even while everything else is intact', async () => {
    const redis = fakeRedis(leaseValue({ hardDeadline: NOW - 1 }));
    const markRow = vi.fn(async () => ({
      id: 'sess-1', type: 'desktop', deviceId: 'dev-1', orgId: 'org-1', userId: 'user-1', promptMode: null,
      status: 'disconnected', terminalGeneration: 7n, terminationPhase: 'pending' as const,
    }));
    const result = await renewRevocationLease('sess-1', {
      loadRow: async () => row(),
      redis: redis as never,
      now: () => NOW,
      markRevoked: markRow,
    });
    expect(result).toEqual({ status: 'revoked', reason: 'hard_deadline' });
  });
});

describe('prepareRevocationLeaseForStart', () => {
  it('refuses a device whose agent has not declared the lease capability', async () => {
    const r = row();
    r.device.revocationLeaseProtocolVersion = 0;
    await expect(
      prepareRevocationLeaseForStart('sess-1', { loadRow: async () => r, now: () => NOW }),
    ).resolves.toEqual({ ok: false, reason: 'agent_upgrade_required' });
  });

  it('refuses an unknown future protocol version rather than assuming forward compatibility', async () => {
    const r = row();
    r.device.revocationLeaseProtocolVersion = 2;
    await expect(
      prepareRevocationLeaseForStart('sess-1', { loadRow: async () => r, now: () => NOW }),
    ).resolves.toEqual({ ok: false, reason: 'agent_upgrade_required' });
  });

  it('refuses when the session row is missing', async () => {
    await expect(
      prepareRevocationLeaseForStart('sess-1', { loadRow: async () => null, now: () => NOW }),
    ).resolves.toEqual({ ok: false, reason: 'session_unavailable' });
  });

  it('refuses when no durable epoch baseline was captured', async () => {
    const r = row();
    r.session.permissionsEpochSnapshot = null;
    await expect(
      prepareRevocationLeaseForStart('sess-1', { loadRow: async () => r, now: () => NOW }),
    ).resolves.toEqual({ ok: false, reason: 'session_unavailable' });
  });

  it('mints a lease block with the renew cadence and clamped hard deadline', async () => {
    const result = await prepareRevocationLeaseForStart('sess-1', {
      loadRow: async () => row(),
      now: () => NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lease).toEqual({
      token: expect.stringContaining('sess-1:'),
      expiresAt: NOW + REVOCATION_LEASE_TTL_MS,
      hardDeadline: NOW - 60_000 + 8 * 60 * 60 * 1000,
      renewEverySec: 25,
      graceSec: 90,
    });
  });
});

// SEC-038 W06 (#5537): the desktop-fence capability gate mirrors the #5481
// lease gate — same denial code, same upgrade message — but sits behind
// REMOTE_DESKTOP_FENCE_REQUIRED, default OFF, so the release that introduces
// it is a no-op for the fleet until the flag is flipped one release later.
describe('prepareRevocationLeaseForStart — desktop fence capability gate (SEC-038 W06)', () => {
  const original = process.env.REMOTE_DESKTOP_FENCE_REQUIRED;
  afterEach(() => {
    if (original === undefined) delete process.env.REMOTE_DESKTOP_FENCE_REQUIRED;
    else process.env.REMOTE_DESKTOP_FENCE_REQUIRED = original;
  });

  it('gate off: admits an unfenced agent (fleet no-op on the introducing release)', async () => {
    delete process.env.REMOTE_DESKTOP_FENCE_REQUIRED;
    const r = row();
    r.device.desktopFenceProtocolVersion = 0;
    const result = await prepareRevocationLeaseForStart('sess-1', { loadRow: async () => r, now: () => NOW });
    expect(result.ok).toBe(true);
  });

  it('gate on: refuses an unfenced agent with the agent_upgrade_required code', async () => {
    process.env.REMOTE_DESKTOP_FENCE_REQUIRED = 'true';
    const r = row();
    r.device.desktopFenceProtocolVersion = 0;
    await expect(
      prepareRevocationLeaseForStart('sess-1', { loadRow: async () => r, now: () => NOW }),
    ).resolves.toEqual({ ok: false, reason: 'agent_upgrade_required' });
  });

  it('gate on: refuses an unknown future fence protocol version rather than assuming forward compatibility', async () => {
    process.env.REMOTE_DESKTOP_FENCE_REQUIRED = 'true';
    const r = row();
    r.device.desktopFenceProtocolVersion = 2;
    await expect(
      prepareRevocationLeaseForStart('sess-1', { loadRow: async () => r, now: () => NOW }),
    ).resolves.toEqual({ ok: false, reason: 'agent_upgrade_required' });
  });

  it('gate on: admits a fenced agent', async () => {
    process.env.REMOTE_DESKTOP_FENCE_REQUIRED = 'true';
    const result = await prepareRevocationLeaseForStart('sess-1', { loadRow: async () => row(), now: () => NOW });
    expect(result.ok).toBe(true);
  });

  it('gate on: the lease gate still wins first — a lease-incapable agent is refused regardless of fence', async () => {
    process.env.REMOTE_DESKTOP_FENCE_REQUIRED = 'true';
    const r = row();
    r.device.revocationLeaseProtocolVersion = 0;
    await expect(
      prepareRevocationLeaseForStart('sess-1', { loadRow: async () => r, now: () => NOW }),
    ).resolves.toEqual({ ok: false, reason: 'agent_upgrade_required' });
  });
});
