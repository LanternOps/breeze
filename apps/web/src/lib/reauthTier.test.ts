import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../stores/auth', () => ({ fetchWithAuth: fetchMock }));

import { discoverReauthTier, useReauthTier } from './reauthTier';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function factors(user: unknown, passkeys: unknown, status = 200) {
  fetchMock.mockImplementation(async (url: string) => (url === '/users/me' ? json(status, user) : json(200, passkeys)));
}

beforeEach(() => vi.clearAllMocks());

describe('discoverReauthTier', () => {
  it('a passkey wins, in either passkeys response shape', async () => {
    factors({ mfaMethod: 'totp' }, [{ id: 'p' }]);
    await expect(discoverReauthTier()).resolves.toBe('passkey');
    factors({ mfaMethod: null }, { passkeys: [{ id: 'p' }] });
    await expect(discoverReauthTier()).resolves.toBe('passkey');
  });

  it('counts an authenticator app held beside the primary (#10650)', async () => {
    factors({ mfaMethod: 'sms', totpEnrolled: true }, []);
    await expect(discoverReauthTier()).resolves.toBe('totp');
    factors({ mfaMethod: 'sms' }, []);
    await expect(discoverReauthTier()).resolves.toBe('password');
  });

  it('throws when a read fails or is malformed', async () => {
    factors({ mfaMethod: 'totp' }, [], 500);
    await expect(discoverReauthTier()).rejects.toThrow();
    factors({ mfaMethod: 'totp' }, { nope: true });
    await expect(discoverReauthTier()).rejects.toThrow();
  });
});

describe('useReauthTier', () => {
  it('uses the factors the parent gives without reading them', async () => {
    const { result } = renderHook(() => useReauthTier(0, 'totp'));
    expect(result.current.tier).toBe('totp');
    await act(async () => { expect(await result.current.ensureTier()).toBe(true); });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('counts a backup authenticator the parent reports (#10650), without reading', async () => {
    // A passkey-primary account whose passkeys are all gone, with TOTP as its backup.
    const { result } = renderHook(() => useReauthTier(0, 'passkey', true));
    expect(result.current.tier).toBe('totp');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads them on the first step-up, reports a failure, and forgets them on reset', async () => {
    const { result } = renderHook(() => useReauthTier(undefined, undefined));
    expect(result.current.tier).toBeNull();
    factors({ mfaMethod: 'totp' }, [], 500);
    await act(async () => { expect(await result.current.ensureTier()).toBe(false); });
    expect(result.current.tier).toBeNull();
    factors({ mfaMethod: 'totp' }, []);
    await act(async () => { expect(await result.current.ensureTier()).toBe(true); });
    expect(result.current.tier).toBe('totp');
    act(() => result.current.resetTier());
    expect(result.current.tier).toBeNull();
  });
});
