import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import HypervVMActions from './HypervVMActions';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('HypervVMActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    });
    fetchMock.mockResolvedValue(makeJsonResponse({ ok: true }));
  });

  it('posts the state payload expected by the Hyper-V power API', async () => {
    render(
      <HypervVMActions
        vmName="Recovered VM"
        vmId="vm-row-1"
        deviceId="device-1"
        currentState="Running"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Force Stop/i }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/backup/hyperv/vm-state/device-1/vm-row-1',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ state: 'force_stop' }),
      })
    ));
  });

  it('posts checkpointName for checkpoint actions', async () => {
    render(
      <HypervVMActions
        vmName="Recovered VM"
        vmId="vm-row-1"
        deviceId="device-1"
        currentState="Running"
      />
    );

    fireEvent.change(screen.getByLabelText(/Checkpoint name/i), { target: { value: 'PrePatch' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/backup/hyperv/checkpoints/device-1/vm-row-1',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'create', checkpointName: 'PrePatch' }),
      })
    ));
  });
});
