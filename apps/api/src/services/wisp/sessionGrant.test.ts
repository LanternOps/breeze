import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enabled: true,
  entitled: true,
  grantRow: null as Record<string, unknown> | null,
  orgPartnerId: 'p1' as string | null,
  selects: [] as string[],
  systemScoped: [] as boolean[],
  ctx: { scope: 'organization' } as { scope: string } | undefined,
}));

vi.mock('../../config/env', () => ({ wispEnabled: () => h.enabled }));
vi.mock('../entitlements', () => ({ hasEntitlement: vi.fn(async () => h.entitled) }));

vi.mock('../../db', () => {
  let inSystem = false;
  const chain = (table: string) => ({
    from: () => ({
      where: () => ({
        limit: async () => {
          h.selects.push(table);
          h.systemScoped.push(inSystem);
          if (table === 'grant') return h.grantRow ? [h.grantRow] : [];
          return h.orgPartnerId ? [{ partnerId: h.orgPartnerId }] : [];
        },
      }),
    }),
  });
  return {
    db: {
      select: (cols: Record<string, unknown>) => chain('grantorUserId' in cols ? 'grant' : 'org'),
    },
    getCurrentDbAccessContext: () => h.ctx,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
      inSystem = true;
      try {
        return await fn();
      } finally {
        inSystem = false;
      }
    },
  };
});

import { hasEntitlement } from '../entitlements';
import { assertGrantCoversSessionOrg, validateWispGrantForSession, WispSessionError } from './sessionGrant';

const auth = { user: { id: 'u1' }, scope: 'organization', orgId: 'orgA' } as never;

function activeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'g1',
    partnerId: 'p1',
    orgId: null,
    grantorUserId: 'u1',
    grantee: 'wisp',
    currentRevisionId: 'r1',
    status: 'active',
    expiresAt: new Date(Date.now() + 86_400_000),
    ...overrides,
  };
}

type Fx = { enabled?: boolean; entitled?: boolean; row?: Record<string, unknown> | null; orgPartnerId?: string | null };

function arrange(fx: Fx) {
  h.enabled = fx.enabled ?? true;
  h.entitled = fx.entitled ?? true;
  h.orgPartnerId = fx.orgPartnerId === undefined ? 'p1' : fx.orgPartnerId;
  h.grantRow = fx.row === null ? null : activeRow(fx.row ?? {});
}

describe('validateWispGrantForSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.selects = [];
    h.systemScoped = [];
  });

  it.each([
    ['flag off', { enabled: false }, 'wisp_disabled', 404],
    ['row missing', { row: null }, 'grant_not_found', 404],
    ['grantee not wisp', { row: { grantee: 'other' } }, 'grant_not_found', 404],
    ['grant of another partner than the session org', { orgPartnerId: 'p2' }, 'grant_not_found', 404],
    ['session org unknown', { orgPartnerId: null }, 'grant_not_found', 404],
    ['other grantor', { row: { grantorUserId: 'u2' } }, 'grant_not_yours', 403],
    ['paused', { row: { status: 'paused' } }, 'grant_inactive', 409],
    ['revoked', { row: { status: 'revoked' } }, 'grant_inactive', 409],
    ['past expiry while still marked active', { row: { expiresAt: new Date(Date.now() - 1000) } }, 'grant_inactive', 409],
    ['no current revision', { row: { currentRevisionId: null } }, 'grant_inactive', 409],
    ['no entitlement', { entitled: false }, 'entitlement_required', 403],
    ['org grant, other org', { row: { orgId: 'orgB' } }, 'grant_scope_mismatch', 400],
  ] as Array<[string, Fx, string, number]>)('%s → %s', async (_n, fx, code, status) => {
    arrange(fx);
    const err = await validateWispGrantForSession(auth, 'g1', 'orgA').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WispSessionError);
    expect(err).toMatchObject({ code, status });
    expect((err as Error).message.length).toBeGreaterThan(10);
  });

  it('flag off short-circuits before any read', async () => {
    arrange({ enabled: false });
    await expect(validateWispGrantForSession(auth, 'g1', 'orgA')).rejects.toMatchObject({ code: 'wisp_disabled' });
    expect(h.selects).toEqual([]);
    expect(hasEntitlement).not.toHaveBeenCalled();
  });

  it('checks the entitlement against the grant partner, only after ownership and status pass', async () => {
    arrange({ row: { status: 'paused' } });
    await expect(validateWispGrantForSession(auth, 'g1', 'orgA')).rejects.toMatchObject({ code: 'grant_inactive' });
    expect(hasEntitlement).not.toHaveBeenCalled();

    arrange({});
    await validateWispGrantForSession(auth, 'g1', 'orgA');
    expect(hasEntitlement).toHaveBeenCalledWith('p1', 'wisp');
  });

  it('returns { grantId, revisionId, partnerId, orgId } for an active own grant', async () => {
    arrange({ row: { orgId: 'orgA' } });
    await expect(validateWispGrantForSession(auth, 'g1', 'orgA')).resolves.toEqual({
      grantId: 'g1', revisionId: 'r1', partnerId: 'p1', orgId: 'orgA',
    });
  });

  it('a partner-wide grant (orgId null) accepts any session org inside the partner', async () => {
    arrange({});
    await expect(validateWispGrantForSession(auth, 'g1', 'orgA')).resolves.toMatchObject({ orgId: null });
    await expect(validateWispGrantForSession(auth, 'g1', 'orgZ')).resolves.toMatchObject({ orgId: null });
  });

  it('reads the grant and the session org by id under SYSTEM context (an org token cannot see wisp_grants)', async () => {
    arrange({});
    await validateWispGrantForSession(auth, 'g1', 'orgA');
    expect(h.selects).toEqual(['grant', 'org']);
    expect(h.systemScoped).toEqual([true, true]);
  });
});

describe('assertGrantCoversSessionOrg', () => {
  it('passes for a partner-wide grant and for the grant org; refuses another org with grant_scope_mismatch', () => {
    const base = { grantId: 'g1', revisionId: 'r1', partnerId: 'p1' };
    expect(() => assertGrantCoversSessionOrg({ ...base, orgId: null }, 'orgX')).not.toThrow();
    expect(() => assertGrantCoversSessionOrg({ ...base, orgId: 'orgA' }, 'orgA')).not.toThrow();
    expect(() => assertGrantCoversSessionOrg({ ...base, orgId: 'orgA' }, 'orgB')).toThrow(
      expect.objectContaining({ code: 'grant_scope_mismatch', status: 400 }),
    );
  });
});
