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

  it('shows the user display name and a translated action in recent access', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          ...listPayload.data,
          accessHistory: [
            { id: 'e1', keyId: KEY_ID, userEmail: 'admin@example.com', userName: 'Ada Admin', action: 'revealed', createdAt: '2026-07-02T00:00:00Z' },
            { id: 'e2', keyId: KEY_ID, userEmail: 'other@example.com', userName: null, action: 'revealed', createdAt: '2026-07-03T00:00:00Z' },
          ],
        },
      }),
    });
    render(<RecoveryKeysPanel deviceId={DEVICE_ID} />);
    await waitFor(() => expect(screen.getByTestId('recovery-access-e1')).toBeTruthy());
    const named = screen.getByTestId('recovery-access-e1').textContent ?? '';
    expect(named).toContain('Ada Admin');
    expect(named).not.toContain('admin@example.com');
    expect(named).toContain('revealed the key');
    expect(screen.getByTestId('recovery-access-e2').textContent).toContain('other@example.com');
  });

  it('rotate on Windows sends the chosen escrowed volume', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          ...listPayload.data,
          keys: [
            ...listPayload.data.keys,
            { id: 'k2', keyType: 'bitlocker_recovery_password', volumeMount: 'D:', protectorId: 'p-2', status: 'active', escrowedAt: '2026-07-01T00:00:00Z', supersededAt: null },
            { id: 'k3', keyType: 'bitlocker_recovery_password', volumeMount: 'E:', protectorId: 'p-3', status: 'superseded', escrowedAt: '2026-06-01T00:00:00Z', supersededAt: '2026-07-01T00:00:00Z' },
          ],
        },
      }),
    });
    runActionMock.mockResolvedValue(undefined);
    render(<RecoveryKeysPanel deviceId={DEVICE_ID} />);
    await waitFor(() => expect(screen.getByTestId('recovery-rotate-open')).toBeTruthy());
    fireEvent.click(screen.getByTestId('recovery-rotate-open'));
    const select = screen.getByTestId('recovery-rotate-volume') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['C:', 'D:']);
    fireEvent.change(select, { target: { value: 'D:' } });
    fireEvent.click(screen.getByTestId('recovery-rotate-confirm'));
    await waitFor(() => expect(runActionMock).toHaveBeenCalledTimes(1));
    await runActionMock.mock.calls[0]![0].request();
    const [, init] = fetchWithAuthMock.mock.calls.at(-1)!;
    expect(JSON.parse(init.body)).toEqual({ volumeMount: 'D:' });
  });

  it('disables rotate on Windows when no volume has an active escrowed key', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { ...listPayload.data, keys: [{ ...listPayload.data.keys[0], status: 'superseded' }] },
      }),
    });
    render(<RecoveryKeysPanel deviceId={DEVICE_ID} />);
    await waitFor(() => expect(screen.getByTestId('recovery-rotate-open')).toBeTruthy());
    expect((screen.getByTestId('recovery-rotate-open') as HTMLButtonElement).disabled).toBe(true);
  });
});
