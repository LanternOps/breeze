import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BulkGroupMembershipDialog from './BulkGroupMembershipDialog';
import type { Device } from './DeviceList';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

/**
 * The bulk "Add to group" / "Remove from group" dialog (#9866). It may offer ONLY groups whose
 * membership the bulk write can actually change for this selection: static (a dynamic group's
 * rules decide membership), owned by the selection's org (partner-owned groups are read-only for
 * membership — PARTNER_GROUP_READ_ONLY_BODY), and — for a site-bound group — only when every
 * selected device is at that site (the API refuses the whole batch otherwise). It then sends the
 * selected ids in ONE request and reports the per-device outcome.
 */
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const ORG = '11111111-1111-4111-8111-000000000001';
const OTHER_ORG = '11111111-1111-4111-8111-000000000002';
const SITE_HQ = '22222222-2222-4222-8222-000000000001';
const SITE_LAB = '22222222-2222-4222-8222-000000000002';

let seq = 0;
const device = (over: Partial<Device> = {}): Device => {
  seq += 1;
  return {
    id: `33333333-3333-4333-8333-${String(seq).padStart(12, '0')}`, deviceClass: 'agent', hostname: `host-${seq}`,
    os: 'windows', osVersion: '11', status: 'online', cpuPercent: 1, ramPercent: 1, lastSeen: '', orgId: ORG,
    orgName: 'Acme', siteId: SITE_HQ, siteName: 'HQ', agentVersion: '1.0.0', tags: [], ...over,
  };
};

const group = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, orgId: ORG, siteId: null, type: 'static', ownerScope: 'organization', deviceCount: 0, ...over,
});

const GROUPS = [
  group('g-static', 'Finance laptops'),
  group('g-dynamic', 'All Windows', { type: 'dynamic' }),
  group('g-partner', 'Partner baseline', { orgId: null, ownerScope: 'partner', type: 'dynamic' }),
  group('g-other-org', 'Other org group', { orgId: OTHER_ORG }),
  group('g-site-hq', 'HQ kiosks', { siteId: SITE_HQ }),
  group('g-site-lab', 'Lab rigs', { siteId: SITE_LAB }),
];

const ok = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body, clone() { return this; } }) as unknown as Response;

function mockApi(writeBody: unknown, writeStatus = 200) {
  vi.mocked(fetchWithAuth).mockImplementation(async (url: string, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') return ok({ data: GROUPS, total: GROUPS.length });
    return ok(writeBody, writeStatus);
  });
}

