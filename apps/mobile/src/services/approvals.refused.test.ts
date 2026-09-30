import { beforeEach, describe, expect, it, vi } from 'vitest';

// An approve the server refuses (a PAM elevation whose target could not be
// verified) must come back as not approved, whatever server version answers.
// Current servers store the row as `denied` with `refusalReason`; older ones
// return the row still `approved` and report the refusal only as
// `enforcementStatus: 'refused'` next to it.

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

const unverified = 'Target identity could not be verified on the device; re-request elevation.';

function jsonResponse(payload: unknown): Response {
  return { ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) } as unknown as Response;
}

describe('approveRequest: a refused approve is never returned as approved', () => {
  beforeEach(() => {
    fetchWithAuthRefreshMock.mockReset();
  });

  it('returns the row a current server stored as denied, unchanged', async () => {
    fetchWithAuthRefreshMock.mockResolvedValue(
      jsonResponse({
        approval: { id: 'a1', status: 'denied', refusalReason: unverified },
        enforcementStatus: 'refused',
        reason: unverified,
      }),
    );
    await expect(approveRequest('a1')).resolves.toMatchObject({ status: 'denied', refusalReason: unverified });
  });

  it('treats an older server\'s approved row with enforcementStatus refused as denied, with the reason', async () => {
    fetchWithAuthRefreshMock.mockResolvedValue(
      jsonResponse({ approval: { id: 'a1', status: 'approved' }, enforcementStatus: 'refused', reason: unverified }),
    );
    await expect(approveRequest('a1')).resolves.toMatchObject({ status: 'denied', refusalReason: unverified });
  });

  it('leaves an approve that took effect approved', async () => {
    fetchWithAuthRefreshMock.mockResolvedValue(
      jsonResponse({ approval: { id: 'a1', status: 'approved', refusalReason: null }, enforcementStatus: 'pending_dispatch' }),
    );
    await expect(approveRequest('a1')).resolves.toMatchObject({ status: 'approved', refusalReason: null });
  });
});
