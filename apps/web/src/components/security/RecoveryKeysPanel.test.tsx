import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuthMock, runActionMock } = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(),
  runActionMock: vi.fn(),
}));

vi.mock('@/stores/auth', () => ({ fetchWithAuth: fetchWithAuthMock }));
vi.mock('@/lib/runAction', () => ({
  runAction: runActionMock,
  handleActionError: vi.fn(),
  ActionError: class ActionError extends Error {},
}));

import RecoveryKeysPanel from './RecoveryKeysPanel';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const KEY_ID = '33333333-3333-4333-8333-333333333333';

const listPayload = {
  data: {
    device: { id: DEVICE_ID, hostname: 'PC-01', os: 'windows' },
    keys: [{
      id: KEY_ID, keyType: 'bitlocker_recovery_password', volumeMount: 'C:',
      protectorId: 'p-1', status: 'active', escrowedAt: '2026-07-01T00:00:00Z', supersededAt: null,
    }],
    accessHistory: [],
  },
};

function mockList() {
  fetchWithAuthMock.mockResolvedValue({ ok: true, json: async () => listPayload });
}

describe('RecoveryKeysPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists escrowed keys without key material', async () => {
    mockList();
    render(<RecoveryKeysPanel deviceId={DEVICE_ID} />);
    await waitFor(() => expect(screen.getByText('C:')).toBeTruthy());
    expect(screen.getByText(/BitLocker/i)).toBeTruthy();
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      `/security/encryption/devices/${DEVICE_ID}/recovery-keys`,
      expect.anything()
    );
  });

  it('reveals a key on demand via the reveal endpoint', async () => {
    mockList();
    runActionMock.mockResolvedValue('111111-222222-333333-444444-555555-666666-777777-888888');
    render(<RecoveryKeysPanel deviceId={DEVICE_ID} />);
    await waitFor(() => expect(screen.getByText('C:')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /reveal/i }));
    await waitFor(() =>
      expect(screen.getByText('111111-222222-333333-444444-555555-666666-777777-888888')).toBeTruthy()
    );
    expect(runActionMock).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state when no keys are escrowed', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { device: { id: DEVICE_ID, hostname: 'PC-01', os: 'linux' }, keys: [], accessHistory: [] } }),
    });
    render(<RecoveryKeysPanel deviceId={DEVICE_ID} />);
    await waitFor(() => expect(screen.getByText(/no recovery keys escrowed/i)).toBeTruthy());
  });
});
