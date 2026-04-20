import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ChangeSiteModal from './ChangeSiteModal';
import { fetchWithAuth } from '../../stores/auth';
import type { Device } from './DeviceList';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 400): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const device: Device = {
  id: 'dev-1',
  hostname: 'host-1',
  os: 'windows',
  osVersion: '10',
  status: 'online',
  cpuPercent: 0,
  ramPercent: 0,
  lastSeen: '2026-04-18T00:00:00Z',
  orgId: 'org-1',
  orgName: 'Acme',
  siteId: 'site-a',
  siteName: 'HQ',
  agentVersion: '1.0.0',
  tags: [],
};

const SITE_A = { id: 'site-a', orgId: 'org-1', name: 'HQ' };
const SITE_B = { id: 'site-b', orgId: 'org-1', name: 'Branch' };

describe('ChangeSiteModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches sites scoped to the device org', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [SITE_A, SITE_B] }));

    render(
      <ChangeSiteModal device={device} isOpen onClose={vi.fn()} onSaved={vi.fn()} />
    );

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        `/orgs/sites?organizationId=${device.orgId}`
      );
    });
  });

  it('disables the move button until a different site is chosen', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [SITE_A, SITE_B] }));

    render(
      <ChangeSiteModal device={device} isOpen onClose={vi.fn()} onSaved={vi.fn()} />
    );

    const moveButton = await screen.findByRole('button', { name: /move device/i });
    expect(moveButton).toBeDisabled();

    const select = await screen.findByLabelText(/new site/i);
    fireEvent.change(select, { target: { value: 'site-b' } });
    expect(moveButton).not.toBeDisabled();
  });

  it('submits PATCH with the new siteId and calls onSaved on success', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ data: [SITE_A, SITE_B] }))
      .mockResolvedValueOnce(makeJsonResponse({ id: device.id, siteId: 'site-b' }));

    const onSaved = vi.fn();
    const onClose = vi.fn();

    render(
      <ChangeSiteModal device={device} isOpen onClose={onClose} onSaved={onSaved} />
    );

    const select = await screen.findByLabelText(/new site/i);
    fireEvent.change(select, { target: { value: 'site-b' } });

    fireEvent.click(screen.getByRole('button', { name: /move device/i }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    expect(fetchWithAuthMock).toHaveBeenLastCalledWith(
      `/devices/${device.id}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ siteId: 'site-b' }),
      })
    );
  });

  it('surfaces API error to the user and does not close', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ data: [SITE_A, SITE_B] }))
      .mockResolvedValueOnce(makeJsonResponse({ error: 'Target site not found' }, false));

    const onClose = vi.fn();
    const onSaved = vi.fn();

    render(
      <ChangeSiteModal device={device} isOpen onClose={onClose} onSaved={onSaved} />
    );

    const select = await screen.findByLabelText(/new site/i);
    fireEvent.change(select, { target: { value: 'site-b' } });
    fireEvent.click(screen.getByRole('button', { name: /move device/i }));

    expect(await screen.findByText(/target site not found/i)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
