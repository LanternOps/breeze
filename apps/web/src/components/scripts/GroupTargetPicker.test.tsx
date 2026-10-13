import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import GroupTargetPicker, { type GroupSelectionSummary } from './GroupTargetPicker';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

const groups = [
  { id: 'g-static', name: 'Front desk', type: 'static', filterFieldsUsed: [], deviceCount: 2, siteId: null },
  { id: 'g-dyn', name: 'Windows servers', type: 'dynamic', filterFieldsUsed: ['osType'], deviceCount: 3, siteId: null },
  { id: 'g-refused', name: 'Named hosts', type: 'dynamic', filterFieldsUsed: ['hostname'], deviceCount: 1, siteId: null },
];

const members: Record<string, Array<{ deviceId: string; hostname: string; status: string; osType: string }>> = {
  'g-static': [
    { deviceId: 'd-1', hostname: 'ws-01', status: 'online', osType: 'windows' },
    { deviceId: 'd-2', hostname: 'mac-01', status: 'online', osType: 'macos' },
  ],
  'g-dyn': [
    { deviceId: 'd-1', hostname: 'ws-01', status: 'online', osType: 'windows' },
    { deviceId: 'd-3', hostname: 'srv-01', status: 'offline', osType: 'windows' },
    { deviceId: 'd-4', hostname: 'srv-02', status: 'online', osType: 'windows' },
  ],
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function installFetch(overrides: { listStatus?: number } = {}) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/device-groups?') || url === '/device-groups') {
      if (overrides.listStatus) return respond({ error: 'nope' }, overrides.listStatus);
      return respond({ data: groups });
    }
    const match = url.match(/^\/device-groups\/([^/]+)\/devices/);
    if (match) {
      const rows = members[match[1]!] ?? [];
      return respond({ data: rows, total: rows.length });
    }
    return respond({}, 404);
  });
}

function Harness({ onSummary, orgId }: { onSummary?: (s: GroupSelectionSummary) => void; orgId?: string }) {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <GroupTargetPicker
      orgId={orgId}
      scriptOsTypes={['windows']}
      selectedIds={selected}
      onSelectedIdsChange={setSelected}
      onSummaryChange={onSummary}
    />
  );
}

describe('GroupTargetPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installFetch();
  });

  it('lists groups, flags dynamic ones, and scopes the list to the org when given', async () => {
    render(<Harness orgId="11111111-1111-4111-8111-111111111111" />);
    expect(await screen.findByText('Front desk')).toBeTruthy();
    expect(screen.getByText('Windows servers')).toBeTruthy();
    expect(screen.getByTestId('group-dynamic-g-dyn')).toBeTruthy();
    expect(screen.queryByTestId('group-dynamic-g-static')).toBeNull();
    expect(fetchMock.mock.calls[0]![0]).toBe('/device-groups?orgId=11111111-1111-4111-8111-111111111111');
  });

  it('disables a refused group and shows the reason, so it cannot be selected', async () => {
    render(<Harness />);
    const box = (await screen.findByTestId('group-checkbox-g-refused')) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    const reason = screen.getByTestId('group-refused-g-refused');
    expect(reason.textContent).toContain('hostname');
    fireEvent.click(box);
    // Never selected, so its members were never even requested.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('g-refused'))).toBe(false);
  });

  it('reports the deduplicated member count, OS-compatible count and offline count', async () => {
    const onSummary = vi.fn();
    render(<Harness onSummary={onSummary} />);
    fireEvent.click(await screen.findByTestId('group-checkbox-g-static'));
    fireEvent.click(screen.getByTestId('group-checkbox-g-dyn'));

    await waitFor(() => {
      const last = onSummary.mock.calls.at(-1)![0] as GroupSelectionSummary;
      expect(last.status).toBe('ready');
      // d-1 is in both groups: 4 unique devices, not 5.
      expect(last.uniqueDevices).toBe(4);
      // windows only: d-1, d-3, d-4 (the macOS device is excluded).
      expect(last.compatibleDevices).toBe(3);
      expect(last.offlineCompatible).toBe(1);
      expect(last.deviceLabels.get('d-3')).toBe('srv-01');
      expect(last.groupNames.get('g-dyn')).toBe('Windows servers');
    });
    expect(screen.getByTestId('group-summary').textContent).toContain('4');
  });

  it('says so when member counts cannot be loaded instead of implying a size', async () => {
    const onSummary = vi.fn();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/device-groups?') || url === '/device-groups') return respond({ data: groups });
      return respond({ error: 'boom' }, 500);
    });
    render(<Harness onSummary={onSummary} />);
    fireEvent.click(await screen.findByTestId('group-checkbox-g-static'));
    await waitFor(() => {
      expect((onSummary.mock.calls.at(-1)![0] as GroupSelectionSummary).status).toBe('error');
    });
    expect(screen.getByTestId('group-summary-error')).toBeTruthy();
  });

  it('shows an error with retry when the group list fails to load', async () => {
    installFetch({ listStatus: 500 });
    render(<Harness />);
    expect(await screen.findByTestId('group-list-error')).toBeTruthy();
  });
});
