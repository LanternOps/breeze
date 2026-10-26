import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import ChangeSiteModal from './ChangeSiteModal';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import type { Device } from './DeviceList';

/**
 * ChangeSiteModal's bulk variant (#9796, spec §4.4): N agent devices of ONE org move to a site in
 * that org through a single POST /devices/bulk/site. The `device` and `subject` variants are pinned
 * unchanged by ChangeSiteModal.test.tsx.
 */
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const base: Device = {
  id: 'd1', hostname: 'FRONTDESK-01', os: 'windows', osVersion: '11', status: 'online', cpuPercent: 0, ramPercent: 0,
  lastSeen: '2026-10-01T00:00:00Z', orgId: 'org-1', orgName: 'Harbor Dental', siteId: 'site-hq', siteName: 'HQ',
  agentVersion: '1.0.0', tags: [],
};
const dev = (id: string, siteId: string, siteName: string): Device => ({ ...base, id, hostname: `HOST-${id}`, siteId, siteName });

const SITES = { data: [
  { id: 'site-hq', orgId: 'org-1', name: 'HQ' },
  { id: 'site-lab', orgId: 'org-1', name: 'Lab' },
  { id: 'site-branch', orgId: 'org-1', name: 'Branch' },
] };

function rigFetch(bulkResponse: Response) {
  vi.mocked(fetchWithAuth).mockImplementation(async (url: string) => {
    if (url.startsWith('/orgs/sites')) return json(200, SITES);
    if (url === '/devices/bulk/site') return bulkResponse;
    throw new Error(`unexpected ${url}`);
  });
}

beforeEach(() => vi.clearAllMocks());

