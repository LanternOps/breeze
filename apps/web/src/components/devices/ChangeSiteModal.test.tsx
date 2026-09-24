import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ChangeSiteModal, { type ChangeSiteSubject } from './ChangeSiteModal';
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
      // `fetchAllSites` (#6412) pages to exhaustion, so the request also
      // carries explicit `page`/`limit` params and an (undefined) init arg.
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        `/orgs/sites?organizationId=${device.orgId}&page=1&limit=100`,
        undefined,
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

describe('ChangeSiteModal — generalised subject + submit (network assets)', () => {
  const subject: ChangeSiteSubject = {
    id: 'asset-1',
    name: 'Core switch',
    orgId: 'org-1',
    siteId: 'site-a',
    siteName: 'HQ',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches sites for the subject org and hands the chosen site to submit instead of PATCHing /devices', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [SITE_A, SITE_B] }));
    const submit = vi.fn().mockResolvedValue({ siteMove: { unlinkedDevice: false } });
    const onSaved = vi.fn();
    const onClose = vi.fn();

    render(
      <ChangeSiteModal subject={subject} submit={submit} isOpen onClose={onClose} onSaved={onSaved} />
    );

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        `/orgs/sites?organizationId=${subject.orgId}&page=1&limit=100`,
        undefined,
      );
    });
    expect(screen.getByText('Core switch')).toBeInTheDocument();

    const select = await screen.findByLabelText(/new site/i);
    fireEvent.change(select, { target: { value: 'site-b' } });
    fireEvent.click(screen.getByRole('button', { name: /move device/i }));

    await waitFor(() => {
      expect(submit).toHaveBeenCalledWith('site-b', 'Branch');
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    // Only the site listing went through fetchWithAuth; the write is the caller's.
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });

  it('shows a submit rejection inline and keeps the dialog open', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [SITE_A, SITE_B] }));
    const submit = vi.fn().mockRejectedValue(new Error('Access to this site denied'));
    const onSaved = vi.fn();
    const onClose = vi.fn();

    render(
      <ChangeSiteModal subject={subject} submit={submit} isOpen onClose={onClose} onSaved={onSaved} />
    );

    const select = await screen.findByLabelText(/new site/i);
    fireEvent.change(select, { target: { value: 'site-b' } });
    fireEvent.click(screen.getByRole('button', { name: /move device/i }));

    expect(await screen.findByText(/access to this site denied/i)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('omits the "within <org>" clause when the subject carries no org name', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [SITE_A, SITE_B] }));

    render(
      <ChangeSiteModal subject={subject} submit={vi.fn()} isOpen onClose={vi.fn()} onSaved={vi.fn()} />
    );

    await screen.findByLabelText(/new site/i);
    expect(screen.queryByText(/to a different site within/i)).not.toBeInTheDocument();
    expect(screen.getByText(/to a different site\./i)).toBeInTheDocument();
  });
});
