import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildExtraTokenClaims, handleRevocationSuccess } from './provider';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildExtraTokenClaims', () => {
  it('returns null tenant claims when the Grant is missing', async () => {
    await expect(buildExtraTokenClaims({ oidc: { entities: {} } }, {})).resolves.toEqual({
      partner_id: null,
      org_id: null,
    });
  });

  it('returns null tenant claims when grant.breeze is missing', async () => {
    await expect(buildExtraTokenClaims({ oidc: { entities: { Grant: {} } } }, {})).resolves.toEqual({
      partner_id: null,
      org_id: null,
    });
  });

  it('returns tenant claims from grant.breeze', async () => {
    await expect(
      buildExtraTokenClaims(
        { oidc: { entities: { Grant: { breeze: { partner_id: 'p1', org_id: 'o1' } } } } },
        {},
      ),
    ).resolves.toEqual({ partner_id: 'p1', org_id: 'o1' });
  });

  it('returns null for missing partial tenant claims', async () => {
    await expect(
      buildExtraTokenClaims({ oidc: { entities: { Grant: { breeze: { partner_id: 'p1' } } } } }, {}),
    ).resolves.toEqual({ partner_id: 'p1', org_id: null });
  });

  it('does not project any other grant fields', async () => {
    const claims = await buildExtraTokenClaims(
      {
        oidc: {
          entities: {
            Grant: {
              breeze: { partner_id: 'p1', org_id: 'o1', role: 'admin' },
              accountId: 'user-1',
            },
          },
        },
      },
      {},
    );

    expect(claims).toEqual({ partner_id: 'p1', org_id: 'o1' });
    expect(Object.keys(claims).sort()).toEqual(['org_id', 'partner_id']);
  });
});

describe('handleRevocationSuccess', () => {
  it('does nothing when token.jti is missing', () => {
    const revokeJti = vi.fn(async () => undefined);

    handleRevocationSuccess({}, { exp: 1_774_000_100 }, { revokeJti, now: () => 1_774_000_000_000 });

    expect(revokeJti).not.toHaveBeenCalled();
  });

  it('does nothing when token.exp is missing', () => {
    const revokeJti = vi.fn(async () => undefined);

    handleRevocationSuccess({}, { jti: 'jti-1' }, { revokeJti, now: () => 1_774_000_000_000 });

    expect(revokeJti).not.toHaveBeenCalled();
  });

  it('revokes the jti with the remaining token ttl', () => {
    const revokeJti = vi.fn(async () => undefined);

    handleRevocationSuccess({}, { jti: 'jti-1', exp: 1_774_000_120 }, { revokeJti, now: () => 1_774_000_000_000 });

    expect(revokeJti).toHaveBeenCalledOnce();
    expect(revokeJti).toHaveBeenCalledWith('jti-1', 120);
  });

  it('clamps a past token ttl to one second', () => {
    const revokeJti = vi.fn(async () => undefined);

    handleRevocationSuccess({}, { jti: 'jti-1', exp: 1_773_999_999 }, { revokeJti, now: () => 1_774_000_000_000 });

    expect(revokeJti).toHaveBeenCalledWith('jti-1', 1);
  });

  it('clamps a zero token ttl to one second', () => {
    const revokeJti = vi.fn(async () => undefined);

    handleRevocationSuccess({}, { jti: 'jti-1', exp: 1_774_000_000 }, { revokeJti, now: () => 1_774_000_000_000 });

    expect(revokeJti).toHaveBeenCalledWith('jti-1', 1);
  });

  it('logs but does not throw when the revocation cache write rejects', async () => {
    const err = new Error('redis down');
    const revokeJti = vi.fn(async () => {
      throw err;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      handleRevocationSuccess({}, { jti: 'jti-1', exp: 1_774_000_120 }, { revokeJti, now: () => 1_774_000_000_000 }),
    ).not.toThrow();
    await Promise.resolve();

    expect(consoleError).toHaveBeenCalledWith('[oauth] revocation cache write failed', err);
  });
});
