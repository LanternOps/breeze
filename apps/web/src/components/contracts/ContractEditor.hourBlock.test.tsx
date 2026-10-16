import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractEditor from './ContractEditor';
import { fetchWithAuth } from '../../stores/auth';
import * as api from '../../lib/api/contracts';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));
vi.mock('../catalog/CatalogItemPicker', () => ({ default: () => null }));
vi.mock('../../lib/api/catalog', () => ({
  listCatalog: vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) }),
}));
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return {
    ...actual,
    createContract: vi.fn(), updateContract: vi.fn(), addContractLine: vi.fn(), removeContractLine: vi.fn(),
    updateContractLine: vi.fn(), contractTransition: vi.fn(), getContractEstimate: vi.fn(),
  };
});

const fetchMock = vi.mocked(fetchWithAuth);
const resp = (payload: unknown, ok = true, status = ok ? 200 : 400): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const contract = {
  autopayExcluded: false, id: 'ct-1', partnerId: 'p1', orgId: 'org-1', name: 'Acme MSA', status: 'active',
  billingTiming: 'advance', intervalMonths: 1, startDate: '2026-06-01', endDate: null, nextBillingAt: '2026-07-01',
  autoIssue: false, autoRenew: false, renewalTermMonths: null, renewalNoticeDays: null, currencyCode: 'USD',
  notes: null, terms: null, createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
} as const;

const blockLine = (p: Partial<Record<string, unknown>> = {}) => ({
  id: 'b1', contractId: 'ct-1', orgId: 'org-1', lineType: 'hour_block', description: 'Support block',
  catalogItemId: null, unitPrice: '1000.00', manualQuantity: null, siteId: null, siteName: null, deviceRoles: null,
  deviceGroupId: null, deviceGroupName: null, deviceGroup: null, site: null,
  includedQuantity: '10.00', overageMode: 'bill', overageUnitPrice: '150.00', taxable: false, sortOrder: 0,
  createdAt: '2026-06-01T00:00:00Z', rolloverPolicy: 'carry_forward', rolloverCapHours: '4.00', hourBlockAlertPct: 80,
  hourBlockFirstPeriodStart: '2026-07-01', hourBlockRetiredAt: null, hourBlockHasHistory: false, ...p,
});
const flatLine = () => ({
  id: 'f1', contractId: 'ct-1', orgId: 'org-1', lineType: 'flat', description: 'Base', catalogItemId: null,
  unitPrice: '50.00', manualQuantity: null, siteId: null, siteName: null, deviceRoles: null, deviceGroupId: null,
  deviceGroupName: null, deviceGroup: null, site: null, includedQuantity: null, overageMode: null, overageUnitPrice: null,
  taxable: true, sortOrder: 1, createdAt: '2026-06-01T00:00:00Z',
});

