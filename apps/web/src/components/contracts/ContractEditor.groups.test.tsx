import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractEditor from './ContractEditor';
import { fetchWithAuth } from '../../stores/auth';
import * as api from '../../lib/api/contracts';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../catalog/CatalogItemPicker', () => ({ default: () => null }));
vi.mock('../../lib/api/catalog', () => ({
  listCatalog: vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) }),
}));
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return {
    ...actual,
    createContract: vi.fn(),
    updateContract: vi.fn(),
    addContractLine: vi.fn(),
    removeContractLine: vi.fn(),
    contractTransition: vi.fn(),
    getContractEstimate: vi.fn(),
  };
});

const fetchMock = vi.mocked(fetchWithAuth);
const resp = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const contract = {
  id: 'ct-1', partnerId: 'p1', orgId: 'org-1', name: 'Acme MSA', status: 'draft', billingTiming: 'advance',
  intervalMonths: 1, startDate: '2026-06-01', endDate: null, nextBillingAt: null, autoIssue: false, autoRenew: false,
  renewalTermMonths: null, renewalNoticeDays: null, currencyCode: 'USD', notes: null, terms: null,
  createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
} as const;

function renderEdit(lines: unknown[] = []) {
  return render(<ContractEditor detail={{ contract: contract as any, lines: lines as any, periods: [] }} onChanged={vi.fn()} />);
}

describe('ContractEditor — per_device_group (#3205 W02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/orgs/organizations')) return resp({ data: [{ id: 'org-1', name: 'Acme' }] });
      if (url.startsWith('/orgs/sites')) return resp({ data: [{ id: 'site-1', name: 'HQ' }] });
      if (url.startsWith('/device-groups')) return resp({ data: [{ id: 'g-1', name: 'VIP laptops', type: 'static' }, { id: 'g-2', name: 'All servers', type: 'dynamic' }] });
      return resp({ data: {} });
    });
    (api.getContractEstimate as any).mockResolvedValue(resp({ data: { currencyCode: 'USD', periodTotal: '0.00', lines: [{ lineId: 'l1', lineType: 'per_device_group', quantity: 0, value: '0.00', live: true, unresolved: 'group_deleted' }], uncoveredDevices: null } }));
    (api.addContractLine as any).mockResolvedValue(resp({ data: { id: 'line-1' } }));
  });

  it('shows the group select only for per_device_group, no site select, and clears it on type change', async () => {
    renderEdit();
    expect(screen.queryByTestId('contract-line-group')).toBeNull();
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'per_device_group' } });
    const select = await screen.findByTestId('contract-line-group');
    await within(select).findByRole('option', { name: /All servers/ });
    expect(screen.queryByTestId('contract-line-site')).toBeNull();
    fireEvent.change(select, { target: { value: 'g-2' } });
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'flat' } });
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'per_device_group' } });
    expect((await screen.findByTestId('contract-line-group') as HTMLSelectElement).value).toBe('');
  });

  it('disables Add until a group is picked, then sends deviceGroupId and no siteId', async () => {
    renderEdit();
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'per_device_group' } });
    fireEvent.change(screen.getByTestId('contract-line-desc'), { target: { value: 'VIP' } });
    expect(screen.getByTestId('add-line-btn')).toBeDisabled();
    const select = await screen.findByTestId('contract-line-group');
    await within(select).findByRole('option', { name: /VIP laptops/ });
    fireEvent.change(select, { target: { value: 'g-1' } });
    expect(screen.getByTestId('add-line-btn')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('add-line-btn'));
    await waitFor(() => expect(api.addContractLine).toHaveBeenCalled());
    const body = (api.addContractLine as any).mock.calls[0][1];
    expect(body).toMatchObject({ lineType: 'per_device_group', deviceGroupId: 'g-1' });
    expect(body.siteId).toBeUndefined();
  });

  it('shows an inline hint and keeps Add disabled when device groups fail to load', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/orgs/organizations')) return resp({ data: [{ id: 'org-1', name: 'Acme' }] });
      if (url.startsWith('/orgs/sites')) return resp({ data: [{ id: 'site-1', name: 'HQ' }] });
      if (url.startsWith('/device-groups')) throw new Error('network down');
      return resp({ data: {} });
    });

    renderEdit();
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'per_device_group' } });
    fireEvent.change(screen.getByTestId('contract-line-desc'), { target: { value: 'VIP' } });

    expect(await screen.findByText("Couldn't load this organization's device groups.")).toBeVisible();
    expect(screen.getByTestId('add-line-btn')).toBeDisabled();
  });

  it('labels a group line with its live name and dynamic hint, a deleted group by its stamped name, and shows "group deleted" as the quantity', async () => {
    renderEdit([
      { id: 'l1', contractId: 'ct-1', orgId: 'org-1', lineType: 'per_device_group', description: 'Old', catalogItemId: null, unitPrice: '5.00', manualQuantity: null, siteId: null, deviceRoles: null, deviceGroupId: null, deviceGroupName: 'Retired group', deviceGroup: null, taxable: false, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z' },
      { id: 'l2', contractId: 'ct-1', orgId: 'org-1', lineType: 'per_device_group', description: 'Servers', catalogItemId: null, unitPrice: '5.00', manualQuantity: null, siteId: null, deviceRoles: null, deviceGroupId: 'g-2', deviceGroupName: 'All servers', deviceGroup: { id: 'g-2', name: 'All servers', type: 'dynamic' }, taxable: false, sortOrder: 1, createdAt: '2026-06-01T00:00:00Z' },
    ]);
    expect((await screen.findByTestId('line-group-0')).textContent).toContain('Retired group');
    expect(screen.getByTestId('line-group-0').textContent).toMatch(/deleted/i);
    expect(screen.getByTestId('line-group-1').textContent).toContain('All servers');
    expect(screen.getByTestId('line-group-1').textContent).toMatch(/dynamic/i);
    expect((await screen.findByTestId('line-qty-0')).textContent).toMatch(/group deleted/i);
  });
});
