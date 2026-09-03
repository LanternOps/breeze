import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractEditor from './ContractEditor';
import { fetchWithAuth } from '../../stores/auth';
import * as api from '../../lib/api/contracts';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  // usePermissions() (billing-RBAC UI gating) reads grants off the store; grant
  // the admin wildcard so every gated control renders and these tests exercise
  // full functionality.
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
// The catalog typeahead is exercised in the invoice-editor test; stub it here.
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

describe('ContractEditor — per_device_role (#3205)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/orgs/organizations')) return resp({ data: [{ id: 'org-1', name: 'Acme' }] });
      if (url.startsWith('/orgs/sites')) return resp({ data: [{ id: 'site-1', name: 'HQ' }] });
      return resp({ data: {} });
    });
    (api.getContractEstimate as any).mockResolvedValue(resp({
      data: { currencyCode: 'USD', periodTotal: '0.00', lines: [], uncoveredDevices: { total: 2, byRole: { unknown: 2 } } },
    }));
    (api.addContractLine as any).mockResolvedValue(resp({ data: { id: 'line-1' } }));
  });

  // Edit mode = a `detail` prop ({ contract, lines, periods }), exactly as
  // ContractEditor.autosave.test.tsx renders it.
  function renderEdit(lines: unknown[] = []) {
    return render(<ContractEditor detail={{ contract: contract as any, lines: lines as any, periods: [] }} onChanged={vi.fn()} />);
  }

  it('shows the role picker only for per_device_role and clears it when the type changes', async () => {
    renderEdit();
    expect(screen.queryByTestId('contract-line-roles')).toBeNull();
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'per_device_role' } });
    expect(await screen.findByTestId('contract-line-roles')).toBeInTheDocument();
    expect(screen.queryByTestId('contract-line-role-unknown')).toBeNull();
    fireEvent.click(screen.getByTestId('contract-line-role-switch'));
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'flat' } });
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'per_device_role' } });
    expect((screen.getByTestId('contract-line-role-switch') as HTMLInputElement).checked).toBe(false);
  });

  it('disables Add until a role is picked, then sends deviceRoles and siteId', async () => {
    renderEdit();
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'per_device_role' } });
    fireEvent.change(screen.getByTestId('contract-line-desc'), { target: { value: 'Network gear' } });
    expect(screen.getByTestId('add-line-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('contract-line-role-switch'));
    fireEvent.click(screen.getByTestId('contract-line-role-router'));
    const site = await screen.findByTestId('contract-line-site');
    await within(site).findByRole('option', { name: 'HQ' });
    fireEvent.change(site, { target: { value: 'site-1' } });
    expect(screen.getByTestId('add-line-btn')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('add-line-btn'));
    await waitFor(() => expect(api.addContractLine).toHaveBeenCalled());
    expect((api.addContractLine as any).mock.calls[0][1]).toMatchObject({
      lineType: 'per_device_role', deviceRoles: ['switch', 'router'], siteId: 'site-1',
    });
  });

  it('lists the roles under a role line and shows the coverage warning from the estimate', async () => {
    renderEdit([{
      id: 'l1', contractId: 'ct-1', orgId: 'org-1', lineType: 'per_device_role', description: 'Network gear',
      catalogItemId: null, unitPrice: '25.00', manualQuantity: null, siteId: null, deviceRoles: ['switch', 'router'],
      taxable: false, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
    }]);
    expect((await screen.findByTestId('line-roles-0')).textContent).toBe('Switch, Router');
    expect((await screen.findByTestId('contract-coverage-warning')).textContent).toContain('2 Unknown');
  });
});
