import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import OrgDevicesTab, { ORG_DEVICES_LIMIT } from './OrgDevicesTab';
import { useOrgStore } from '@/stores/orgStore';
import type { OrgFetch } from './orgRecordFetch';
import { navigateTo } from '@/lib/navigation';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const applyOrgSwitchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orgSwitch', () => ({ applyOrgSwitch: applyOrgSwitchMock }));

const granted = vi.hoisted(() => new Set<string>(['organizations:write']));
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => granted.has(`${r}:${a}`) }),
}));

const RECORD_ORG = 'org-record-1';
const OTHER_ORG = 'org-other-2';

// Raw `/devices` row, as the API sends it (the tab runs it through toDeviceListRow).
const DEVICE = {
  id: 'd1',
  hostname: 'acme-laptop-01',
  osType: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 37.456789012,
  ramPercent: 20,
  lastSeenAt: '2026-09-01T00:00:00.000Z',
  orgId: RECORD_ORG,
  siteId: 'site-1',
  agentVersion: '1.0.0',
  tags: [],
};

function jsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) } as unknown as Response;
}

/** A `makeOrgFetch(RECORD_ORG)`-shaped stub that records every path it's called with. */
function makeRecordingOrgFetch(handlers: Record<string, () => Response>): { orgFetch: OrgFetch; calls: string[] } {
  const calls: string[] = [];
  // Cast: OrgFetch is branded (ORG_PINNED) so only makeOrgFetch can mint one;
  // tests stand in for it the same way OrgTicketsTab.test.tsx does.
  const orgFetch = (async (path: string) => {
    calls.push(path);
    for (const [fragment, make] of Object.entries(handlers)) {
      if (path.includes(fragment)) return make();
    }
    return jsonResponse({ data: [] });
  }) as unknown as OrgFetch;
  return { orgFetch, calls };
}