describe('ChangeSiteModal — bulk variant', () => {
  it('lists only the selection org\'s sites (the API narrows to the viewer\'s allowlist)', async () => {
    rigFetch(json(200, { results: [], summary: { moved: 0, total: 0 } }));
    render(<ChangeSiteModal devices={[dev('d1', 'site-hq', 'HQ'), dev('d2', 'site-lab', 'Lab')]} isOpen onClose={vi.fn()} onSaved={vi.fn()} onBulkMoved={vi.fn()} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/sites?organizationId=org-1&page=1&limit=100', undefined));
    expect(await screen.findByRole('option', { name: 'Branch' })).toBeTruthy();
  });

  it('says "N devices from K sites" when the selection spans several source sites', async () => {
    rigFetch(json(200, { results: [], summary: { moved: 0, total: 0 } }));
    render(<ChangeSiteModal devices={[dev('d1', 'site-hq', 'HQ'), dev('d2', 'site-lab', 'Lab'), dev('d3', 'site-hq', 'HQ')]} isOpen onClose={vi.fn()} onSaved={vi.fn()} onBulkMoved={vi.fn()} />);
    expect(await screen.findByTestId('change-site-bulk-current')).toHaveTextContent('3 devices from 2 sites');
  });

  it('names the one current site when every selected device shares it', async () => {
    rigFetch(json(200, { results: [], summary: { moved: 0, total: 0 } }));
    render(<ChangeSiteModal devices={[dev('d1', 'site-hq', 'HQ'), dev('d2', 'site-hq', 'HQ')]} isOpen onClose={vi.fn()} onSaved={vi.fn()} onBulkMoved={vi.fn()} />);
    expect(await screen.findByTestId('change-site-bulk-current')).toHaveTextContent('HQ');
  });

  it('submits ONE POST /devices/bulk/site, then reports the 200 body and closes', async () => {
    const body = { results: [{ id: 'd1', outcome: 'moved' }, { id: 'd2', outcome: 'conflict' }], summary: { moved: 1, total: 2 } };
    rigFetch(json(200, body));
    const onBulkMoved = vi.fn();
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<ChangeSiteModal devices={[dev('d1', 'site-hq', 'HQ'), dev('d2', 'site-lab', 'Lab')]} isOpen onClose={onClose} onSaved={onSaved} onBulkMoved={onBulkMoved} />);
    await screen.findByRole('option', { name: 'Branch' });
    fireEvent.change(screen.getByLabelText(/New site/), { target: { value: 'site-branch' } });
    fireEvent.click(screen.getByTestId('change-site-submit'));
    await waitFor(() => expect(onBulkMoved).toHaveBeenCalledWith(body, 'Branch'));
    const posts = vi.mocked(fetchWithAuth).mock.calls.filter(([url]) => url === '/devices/bulk/site');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]![1]?.body))).toEqual({
      siteId: 'site-branch', devices: [{ id: 'd1', expectedSiteId: 'site-hq' }, { id: 'd2', expectedSiteId: 'site-lab' }],
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a whole-batch refusal keeps the dialog open with the reason (and runAction toasts it)', async () => {
    rigFetch(json(400, { error: 'Selected devices belong to more than one organization', code: 'mixed_org' }));
    const onBulkMoved = vi.fn();
    const onClose = vi.fn();
    render(<ChangeSiteModal devices={[dev('d1', 'site-hq', 'HQ'), dev('d2', 'site-lab', 'Lab')]} isOpen onClose={onClose} onSaved={vi.fn()} onBulkMoved={onBulkMoved} />);
    await screen.findByRole('option', { name: 'Branch' });
    fireEvent.change(screen.getByLabelText(/New site/), { target: { value: 'site-branch' } });
    fireEvent.click(screen.getByTestId('change-site-submit'));
    expect(await screen.findByText('Selected devices belong to more than one organization')).toBeTruthy();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(onBulkMoved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('MFA required is surfaced the way runAction maps MFA_REQUIRED', async () => {
    rigFetch(json(403, { error: 'MFA required', code: 'MFA_REQUIRED' }));
    render(<ChangeSiteModal devices={[dev('d1', 'site-hq', 'HQ')]} isOpen onClose={vi.fn()} onSaved={vi.fn()} onBulkMoved={vi.fn()} />);
    await screen.findByRole('option', { name: 'Branch' });
    fireEvent.change(screen.getByLabelText(/New site/), { target: { value: 'site-branch' } });
    fireEvent.click(screen.getByTestId('change-site-submit'));
    expect(await screen.findByText('Multi-factor authentication is required')).toBeTruthy();
  });

  it('a 401 is left to the session-expiry path: no inline error, no toast, dialog untouched', async () => {
    rigFetch(json(401, { error: 'Unauthorized' }));
    const onUnauthorized = vi.fn();
    render(<ChangeSiteModal devices={[dev('d1', 'site-hq', 'HQ')]} isOpen onClose={vi.fn()} onSaved={vi.fn()} onBulkMoved={vi.fn()} onUnauthorized={onUnauthorized} />);
    await screen.findByRole('option', { name: 'Branch' });
    fireEvent.change(screen.getByLabelText(/New site/), { target: { value: 'site-branch' } });
    fireEvent.click(screen.getByTestId('change-site-submit'));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(showToast).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a committed move is never reported as failed, even if the caller\'s report throws; the list still refreshes', async () => {
    rigFetch(json(200, { results: [{ id: 'd1', outcome: 'moved' }], summary: { moved: 1, total: 1 } }));
    const onBulkMoved = vi.fn(() => { throw new Error('toast blew up'); });
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ChangeSiteModal devices={[dev('d1', 'site-hq', 'HQ')]} isOpen onClose={onClose} onSaved={onSaved} onBulkMoved={onBulkMoved} />);
    await screen.findByRole('option', { name: 'Branch' });
    fireEvent.change(screen.getByLabelText(/New site/), { target: { value: 'site-branch' } });
    fireEvent.click(screen.getByTestId('change-site-submit'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Couldn't move the devices. Try again.")).toBeNull();
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    // Logged, never silent.
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('bulk site move outcome'), expect.any(Error));
    spy.mockRestore();
  });

  it('a network failure (no answer) refreshes the list behind the dialog: some devices may have moved', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async (url: string) => {
      if (url.startsWith('/orgs/sites')) return json(200, SITES);
      throw new TypeError('Failed to fetch');
    });
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<ChangeSiteModal devices={[dev('d1', 'site-hq', 'HQ')]} isOpen onClose={onClose} onSaved={onSaved} onBulkMoved={vi.fn()} />);
    await screen.findByRole('option', { name: 'Branch' });
    fireEvent.change(screen.getByLabelText(/New site/), { target: { value: 'site-branch' } });
    fireEvent.click(screen.getByTestId('change-site-submit'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('the submit is disabled until a target is chosen when the selection spans several sites', async () => {
    rigFetch(json(200, { results: [], summary: { moved: 0, total: 0 } }));
    render(<ChangeSiteModal devices={[dev('d1', 'site-hq', 'HQ'), dev('d2', 'site-lab', 'Lab')]} isOpen onClose={vi.fn()} onSaved={vi.fn()} onBulkMoved={vi.fn()} />);
    await screen.findByRole('option', { name: 'Branch' });
    expect(screen.getByTestId('change-site-submit')).toBeDisabled();
    expect(screen.getByTestId('change-site-submit')).toHaveTextContent('Move 2 devices');
  });
});
