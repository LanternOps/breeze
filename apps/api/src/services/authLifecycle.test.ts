import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { transaction: vi.fn() },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./tokenRevocation', () => ({ revokeAllUserTokens: vi.fn(async () => undefined) }));
vi.mock('./permissions', () => ({ clearPermissionCache: vi.fn(async () => undefined) }));
vi.mock('../oauth/grantRevocation', () => ({
  revokeAllUserOauthArtifacts: vi.fn(async () => ({ grantsRevoked: 1, refreshTokensRevoked: 2, jtisRevoked: 3 })),
}));

import { advanceUserEpochs, runPostCommitCleanup } from './authLifecycle';
import { revokeAllUserTokens } from './tokenRevocation';
import { clearPermissionCache } from './permissions';
import { revokeAllUserOauthArtifacts } from '../oauth/grantRevocation';

const setCalls: Record<string, unknown>[] = [];
function makeTx() {
  const updateChain = {
    set: (v: Record<string, unknown>) => { setCalls.push(v); return updateChain; },
    where: () => updateChain,
    returning: () => Promise.resolve([
      { authEpoch: 2, mfaEpoch: 1, emailEpoch: 1, passwordResetEpoch: 1 },
    ]),
  };
  return { update: () => updateChain };
}

describe('advanceUserEpochs', () => {
  it('increments only requested epochs and returns the new row', async () => {
    const tx = makeTx() as never;
    const result = await advanceUserEpochs(tx, 'u1', { auth: true });
    expect(result.authEpoch).toBe(2);
    // the SET payload used SQL increments for auth only
    expect(setCalls.length).toBe(1);
    const set = setCalls[0]!;
    expect(set.authEpoch).toBeDefined();
    expect(set.mfaEpoch).toBeUndefined();
    expect(set.emailEpoch).toBeUndefined();
    expect(set.passwordResetEpoch).toBeUndefined();
  });
});

describe('runPostCommitCleanup', () => {
  it('runs all three cleanups and reports success', async () => {
    const result = await runPostCommitCleanup('u1');
    expect(result).toMatchObject({ redisOk: true, permissionCacheOk: true, oauthOk: true });
    expect(result.oauthResult).toMatchObject({ grantsRevoked: 1 });
  });

  it('a Redis failure does not short-circuit the OAuth sweep and is reported, not thrown', async () => {
    vi.mocked(revokeAllUserTokens).mockRejectedValueOnce(new Error('redis down'));
    const result = await runPostCommitCleanup('u1');
    expect(result.redisOk).toBe(false);
    expect(result.oauthOk).toBe(true);
    expect(clearPermissionCache).toHaveBeenCalled();
    expect(revokeAllUserOauthArtifacts).toHaveBeenCalled();
  });
});
