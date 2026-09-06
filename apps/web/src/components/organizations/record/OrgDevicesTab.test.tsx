import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import OrgDevicesTab from './OrgDevicesTab';
import { useOrgStore } from '@/stores/orgStore';
import type { OrgFetch } from './orgRecordFetch';

const RECORD_ORG = 'org-record-1';
const OTHER_ORG = 'org-other-2';

const DEVICE = {
  id: 'd1',
  hostname: 'acme-laptop-01',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 10,
  ramPercent: 20,
  lastSeen: '2026-09-01T00:00:00.000Z',
  orgId: RECORD_ORG,
  orgName: 'Acme Dental',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
  tags: [],
};

function jsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) } as unknown as Response;
}

/** A `makeOrgFetch(RECORD_ORG)`-shaped stub that records every path it's called with. */
function makeRecordingOrgFetch(handlers: Record<string, () => Response>): { orgFetch: OrgFetch; calls: string[] } {
  const calls: string[] = [];
  const orgFetch: OrgFetch = async (path) => {
    calls.push(path);
    for (const [fragment, make] of Object.entries(handlers)) {
      if (path.includes(fragment)) return make();
    }
    return jsonResponse({ data: [] });
  };
  return { orgFetch, calls };
}

describe('OrgDevicesTab', () => {
  it('loads devices through orgFetch (org-pinned) and renders them with forceSingleOrg, while the store points elsewhere', async () => {
    useOrgStore.setState({ currentOrgId: OTHER_ORG, allOrgs: false } as never);
    const { orgFetch, calls } = makeRecordingOrgFetch({
      '/devices': () => jsonResponse({ data: [DEVICE] }),
      '/orgs/sites': () => jsonResponse({ data: [{ id: 'site-1', name: 'HQ' }] }),
    });

    render(<OrgDevicesTab orgId={RECORD_ORG} orgFetch={orgFetch} />);

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
  });

  const secondDevice = { ...DEVICE, id: 'd2', hostname: 'acme-desktop-02', status: 'offline', siteId: 'site-2', siteName: 'Branch' };

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
    return render(<OrgDevicesTab orgId={RECORD_ORG} orgFetch={orgFetch} />);
  }

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
    render(<OrgDevicesTab orgId={RECORD_ORG} orgFetch={orgFetch} />);
    await waitFor(() => expect(screen.getByTestId('org-devices-error')).toBeTruthy());
  });

  it('shows the same error state on a malformed 200 devices body, not "no devices" (#5075 W02 review)', async () => {
    const { orgFetch } = makeRecordingOrgFetch({ '/devices': () => jsonResponse({ data: null }) });
    render(<OrgDevicesTab orgId={RECORD_ORG} orgFetch={orgFetch} />);
    await waitFor(() => expect(screen.getByTestId('org-devices-error')).toBeTruthy());
  });
});
