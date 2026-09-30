import { describe, expect, it, vi } from 'vitest';
import {
  createTerminalLogoutService,
  type TerminalLogoutDependencies,
  type TerminalLogoutFamily,
  type TerminalLogoutTransaction,
  type TerminalLogoutUser,
} from './terminalLogout';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const FA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TRANSITION = '44444444-4444-4444-8444-444444444444';

function harness(options: {
  refresh?: Record<string, unknown> | null;
  refreshDigest?: string | null;
  refreshAuthority?:
    | { kind: 'current'; userId: string; familyId: string }
    | { kind: 'legacy_or_stale_family'; familyId: string }
    | { kind: 'invalid' };
  rollback?: boolean;
  cleanupFailure?: boolean;
  revokedFamilies?: string[];
} = {}) {
  const events: string[] = [];
  const revoked: string[] = [];
  const users = new Map<string, TerminalLogoutUser>([
    [A, { id: A, status: 'active' as const, authEpoch: 4, mfaEpoch: 9 }],
    [B, { id: B, status: 'active' as const, authEpoch: 6, mfaEpoch: 2 }],
    [C, { id: C, status: 'active' as const, authEpoch: 8, mfaEpoch: 3 }],
  ]);
  const revokedAt = (id: string) => (options.revokedFamilies?.includes(id) ? new Date('2029-01-01') : null);
  const families = new Map<string, TerminalLogoutFamily>([
    [FA, { familyId: FA, userId: A, revokedAt: revokedAt(FA), absoluteExpiresAt: new Date('2030-01-01'), currentRefreshJtiDigest: 'fa' }],
    [FB, { familyId: FB, userId: B, revokedAt: revokedAt(FB), absoluteExpiresAt: new Date('2030-01-01'), currentRefreshJtiDigest: Object.hasOwn(options, 'refreshDigest') ? options.refreshDigest! : 'digest-current' }],
    [FC, { familyId: FC, userId: C, revokedAt: revokedAt(FC), absoluteExpiresAt: new Date('2030-01-01'), currentRefreshJtiDigest: 'fc' }],
  ]);

  const tx: TerminalLogoutTransaction = {
    transition: {
      id: TRANSITION,
      generation: 3,
      state: 'active',
      currentUserId: C,
      currentFamilyId: FC,
      databaseNow: new Date(1_850_000_000 * 1000),
    },
    lockUsers: vi.fn(async (ids: readonly string[]) => {
      events.push(`users:${ids.join(',')}`);
      return new Map(ids.flatMap((id) => users.has(id) ? [[id, users.get(id)!]] : []));
    }),
    lockFamilies: vi.fn(async (familyIds: readonly string[]) => {
      events.push(`families:${familyIds.join(',')}`);
      return new Map([...families].filter(([id]) => familyIds.includes(id)));
    }),
    classifyRefreshAuthority: vi.fn(async () => {
      events.push('classify-refresh');
      return options.refreshAuthority ?? { kind: 'current' as const, userId: B, familyId: FB };
    }),
    revokeFamily: vi.fn(async (id: string) => {
      events.push(`revoke:${id}`);
      revoked.push(id);
    }),
    retireWithSuccessor: vi.fn(async () => {
      events.push('retire');
      return { kind: 'browser' as const, value: 'c2' };
    }),
    markLogoutPending: vi.fn(async ({ logoutId, nonceDigest }) => {
      events.push('pending');
      return { transitionId: TRANSITION, logoutId, generation: 4, nonceDigest };
    }),
  };

  const cleanup = vi.fn(async (_input: { familyIds: readonly string[]; refreshJti: string | null }) => {
    events.push('cleanup');
    if (options.cleanupFailure) throw new Error('redis unavailable');
  });
  const deps: TerminalLogoutDependencies = {
    verifyRefreshToken: vi.fn(async () => options.refresh ?? null),
    withLockedTransition: vi.fn(async (_binding, callback) => {
      events.push('transition');
      if (options.rollback) throw new Error('postgres rollback');
      return callback(tx);
    }),
    cleanup,
    randomUuid: vi.fn(() => '55555555-5555-4555-8555-555555555555'),
    randomNonce: vi.fn(() => 'ab'.repeat(32)),
  };
  return { service: createTerminalLogoutService(deps), events, revoked, cleanup, tx };
}

const access = { userId: A, authEpoch: 4, mfaEpoch: 9, familyId: FA };
const binding = { kind: 'browser' as const, value: 'c1' };

