import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractEditor from './ContractEditor';
import { fetchWithAuth } from '../../stores/auth';
import * as api from '../../lib/api/contracts';
import type { ContractLine, ContractStatus } from '../../lib/api/contracts';
import type { CatalogItem } from '../../lib/api/catalog';
import { showToast } from '../shared/Toast';

const authState = vi.hoisted(() => ({
  permissions: [{ resource: '*', action: '*' }],
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: authState.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../catalog/CatalogItemPicker', () => ({
  default: ({ items, onSelect }: { items: CatalogItem[]; onSelect: (item: CatalogItem) => void }) => (
    <div>{items.map((item) => (
      <button key={item.id} type="button" data-testid={`catalog-pick-${item.id}`} onClick={() => onSelect(item)}>
        {item.name}
      </button>
    ))}</div>
  ),
}));
const catalogRows = vi.hoisted(() => ({
  items: [
    { id: 'cat-1', name: 'Catalog one', isBundle: false },
    { id: 'cat-2', name: 'Catalog two', isBundle: false },
  ] as CatalogItem[],
}));
vi.mock('../../lib/api/catalog', () => ({
  listCatalog: vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: catalogRows.items }) }),
  resolveCatalogPrice: vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: null }) }),
}));
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return {
    ...actual,
    createContract: vi.fn(), updateContract: vi.fn(), addContractLine: vi.fn(),
    removeContractLine: vi.fn(), updateContractLine: vi.fn(), contractTransition: vi.fn(),
    getContractEstimate: vi.fn(),
  };
});

const fetchMock = vi.mocked(fetchWithAuth);
const resp = (payload: unknown, ok = true, status = ok ? 200 : 400): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const contract = {
  id: 'ct-1', partnerId: 'p1', orgId: 'org-1', name: 'Acme MSA', status: 'draft', billingTiming: 'advance',
  intervalMonths: 1, startDate: '2026-06-01', endDate: null, nextBillingAt: null, autoIssue: false, autoRenew: false,
  renewalTermMonths: null, renewalNoticeDays: null, currencyCode: 'USD', notes: null, terms: null,
  createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
} as const;

const baseLine: ContractLine = {
  id: 'l1', contractId: 'ct-1', orgId: 'org-1', lineType: 'per_device', description: 'Managed device',
  catalogItemId: null, unitPrice: '10.00', manualQuantity: null,
  includedQuantity: null, overageMode: null, overageUnitPrice: null, siteId: null, siteName: null, deviceRoles: null,
  deviceGroupId: null, deviceGroupName: null, deviceGroup: null, site: null, taxable: false, sortOrder: 0,
  createdAt: '2026-06-01T00:00:00Z',
};

