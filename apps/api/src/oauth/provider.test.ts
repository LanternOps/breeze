import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  ALL_MCP_SCOPES,
  buildExtraTokenClaims,
  handleRevocationSuccess,
  REFRESH_TOKEN_TTL_SECONDS,
  resolveMcpResourceServerScope,
  resolvePartnerIdForResourceServerInfo,
} from './provider';
import { GRANT_REVOCATION_TTL_SECONDS } from './adapter';
import { GRANT_REVOCATION_TTL_SECONDS as REVOCATION_SERVICE_GRANT_TTL_SECONDS } from './revocationService';
import { GrantTenancyError } from './effectiveScopes';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { users } from '../db/schema';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

// Mock the tenant-status assertion so provider tests stay hermetic — the
// real implementation issues `getActivePartner`/`getActiveOrgTenant` Drizzle
// queries against `partners` / `organizations`, which require a live DB and
// real UUIDs. The buildExtraTokenClaims tests below pass non-UUID fixtures
// like 'p1'/'o1' on purpose, so we no-op the assertion here.
vi.mock('../services/tenantStatus', () => ({
  TenantInactiveError: class TenantInactiveError extends Error {
    constructor(message = 'Tenant is not active') {
      super(message);
      this.name = 'TenantInactiveError';
    }
  },
  assertActiveTenantContext: vi.fn(async () => {}),
  getActivePartner: vi.fn(async () => null),
  getActiveOrgTenant: vi.fn(async () => null),
}));

// Mock the effective-scope module so provider tests stay hermetic and
// focus purely on WIRING (does getResourceServerInfo's logic route grant
// tenancy through resolveGrantContext, never the old sync/cache-only path;
// does it propagate a tenancy failure instead of swallowing it into "all
// scopes"). The scope-policy intersection math itself (partner policy
// reduction, displayed-set intersection, DB cold-cache resolution) is
// covered in effectiveScopes.test.ts.
vi.mock('./effectiveScopes', async () => {
  const actual = await vi.importActual<typeof import('./effectiveScopes')>('./effectiveScopes');
  return {
    ...actual,
    resolveGrantContext: vi.fn(),
    computeEffectiveMcpScopes: vi.fn(),
  };
});

const effectiveScopes = await import('./effectiveScopes');
const resolveGrantContextMock = vi.mocked(effectiveScopes.resolveGrantContext);
const computeEffectiveMcpScopesMock = vi.mocked(effectiveScopes.computeEffectiveMcpScopes);
const selectMock = vi.mocked(db.select);

function mockSelectRows(rows: unknown[]) {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  selectMock.mockReturnValueOnce({ from } as unknown as ReturnType<typeof db.select>);
  return { from, where, limit };
}

function mockSelectError(error: unknown) {
  const limit = vi.fn(async () => {
    throw error;
  });
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  selectMock.mockReturnValueOnce({ from } as unknown as ReturnType<typeof db.select>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OAuth token TTL policy', () => {
  it('keeps refresh tokens aligned with the 14-day Grant/Session lifetime', () => {
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(14 * 24 * 60 * 60);
  });

  it('uses a 30-minute access token TTL (#2363 — 600s forced a refresh every 10 min)', () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(1800);
  });

  it('keeps the grant-revocation marker TTL >= the access token TTL (drift guard, #2363)', () => {
    // adapter.ts hand-syncs GRANT_REVOCATION_TTL_SECONDS because importing
    // provider.ts there would create an import cycle. The marker must
    // outlive the longest-lived access JWT minted under a grant — if it
    // expired first, revoked grants' sibling access tokens would validate
    // again for the remainder of their lifetime.
    expect(GRANT_REVOCATION_TTL_SECONDS).toBeGreaterThanOrEqual(ACCESS_TOKEN_TTL_SECONDS);
    // revocationService.ts hand-syncs the same marker TTL (it stays off the
    // provider import chain for the same cycle reason) — hold it to the same
    // floor so a future TTL bump can't silently reopen the residual-access
    // window through the grants-driven revocation path (MCP-OAUTH-07/10).
    expect(REVOCATION_SERVICE_GRANT_TTL_SECONDS).toBeGreaterThanOrEqual(ACCESS_TOKEN_TTL_SECONDS);
  });
});

