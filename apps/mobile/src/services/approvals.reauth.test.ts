import { beforeEach, describe, expect, it, vi } from 'vitest';

// #4052: critical-tier (L4) approvals need a fresh account re-auth
// (`reauthPassword` / `reauthMfaCode`) on the approve body, and the 401s the
// server answers for it must be told apart from a failed hardware step-up.

const { fetchWithAuthRefreshMock } = vi.hoisted(() => ({
  fetchWithAuthRefreshMock: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => 'tok'),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock('./serverConfig', () => ({ getServerUrl: vi.fn(async () => 'https://api.example.test') }));
vi.mock('./authedFetch', () => ({ fetchWithAuthRefresh: fetchWithAuthRefreshMock }));

import { approveRequest } from './approvals';

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

function sentBody(): Record<string, unknown> | undefined {
  const init = fetchWithAuthRefreshMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return init?.body ? JSON.parse(init.body as string) : undefined;
}

describe('approveRequest critical-tier re-auth (#4052)', () => {
  beforeEach(() => {
    fetchWithAuthRefreshMock.mockReset();
    fetchWithAuthRefreshMock.mockResolvedValue(jsonResponse(200, { approval: { id: 'a1' } }));
  });

  it('sends reauthPassword for a password factor, alongside the hardware proof', async () => {
    await approveRequest('a1', { proof: { sig: 'x' }, reauth: { kind: 'password', value: 'hunter2' } });
    const body = sentBody();
    expect(body?.reauthPassword).toBe('hunter2');
    expect(body?.reauthMfaCode).toBeUndefined();
    expect(body?.proof).toEqual({ sig: 'x' });
  });

  it('sends reauthMfaCode for an authenticator-code factor', async () => {
    await approveRequest('a1', { reauth: { kind: 'totp', value: '123456' } });
    const body = sentBody();
    expect(body?.reauthMfaCode).toBe('123456');
    expect(body?.reauthPassword).toBeUndefined();
  });

  it('never refreshes-and-replays an approve carrying a re-auth secret', async () => {
    await approveRequest('a1', { reauth: { kind: 'password', value: 'hunter2' } });
    expect(fetchWithAuthRefreshMock.mock.calls[0]?.[3]).toEqual({ retryOnAuthFailure: false });
  });

  it('sends no body at all when there is nothing to step up with (unchanged)', async () => {
    await approveRequest('a1');
    expect(sentBody()).toBeUndefined();
  });

  it('maps 401 reauth_required to REAUTH_REQUIRED', async () => {
    fetchWithAuthRefreshMock.mockResolvedValue(jsonResponse(401, { success: false, error: 'reauth_required' }));
    await expect(approveRequest('a1', { proof: { sig: 'x' } })).rejects.toThrow('REAUTH_REQUIRED');
  });

  it('maps a rejected password/code (401 invalid_credentials) to REAUTH_INVALID', async () => {
    fetchWithAuthRefreshMock.mockResolvedValue(
      jsonResponse(401, { error: 'Invalid credentials', message: 'Invalid credentials', code: 'invalid_credentials' }),
    );
    await expect(
      approveRequest('a1', { reauth: { kind: 'password', value: 'wrong' } }),
    ).rejects.toThrow('REAUTH_INVALID');
  });

  it('maps a throttled re-auth (429) to REAUTH_THROTTLED', async () => {
    fetchWithAuthRefreshMock.mockResolvedValue(
      jsonResponse(429, { error: 'Too many attempts. Please try again later.' }),
    );
    await expect(
      approveRequest('a1', { reauth: { kind: 'totp', value: '000000' } }),
    ).rejects.toThrow('REAUTH_THROTTLED');
  });

  it('keeps any other 401 as STEP_UP_FAILED', async () => {
    fetchWithAuthRefreshMock.mockResolvedValue(jsonResponse(401, { success: false, error: 'assertion_failed' }));
    await expect(approveRequest('a1', { proof: { sig: 'x' } })).rejects.toThrow('STEP_UP_FAILED');
  });

  it('keeps a 401 with an unreadable body as STEP_UP_FAILED', async () => {
    fetchWithAuthRefreshMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: vi.fn().mockRejectedValue(new Error('not json')),
    } as unknown as Response);
    await expect(approveRequest('a1')).rejects.toThrow('STEP_UP_FAILED');
  });
});