const optionLabels = () =>
  Array.from((screen.getByTestId('bulk-group-select') as HTMLSelectElement).options)
    .filter((o) => o.value !== '')
    .map((o) => o.textContent);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BulkGroupMembershipDialog — which groups are offered', () => {
  it('asks the API for the static groups of the selection org only', async () => {
    mockApi({});
    render(<BulkGroupMembershipDialog mode="add" devices={[device()]} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByTestId('bulk-group-select');
    const [url] = vi.mocked(fetchWithAuth).mock.calls[0]!;
    const params = new URL(String(url), 'http://x').searchParams;
    expect(new URL(String(url), 'http://x').pathname).toBe('/device-groups');
    expect(params.get('orgId')).toBe(ORG);
    expect(params.get('type')).toBe('static');
    expect(params.get('ownerScope')).toBe('organization');
  });

  it('lists only static, org-owned groups of that org, plus site groups only when every device is at that site', async () => {
    mockApi({});
    render(<BulkGroupMembershipDialog mode="add" devices={[device(), device()]} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByTestId('bulk-group-select');
    expect(optionLabels()).toEqual(['Finance laptops', 'HQ kiosks']);
  });

  it('drops every site group when the selection spans two sites', async () => {
    mockApi({});
    render(
      <BulkGroupMembershipDialog
        mode="remove"
        devices={[device(), device({ siteId: SITE_LAB, siteName: 'Lab' })]}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    await screen.findByTestId('bulk-group-select');
    expect(optionLabels()).toEqual(['Finance laptops']);
  });

  it('says so, and offers nothing to submit, when no group qualifies', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(ok({ data: [GROUPS[1], GROUPS[2]], total: 2 }));
    render(<BulkGroupMembershipDialog mode="add" devices={[device()]} onClose={vi.fn()} onDone={vi.fn()} />);
    expect(await screen.findByTestId('bulk-group-empty')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-group-submit')).toBeDisabled();
  });
});

describe('BulkGroupMembershipDialog — add', () => {
  it('sends every selected id to POST /device-groups/:id/devices in one request and toasts the outcome', async () => {
    const devices = [device(), device(), device()];
    mockApi({ data: { added: 2, skipped: 1, total: 9 } }, 201);
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(<BulkGroupMembershipDialog mode="add" devices={devices} onClose={onClose} onDone={onDone} />);
    fireEvent.change(await screen.findByTestId('bulk-group-select'), { target: { value: 'g-static' } });
    fireEvent.click(screen.getByTestId('bulk-group-submit'));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const writes = vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toBe('/device-groups/g-static/devices');
    expect(JSON.parse(String(writes[0]![1]!.body))).toEqual({ deviceIds: devices.map((d) => d.id) });
    expect(showToast).toHaveBeenCalledWith({
      type: 'success',
      message: 'Finance laptops: 2 added, 1 already in the group',
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the dialog open when the API refuses the batch (runAction already toasted it)', async () => {
    mockApi({ error: 'Some devices are invalid or belong to a different organization' }, 400);
    const onClose = vi.fn();
    render(<BulkGroupMembershipDialog mode="add" devices={[device()]} onClose={onClose} onDone={vi.fn()} />);
    fireEvent.change(await screen.findByTestId('bulk-group-select'), { target: { value: 'g-static' } });
    fireEvent.click(screen.getByTestId('bulk-group-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Some devices are invalid');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('BulkGroupMembershipDialog — remove', () => {
  it('sends every selected id to the bulk-remove route in one request', async () => {
    const devices = [device(), device()];
    mockApi({
      data: {
        results: devices.map((d) => ({ deviceId: d.id, outcome: 'removed' })),
        summary: { removed: 2, notMember: 0, forbidden: 0, total: 2 },
      },
    });
    const onDone = vi.fn();
    render(<BulkGroupMembershipDialog mode="remove" devices={devices} onClose={vi.fn()} onDone={onDone} />);
    fireEvent.change(await screen.findByTestId('bulk-group-select'), { target: { value: 'g-site-hq' } });
    fireEvent.click(screen.getByTestId('bulk-group-submit'));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const writes = vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toBe('/device-groups/g-site-hq/devices/remove');
    expect(JSON.parse(String(writes[0]![1]!.body))).toEqual({ deviceIds: devices.map((d) => d.id) });
    expect(showToast).toHaveBeenCalledWith({ type: 'success', message: 'HQ kiosks: 2 removed, 0 were not in the group' });
  });

  it('names the devices the API refused (site access) in a warning', async () => {
    const devices = [device(), device()];
    mockApi({
      data: {
        results: [
          { deviceId: devices[0]!.id, outcome: 'removed' },
          { deviceId: devices[1]!.id, outcome: 'forbidden' },
        ],
        summary: { removed: 1, notMember: 0, forbidden: 1, total: 2 },
      },
    });
    render(<BulkGroupMembershipDialog mode="remove" devices={devices} onClose={vi.fn()} onDone={vi.fn()} />);
    fireEvent.change(await screen.findByTestId('bulk-group-select'), { target: { value: 'g-static' } });
    fireEvent.click(screen.getByTestId('bulk-group-submit'));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith({
      type: 'warning',
      message: `Finance laptops: 1 removed, 0 were not in the group. Not removed (no access to the device's site): ${devices[1]!.hostname}`,
    });
  });

  it('is an error, not a success, when the API removed nothing because of access', async () => {
    const devices = [device()];
    mockApi({
      data: {
        results: [{ deviceId: devices[0]!.id, outcome: 'forbidden' }],
        summary: { removed: 0, notMember: 0, forbidden: 1, total: 1 },
      },
    });
    render(<BulkGroupMembershipDialog mode="remove" devices={devices} onClose={vi.fn()} onDone={vi.fn()} />);
    fireEvent.change(await screen.findByTestId('bulk-group-select'), { target: { value: 'g-static' } });
    fireEvent.click(screen.getByTestId('bulk-group-submit'));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(vi.mocked(showToast).mock.calls.at(-1)![0]).toEqual({
      type: 'error',
      message: `Finance laptops: 0 removed, 0 were not in the group. Not removed (no access to the device's site): ${devices[0]!.hostname}`,
    });
  });
});

describe('BulkGroupMembershipDialog — failures the user must not miss', () => {
  it('an unreadable 2xx keeps the dialog open with the error but still refreshes the list (the write may have landed)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockApi({ data: { unexpected: true } });
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(<BulkGroupMembershipDialog mode="remove" devices={[device()]} onClose={onClose} onDone={onDone} />);
    fireEvent.change(await screen.findByTestId('bulk-group-select'), { target: { value: 'g-static' } });
    fireEvent.click(screen.getByTestId('bulk-group-submit'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to update group membership');
    expect(onDone).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // The unexpected body is logged, not dropped.
    expect(errorSpy.mock.calls.some((args) => args.some((a) => JSON.stringify(a ?? '').includes('unexpected')))).toBe(true);
    errorSpy.mockRestore();
  });

  it('a 401 while loading groups hands off to the session-expiry handler', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(ok({ error: 'Unauthorized' }, 401));
    const onUnauthorized = vi.fn();
    render(
      <BulkGroupMembershipDialog mode="add" devices={[device()]} onClose={vi.fn()} onDone={vi.fn()} onUnauthorized={onUnauthorized} />,
    );
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('any other failure while loading groups shows the load error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fetchWithAuth).mockResolvedValue(ok({ error: 'boom' }, 500));
    render(<BulkGroupMembershipDialog mode="add" devices={[device()]} onClose={vi.fn()} onDone={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the groups of this organization');
    expect(screen.getByTestId('bulk-group-submit')).toBeDisabled();
  });
});
