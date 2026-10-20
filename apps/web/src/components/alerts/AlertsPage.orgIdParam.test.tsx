import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AlertsPage from './AlertsPage';
import { fetchWithAuth } from '../../stores/auth';

// #9108: `/alerts?orgId=<id>` (the org record's links) must open THAT org's
// alerts, not whichever org the header switcher holds.

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (select: (state: { user: { canManagePartnerWide: boolean } }) => unknown) => select({ user: { canManagePartnerWide: true } }),
}));

const showToastMock = vi.hoisted(() => vi.fn());
vi.mock('../shared/Toast', () => ({ showToast: showToastMock }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../filters/DeviceFilterBar', () => ({ DeviceFilterBar: () => null }));

const applyOrgSwitchMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('@/lib/orgSwitch', () => ({ applyOrgSwitch: applyOrgSwitchMock }));

const ORGS = [
  { id: 'org-1', name: 'Acme Dental' },
  { id: 'org-2', name: 'Beta Logistics' },
];
let mockCurrentOrgId: string | null = 'org-1';
let mockAllOrgs = false;
let mockOrganizationsLoaded = true;
let mockOrgListError: string | null = null;
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      currentOrgId: mockCurrentOrgId,
      allOrgs: mockAllOrgs,
      error: mockOrgListError,
      organizationsLoaded: mockOrganizationsLoaded,
      organizations: mockOrganizationsLoaded ? ORGS : [],
    }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown) =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const alertListRequests = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/alerts?status='));

function setUrl(url: string) {
  window.history.replaceState(null, '', url);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCurrentOrgId = 'org-1';
  mockAllOrgs = false;
  mockOrganizationsLoaded = true;
  mockOrgListError = null;
  fetchMock.mockImplementation(() => Promise.resolve(json({ data: [] })));
});

afterEach(() => setUrl('/'));

describe('AlertsPage — ?orgId= deep link (#9108)', () => {
  it('switches the working org to the linked org and lands on /alerts', async () => {
    setUrl('/alerts?orgId=org-2');
    render(<AlertsPage />);
    await waitFor(() => expect(applyOrgSwitchMock).toHaveBeenCalledTimes(1));
    expect(applyOrgSwitchMock).toHaveBeenCalledWith('org-2', 'Switched to Beta Logistics', '/alerts');
    // The working org's alerts are never fetched for a link that names another org.
    expect(alertListRequests()).toHaveLength(0);
  });

  it('rewrites the deep-link entry to the destination BEFORE switching, so Back never re-runs the switch', async () => {
    setUrl('/alerts?orgId=org-2#hideAiNoise');
    const historyLength = window.history.length;
    let urlAtSwitch = '';
    applyOrgSwitchMock.mockImplementationOnce(() => {
      urlAtSwitch = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      return Promise.resolve();
    });
    render(<AlertsPage />);
    await waitFor(() => expect(applyOrgSwitchMock).toHaveBeenCalledTimes(1));
    // applyOrgSwitch's navigation to '/alerts' then targets the current URL (a
    // replace, not a push) — no '/alerts?orgId=' entry is left behind.
    expect(urlAtSwitch).toBe('/alerts');
    expect(window.history.length).toBe(historyLength);
  });

  it('switches out of the fleet (All organizations) view too', async () => {
    mockCurrentOrgId = null;
    mockAllOrgs = true;
    setUrl('/alerts?orgId=org-2');
    render(<AlertsPage />);
    await waitFor(() => expect(applyOrgSwitchMock).toHaveBeenCalledWith('org-2', 'Switched to Beta Logistics', '/alerts'));
    expect(alertListRequests()).toHaveLength(0);
  });

  it('does not switch when the link names the working org; strips the param and loads alerts', async () => {
    setUrl('/alerts?orgId=org-1#hideAiNoise');
    render(<AlertsPage />);
    await waitFor(() => expect(alertListRequests()).toHaveLength(1));
    expect(applyOrgSwitchMock).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
    expect(window.location.pathname).toBe('/alerts');
    expect(window.location.hash).toBe('#hideAiNoise');
  });

  it('does not switch to an org the user cannot see; says so, strips the param, loads the current scope', async () => {
    setUrl('/alerts?orgId=org-unknown');
    render(<AlertsPage />);
    await waitFor(() => expect(alertListRequests()).toHaveLength(1));
    expect(applyOrgSwitchMock).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
    expect(showToastMock).toHaveBeenCalledWith({ type: 'warning', message: 'The linked organization is not available. Showing your current selection instead.' });
  });

  it('says so (never silently substitutes the working org) when the org list fails to load', async () => {
    mockOrganizationsLoaded = false;
    mockOrgListError = 'Failed to fetch organizations';
    setUrl('/alerts?orgId=org-2');
    render(<AlertsPage />);
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith({ type: 'warning', message: 'The linked organization is not available. Showing your current selection instead.' }));
    expect(applyOrgSwitchMock).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
  });

  it('no notice when the link names the working org', async () => {
    setUrl('/alerts?orgId=org-1');
    render(<AlertsPage />);
    await waitFor(() => expect(alertListRequests()).toHaveLength(1));
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('waits for the org list before deciding (no switch, no fetch while it loads)', async () => {
    mockOrganizationsLoaded = false;
    setUrl('/alerts?orgId=org-2');
    const { rerender } = render(<AlertsPage />);
    await screen.findByRole('heading', { level: 1 }).catch(() => undefined);
    expect(applyOrgSwitchMock).not.toHaveBeenCalled();
    expect(alertListRequests()).toHaveLength(0);

    mockOrganizationsLoaded = true;
    rerender(<AlertsPage />);
    await waitFor(() => expect(applyOrgSwitchMock).toHaveBeenCalledWith('org-2', 'Switched to Beta Logistics', '/alerts'));
    expect(alertListRequests()).toHaveLength(0);
  });

  it('releases the page (loads alerts, strips the param) if the switch navigation fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    applyOrgSwitchMock.mockImplementationOnce(() => Promise.reject(new Error('nav failed')));
    setUrl('/alerts?orgId=org-2');
    render(<AlertsPage />);
    await waitFor(() => expect(alertListRequests()).toHaveLength(1));
    expect(window.location.search).toBe('');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('behaves as before with no orgId param', async () => {
    setUrl('/alerts');
    render(<AlertsPage />);
    await waitFor(() => expect(alertListRequests()).toHaveLength(1));
    expect(applyOrgSwitchMock).not.toHaveBeenCalled();
  });
});
