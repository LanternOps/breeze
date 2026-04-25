import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildExtraTokenClaims, handleRevocationSuccess, REFRESH_TOKEN_TTL_SECONDS } from './provider';

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
