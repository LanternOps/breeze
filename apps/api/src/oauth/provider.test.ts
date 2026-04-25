import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_MCP_SCOPES,
  buildExtraTokenClaims,
  handleRevocationSuccess,
  REFRESH_TOKEN_TTL_SECONDS,
  resolveAllowedMcpScopes,
  resolvePartnerIdForResourceServerInfo,
} from './provider';
import { clearPartnerScopePolicyCache } from './partnerScopePolicy';

// Mock the policy module so provider tests stay hermetic — the real
// lookup touches the DB, which isn't wired up in unit tests.
vi.mock('./partnerScopePolicy', async () => {
  const actual = await vi.importActual<typeof import('./partnerScopePolicy')>('./partnerScopePolicy');
  const policyByPartner = new Map<string, { mcp_allowed_scopes?: string[] }>();
  return {
    ...actual,
    getPartnerScopePolicy: vi.fn(async (partnerId: string) =>
      policyByPartner.get(partnerId) ?? {},
    ),
    clearPartnerScopePolicyCache: vi.fn((partnerId?: string) => {
      if (partnerId) policyByPartner.delete(partnerId);
      else policyByPartner.clear();
    }),
    // Test-only setter so individual tests can arrange scenarios.
    __setTestPolicy: (partnerId: string, policy: { mcp_allowed_scopes?: string[] }) => {
      policyByPartner.set(partnerId, policy);
    },
  };
});

beforeEach(() => {
  clearPartnerScopePolicyCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OAuth token TTL policy', () => {
  it('keeps refresh tokens aligned with the 14-day Grant/Session lifetime', () => {
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(14 * 24 * 60 * 60);
  });
});

describe('buildExtraTokenClaims', () => {
  it('returns null tenant claims when the Grant is missing', async () => {
    await expect(buildExtraTokenClaims({ oidc: { entities: {} } }, {})).resolves.toEqual({
      partner_id: null,
      org_id: null,
      grant_id: null,
    });
  });

  it('returns null tenant claims when grant.breeze is missing', async () => {
    await expect(buildExtraTokenClaims({ oidc: { entities: { Grant: {} } } }, {})).resolves.toEqual({
      partner_id: null,
      org_id: null,
      grant_id: null,
    });
  });

  it('returns tenant claims from grant.breeze and the grant id from grant.jti', async () => {
    await expect(
      buildExtraTokenClaims(
        { oidc: { entities: { Grant: { jti: 'grant-1', breeze: { partner_id: 'p1', org_id: 'o1' } } } } },
        {},
      ),
    ).resolves.toEqual({ partner_id: 'p1', org_id: 'o1', grant_id: 'grant-1' });
  });

  it('returns null for missing partial tenant claims (still surfaces grant_id)', async () => {
    await expect(
      buildExtraTokenClaims({ oidc: { entities: { Grant: { jti: 'grant-2', breeze: { partner_id: 'p1' } } } } }, {}),
    ).resolves.toEqual({ partner_id: 'p1', org_id: null, grant_id: 'grant-2' });
  });

  it('does not project any other grant fields beyond partner_id, org_id, grant_id', async () => {
    // grant_id is now also surfaced (added 2026-04-24 so bearer middleware can
    // check the grant-revocation cache and reject every access JWT minted
    // under a revoked grant). Aside from that the projection stays narrow.
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
      {},
    );

    expect(claims).toEqual({ partner_id: 'p1', org_id: 'o1', grant_id: 'grant-3' });
    expect(Object.keys(claims).sort()).toEqual(['grant_id', 'org_id', 'partner_id']);
  });
});

