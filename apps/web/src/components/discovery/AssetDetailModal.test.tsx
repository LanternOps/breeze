import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AssetDetailModal, { type AssetDetail } from './AssetDetailModal';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeResponse = (payload: unknown = {}, ok = true): Response =>
  ({
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(payload),
    clone: vi.fn().mockImplementation(function (this: Response) {
      return this;
    }),
  } as unknown as Response);

const asset: AssetDetail = {
  id: 'asset-1',
  ip: '10.0.0.5',
  mac: '—',
  hostname: 'printer-01',
  type: 'unknown',
  approvalStatus: 'pending',
  isOnline: true,
  manufacturer: '—',
  linkedDeviceId: null,
};

const devices = [
  { id: 'dev-1', name: 'WS-FRONTDESK' },
  { id: 'dev-2', name: 'WS-BACKOFFICE' },
];

beforeEach(() => {
  fetchMock.mockReset();
  // Default: any call (e.g. AssetMonitoringSection mount fetch) resolves empty.
  fetchMock.mockResolvedValue(makeResponse());
});

describe('AssetDetailModal — link to managed device', () => {
  it('renders descriptive header and helper copy that explains the link action', () => {
    render(<AssetDetailModal open asset={asset} devices={devices} onClose={() => {}} />);

    expect(screen.getByText('Link to managed device')).toBeInTheDocument();
    expect(
      screen.getByText(/Associate this discovered asset with an existing agent-managed device/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/does not install an agent or create a new device/i)).toBeInTheDocument();
    expect(screen.getByText(/marked as approved/i)).toBeInTheDocument();
    expect(screen.getByText('Select a managed device')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link asset' })).toBeInTheDocument();
  });

  it('shows a success confirmation naming the device after a successful link', async () => {
    const onLinked = vi.fn();
    render(
      <AssetDetailModal open asset={asset} devices={devices} onClose={() => {}} onLinked={onLinked} />
    );

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'dev-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link asset' }));

    await waitFor(() => {
      expect(
        screen.getByText('Asset linked to WS-FRONTDESK. It is now marked approved.')
      ).toBeInTheDocument();
    });
    expect(onLinked).toHaveBeenCalledWith('asset-1');
    expect(fetchMock).toHaveBeenCalledWith(
      '/discovery/assets/asset-1/link',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('falls back to a device-name-less confirmation when the linked device is not in the list', async () => {
    // asset.linkedDeviceId references a device absent from `devices` — the
    // select pre-selects it, but the name lookup misses, exercising the
    // fallback branch of the success message.
    const orphanAsset: AssetDetail = { ...asset, linkedDeviceId: 'dev-not-in-list' };
    render(<AssetDetailModal open asset={orphanAsset} devices={devices} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Link asset' }));

    await waitFor(() => {
      expect(
        screen.getByText('Asset linked. It is now marked approved.')
      ).toBeInTheDocument();
    });
  });

  it('surfaces an error and shows no success message when the link request fails', async () => {
    render(<AssetDetailModal open asset={asset} devices={devices} onClose={() => {}} />);

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'dev-2' } });
    // Override only the link call to fail; mount fetch already resolved.
    fetchMock.mockResolvedValueOnce(makeResponse({}, false));
    fireEvent.click(screen.getByRole('button', { name: 'Link asset' }));

    await waitFor(() => {
      expect(screen.getByText('Failed to link asset')).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/It is now marked approved\./i)
    ).not.toBeInTheDocument();
  });

  it('requires a device selection before linking', async () => {
    render(<AssetDetailModal open asset={asset} devices={devices} onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Link asset' }));

    await waitFor(() => {
      expect(screen.getByText('Select a device to link.')).toBeInTheDocument();
    });
  });
});