describe('ContractEditor — inline line edit (#3205 W03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.permissions = [{ resource: '*', action: '*' }];
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/orgs/organizations')) return resp({ data: [{ id: 'org-1', name: 'Acme' }] });
      if (url.startsWith('/orgs/sites')) return resp({ data: [{ id: 'site-1', name: 'HQ' }] });
      if (url.startsWith('/device-groups')) return resp({ data: [{ id: 'g-1', name: 'VIP laptops', type: 'static' }] });
      return resp({ data: {} });
    });
    (api.getContractEstimate as any).mockResolvedValue(resp({
      data: { currencyCode: 'USD', periodTotal: '0.00', lines: [], uncoveredDevices: null, overages: [] },
    }));
    (api.updateContractLine as any).mockResolvedValue(resp({ data: { ...baseLine, description: 'Renamed' } }));
  });

  const detailFor = (lines: ContractLine[] = [baseLine], status: ContractStatus = 'draft') => ({
    contract: { ...contract, status }, lines, periods: [],
  });

  const renderEdit = (lines: ContractLine[] = [baseLine], status: ContractStatus = 'draft') =>
    render(<ContractEditor detail={detailFor(lines, status)} onChanged={vi.fn()} />);

  const patchBody = () => (api.updateContractLine as any).mock.calls[0][2] as Record<string, unknown>;

  // Decision 11: Remove was gated on permission alone and 409'd on click for a
  // cancelled or expired contract. Edit and Remove now share one predicate.
  it.each(['draft', 'active'] as const)('renders Edit and Remove on a %s contract', async (status) => {
    renderEdit([baseLine], status);
    expect(await screen.findByTestId('line-edit-0')).toBeInTheDocument();
    expect(screen.getByTestId('line-remove-0')).toBeInTheDocument();
  });

  it.each(['paused', 'cancelled', 'expired'] as const)('renders NEITHER on a %s contract', async (status) => {
    renderEdit([baseLine], status as ContractStatus);
    await screen.findByTestId('line-row-0');
    expect(screen.queryByTestId('line-edit-0')).toBeNull();
    expect(screen.queryByTestId('line-remove-0')).toBeNull();
  });

  it.each(['paused', 'cancelled', 'expired'] as const)('disables Add on a %s contract', async (status) => {
    renderEdit([baseLine], status as ContractStatus);
    fireEvent.change(await screen.findByTestId('contract-line-desc'), { target: { value: 'Should not add' } });
    const add = await screen.findByTestId('add-line-btn');
    expect(add).toBeDisabled();
    fireEvent.click(add);
    expect(api.addContractLine).not.toHaveBeenCalled();
  });

  it('renders no Edit or Remove affordance without contracts:write', async () => {
    authState.permissions = [];
    renderEdit();
    await screen.findByTestId('line-row-0');
    expect(screen.queryByTestId('line-edit-0')).toBeNull();
    expect(screen.queryByTestId('line-remove-0')).toBeNull();
  });

  it('moves focus into the form on open and returns it to Edit on cancel', async () => {
    renderEdit();
    const edit = await screen.findByTestId('line-edit-0');
    fireEvent.click(edit);
    expect(await screen.findByTestId('line-edit-desc-0')).toHaveFocus();
    fireEvent.click(screen.getByTestId('line-edit-cancel-0'));
    await waitFor(() => expect(screen.getByTestId('line-edit-0')).toHaveFocus());
  });

  it('discards draft changes on cancel and restores persisted row values', async () => {
    renderEdit();
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.change(screen.getByTestId('line-edit-desc-0'), { target: { value: 'Discard me' } });
    fireEvent.click(screen.getByTestId('line-edit-cancel-0'));
    expect(screen.getByTestId('line-row-0')).toHaveTextContent('Managed device');
    fireEvent.click(screen.getByTestId('line-edit-0'));
    expect(screen.getByTestId('line-edit-desc-0')).toHaveValue('Managed device');
  });

  it('shows the type as a locked label with no type select', async () => {
    renderEdit();
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    const form = await screen.findByTestId('line-edit-form-0');
    expect(within(form).getByTestId('line-edit-type-locked').textContent).toMatch(/can.t be changed/i);
    expect(within(form).queryByTestId('line-edit-type')).toBeNull();
  });

  it('sends ONLY the changed field for a description-only edit', async () => {
    renderEdit();
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.change(screen.getByTestId('line-edit-desc-0'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('line-edit-save-0'));
    await waitFor(() => expect(api.updateContractLine).toHaveBeenCalled());
    expect(patchBody()).toEqual({ description: 'Renamed' });
  });

  it('diffs against the immutable row snapshot captured when edit opened', async () => {
    const view = renderEdit();
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    view.rerender(<ContractEditor
      detail={detailFor([{ ...baseLine, unitPrice: '12.00' }])}
      onChanged={vi.fn()}
    />);
    fireEvent.change(screen.getByTestId('line-edit-desc-0'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('line-edit-save-0'));
    await waitFor(() => expect(api.updateContractLine).toHaveBeenCalled());
    expect(patchBody()).toEqual({ description: 'Renamed' });
  });

  // The unlink EXCEPTION to the minimal patch: transition row 6 requires all
  // three, so a minimal patch would 400 on a legitimate gesture.
  it('sends catalogItemId, unitPrice and taxable together on an unlink even when neither was retyped', async () => {
    renderEdit([{ ...baseLine, catalogItemId: 'cat-1', unitPrice: '20.00', taxable: true }]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.click(screen.getByTestId('line-edit-unlink-0'));
    fireEvent.click(screen.getByTestId('line-edit-save-0'));
    await waitFor(() => expect(api.updateContractLine).toHaveBeenCalled());
    expect(patchBody()).toEqual({ catalogItemId: null, unitPrice: '20.00', taxable: true });
  });

  it('relinks an unlinked line with only the new catalogItemId', async () => {
    renderEdit();
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    const form = await screen.findByTestId('line-edit-form-0');
    fireEvent.click(within(form).getByTestId('catalog-pick-cat-2'));
    expect(screen.getByTestId('line-edit-price-0')).toBeDisabled();
    expect(screen.getByTestId('line-edit-price-source-0')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('line-edit-save-0'));
    await waitFor(() => expect(api.updateContractLine).toHaveBeenCalled());
    expect(patchBody()).toEqual({ catalogItemId: 'cat-2' });
  });

  it('relinks a linked line to a different item without sending price fields', async () => {
    renderEdit([{ ...baseLine, catalogItemId: 'cat-1', unitPrice: '20.00', taxable: true }]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    const form = await screen.findByTestId('line-edit-form-0');
    fireEvent.click(within(form).getByTestId('catalog-pick-cat-2'));
    fireEvent.click(screen.getByTestId('line-edit-save-0'));
    await waitFor(() => expect(api.updateContractLine).toHaveBeenCalled());
    expect(patchBody()).toEqual({ catalogItemId: 'cat-2' });
  });

  it('picking the already-linked item leaves Save disabled', async () => {
    renderEdit([{ ...baseLine, catalogItemId: 'cat-1', unitPrice: '20.00' }]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    const form = await screen.findByTestId('line-edit-form-0');
    fireEvent.click(within(form).getByTestId('catalog-pick-cat-1'));
    expect(screen.getByTestId('line-edit-save-0')).toBeDisabled();
    expect(api.updateContractLine).not.toHaveBeenCalled();
  });

  it('restores the persisted catalog link after unlinking', async () => {
    renderEdit([{ ...baseLine, catalogItemId: 'cat-1', unitPrice: '20.00' }]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.click(screen.getByTestId('line-edit-unlink-0'));
    fireEvent.click(screen.getByTestId('line-edit-restore-catalog-0'));
    expect(screen.getByTestId('line-edit-price-0')).toBeDisabled();
    expect(screen.getByTestId('line-edit-save-0')).toBeDisabled();
  });

  it('"Refresh price from catalog" sends exactly { refreshCatalogPrice: true }', async () => {
    renderEdit([{ ...baseLine, catalogItemId: 'cat-1', unitPrice: '20.00' }]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.click(screen.getByTestId('line-edit-refresh-0'));
    await waitFor(() => expect(api.updateContractLine).toHaveBeenCalled());
    expect(patchBody()).toEqual({ refreshCatalogPrice: true });
  });

  it('refreshes catalog price without discarding an unsaved description edit', async () => {
    renderEdit([{ ...baseLine, catalogItemId: 'cat-1', unitPrice: '20.00' }]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.change(screen.getByTestId('line-edit-desc-0'), { target: { value: 'Renamed before refresh' } });
    fireEvent.click(screen.getByTestId('line-edit-refresh-0'));
    await waitFor(() => expect(api.updateContractLine).toHaveBeenCalled());
    expect(patchBody()).toEqual({ description: 'Renamed before refresh', refreshCatalogPrice: true });
  });

  it('shows a catalog-linked price read-only, and keeps Save disabled after an unlink until a price is entered', async () => {
    renderEdit([{ ...baseLine, catalogItemId: 'cat-1', unitPrice: '20.00', taxable: true }]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    expect(screen.getByTestId('line-edit-price-0')).toBeDisabled();
    expect(screen.getByTestId('line-edit-taxable-0')).toBeDisabled();
    fireEvent.click(screen.getByTestId('line-edit-unlink-0'));
    expect(screen.getByTestId('line-edit-price-0')).not.toBeDisabled();
    fireEvent.change(screen.getByTestId('line-edit-price-0'), { target: { value: '' } });
    expect(screen.getByTestId('line-edit-save-0')).toBeDisabled();
    fireEvent.change(screen.getByTestId('line-edit-price-0'), { target: { value: '3.00' } });
    expect(screen.getByTestId('line-edit-save-0')).not.toBeDisabled();
  });

  it('disables Save with no changes and with no roles left on a role line', async () => {
    renderEdit([{ ...baseLine, lineType: 'per_device_role', deviceRoles: ['server'] }]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    expect(screen.getByTestId('line-edit-save-0')).toBeDisabled();
    fireEvent.click(screen.getByTestId('line-edit-role-server-0'));
    expect(screen.getByTestId('line-edit-save-0')).toBeDisabled();
  });

  it('disables Save when a manual line quantity is empty or invalid', async () => {
    renderEdit([{ ...baseLine, lineType: 'manual', manualQuantity: '1.00' }]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    const quantity = screen.getByTestId('line-edit-qty-0');
    fireEvent.change(quantity, { target: { value: '' } });
    expect(screen.getByTestId('line-edit-save-0')).toBeDisabled();
    fireEvent.change(quantity, { target: { value: '1.234' } });
    expect(screen.getByTestId('line-edit-save-0')).toBeDisabled();
  });

  // The orphaned-group repair: Save stays disabled until a live group is picked,
  // so a patch can never re-send the null the FK left behind.
  it('disables Save on an orphaned group line until a group is picked', async () => {
    renderEdit([{ ...baseLine, lineType: 'per_device_group', siteId: null, deviceGroupId: null, deviceGroupName: 'Retired', deviceGroup: null }]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    expect(screen.getByTestId('line-edit-save-0')).toBeDisabled();
    const select = await screen.findByTestId('line-edit-group-0');
    expect(await within(select).findByTestId('line-edit-group-option-g-1')).toHaveTextContent('VIP laptops');
    fireEvent.change(select, { target: { value: 'g-1' } });
    expect(screen.getByTestId('line-edit-save-0')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('line-edit-save-0'));
    await waitFor(() => expect(api.updateContractLine).toHaveBeenCalled());
    expect(patchBody()).toEqual({ deviceGroupId: 'g-1' });
  });

  it('disables Edit on every other row while one is open', async () => {
    renderEdit([baseLine, { ...baseLine, id: 'l2', description: 'Second' }]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    expect(screen.getByTestId('line-edit-1')).toBeDisabled();
  });

  it('renders a site-scoped line with the labelled site sub-label from line.site', async () => {
    renderEdit([{ ...baseLine, siteId: 'site-1', siteName: 'HQ', site: { id: 'site-1', name: 'HQ' } }]);
    expect((await screen.findByTestId('line-site-0')).textContent).toBe('Site: HQ');
  });

  it('renders the site sub-label whenever line.site is present', async () => {
    renderEdit([{ ...baseLine, lineType: 'flat', siteId: 'site-1', siteName: 'HQ', site: { id: 'site-1', name: 'HQ' } }]);
    expect((await screen.findByTestId('line-site-0')).textContent).toBe('Site: HQ');
  });

  it.each([
    ['INVALID_STATE', 'Lines can only be edited on draft or active contracts.'],
    ['INVALID_LINE_PATCH', 'Those changes aren’t valid for this line type.'],
    ['LINE_NOT_FOUND', 'That line no longer exists. Refresh the contract.'],
    ['SITE_NOT_IN_ORG', 'That site belongs to a different organization.'],
    ['GROUP_NOT_IN_ORG', 'That device group belongs to a different organization.'],
    ['CATALOG_ITEM_NOT_FOUND', 'That catalog item isn’t available on this contract.'],
  ])('toasts the friendly message on %s and keeps the row in edit mode', async (code, message) => {
    (api.updateContractLine as any).mockResolvedValue(
      resp({ error: 'not editable', code }, false, 409),
    );
    renderEdit();
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.change(screen.getByTestId('line-edit-desc-0'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('line-edit-save-0'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message }),
    ));
    expect(screen.getByTestId('line-edit-form-0')).toBeInTheDocument();
  });

  it('does not toast on a 401 — the auth redirect is the feedback', async () => {
    (api.updateContractLine as any).mockResolvedValue(resp({ error: 'Unauthorized' }, false, 401));
    renderEdit();
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.change(screen.getByTestId('line-edit-desc-0'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('line-edit-save-0'));
    await waitFor(() => expect(api.updateContractLine).toHaveBeenCalled());
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});
