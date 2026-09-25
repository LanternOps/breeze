// apps/web/src/components/backup/ExternalBackupCard.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ExternalBackupCard from './ExternalBackupCard';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);
const res = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const providerRow = (o: Record<string, unknown> = {}) => ({
  id: 'row-1', provider: 'cove', orgId: 'org-1',
  vendorDeviceName: 'ACME-SRV01', computerName: 'srv01', customerName: 'Acme North',
  status: 'completed', health: 'healthy',
  lastSuccessAt: '2026-09-15T01:00:00.000Z', lastSessionAt: '2026-09-15T01:00:00.000Z',
  selectedBytes: 2048, usedBytes: 4096, errorsCount: 0, dataSources: ['files', 'mssql'],
  breezeDeviceId: 'device-1',
  history28d: [{ day: '2026-09-15', status: 'completed' }],
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(res({ data: [providerRow()] }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('ExternalBackupCard', () => {
  it('fetches the provider row for this device only', async () => {
    render(<ExternalBackupCard deviceId="device-1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/backup/providers/devices?deviceId=device-1'));
  });

  // D10: raw enum values must not reach the UI — status and data sources are
  // translated labels, not the wire values ('completed', 'files', 'mssql').
  it('renders status, health, sizes, data sources and the customer name', async () => {
    render(<ExternalBackupCard deviceId="device-1" />);
    const card = await screen.findByTestId('external-backup-card');
    expect(card.textContent).toContain('Completed');
    expect(card.textContent).toContain('Acme North');
    expect(card.textContent).toContain('Files & folders, SQL Server');
    expect(screen.getByTestId('external-backup-selected').textContent).toContain('2.00 KB');
    expect(screen.getByTestId('external-backup-used').textContent).toContain('4.00 KB');
    expect(screen.getByTestId('external-backup-health-dot')).toBeInTheDocument();
  });

  it('renders the 28-day bar when the API supplies history', async () => {
    render(<ExternalBackupCard deviceId="device-1" />);
    expect(await screen.findByTestId('external-backup-history')).toBeInTheDocument();
  });

  it('derives health client-side and skips the bar when the API omits both', async () => {
    fetchMock.mockResolvedValue(res({ data: [providerRow({ health: undefined, history28d: undefined, status: 'failed' })] }));
    render(<ExternalBackupCard deviceId="device-1" />);
    await screen.findByTestId('external-backup-card');
    expect(screen.queryByTestId('external-backup-history')).toBeNull();
    expect(screen.getByTestId('external-backup-health-dot')).toBeInTheDocument();
  });

  it('renders nothing and reports absence when there is no provider row', async () => {
    fetchMock.mockResolvedValue(res({ data: [] }));
    const onPresenceChange = vi.fn();
    render(<ExternalBackupCard deviceId="device-1" onPresenceChange={onPresenceChange} />);
    await waitFor(() => expect(onPresenceChange).toHaveBeenCalledWith(false));
    expect(screen.queryByTestId('external-backup-card')).toBeNull();
  });

  it('PUTs deviceId:null to unlink, after confirming', async () => {
    const onUnlinked = vi.fn();
    render(<ExternalBackupCard deviceId="device-1" onUnlinked={onUnlinked} />);
    fireEvent.click(await screen.findByTestId('external-backup-unlink'));

    await waitFor(() => expect(onUnlinked).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe('/backup/providers/devices/row-1/link');
    expect((init as RequestInit).method).toBe('PUT');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ deviceId: null });
  });

  it('does not unlink when the confirm is dismissed', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    render(<ExternalBackupCard deviceId="device-1" />);
    fireEvent.click(await screen.findByTestId('external-backup-unlink'));
    expect(fetchMock).toHaveBeenCalledTimes(1); // the initial GET only
  });

  it('toasts and does not call onUnlinked when the unlink PUT fails', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (method === 'PUT') return res({ error: 'link busy' }, false, 500);
      return res({ data: [providerRow()] });
    });
    const onUnlinked = vi.fn();
    render(<ExternalBackupCard deviceId="device-1" onUnlinked={onUnlinked} />);
    fireEvent.click(await screen.findByTestId('external-backup-unlink'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/backup/providers/devices/row-1/link', expect.objectContaining({ method: 'PUT' })));
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(onUnlinked).not.toHaveBeenCalled();
  });

  it('surfaces a load failure instead of silently rendering nothing', async () => {
    fetchMock.mockResolvedValue(res({ error: 'nope' }, false, 500));
    render(<ExternalBackupCard deviceId="device-1" />);
    expect(await screen.findByTestId('external-backup-error')).toBeInTheDocument();
  });
});