describe('OrgDevicesTab', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(navigateTo).mockClear();
    applyOrgSwitchMock.mockReset();
    useOrgStore.setState({ currentOrgId: OTHER_ORG, allOrgs: false } as never);
    granted.clear();
    granted.add('organizations:write');
  });

  it('loads devices through orgFetch (org-pinned) and renders them with forceSingleOrg, while the store points elsewhere', async () => {
    useOrgStore.setState({ currentOrgId: OTHER_ORG, allOrgs: false } as never);
    const { orgFetch, calls } = makeRecordingOrgFetch({
      '/devices': () => jsonResponse({ data: [DEVICE] }),
      '/orgs/sites': () => jsonResponse({ data: [{ id: 'site-1', name: 'HQ' }] }),
    });

    render(<OrgDevicesTab orgId={RECORD_ORG} orgName="Acme Dental" orgFetch={orgFetch} />);

    await waitFor(() => expect(screen.getByText('acme-laptop-01')).toBeTruthy());
    // Every call went through the org-pinned fetch, never a bare ambient one —
    // the shape of the guarantee is "this tab never bypasses orgFetch", proven
    // by the fact every one of its own calls used it.
    expect(calls.some((c) => c.startsWith('/devices'))).toBe(true);
    expect(calls.some((c) => c.includes('/orgs/sites'))).toBe(true);
    // The Organization column would be redundant here — every row is already
    // this org's — so it must not appear even though the store's scope
    // (fleet-eligible) would otherwise show it.
    expect(screen.queryByText(/^Organization$/)).toBeNull();
    // Same transform as /devices: percents are rounded, site names resolved from /orgs/sites.
    expect(screen.getByText('37.5%')).toBeTruthy();
    expect(screen.getAllByText('HQ').length).toBeGreaterThan(0);
  });

  const secondDevice = { ...DEVICE, id: 'd2', hostname: 'acme-desktop-02', status: 'offline', siteId: 'site-2' };

  function renderTwoDevices() {
    const { orgFetch } = makeRecordingOrgFetch({
      '/devices': () => jsonResponse({ data: [DEVICE, secondDevice] }),
      '/orgs/sites': () =>
        jsonResponse({
          data: [
            { id: 'site-1', name: 'HQ' },
            { id: 'site-2', name: 'Branch' },
          ],
        }),
    });
    return render(<OrgDevicesTab orgId={RECORD_ORG} orgName="Acme Dental" orgFetch={orgFetch} />);
  }

  it('row click navigates to the device page', async () => {
    renderTwoDevices();
    await waitFor(() => expect(screen.getByText('acme-laptop-01')).toBeTruthy());
    fireEvent.click(screen.getByText('acme-laptop-01'));
    expect(navigateTo).toHaveBeenCalledWith('/devices/d1');
  });

  it('uses the embedded column preset and persists it under its own key', async () => {
    renderTwoDevices();
    await waitFor(() => expect(screen.getByText('acme-laptop-01')).toBeTruthy());
    expect(screen.queryByText(/^Class$/)).toBeNull();
    expect(screen.queryByText(/^Role$/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /columns/i }));
    fireEvent.click(screen.getByLabelText('OS Version'));

    expect(window.localStorage.getItem('breeze.devices.columns.orgTab')).not.toBeNull();
    expect(window.localStorage.getItem('breeze.devices.columns')).toBeNull();
  });

  it('the search filter narrows the rendered rows client-side', async () => {
    renderTwoDevices();

    await waitFor(() => expect(screen.getByText('acme-laptop-01')).toBeTruthy());
    expect(screen.getByText('acme-desktop-02')).toBeTruthy();

    const search = screen.getByTestId('org-devices-search') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'laptop' } });

    await waitFor(() => {
      expect(screen.getByText('acme-laptop-01')).toBeTruthy();
      expect(screen.queryByText('acme-desktop-02')).toBeNull();
    });
  });

  it('the status filter narrows the rendered rows to the selected status', async () => {
    renderTwoDevices();
    await waitFor(() => expect(screen.getByText('acme-laptop-01')).toBeTruthy());

    const statusFilter = screen.getByTestId('org-devices-status-filter') as HTMLSelectElement;
    fireEvent.change(statusFilter, { target: { value: 'offline' } });

    await waitFor(() => {
      expect(screen.queryByText('acme-laptop-01')).toBeNull();
      expect(screen.getByText('acme-desktop-02')).toBeTruthy();
    });
  });

  it('the site filter narrows the rendered rows to the selected site', async () => {
    renderTwoDevices();
    await waitFor(() => expect(screen.getByText('acme-laptop-01')).toBeTruthy());

    const siteFilter = screen.getByTestId('org-devices-site-filter') as HTMLSelectElement;
    fireEvent.change(siteFilter, { target: { value: 'site-2' } });

    await waitFor(() => {
      expect(screen.queryByText('acme-laptop-01')).toBeNull();
      expect(screen.getByText('acme-desktop-02')).toBeTruthy();
    });
  });

  it('shows a retryable-looking error state when the devices load fails outright', async () => {
    const { orgFetch } = makeRecordingOrgFetch({ '/devices': () => jsonResponse({ error: 'boom' }, false, 500) });
    render(<OrgDevicesTab orgId={RECORD_ORG} orgName="Acme Dental" orgFetch={orgFetch} />);
    await waitFor(() => expect(screen.getByTestId('org-devices-error')).toBeTruthy());
  });

  it('shows the same error state on a malformed 200 devices body, not "no devices" (#5075 W02 review)', async () => {
    const { orgFetch } = makeRecordingOrgFetch({ '/devices': () => jsonResponse({ data: null }) });
    render(<OrgDevicesTab orgId={RECORD_ORG} orgName="Acme Dental" orgFetch={orgFetch} />);
    await waitFor(() => expect(screen.getByTestId('org-devices-error')).toBeTruthy());
  });
  // ---- #9023 ----

  it('names the three filter controls for assistive tech, keeping the visible placeholder', async () => {
    renderTwoDevices();
    await waitFor(() => expect(screen.getByText('acme-laptop-01')).toBeTruthy());
    expect(screen.getByTestId('org-devices-search').getAttribute('aria-label')).toBe('Search devices by hostname');
    expect(screen.getByTestId('org-devices-search').getAttribute('placeholder')).toBe('Search devices');
    expect(screen.getByTestId('org-devices-status-filter').getAttribute('aria-label')).toBe('Filter by status');
    expect(screen.getByTestId('org-devices-site-filter').getAttribute('aria-label')).toBe('Filter by site');
  });

  it('an org with no devices gets an enrol prompt, not a table with "try adjusting your filters"', async () => {
    const { orgFetch } = makeRecordingOrgFetch({ '/devices': () => jsonResponse({ data: [] }) });
    render(<OrgDevicesTab orgId={RECORD_ORG} orgName="Acme Dental" orgFetch={orgFetch} />);

    const empty = await screen.findByTestId('org-devices-empty');
    expect(empty.textContent).toContain('No devices enrolled in Acme Dental yet');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText(/try adjusting/i)).toBeNull();
    expect(screen.queryByTestId('org-devices-search')).toBeNull();

    // "Add device" is the existing enrol flow on /devices, in this org's workspace.
    fireEvent.click(screen.getByTestId('org-devices-add'));
    expect(applyOrgSwitchMock).toHaveBeenCalledWith(RECORD_ORG, 'Switched to Acme Dental', '/devices#add-device');
  });

  it('withholds "Add device" from a role that cannot mint an enrolment key', async () => {
    granted.clear();
    const { orgFetch } = makeRecordingOrgFetch({ '/devices': () => jsonResponse({ data: [] }) });
    render(<OrgDevicesTab orgId={RECORD_ORG} orgName="Acme Dental" orgFetch={orgFetch} />);

    await screen.findByTestId('org-devices-empty');
    expect(screen.queryByTestId('org-devices-add')).toBeNull();
  });

  it('filters that match nothing say so and offer to clear them', async () => {
    renderTwoDevices();
    await waitFor(() => expect(screen.getByText('acme-laptop-01')).toBeTruthy());

    fireEvent.change(screen.getByTestId('org-devices-search'), { target: { value: 'nothing-like-this' } });
    fireEvent.change(screen.getByTestId('org-devices-status-filter'), { target: { value: 'offline' } });

    const none = await screen.findByTestId('org-devices-no-matches');
    expect(none.textContent).toContain('No devices match');
    expect(screen.queryByTestId('org-devices-empty')).toBeNull();

    fireEvent.click(screen.getByTestId('org-devices-clear-filters'));
    await waitFor(() => expect(screen.getByText('acme-laptop-01')).toBeTruthy());
    expect(screen.getByText('acme-desktop-02')).toBeTruthy();
    expect((screen.getByTestId('org-devices-search') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('org-devices-status-filter') as HTMLSelectElement).value).toBe('');
  });

  it('hides pagination and the per-page picker when every device fits on one page', async () => {
    renderTwoDevices();
    await waitFor(() => expect(screen.getByText('acme-laptop-01')).toBeTruthy());
    expect(screen.queryByLabelText('Devices per page')).toBeNull();
    expect(screen.queryByText(/Showing 1 to 2/)).toBeNull();
  });

  it('says when the 200-device cap cut the list short, and hands off to Devices in this org', async () => {
    const { orgFetch, calls } = makeRecordingOrgFetch({
      '/devices': () => jsonResponse({ data: [DEVICE], pagination: { nextCursor: 'next-page', limit: ORG_DEVICES_LIMIT } }),
    });
    render(<OrgDevicesTab orgId={RECORD_ORG} orgName="Acme Dental" orgFetch={orgFetch} />);

    const notice = await screen.findByTestId('org-devices-cap-notice');
    expect(notice.textContent).toContain(`Showing the first ${ORG_DEVICES_LIMIT} devices`);
    expect(calls.find((c) => c.startsWith('/devices'))).toContain(`limit=${ORG_DEVICES_LIMIT}`);

    fireEvent.click(screen.getByTestId('org-devices-open-in-devices'));
    expect(applyOrgSwitchMock).toHaveBeenCalledWith(RECORD_ORG, 'Switched to Acme Dental', '/devices');
  });

  it('reads truncation from a `total` above the row count too, and not at equality', async () => {
    const { orgFetch } = makeRecordingOrgFetch({
      '/devices': () => jsonResponse({ data: [DEVICE], pagination: { total: 450 } }),
    });
    const { unmount } = render(<OrgDevicesTab orgId={RECORD_ORG} orgName="Acme Dental" orgFetch={orgFetch} />);
    await screen.findByTestId('org-devices-cap-notice');
    unmount();

    const exact = makeRecordingOrgFetch({ '/devices': () => jsonResponse({ data: [DEVICE], pagination: { total: 1 } }) });
    render(<OrgDevicesTab orgId={RECORD_ORG} orgName="Acme Dental" orgFetch={exact.orgFetch} />);
    await waitFor(() => expect(screen.getByText('acme-laptop-01')).toBeTruthy());
    expect(screen.queryByTestId('org-devices-cap-notice')).toBeNull();
  });

  it('shows no cap notice for a bare-array body, and clears a previous org\'s notice', async () => {
    const truncated = makeRecordingOrgFetch({
      '/devices': () => jsonResponse({ data: [DEVICE], pagination: { nextCursor: 'more' } }),
    });
    const { rerender } = render(<OrgDevicesTab orgId={RECORD_ORG} orgName="Acme Dental" orgFetch={truncated.orgFetch} />);
    await screen.findByTestId('org-devices-cap-notice');

    const bare = makeRecordingOrgFetch({ '/devices': () => jsonResponse([{ ...DEVICE, orgId: OTHER_ORG }]) });
    rerender(<OrgDevicesTab orgId={OTHER_ORG} orgName="Beta Legal" orgFetch={bare.orgFetch} />);
    await waitFor(() => expect(screen.getByText('acme-laptop-01')).toBeTruthy());
    expect(screen.queryByTestId('org-devices-cap-notice')).toBeNull();
  });

  it('just navigates (no switch, no "Switched to" toast) when the workspace already is this org', async () => {
    useOrgStore.setState({ currentOrgId: RECORD_ORG, allOrgs: false } as never);
    const { orgFetch } = makeRecordingOrgFetch({ '/devices': () => jsonResponse({ data: [] }) });
    render(<OrgDevicesTab orgId={RECORD_ORG} orgName="Acme Dental" orgFetch={orgFetch} />);

    fireEvent.click(await screen.findByTestId('org-devices-add'));
    expect(applyOrgSwitchMock).not.toHaveBeenCalled();
    expect(navigateTo).toHaveBeenCalledWith('/devices#add-device');
  });

  it('shows no cap notice when the whole org fit in one request', async () => {
    const { orgFetch } = makeRecordingOrgFetch({
      '/devices': () => jsonResponse({ data: [DEVICE], pagination: { nextCursor: null, limit: ORG_DEVICES_LIMIT } }),
    });
    render(<OrgDevicesTab orgId={RECORD_ORG} orgName="Acme Dental" orgFetch={orgFetch} />);
    await waitFor(() => expect(screen.getByText('acme-laptop-01')).toBeTruthy());
    expect(screen.queryByTestId('org-devices-cap-notice')).toBeNull();
  });
});