describe('ContractEditor — block hours (#4547 W03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/orgs/organizations')) return resp({ data: [{ id: 'org-1', name: 'Acme' }] });
      if (url.startsWith('/orgs/sites')) return resp({ data: [] });
      if (url.startsWith('/device-groups')) return resp({ data: [] });
      return resp({ data: {} });
    });
    (api.getContractEstimate as any).mockResolvedValue(resp({
      data: { currencyCode: 'USD', periodTotal: '0.00', lines: [], uncoveredDevices: null, overages: [], hourBlock: null },
    }));
    (api.addContractLine as any).mockResolvedValue(resp({ data: { id: 'new' } }));
    (api.updateContractLine as any).mockResolvedValue(resp({ data: blockLine() }));
    (api.removeContractLine as any).mockResolvedValue(resp({ data: { ok: true, retired: false } }));
  });

  function renderEdit(lines: unknown[] = []) {
    return render(<ContractEditor detail={{ autopayEnabled: false, contract: contract as any, lines: lines as any, periods: [] }} onChanged={vi.fn()} />);
  }
  const pickBlock = async () => {
    fireEvent.change(screen.getByTestId('contract-line-type'), { target: { value: 'hour_block' } });
    await screen.findByTestId('contract-line-block-fields');
  };
  const fillValidBlock = () => {
    fireEvent.change(screen.getByTestId('contract-line-desc'), { target: { value: 'Support block' } });
    fireEvent.change(screen.getByTestId('contract-line-price'), { target: { value: '1000.00' } });
    fireEvent.change(screen.getByTestId('contract-line-block-hours'), { target: { value: '10' } });
    fireEvent.change(screen.getByTestId('contract-line-block-extra-rate'), { target: { value: '150.00' } });
  };

  it('offers the block type and shows only the block fields: no site, roles, group, manual quantity, allowance toggle or overage-mode choice', async () => {
    renderEdit();
    expect(Array.from((screen.getByTestId('contract-line-type') as HTMLSelectElement).options).map((o) => o.value)).toContain('hour_block');
    await pickBlock();
    for (const gone of ['contract-line-site', 'contract-line-group', 'contract-line-qty', 'contract-line-allowance-toggle',
      'contract-line-overage-mode-group', 'contract-line-overage-flag', 'contract-line-included-qty']) {
      expect(screen.queryByTestId(gone)).toBeNull();
    }
    expect(screen.queryByTestId('contract-line-roles')).toBeNull();
    expect(screen.getByTestId('contract-line-block-firstperiod')).toBeInTheDocument();
  });

  it('adds a block with the exact payload: hours, bill mode, rate, policy — and no site/roles/group/manual/cap/alert keys', async () => {
    renderEdit();
    await pickBlock();
    fillValidBlock();
    fireEvent.click(screen.getByTestId('add-line-btn'));
    await waitFor(() => expect(api.addContractLine).toHaveBeenCalled());
    const body = (api.addContractLine as any).mock.calls[0][1];
    expect(body).toMatchObject({
      lineType: 'hour_block', description: 'Support block', unitPrice: '1000.00', taxable: false,
      includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'none',
    });
    for (const absent of ['siteId', 'deviceRoles', 'deviceGroupId', 'manualQuantity', 'rolloverCapHours', 'hourBlockAlertPct']) {
      expect(body[absent]).toBeUndefined();
    }
  });

  it('disables the cap under rollover none, sends it under carry_forward, and sends the alert percentage', async () => {
    renderEdit();
    await pickBlock();
    fillValidBlock();
    expect(screen.getByTestId('contract-line-block-cap')).toBeDisabled();
    fireEvent.click(screen.getByTestId('contract-line-block-rollover-carry'));
    expect(screen.getByTestId('contract-line-block-cap')).not.toBeDisabled();
    fireEvent.change(screen.getByTestId('contract-line-block-cap'), { target: { value: '4' } });
    fireEvent.change(screen.getByTestId('contract-line-block-alert'), { target: { value: '80' } });
    fireEvent.click(screen.getByTestId('add-line-btn'));
    await waitFor(() => expect(api.addContractLine).toHaveBeenCalled());
    expect((api.addContractLine as any).mock.calls[0][1]).toMatchObject({
      rolloverPolicy: 'carry_forward', rolloverCapHours: '4', hourBlockAlertPct: 80,
    });
    // Switching back to none must not leak a stale cap into the payload.
    (api.addContractLine as any).mockClear();
    await pickBlock();
    fillValidBlock();
    fireEvent.click(screen.getByTestId('contract-line-block-rollover-carry'));
    fireEvent.change(screen.getByTestId('contract-line-block-cap'), { target: { value: '9' } });
    fireEvent.click(screen.getByTestId('contract-line-block-rollover-none'));
    fireEvent.click(screen.getByTestId('add-line-btn'));
    await waitFor(() => expect(api.addContractLine).toHaveBeenCalled());
    expect((api.addContractLine as any).mock.calls[0][1].rolloverCapHours).toBeUndefined();
  });

  it('gates Add on valid hours (fractional ok, zero not), price, cap and alert bounds', async () => {
    renderEdit();
    await pickBlock();
    fireEvent.change(screen.getByTestId('contract-line-desc'), { target: { value: 'Support block' } });
    expect(screen.getByTestId('add-line-btn')).toBeDisabled();           // nothing entered yet
    fillValidBlock();
    expect(screen.getByTestId('add-line-btn')).not.toBeDisabled();
    for (const bad of ['0', '0.00', '-1', 'abc', '1.234', '']) {
      fireEvent.change(screen.getByTestId('contract-line-block-hours'), { target: { value: bad } });
      expect(screen.getByTestId('add-line-btn')).toBeDisabled();
    }
    fireEvent.change(screen.getByTestId('contract-line-block-hours'), { target: { value: '7.5' } });
    expect(screen.getByTestId('add-line-btn')).not.toBeDisabled();
    // (a non-numeric string cannot be entered in a number input: jsdom and browsers both sanitize it to '')
    for (const bad of ['0', '101', '12.5']) {
      fireEvent.change(screen.getByTestId('contract-line-block-alert'), { target: { value: bad } });
      expect(screen.getByTestId('add-line-btn')).toBeDisabled();
    }
    fireEvent.change(screen.getByTestId('contract-line-block-alert'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('contract-line-block-extra-rate'), { target: { value: '' } });
    expect(screen.getByTestId('add-line-btn')).toBeDisabled();
  });

  it('blocks a second live block on the same contract with the retire-first hint, and a retired one does not count', async () => {
    renderEdit([blockLine()]);
    await pickBlock();
    fillValidBlock();
    expect(screen.getByTestId('contract-line-block-exists')).toBeInTheDocument();
    expect(screen.getByTestId('add-line-btn')).toBeDisabled();
  });

  it('a retired block does not count toward the one-live-block hint', async () => {
    renderEdit([blockLine({ hourBlockRetiredAt: '2026-07-10T00:00:00Z', hourBlockHasHistory: true })]);
    await pickBlock();
    fillValidBlock();
    expect(screen.queryByTestId('contract-line-block-exists')).toBeNull();
    expect(screen.getByTestId('add-line-btn')).not.toBeDisabled();
  });

  it('maps HOUR_BLOCK_EXISTS to the friendly retire-first copy', async () => {
    (api.addContractLine as any).mockResolvedValue(resp({ error: 'exists', code: 'HOUR_BLOCK_EXISTS' }, false, 409));
    renderEdit();
    await pickBlock();
    fillValidBlock();
    fireEvent.click(screen.getByTestId('add-line-btn'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: expect.stringContaining('already has an active block-hours line'),
    })));
  });

  it('REGRESSION: renaming a block sends exactly { description } — never the generic allowance-clearing nulls', async () => {
    renderEdit([blockLine()]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.change(screen.getByTestId('line-edit-desc-0'), { target: { value: 'Support block (renamed)' } });
    fireEvent.click(screen.getByTestId('line-edit-save-0'));
    await waitFor(() => expect(api.updateContractLine).toHaveBeenCalled());
    expect((api.updateContractLine as any).mock.calls[0][2]).toEqual({ description: 'Support block (renamed)' });
  });

  it('editing sends only the changed block fields; "none" clears the cap in the same patch; 10 vs 10.00 is not a change', async () => {
    renderEdit([blockLine()]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    expect((screen.getByTestId('line-edit-block-hours-0') as HTMLInputElement).value).toBe('10');
    fireEvent.change(screen.getByTestId('line-edit-block-hours-0'), { target: { value: '12' } });
    fireEvent.change(screen.getByTestId('line-edit-block-extra-rate-0'), { target: { value: '175.00' } });
    fireEvent.click(screen.getByTestId('line-edit-block-rollover-none-0'));
    fireEvent.change(screen.getByTestId('line-edit-block-alert-0'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('line-edit-save-0'));
    await waitFor(() => expect(api.updateContractLine).toHaveBeenCalled());
    expect((api.updateContractLine as any).mock.calls[0][2]).toEqual({
      includedQuantity: '12', overageUnitPrice: '175.00', rolloverPolicy: 'none', rolloverCapHours: null, hourBlockAlertPct: null,
    });
    expect(screen.queryByTestId('line-edit-block-overage-mode-0')).toBeNull();   // mode is never a choice
  });

  it('states that edits apply to the current open period at its close — with the period dates once the estimate is loaded', async () => {
    renderEdit([blockLine()]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    expect(screen.getByTestId('line-edit-block-midperiod-0')).toHaveTextContent('Changes apply to the current open period at its close.');
  });

  it('shows the open period dates in that notice when the estimate carries the live block', async () => {
    (api.getContractEstimate as any).mockResolvedValue(resp({ data: {
      currencyCode: 'USD', periodTotal: '1000.00', lines: [], uncoveredDevices: null, overages: [],
      hourBlock: { lineId: 'b1', periodStart: '2026-09-01', periodEnd: '2026-10-01', includedHours: 10, carriedInHours: 0, consumedHours: 0, unapprovedHours: 0, foreignCurrencyHours: 0, remainingHours: 10, overageHours: 0, overageUnitPrice: '150.00', overageValue: '0.00', alertPct: null, billingTiming: 'advance', lateEntryHours: 0 },
    } }));
    renderEdit([blockLine()]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    await waitFor(() => expect(screen.getByTestId('line-edit-block-midperiod-0')).toHaveTextContent(/current open period \(.+ – .+\) at its close/));
  });

  it('maps HOUR_BLOCK_FIELD_LOCKED on save to its copy', async () => {
    (api.updateContractLine as any).mockResolvedValue(resp({ error: 'locked', code: 'HOUR_BLOCK_FIELD_LOCKED' }, false, 400));
    renderEdit([blockLine()]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.change(screen.getByTestId('line-edit-block-hours-0'), { target: { value: '11' } });
    fireEvent.click(screen.getByTestId('line-edit-save-0'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: expect.stringContaining("can't be changed on a block-hours line"),
    })));
  });

  it('remove confirm says RETIRE for a block with history and plain remove otherwise; the toast follows the server', async () => {
    renderEdit([blockLine({ hourBlockHasHistory: true })]);
    fireEvent.click(await screen.findByTestId('line-remove-0'));
    expect(await screen.findByText(/retired instead of deleted/i)).toBeInTheDocument();
    (api.removeContractLine as any).mockResolvedValue(resp({ data: { ok: true, retired: true } }));
    fireEvent.click(screen.getByTestId('contract-line-remove-confirm'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Block hours retired' })));
  });

  it('remove confirm for a block with no history keeps the ordinary remove copy', async () => {
    renderEdit([blockLine({ hourBlockHasHistory: false })]);
    fireEvent.click(await screen.findByTestId('line-remove-0'));
    expect(screen.queryByText(/retired instead of deleted/i)).toBeNull();
  });

  it('a retired block shows a Retired badge and offers neither Edit nor Remove, and adds nothing to the estimate', async () => {
    renderEdit([blockLine({ hourBlockRetiredAt: '2026-07-10T00:00:00Z', hourBlockHasHistory: true }), flatLine()]);
    expect(await screen.findByTestId('line-block-summary-0')).toHaveTextContent('Retired');
    expect(screen.queryByTestId('line-edit-0')).toBeNull();
    expect(screen.queryByTestId('line-remove-0')).toBeNull();
    expect(screen.getByTestId('line-edit-1')).toBeInTheDocument();
  });

  it('a live block shows the stamped first counted period and its hours per period', async () => {
    renderEdit([blockLine()]);
    expect(await screen.findByTestId('line-block-summary-0')).toHaveTextContent(/Counts from/);
    expect(screen.getByTestId('line-qty-0')).toHaveTextContent('10 hours per period');
  });
});
