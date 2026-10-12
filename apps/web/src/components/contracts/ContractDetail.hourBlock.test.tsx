import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractDetail from './ContractDetail';
import * as api from '../../lib/api/contracts';
import type { ContractDetail as ContractDetailData } from '../../lib/api/contracts';

type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({ permissions: [] as Perm[] }));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) => selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return { ...actual, contractTransition: vi.fn(), generateContractInvoice: vi.fn(), getContractEstimate: vi.fn(), listContractHourPeriods: vi.fn() };
});

const resp = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const baseDetail: ContractDetailData = {
  autopayEnabled: false,
  contract: {
    autopayExcluded: false, id: 'ct-1', partnerId: 'p1', orgId: 'org-1', name: 'Acme MSA', status: 'active',
    billingTiming: 'advance', intervalMonths: 1, startDate: '2026-06-01', endDate: null, nextBillingAt: '2026-07-01',
    autoIssue: false, autoRenew: false, renewalTermMonths: null, renewalNoticeDays: null, currencyCode: 'USD',
    notes: null, terms: null, createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  lines: [], periods: [],
};
const blockLine = (p: Record<string, unknown> = {}) => ({
  id: 'b1', contractId: 'ct-1', orgId: 'org-1', lineType: 'hour_block', description: 'Support block',
  catalogItemId: null, unitPrice: '1000.00', manualQuantity: null, siteId: null, siteName: null, deviceRoles: null,
  deviceGroupId: null, deviceGroupName: null, deviceGroup: null, site: null, includedQuantity: '10.00',
  overageMode: 'bill', overageUnitPrice: '150.00', taxable: false, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
  rolloverPolicy: 'none', rolloverCapHours: null, hourBlockAlertPct: 80, hourBlockFirstPeriodStart: '2026-06-01',
  hourBlockRetiredAt: null, ...p,
}) as ContractDetailData['lines'][number];

const hb = (p: Record<string, unknown> = {}) => ({
  lineId: 'b1', periodStart: '2026-09-01', periodEnd: '2026-10-01', includedHours: 10, carriedInHours: 0,
  consumedHours: 6.5, unapprovedHours: 0, foreignCurrencyHours: 0, remainingHours: 3.5, overageHours: 0,
  overageUnitPrice: '150.00', overageValue: '0.00', alertPct: 80, billingTiming: 'advance', lateEntryHours: 0, ...p,
});
const estimateWith = (hourBlock: unknown) => resp({ data: {
  currencyCode: 'USD', periodTotal: '1000.00', uncoveredDevices: null, overages: [],
  lines: [{ lineId: 'b1', lineType: 'hour_block', quantity: 1, value: '1000.00', live: false, counted: 1, included: null, overage: 0, overageMode: null, overageValue: '0.00' }],
  hourBlock,
} });
const row = (i: number, over: Record<string, unknown> = {}) => ({
  id: `hp${i}`, contractLineId: 'b1', periodStart: `2026-0${i}-01`, periodEnd: `2026-0${i + 1}-01`,
  includedHours: '10.00', carriedInHours: '0.00', consumedHours: '12.00', overageHours: '2.00', carriedOutHours: '0.00',
  foreignCurrencyHours: '0.00', entryCount: 5, overageUnitPrice: '150.00', currencyCode: 'USD',
  overageInvoiceId: 'inv-1', closeSource: 'billing_run', closedAt: '2026-09-01T00:00:00Z', ...over,
});

describe('ContractDetail — block hours (#4547 W03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.permissions = [{ resource: 'contracts', action: 'manage' }];
    (api.listContractHourPeriods as any).mockResolvedValue(resp({ data: { items: [], nextCursor: null } }));
  });
  const renderDetail = (lines: ContractDetailData['lines'], hourBlock: unknown = null) => {
    (api.getContractEstimate as any).mockResolvedValue(estimateWith(hourBlock));
    return render(<ContractDetail detail={{ ...baseDetail, lines }} onChanged={vi.fn()} />);
  };

  it('renders nothing for a contract with no block line (and never fetches history)', async () => {
    renderDetail([]);
    await screen.findByTestId('contract-detail');
    expect(screen.queryByTestId('hour-block-panel')).toBeNull();
    expect(api.listContractHourPeriods).not.toHaveBeenCalled();
  });

  it('shows the usage bar: 6.5 of 10 used, 3.5 remaining, the period end, and a progressbar', async () => {
    renderDetail([blockLine()], hb());
    const usage = await screen.findByTestId('hour-block-usage');
    expect(usage).toHaveTextContent(/6\.5 of 10 hours used · 3\.5 remaining · period ends/);
    const bar = screen.getByTestId('hour-block-bar');
    expect(bar).toHaveAttribute('role', 'progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '6.5');
    expect(bar).toHaveAttribute('aria-valuemax', '10');
    expect(screen.queryByTestId('hour-block-over')).toBeNull();
  });

  it('opening balance includes carried-in hours and says so', async () => {
    renderDetail([blockLine()], hb({ carriedInHours: 3, includedHours: 10, consumedHours: 6.5, remainingHours: 6.5 }));
    expect(await screen.findByTestId('hour-block-usage')).toHaveTextContent(/6\.5 of 13 hours used/);
    expect(screen.getByTestId('hour-block-carried')).toHaveTextContent('3 hours carried forward');
  });

  it('over-block state: hours over, the money at period close, and the advance-billing note', async () => {
    renderDetail([blockLine()], hb({ consumedHours: 12, remainingHours: 0, overageHours: 2, overageValue: '300.00' }));
    const over = await screen.findByTestId('hour-block-over');
    expect(over).toHaveTextContent(/2 hours over the block/);
    expect(over).toHaveTextContent('300.00');
    expect(screen.getByTestId('hour-block-timing-note')).toHaveTextContent('following invoice');
  });

  it('an arrears contract says the overage is on THIS period\'s invoice instead', async () => {
    renderDetail([blockLine()], hb({ consumedHours: 12, remainingHours: 0, overageHours: 2, overageValue: '300.00', billingTiming: 'arrears' }));
    expect(await screen.findByTestId('hour-block-timing-note')).toHaveTextContent("this period's invoice");
  });

  it('shows the unapproved, foreign-currency and late-entry sub-figures only when non-zero', async () => {
    renderDetail([blockLine()], hb({ unapprovedHours: 1, foreignCurrencyHours: 1.5, lateEntryHours: 2 }));
    expect(await screen.findByTestId('hour-block-unapproved')).toHaveTextContent('1 hours');
    expect(screen.getByTestId('hour-block-foreign')).toHaveTextContent('1.5 hours');
    expect(screen.getByTestId('hour-block-late')).toHaveTextContent('2 hours');
    expect(screen.getByTestId('hour-block-extra-rate')).toHaveTextContent('150.00');
  });

  it('no sub-figures and no notes at zero', async () => {
    renderDetail([blockLine()], hb());
    await screen.findByTestId('hour-block-usage');
    for (const id of ['hour-block-unapproved', 'hour-block-foreign', 'hour-block-late', 'hour-block-carried', 'hour-block-over']) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  it('before the first counted period it says "Block starts <date>" instead of a 0-used bar', async () => {
    renderDetail([blockLine()], hb({ periodStart: '2999-01-01', periodEnd: '2999-02-01', consumedHours: 0, remainingHours: 10 }));
    expect(await screen.findByTestId('hour-block-starts-later')).toHaveTextContent(/^Block starts /);
    expect(screen.queryByTestId('hour-block-bar')).toBeNull();
    expect(screen.queryByTestId('hour-block-usage')).toBeNull();
    expect(screen.getByTestId('hour-block-extra-rate')).toBeInTheDocument();
  });

  it('a failed estimate shows the load-failed note without crashing the page', async () => {
    (api.getContractEstimate as any).mockResolvedValue(resp({}, false));
    render(<ContractDetail detail={{ ...baseDetail, lines: [blockLine()] }} onChanged={vi.fn()} />);
    expect(await screen.findByTestId('hour-block-load-failed')).toBeInTheDocument();
  });

  it('lists closed periods newest first with an invoice link, and loads more with the server cursor', async () => {
    (api.listContractHourPeriods as any)
      .mockResolvedValueOnce(resp({ data: { items: [row(3), row(2)], nextCursor: '2026-02-01|x' } }))
      .mockResolvedValueOnce(resp({ data: { items: [row(1, { overageInvoiceId: null, overageHours: '0.00' })], nextCursor: null } }));
    renderDetail([blockLine()], hb());
    const table = await screen.findByTestId('hour-block-history');
    await waitFor(() => expect(within(table).getAllByTestId(/^hour-block-history-row-/)).toHaveLength(2));
    expect(within(table).getByTestId('hour-block-history-row-hp3').querySelector('a[href="/billing/invoices/inv-1"]')).not.toBeNull();
    fireEvent.click(screen.getByTestId('hour-block-history-more'));
    await waitFor(() => expect(within(table).getAllByTestId(/^hour-block-history-row-/)).toHaveLength(3));
    expect((api.listContractHourPeriods as any).mock.calls[1][1]).toMatchObject({ cursor: '2026-02-01|x' });
    expect(screen.queryByTestId('hour-block-history-more')).toBeNull();
  });

  it('empty history and a failed history fetch are both explicit', async () => {
    renderDetail([blockLine()], hb());
    expect(await screen.findByTestId('hour-block-history-empty')).toBeInTheDocument();
    (api.listContractHourPeriods as any).mockResolvedValue(resp({}, false));
    const { unmount } = renderDetail([blockLine()], hb());
    unmount();
    renderDetail([blockLine()], hb());
    expect(await screen.findByTestId('hour-block-history-error')).toBeInTheDocument();
  });

  it('flags a closed period that had overage but lost its invoice, and shows a plain dash only when nothing was over', async () => {
    (api.listContractHourPeriods as any).mockResolvedValue(resp({ data: { items: [
      row(3, { overageInvoiceId: null, overageHours: '2.00' }),   // invoice removed: hours not billed
      row(2, { overageInvoiceId: null, overageHours: '0.00' }),   // nothing over: no invoice expected
      row(1),                                                       // invoiced
    ], nextCursor: null } }));
    renderDetail([blockLine()], hb());
    expect(await screen.findByTestId('hour-block-history-removed-hp3')).toHaveTextContent('Overage invoice removed — hours not billed');
    expect(screen.queryByTestId('hour-block-history-removed-hp2')).toBeNull();
    expect(screen.queryByTestId('hour-block-history-removed-hp1')).toBeNull();
  });

  it('a retired block still shows its history and a Retired badge in the lines table, with no live bar', async () => {
    (api.listContractHourPeriods as any).mockResolvedValue(resp({ data: { items: [row(1)], nextCursor: null } }));
    renderDetail([blockLine({ hourBlockRetiredAt: '2026-07-10T00:00:00Z' })], null);
    expect(await screen.findByTestId('hour-block-history')).toBeInTheDocument();
    expect(screen.queryByTestId('hour-block-bar')).toBeNull();
    expect(screen.getByTestId('contract-detail-line-b1')).toHaveTextContent('Retired');
  });
});