describe('terminal logout ends exactly the presented sign-in session', () => {
  it('revokes the bearer, refresh-cookie and binding families in lock order and nothing user-wide', async () => {
    const h = harness({
      refresh: { type: 'refresh', sub: B, fam: FB, jti: 'refresh-jti', aep: 6, mep: 2 },
    });

    await expect(h.service.performOrdinaryTerminalLogout({ binding, access, refreshToken: 'refresh' }))
      .resolves.toEqual({ replacement: { kind: 'browser', value: 'c2' }, cleanupOk: true });

    expect(h.events.slice(0, 4)).toEqual([
      'transition',
      `users:${A},${B},${C}`,
      `families:${FA},${FB},${FC}`,
      'classify-refresh',
    ]);
    expect(h.revoked).toEqual([FA, FB, FC]);
    // The durable transaction exposes no user-wide primitive: ending one
    // sign-in session must never advance the user's epochs or revoke the
    // user's other refresh families.
    expect(Object.keys(h.tx)).not.toContain('globallyRevokeUser');
    expect(h.cleanup).toHaveBeenCalledWith({ familyIds: [FA, FB, FC], refreshJti: 'refresh-jti' });
    expect(h.events.indexOf('cleanup')).toBeGreaterThan(h.events.indexOf('retire'));
  });

  it('only locks the named families, never every family the user owns', async () => {
    const h = harness();
    await h.service.performOrdinaryTerminalLogout({ binding, access, refreshToken: null });
    expect(h.tx.lockFamilies).toHaveBeenCalledWith([FA, FC]);
  });

  it.each([
    ['stale', 'stale-digest'],
    ['legacy', null],
  ])('revokes a %s refresh token family the browser presented', async (_kind, digest) => {
    const h = harness({
      refreshDigest: digest,
      refreshAuthority: { kind: 'legacy_or_stale_family', familyId: FB },
      refresh: { type: 'refresh', sub: B, fam: FB, jti: 'refresh-jti', aep: 6, mep: 2 },
    });

    await h.service.performOrdinaryTerminalLogout({ binding, access, refreshToken: 'refresh' });

    expect(h.revoked).toEqual([FA, FB, FC]);
  });

  it('does not revoke a family named by an unverifiable refresh token', async () => {
    const h = harness({
      refresh: { type: 'access', sub: B, fam: FB, jti: 'forged' },
      refreshAuthority: { kind: 'invalid' },
    });
    await h.service.performOrdinaryTerminalLogout({ binding, access, refreshToken: 'invalid' });
    expect(h.revoked).toEqual([FA, FC]);
    expect(h.cleanup).toHaveBeenCalledWith({ familyIds: [FA, FC], refreshJti: null });
  });

  it('does not revoke a family the classifier did not confirm for that refresh subject', async () => {
    const h = harness({
      refresh: { type: 'refresh', sub: B, fam: FB, jti: 'refresh-jti', aep: 6, mep: 2 },
      refreshAuthority: { kind: 'current', userId: C, familyId: FC },
    });
    await h.service.performOrdinaryTerminalLogout({ binding, access, refreshToken: 'refresh' });
    expect(h.revoked).toEqual([FA, FC]);
  });

  it('still ends the bearer session when the bearer epochs went stale after admission', async () => {
    const h = harness();
    await h.service.performOrdinaryTerminalLogout({
      binding,
      access: { ...access, authEpoch: 3 },
      refreshToken: null,
    });
    expect(h.revoked).toEqual([FA, FC]);
  });

  it('never revokes a family that belongs to a different user than the token naming it', async () => {
    const h = harness();
    await h.service.performOrdinaryTerminalLogout({
      binding,
      access: { ...access, familyId: FB },
      refreshToken: null,
    });
    expect(h.revoked).toEqual([FC]);
  });

  it('skips families that are already revoked', async () => {
    const h = harness({ revokedFamilies: [FA] });
    await h.service.performOrdinaryTerminalLogout({ binding, access, refreshToken: null });
    expect(h.revoked).toEqual([FC]);
    expect(h.cleanup).toHaveBeenCalledWith({ familyIds: [FC], refreshJti: null });
  });
});

describe('terminal logout transaction boundaries', () => {
  it('keeps durable success authoritative when Redis cleanup fails after commit', async () => {
    const h = harness({ cleanupFailure: true });
    await expect(h.service.performOrdinaryTerminalLogout({ binding, access, refreshToken: null }))
      .resolves.toEqual({ replacement: { kind: 'browser', value: 'c2' }, cleanupOk: false });
    expect(h.revoked).toEqual([FA, FC]);
  });

  it('propagates PostgreSQL rollback and never runs post-commit cleanup', async () => {
    const h = harness({ rollback: true });
    await expect(h.service.performOrdinaryTerminalLogout({ binding, access, refreshToken: null }))
      .rejects.toThrow('postgres rollback');
    expect(h.cleanup).not.toHaveBeenCalled();
  });

  it('prepares CF logout by clearing refresh authority while keeping C1 pending', async () => {
    const h = harness();
    const result = await h.service.prepareCfTerminalLogout({ binding, access, refreshToken: null });
    expect(result).toEqual({
      transitionId: TRANSITION,
      logoutId: '55555555-5555-4555-8555-555555555555',
      generation: 4,
      nonce: 'ab'.repeat(32),
      issuedAt: 1_850_000_000,
      expiresAt: 1_850_000_300,
      cleanupOk: true,
    });
    expect(h.tx.retireWithSuccessor).not.toHaveBeenCalled();
    expect(h.tx.markLogoutPending).toHaveBeenCalledTimes(1);
  });
});