describe('buildExtraTokenClaims', () => {
  it('denies minting when the Grant is missing', async () => {
    await expect(buildExtraTokenClaims({ oidc: { entities: {} } }, {})).rejects.toThrow(
      /authoritative OAuth grant/i,
    );
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('denies minting when the Grant has no authoritative account', async () => {
    await expect(
      buildExtraTokenClaims(
        { oidc: { entities: { Grant: { jti: 'grant-no-account', breeze: { partner_id: 'p1' } } } } },
        {},
      ),
    ).rejects.toThrow(/authoritative account/i);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('includes the active user auth epoch and preserves partner, org, and grant claims', async () => {
    const query = mockSelectRows([{ id: 'user-1', status: 'active', authEpoch: 7 }]);

    await expect(
      buildExtraTokenClaims(
        {
          oidc: {
            entities: {
              Grant: {
                jti: 'grant-1',
                accountId: 'user-1',
                breeze: { partner_id: 'p1', org_id: 'o1' },
              },
            },
          },
        },
        { accountId: 'user-1' },
      ),
    ).resolves.toEqual({
      partner_id: 'p1',
      org_id: 'o1',
      grant_id: 'grant-1',
      auth_epoch: 7,
    });
    expect(selectMock).toHaveBeenCalledWith({
      id: users.id,
      status: users.status,
      authEpoch: users.authEpoch,
    });
    expect(query.limit).toHaveBeenCalledWith(1);
    expect(runOutsideDbContext).toHaveBeenCalledOnce();
    expect(withSystemDbAccessContext).toHaveBeenCalledOnce();
  });

  it('preserves a null organization claim for a partner-scoped grant', async () => {
    mockSelectRows([{ id: 'user-1', status: 'active', authEpoch: 3 }]);

    await expect(
      buildExtraTokenClaims(
        {
          oidc: {
            entities: {
              Grant: {
                jti: 'grant-2',
                accountId: 'user-1',
                breeze: { partner_id: 'p1' },
              },
            },
          },
        },
        { accountId: 'user-1' },
      ),
    ).resolves.toEqual({
      partner_id: 'p1',
      org_id: null,
      grant_id: 'grant-2',
      auth_epoch: 3,
    });
  });

  it('denies a grant/token account mismatch before any database lookup', async () => {
    await expect(
      buildExtraTokenClaims(
        {
          oidc: {
            entities: {
              Grant: {
                jti: 'grant-mismatch',
                accountId: 'user-authoritative',
                breeze: { partner_id: 'p1' },
              },
            },
          },
        },
        { accountId: 'user-other' },
      ),
    ).rejects.toThrow(/account mismatch/i);
    expect(selectMock).not.toHaveBeenCalled();
    expect(runOutsideDbContext).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', []],
    ['inactive', [{ id: 'user-1', status: 'disabled', authEpoch: 9 }]],
  ])('denies minting when the authoritative user is %s', async (_case, rows) => {
    mockSelectRows(rows);

    await expect(
      buildExtraTokenClaims(
        {
          oidc: {
            entities: {
              Grant: {
                jti: `grant-${_case}`,
                accountId: 'user-1',
                breeze: { partner_id: 'p1' },
              },
            },
          },
        },
        { accountId: 'user-1' },
      ),
    ).rejects.toThrow(/active OAuth user/i);
  });

  it('propagates database failure so oidc-provider returns server_error', async () => {
    const databaseError = new Error('database unavailable');
    mockSelectError(databaseError);

    await expect(
      buildExtraTokenClaims(
        {
          oidc: {
            entities: {
              Grant: {
                jti: 'grant-db-failure',
                accountId: 'user-1',
                breeze: { partner_id: 'p1' },
              },
            },
          },
        },
        { accountId: 'user-1' },
      ),
    ).rejects.toBe(databaseError);
  });

  it('does not project any other grant fields beyond the canonical access claims', async () => {
    // grant_id is now also surfaced (added 2026-04-24 so bearer middleware can
    // check the grant-revocation cache and reject every access JWT minted
    // under a revoked grant). Aside from that the projection stays narrow.
    mockSelectRows([{ id: 'user-1', status: 'active', authEpoch: 11 }]);
    const claims = await buildExtraTokenClaims(
      {
        oidc: {
          entities: {
            Grant: {
              jti: 'grant-3',
              breeze: { partner_id: 'p1', org_id: 'o1', role: 'admin' },
              accountId: 'user-1',
            },
          },
        },
      },
      { accountId: 'user-1' },
    );

    expect(claims).toEqual({
      partner_id: 'p1',
      org_id: 'o1',
      grant_id: 'grant-3',
      auth_epoch: 11,
    });
    expect(Object.keys(claims).sort()).toEqual(['auth_epoch', 'grant_id', 'org_id', 'partner_id']);
  });
});

describe('handleRevocationSuccess', () => {
  it('does nothing when token.jti is missing', async () => {
    const writeMarker = vi.fn(async () => ({ status: 'written' as const }));

    await handleRevocationSuccess({}, { sub: 'user-1', exp: 1_774_000_100 }, { writeMarker, now: () => 1_774_000_000_000 });

    expect(writeMarker).not.toHaveBeenCalled();
  });

  it('does nothing when token.exp is missing', async () => {
    const writeMarker = vi.fn(async () => ({ status: 'written' as const }));

    await handleRevocationSuccess({}, { sub: 'user-1', jti: 'jti-1' }, { writeMarker, now: () => 1_774_000_000_000 });

    expect(writeMarker).not.toHaveBeenCalled();
  });

  it('revokes the jti with the remaining token ttl', async () => {
    const writeMarker = vi.fn(async () => ({ status: 'written' as const }));

    await handleRevocationSuccess(
      {},
      { sub: 'user-1', jti: 'jti-1', exp: 1_774_000_120 },
      { writeMarker, now: () => 1_774_000_000_000 },
    );

    expect(writeMarker).toHaveBeenCalledOnce();
    expect(writeMarker).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        userId: 'user-1',
        markerType: 'jti',
        markerId: 'jti-1',
        expiresAt: new Date(1_774_000_120_000),
      }),
    );
  });

  it('clamps a past token ttl to one second', async () => {
    const writeMarker = vi.fn(async () => ({ status: 'written' as const }));

    await handleRevocationSuccess(
      {},
      { sub: 'user-1', jti: 'jti-1', exp: 1_773_999_999 },
      { writeMarker, now: () => 1_774_000_000_000 },
    );

    expect(writeMarker).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ expiresAt: new Date(1_774_000_001_000) }),
    );
  });

  it('clamps a zero token ttl to one second', async () => {
    const writeMarker = vi.fn(async () => ({ status: 'written' as const }));

    await handleRevocationSuccess(
      {},
      { sub: 'user-1', jti: 'jti-1', exp: 1_774_000_000 },
      { writeMarker, now: () => 1_774_000_000_000 },
    );

    expect(writeMarker).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ expiresAt: new Date(1_774_000_001_000) }),
    );
  });

  it('fails closed only after the durable helper queues a retry', async () => {
    const writeMarker = vi.fn(async () => ({
      status: 'retry_queued' as const,
      errorCode: 'redis_unavailable' as const,
    }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      handleRevocationSuccess(
        { oidc: { client: { clientId: 'client-z' } } },
        { sub: 'user-1', jti: 'jti-1', exp: 1_774_000_120 },
        { writeMarker, now: () => 1_774_000_000_000 },
      ),
    ).rejects.toThrow(/revocation cache unavailable/i);

    expect(writeMarker).toHaveBeenCalledOnce();
    expect(withSystemDbAccessContext).toHaveBeenCalled();
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('jti-1');
  });
});

