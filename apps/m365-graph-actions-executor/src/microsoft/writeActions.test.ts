import { describe, it, expect, vi } from 'vitest';
import { executeGraphWriteAction, generateTemporaryPassword } from './writeActions';
import { GraphClientError, type MicrosoftGraphClient } from './graphClient';
import type { OpaqueAccessToken } from './tokenClient';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ACCESS_TOKEN = 't' as OpaqueAccessToken;

function client(overrides: Partial<MicrosoftGraphClient>): MicrosoftGraphClient {
  return {
    probeTenant: vi.fn(),
    readResource: vi.fn().mockResolvedValue({ id: USER_ID }),
    readCollection: vi.fn(),
    patch: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as MicrosoftGraphClient;
}

describe('executeGraphWriteAction — disable', () => {
  it('resolves the user then PATCHes accountEnabled:false', async () => {
    const patch = vi.fn().mockResolvedValue(undefined);
    const gc = client({ patch });
    const result = await executeGraphWriteAction(
      { type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x' },
      { accessToken: ACCESS_TOKEN, graphClient: gc },
    );
    expect(result).toEqual({ success: true, action: 'm365.user.disable', userId: USER_ID });
    expect(patch).toHaveBeenCalledWith(expect.objectContaining({
      path: `/users/${USER_ID}`,
      body: { accountEnabled: false },
    }));
  });

  it('maps a 404 on resolve to user_not_found (no PATCH)', async () => {
    const patch = vi.fn();
    const gc = client({
      readResource: vi.fn().mockRejectedValue(new GraphClientError('graph_not_found')),
      patch,
    });
    const result = await executeGraphWriteAction(
      { type: 'm365.user.disable', userIdentifier: 'ghost@b.com', reason: 'x' },
      { accessToken: ACCESS_TOKEN, graphClient: gc },
    );
    expect(result).toEqual({ success: false, errorCode: 'user_not_found' });
    expect(patch).not.toHaveBeenCalled();
  });
});

describe('executeGraphWriteAction — reset', () => {
  it('PATCHes passwordProfile with forceChange and returns the temp password', async () => {
    const patch = vi.fn().mockResolvedValue(undefined);
    const gc = client({ patch });
    const result = await executeGraphWriteAction(
      { type: 'm365.user.reset_password', userIdentifier: 'a@b.com', reason: 'x' },
      { accessToken: ACCESS_TOKEN, graphClient: gc },
    );
    expect(result.success).toBe(true);
    if (result.success && result.action === 'm365.user.reset_password') {
      expect(result.userId).toBe(USER_ID);
      expect(result.forceChangeNextSignIn).toBe(true);
      expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(16);
    }
    const body = patch.mock.calls[0]![0].body;
    expect(body.passwordProfile.forceChangePasswordNextSignIn).toBe(true);
    expect(typeof body.passwordProfile.password).toBe('string');
  });

  it('maps a 429 to graph_throttled with retryAfter', async () => {
    const gc = client({ patch: vi.fn().mockRejectedValue(new GraphClientError('graph_throttled', 30)) });
    const result = await executeGraphWriteAction(
      { type: 'm365.user.reset_password', userIdentifier: 'a@b.com', reason: 'x' },
      { accessToken: ACCESS_TOKEN, graphClient: gc },
    );
    expect(result).toEqual({ success: false, errorCode: 'graph_throttled', retryAfterSeconds: 30 });
  });
});

describe('generateTemporaryPassword', () => {
  it('is >=16 chars and mixes classes', () => {
    const pw = generateTemporaryPassword();
    expect(pw.length).toBeGreaterThanOrEqual(16);
    expect(/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw)).toBe(true);
  });
});
