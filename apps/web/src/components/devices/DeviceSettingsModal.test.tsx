import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import DeviceSettingsModal from './DeviceSettingsModal';
import type { Device } from './DeviceList';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/fetchAllSites', () => ({ fetchAllSites: vi.fn().mockResolvedValue([]) }));

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const device = {
  id: 'dev-1',
  orgId: 'org-1',
  siteId: 'site-1',
  hostname: 'WS-01',
  displayName: 'WS-01',
  status: 'online',
  tags: [],
} as unknown as Device;

const res = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function renderModal() {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<DeviceSettingsModal device={device} isOpen onClose={onClose} onSaved={onSaved} />);
  fireEvent.change(screen.getByPlaceholderText(/add a tag/i), { target: { value: 'vip' } });
  fireEvent.keyDown(screen.getByPlaceholderText(/add a tag/i), { key: 'Enter' });
  return { onClose, onSaved };
}

describe('DeviceSettingsModal save feedback', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    toastMock.mockReset();
  });

  it('toasts success after saving a tag change and closes', async () => {
    fetchMock.mockResolvedValue(res({ id: 'dev-1' }));
    const { onClose, onSaved } = renderModal();

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSaved).toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: 'Device settings saved' })
    );
  });

  it('toasts the API error and keeps the modal open when the save fails', async () => {
    fetchMock.mockResolvedValue(res({ error: 'Tag limit exceeded' }, false, 400));
    const { onClose, onSaved } = renderModal();

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'Tag limit exceeded' })
      )
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