describe('handleRevocationSuccess', () => {
  it('does nothing when token.jti is missing', async () => {
    const revokeJti = vi.fn(async () => undefined);

    await handleRevocationSuccess({}, { exp: 1_774_000_100 }, { revokeJti, now: () => 1_774_000_000_000 });

    expect(revokeJti).not.toHaveBeenCalled();
  });

  it('does nothing when token.exp is missing', async () => {
    const revokeJti = vi.fn(async () => undefined);

    await handleRevocationSuccess({}, { jti: 'jti-1' }, { revokeJti, now: () => 1_774_000_000_000 });

    expect(revokeJti).not.toHaveBeenCalled();
  });

  it('revokes the jti with the remaining token ttl', async () => {
    const revokeJti = vi.fn(async () => undefined);

    await handleRevocationSuccess({}, { jti: 'jti-1', exp: 1_774_000_120 }, { revokeJti, now: () => 1_774_000_000_000 });

    expect(revokeJti).toHaveBeenCalledOnce();
    expect(revokeJti).toHaveBeenCalledWith('jti-1', 120);
  });

  it('clamps a past token ttl to one second', async () => {
    const revokeJti = vi.fn(async () => undefined);

    await handleRevocationSuccess({}, { jti: 'jti-1', exp: 1_773_999_999 }, { revokeJti, now: () => 1_774_000_000_000 });

    expect(revokeJti).toHaveBeenCalledWith('jti-1', 1);
  });

  it('clamps a zero token ttl to one second', async () => {
    const revokeJti = vi.fn(async () => undefined);

    await handleRevocationSuccess({}, { jti: 'jti-1', exp: 1_774_000_000 }, { revokeJti, now: () => 1_774_000_000_000 });

    expect(revokeJti).toHaveBeenCalledWith('jti-1', 1);
  });

  it('logs and rethrows when the revocation cache write rejects (operator-visible 5xx)', async () => {
    const err = new Error('redis down');
    const revokeJti = vi.fn(async () => {
      throw err;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      handleRevocationSuccess(
        { oidc: { client: { clientId: 'client-z' } } },
        { jti: 'jti-1', exp: 1_774_000_120 },
        { revokeJti, now: () => 1_774_000_000_000 },
      ),
    ).rejects.toBe(err);

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('OAUTH_REVOCATION_CACHE_WRITE_FAILED'),
      expect.objectContaining({ jti: 'jti-1', clientId: 'client-z' }),
    );
  });
});

describe('resolvePartnerIdForResourceServerInfo', () => {
  it('returns partner_id from the Grant entity when present', () => {
    const id = resolvePartnerIdForResourceServerInfo(
      { oidc: { entities: { Grant: { jti: 'g1', breeze: { partner_id: 'partner-A', org_id: 'o1' } } } } },
      {},
    );
    expect(id).toBe('partner-A');
  });

  it('falls back to client.partner_id when Grant is missing', () => {
    const id = resolvePartnerIdForResourceServerInfo(
      { oidc: { entities: {} } },
      { partner_id: 'partner-B' },
    );
    expect(id).toBe('partner-B');
  });

  it('returns null when neither source carries a partner_id', () => {
    const id = resolvePartnerIdForResourceServerInfo(
      { oidc: { entities: {} } },
      {},
    );
    expect(id).toBeNull();
  });
});

describe('resolveAllowedMcpScopes', () => {
  it('returns all scopes when partnerId is null', async () => {
    const { allowed, reduced } = await resolveAllowedMcpScopes(null);
    expect(allowed).toEqual([...ALL_MCP_SCOPES]);
    expect(reduced).toBe(false);
  });

  it('returns all scopes when the partner has no policy (back-compat)', async () => {
    const { allowed, reduced } = await resolveAllowedMcpScopes('partner-no-policy');
    expect(allowed).toEqual([...ALL_MCP_SCOPES]);
    expect(reduced).toBe(false);
  });

  it('intersects the issuable set with mcp_allowed_scopes', async () => {
    const mod = await import('./partnerScopePolicy');
    (mod as unknown as { __setTestPolicy: (p: string, v: { mcp_allowed_scopes: string[] }) => void })
      .__setTestPolicy('partner-readonly', { mcp_allowed_scopes: ['mcp:read'] });

    const { allowed, reduced } = await resolveAllowedMcpScopes('partner-readonly');
    expect(allowed).toEqual(['mcp:read']);
    expect(reduced).toBe(true);
  });

  it('drops scopes the partner does not allow even if every scope is requested', async () => {
    const mod = await import('./partnerScopePolicy');
    (mod as unknown as { __setTestPolicy: (p: string, v: { mcp_allowed_scopes: string[] }) => void })
      .__setTestPolicy('partner-limited', { mcp_allowed_scopes: ['mcp:read', 'mcp:execute'] });

    const { allowed, reduced } = await resolveAllowedMcpScopes('partner-limited');
    expect(allowed).toEqual(['mcp:read', 'mcp:execute']);
    expect(reduced).toBe(true);
  });

  it('returns an empty list when the policy disallows every known scope', async () => {
    const mod = await import('./partnerScopePolicy');
    (mod as unknown as { __setTestPolicy: (p: string, v: { mcp_allowed_scopes: string[] }) => void })
      .__setTestPolicy('partner-none', { mcp_allowed_scopes: [] });

    const { allowed, reduced } = await resolveAllowedMcpScopes('partner-none');
    expect(allowed).toEqual([]);
    expect(reduced).toBe(true);
  });
});
