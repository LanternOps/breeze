import { describe, expect, it, vi } from 'vitest';
import { deriveIsRecursive } from './approvalRecursion';

const TARGET_USER = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';
const MOBILE_CLIENT_ID = 'cli_breeze_mobile';
const HELPER_CLIENT_ID = 'cli_breeze_helper';

function fakeResolver(map: Record<string, string | null>) {
  return vi.fn(async (id: string) => map[id] ?? null);
}

describe('deriveIsRecursive', () => {
  it('returns false when requestingClientId is null (current AI-agent path)', async () => {
    const result = await deriveIsRecursive({
      requestingClientId: null,
      targetUserId: TARGET_USER,
      resolveClientName: fakeResolver({}),
    });
    expect(result).toBe(false);
  });

  it('returns false when no resolver is supplied', async () => {
    const result = await deriveIsRecursive({
      requestingClientId: MOBILE_CLIENT_ID,
      targetUserId: TARGET_USER,
    });
    expect(result).toBe(false);
  });

  it('returns true when the requesting OAuth client is "Breeze Mobile" and the user matches', async () => {
    const result = await deriveIsRecursive({
      requestingClientId: MOBILE_CLIENT_ID,
      targetUserId: TARGET_USER,
      requestingUserId: TARGET_USER,
      resolveClientName: fakeResolver({ [MOBILE_CLIENT_ID]: 'Breeze Mobile' }),
    });
    expect(result).toBe(true);
  });

  it('also accepts the kebab-case client_name registration', async () => {
    const result = await deriveIsRecursive({
      requestingClientId: MOBILE_CLIENT_ID,
      targetUserId: TARGET_USER,
      requestingUserId: TARGET_USER,
      resolveClientName: fakeResolver({ [MOBILE_CLIENT_ID]: 'breeze-mobile' }),
    });
    expect(result).toBe(true);
  });

  it('returns false when the requesting user differs from the target user', async () => {
    const result = await deriveIsRecursive({
      requestingClientId: MOBILE_CLIENT_ID,
      targetUserId: TARGET_USER,
      requestingUserId: OTHER_USER,
      resolveClientName: fakeResolver({ [MOBILE_CLIENT_ID]: 'Breeze Mobile' }),
    });
    expect(result).toBe(false);
  });

  it('returns false for a non-mobile OAuth client even when users match', async () => {
    const result = await deriveIsRecursive({
      requestingClientId: HELPER_CLIENT_ID,
      targetUserId: TARGET_USER,
      requestingUserId: TARGET_USER,
      resolveClientName: fakeResolver({ [HELPER_CLIENT_ID]: 'Breeze Helper' }),
    });
    expect(result).toBe(false);
  });

  it('returns false when the resolver returns null (unknown client)', async () => {
    const result = await deriveIsRecursive({
      requestingClientId: 'cli_deleted',
      targetUserId: TARGET_USER,
      requestingUserId: TARGET_USER,
      resolveClientName: fakeResolver({}),
    });
    expect(result).toBe(false);
  });

  it('fails closed when the resolver throws', async () => {
    const resolver = vi.fn(async () => {
      throw new Error('db down');
    });
    const result = await deriveIsRecursive({
      requestingClientId: MOBILE_CLIENT_ID,
      targetUserId: TARGET_USER,
      requestingUserId: TARGET_USER,
      resolveClientName: resolver,
    });
    expect(result).toBe(false);
  });

  it('skips the resolver when requestingUserId already disqualifies the loop', async () => {
    const resolver = vi.fn(async () => 'Breeze Mobile');
    const result = await deriveIsRecursive({
      requestingClientId: MOBILE_CLIENT_ID,
      targetUserId: TARGET_USER,
      requestingUserId: OTHER_USER,
      resolveClientName: resolver,
    });
    expect(result).toBe(false);
    expect(resolver).not.toHaveBeenCalled();
  });
});