describe('resolvePartnerIdForResourceServerInfo', () => {
  // MCP-OAUTH-02: this function no longer looks at the Grant entity at all —
  // Grant tenancy resolution moved to the async `resolveGrantContext`
  // (effectiveScopes.ts), which `resolveMcpResourceServerScope` calls
  // directly for grant-bearing requests. This function is now ONLY the
  // grantless-flow (client-binding) fallback.
  it('falls back to client.partner_id when there is no Grant', () => {
    const id = resolvePartnerIdForResourceServerInfo(
      { oidc: { entities: {} } },
      { partner_id: 'partner-B' },
    );
    expect(id).toBe('partner-B');
  });

  it('returns null when no client partner binding is resolvable', () => {
    const id = resolvePartnerIdForResourceServerInfo(
      { oidc: { entities: {} } },
      {},
    );
    expect(id).toBeNull();
  });

  it('ignores a Grant entity even if one is present (Grant path is handled elsewhere)', () => {
    const id = resolvePartnerIdForResourceServerInfo(
      { oidc: { entities: { Grant: { jti: 'g1', breeze: { partner_id: 'partner-A' } } } } },
      {},
    );
    expect(id).toBeNull();
  });
});

describe('resolveMcpResourceServerScope', () => {
  it('grant present: resolves tenancy via resolveGrantContext (never the old sync/cache-only path)', async () => {
    resolveGrantContextMock.mockResolvedValue({ grantId: 'g1', partnerId: 'partner-A', orgId: 'org-1' });
    computeEffectiveMcpScopesMock.mockResolvedValue(['mcp:read']);

    const result = await resolveMcpResourceServerScope(
      { oidc: { entities: { Grant: { jti: 'g1' } } } },
      {},
    );

    expect(resolveGrantContextMock).toHaveBeenCalledWith('g1');
    expect(computeEffectiveMcpScopesMock).toHaveBeenCalledWith({
      requested: [...ALL_MCP_SCOPES],
      partnerId: 'partner-A',
      hasGrant: true,
    });
    expect(result).toEqual({ scope: 'mcp:read', partnerId: 'partner-A', reduced: true });
  });

  it('grant present but resolveGrantContext resolves null partner: computeEffectiveMcpScopes still sees hasGrant=true (fails closed, cannot escape to all scopes)', async () => {
    resolveGrantContextMock.mockResolvedValue(null);
    computeEffectiveMcpScopesMock.mockImplementation(async ({ partnerId, hasGrant }) => {
      if (partnerId === null && hasGrant) throw new GrantTenancyError('no tenancy');
      return [];
    });

    await expect(
      resolveMcpResourceServerScope({ oidc: { entities: { Grant: { jti: 'g2' } } } }, {}),
    ).rejects.toThrow(GrantTenancyError);
    expect(computeEffectiveMcpScopesMock).toHaveBeenCalledWith({
      requested: [...ALL_MCP_SCOPES],
      partnerId: null,
      hasGrant: true,
    });
  });

  it('grant present + resolveGrantContext itself throws GrantTenancyError: propagates (structured OAuth error, generic client message — see err_out.js)', async () => {
    const err = new GrantTenancyError('grant g3 has no durable partner tenancy');
    resolveGrantContextMock.mockRejectedValue(err);

    await expect(
      resolveMcpResourceServerScope({ oidc: { entities: { Grant: { jti: 'g3' } } } }, {}),
    ).rejects.toBe(err);
    expect(computeEffectiveMcpScopesMock).not.toHaveBeenCalled();
  });

  it('no grant present: resolves partnerId via the client fallback and never calls resolveGrantContext', async () => {
    computeEffectiveMcpScopesMock.mockResolvedValue([...ALL_MCP_SCOPES]);

    const result = await resolveMcpResourceServerScope(
      { oidc: { entities: {} } },
      { partner_id: 'partner-B' },
    );

    expect(resolveGrantContextMock).not.toHaveBeenCalled();
    expect(computeEffectiveMcpScopesMock).toHaveBeenCalledWith({
      requested: [...ALL_MCP_SCOPES],
      partnerId: 'partner-B',
      hasGrant: false,
    });
    expect(result).toEqual({ scope: ALL_MCP_SCOPES.join(' '), partnerId: 'partner-B', reduced: false });
  });

  it('no grant, no resolvable partner: still routes through computeEffectiveMcpScopes (documented legacy behavior lives there, not here)', async () => {
    computeEffectiveMcpScopesMock.mockResolvedValue([...ALL_MCP_SCOPES]);

    const result = await resolveMcpResourceServerScope({ oidc: { entities: {} } }, {});

    expect(computeEffectiveMcpScopesMock).toHaveBeenCalledWith({
      requested: [...ALL_MCP_SCOPES],
      partnerId: null,
      hasGrant: false,
    });
    expect(result.partnerId).toBeNull();
  });

  it('marks reduced=true when computeEffectiveMcpScopes narrows the set', async () => {
    resolveGrantContextMock.mockResolvedValue({ grantId: 'g4', partnerId: 'partner-C', orgId: null });
    computeEffectiveMcpScopesMock.mockResolvedValue(['mcp:read']);

    const result = await resolveMcpResourceServerScope(
      { oidc: { entities: { Grant: { grantId: 'g4' } } } },
      {},
    );

    expect(result.reduced).toBe(true);
    expect(result.scope).toBe('mcp:read');
  });
});
