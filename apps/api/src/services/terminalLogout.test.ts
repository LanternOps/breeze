import { beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycle = vi.hoisted(() => ({
  transaction: vi.fn(),
  revokeFamilies: vi.fn(),
}));
const revocation = vi.hoisted(() => ({
  revokeUserTokens: vi.fn(),
  revokeJti: vi.fn(),
}));

vi.mock('./authLifecycle', () => ({
  withAuthLifecycleSystemTransaction: (fn: (tx: object) => Promise<unknown>) => lifecycle.transaction(fn),
  revokeAllUserSessionFamilies: (...args: unknown[]) => lifecycle.revokeFamilies(...args),
}));
vi.mock('./tokenRevocation', () => ({
  revokeAllUserTokens: (...args: unknown[]) => revocation.revokeUserTokens(...args),
  revokeRefreshTokenJti: (...args: unknown[]) => revocation.revokeJti(...args),
}));

import { revokeTerminalLogoutSubjects } from './terminalLogout';

describe('revokeTerminalLogoutSubjects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycle.transaction.mockImplementation(async (fn: (tx: object) => Promise<unknown>) => fn({ kind: 'tx' }));
    lifecycle.revokeFamilies.mockResolvedValue(2);
    revocation.revokeUserTokens.mockResolvedValue(undefined);
    revocation.revokeJti.mockResolvedValue(true);
  });

  it('durably revokes every family for access and refresh subjects before Redis acceleration', async () => {
    await revokeTerminalLogoutSubjects({
      subjectIds: ['user-b', 'user-a', 'user-a'],
      refreshJti: 'refresh-jti',
    });

    expect(lifecycle.revokeFamilies.mock.calls).toEqual([
      [{ kind: 'tx' }, 'user-a', 'cf-access-terminal-logout'],
      [{ kind: 'tx' }, 'user-b', 'cf-access-terminal-logout'],
    ]);
    expect(revocation.revokeUserTokens.mock.calls).toEqual([['user-a'], ['user-b']]);
    expect(revocation.revokeJti).toHaveBeenCalledWith('refresh-jti');
    expect(lifecycle.revokeFamilies.mock.invocationCallOrder.at(-1))
      .toBeLessThan(revocation.revokeUserTokens.mock.invocationCallOrder[0]!);
  });

  it('still revokes all same-user families when access and refresh use different families', async () => {
    await revokeTerminalLogoutSubjects({ subjectIds: ['user-a', 'user-a'], refreshJti: 'jti-b' });

    expect(lifecycle.revokeFamilies).toHaveBeenCalledOnce();
    expect(lifecycle.revokeFamilies).toHaveBeenCalledWith(
      { kind: 'tx' },
      'user-a',
      'cf-access-terminal-logout',
    );
    expect(revocation.revokeJti).toHaveBeenCalledWith('jti-b');
  });

  it('fails closed when durable revocation cannot commit', async () => {
    lifecycle.revokeFamilies.mockRejectedValueOnce(new Error('postgres unavailable'));

    await expect(revokeTerminalLogoutSubjects({ subjectIds: ['user-a'] }))
      .rejects.toThrow('postgres unavailable');
    expect(revocation.revokeUserTokens).not.toHaveBeenCalled();
  });
});
