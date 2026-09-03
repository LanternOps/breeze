import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuth, navigateTo, canMock } = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(), navigateTo: vi.fn(), canMock: vi.fn(() => true),
}));
vi.mock('../../stores/auth', () => ({ fetchWithAuth }));
vi.mock('@/lib/navigation', () => ({ navigateTo }));
vi.mock('@/lib/permissions', () => ({ usePermissions: () => ({ permissions: [], can: canMock }) }));

import DeviceBillingCard from './DeviceBillingCard';

const DEVICE_ID = 'device-1';
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) }) as unknown as Response;
const fail = (status: number, body: unknown) => ({ ok: false, status, json: async () => body }) as unknown as Response;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const base = {
  deviceId: DEVICE_ID, orgId: 'org-1', deviceRole: 'server', siteId: 'site-1',
  notBillable: false, notBillableReason: null, uncovered: false, lines: [],
};

beforeEach(() => { vi.clearAllMocks(); canMock.mockReturnValue(true); });

describe('DeviceBillingCard (#3205 W06)', () => {
  it('renders NOTHING and fetches NOTHING without contracts:read', () => {
    canMock.mockReturnValue(false);
    const { container } = render(<DeviceBillingCard deviceId={DEVICE_ID} />);
    expect(container).toBeEmptyDOMElement();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('shows a skeleton first, then the covered rows with matchedBy chips and contract links', async () => {
    fetchWithAuth.mockResolvedValueOnce(ok({
      ...base,
      lines: [
        { contractId: 'c1', contractName: 'Acme MSA', contractStatus: 'active', lineId: 'l1', lineType: 'per_device_role', description: 'Managed servers', matchedBy: 'role', siteId: null, deviceRoles: ['server'], deviceGroup: null },
        { contractId: 'c2', contractName: 'Beta Retainer', contractStatus: 'active', lineId: 'l2', lineType: 'per_device_group', description: 'VIP', matchedBy: 'group', siteId: null, deviceRoles: null, deviceGroup: { id: 'g1', name: 'VIP Laptops' } },
      ],
    }));
    render(<DeviceBillingCard deviceId={DEVICE_ID} />);
    const loading = screen.getByTestId('device-billing-loading');
    expect(loading).toBeInTheDocument();
    expect(screen.getByTestId('device-billing-card')).toContainElement(loading);
    expect(loading).toHaveAttribute('role', 'status');
    expect(loading.querySelector('.sr-only')).toHaveTextContent('Billing');
    const rows = await screen.findAllByTestId('device-billing-line');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Acme MSA');
    expect(rows[0]!.textContent).toContain('Active');
    expect(rows[0]!.querySelector('[data-testid="device-billing-contract-status"]')).toHaveTextContent('Active');
    expect(rows[0]!.textContent).toContain('Role: Server');
    expect(rows[1]!.textContent).toContain('Group: VIP Laptops');
    expect(rows[0]!.querySelector('a')!.getAttribute('href')).toBe('/contracts/c1');
    expect(rows[1]!.querySelector('a')!.getAttribute('href')).toBe('/contracts/c2');
    expect(screen.getByRole('heading', { level: 3, name: 'Billing' })).toBeInTheDocument();
    expect(fetchWithAuth).toHaveBeenCalledWith(`/devices/${DEVICE_ID}/billing`);
  });

  it('org-wide and site chips are distinct', async () => {
    fetchWithAuth.mockResolvedValueOnce(ok({
      ...base,
      lines: [
        { contractId: 'c1', contractName: 'A', contractStatus: 'active', lineId: 'l1', lineType: 'per_device', description: 'All', matchedBy: 'org', siteId: null, deviceRoles: null, deviceGroup: null },
        { contractId: 'c1', contractName: 'A', contractStatus: 'active', lineId: 'l2', lineType: 'per_device', description: 'HQ', matchedBy: 'site', siteId: 'site-1', deviceRoles: null, deviceGroup: null },
      ],
    }));
    render(<DeviceBillingCard deviceId={DEVICE_ID} />);
    const rows = await screen.findAllByTestId('device-billing-line');
    expect(rows[0]!.textContent).toContain('Org-wide');
    expect(rows[1]!.textContent).toContain('This site');
  });

  it('uncovered shows the copy, the role chip and a contracts link', async () => {
    fetchWithAuth.mockResolvedValueOnce(ok({ ...base, uncovered: true }));
    render(<DeviceBillingCard deviceId={DEVICE_ID} />);
    const el = await screen.findByTestId('device-billing-uncovered');
    expect(el.textContent).toMatch(/no active contract line/i);
    expect(el.textContent).toContain('Server');
    expect(screen.getByTestId('device-billing-uncovered').querySelector('a')!.getAttribute('href')).toBe('/contracts');
  });

  it.each([
    ['decommissioned', /decommissioned/i],
    ['ephemeral', /ephemeral/i],
    ['not_billable', /not currently billable/i],
  ])('not billable (%s) shows its own copy and NOT the uncovered copy', async (reason, pattern) => {
    fetchWithAuth.mockResolvedValueOnce(ok({ ...base, notBillable: true, notBillableReason: reason, uncovered: false }));
    render(<DeviceBillingCard deviceId={DEVICE_ID} />);
    expect((await screen.findByTestId('device-billing-not-billable')).textContent).toMatch(pattern);
    expect(screen.queryByTestId('device-billing-uncovered')).toBeNull();
  });

  it('a GROUP_EVALUATION_FAILED 500 names the group, offers Retry, and never says "not billed"', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(fail(500, { error: 'boom', code: 'GROUP_EVALUATION_FAILED', details: { groupId: 'g1', groupName: 'VIP Laptops', reason: 'invalid_filter' } }))
      .mockResolvedValueOnce(ok({ ...base, uncovered: true }));
    render(<DeviceBillingCard deviceId={DEVICE_ID} />);
    const err = await screen.findByTestId('device-billing-error');
    expect(err.textContent).toContain('VIP Laptops');
    expect(screen.queryByTestId('device-billing-uncovered')).toBeNull();
    fireEvent.click(screen.getByTestId('device-billing-retry'));
    await screen.findByTestId('device-billing-uncovered');
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('a generic 500 renders the generic message', async () => {
    fetchWithAuth.mockResolvedValueOnce(fail(500, { error: 'nope' }));
    render(<DeviceBillingCard deviceId={DEVICE_ID} />);
    const error = await screen.findByTestId('device-billing-error');
    expect(error.textContent).toMatch(/couldn't load/i);
    expect(error).toHaveAttribute('aria-live', 'polite');
  });

  it('401 redirects to login and hides every card state', async () => {
    fetchWithAuth.mockResolvedValueOnce(fail(401, {}));
    render(<DeviceBillingCard deviceId={DEVICE_ID} />);
    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(screen.queryByTestId('device-billing-card')).toBeNull();
    expect(screen.queryByTestId('device-billing-error')).toBeNull();
    expect(screen.queryByTestId('device-billing-uncovered')).toBeNull();
    expect(screen.queryByTestId('device-billing-not-billable')).toBeNull();
    expect(screen.queryByTestId('device-billing-loading')).toBeNull();
    expect(screen.queryByTestId('device-billing-line')).toBeNull();
  });

  it('403 hides the card when server-side permissions or site scope reject access', async () => {
    fetchWithAuth.mockResolvedValueOnce(fail(403, {}));
    render(<DeviceBillingCard deviceId={DEVICE_ID} />);
    await waitFor(() => expect(screen.queryByTestId('device-billing-loading')).toBeNull());
    expect(screen.queryByTestId('device-billing-card')).toBeNull();
    expect(screen.queryByTestId('device-billing-error')).toBeNull();
  });

  it('discards a stale response when the device changes', async () => {
    const deviceA = deferred<Response>();
    const deviceB = deferred<Response>();
    fetchWithAuth.mockReturnValueOnce(deviceA.promise).mockReturnValueOnce(deviceB.promise);

    const { rerender } = render(<DeviceBillingCard deviceId="device-a" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/devices/device-a/billing'));
    rerender(<DeviceBillingCard deviceId="device-b" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/devices/device-b/billing'));

    await act(async () => {
      deviceB.resolve(ok({
        ...base,
        deviceId: 'device-b',
        lines: [{ contractId: 'b', contractName: 'Device B Contract', contractStatus: 'active', lineId: 'lb', lineType: 'per_device', description: 'B line', matchedBy: 'org', siteId: null, deviceRoles: null, deviceGroup: null }],
      }));
      await deviceB.promise;
    });
    expect((await screen.findByTestId('device-billing-line')).textContent).toContain('Device B Contract');

    await act(async () => {
      deviceA.resolve(ok({
        ...base,
        deviceId: 'device-a',
        lines: [{ contractId: 'a', contractName: 'Device A Contract', contractStatus: 'active', lineId: 'la', lineType: 'per_device', description: 'A line', matchedBy: 'org', siteId: null, deviceRoles: null, deviceGroup: null }],
      }));
      await deviceA.promise;
    });
    expect(screen.getByTestId('device-billing-line')).toHaveTextContent('Device B Contract');
    expect(screen.queryByText('Device A Contract')).toBeNull();
  });
});
