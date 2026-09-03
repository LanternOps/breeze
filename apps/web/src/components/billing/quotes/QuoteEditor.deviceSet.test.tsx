import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteEditor from './QuoteEditor';
import { addManualLine } from '../../../lib/api/quotes';
import { fetchWithAuth } from '../../../stores/auth';

vi.mock('../../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(), fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) => selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../../lib/api/catalog', async (original) => ({
  ...(await original<typeof import('../../../lib/api/catalog')>()),
  listCatalog: vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ data: [] }) }),
}));
vi.mock('../../../lib/api/quotes', async (original) => ({
  ...(await original<typeof import('../../../lib/api/quotes')>()),
  addManualLine: vi.fn(),
}));

const ok = (data: unknown): Response => ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data }) }) as never;
const block = { id: 'b1', quoteId: 'q1', orgId: 'org1', blockType: 'line_items', content: {}, sortOrder: 0, createdAt: '' };
const quote = {
  id: 'q1', quoteNumber: null, partnerId: 'p1', orgId: 'org1', siteId: null, status: 'draft', currencyCode: 'USD',
  issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null, taxTotal: '0.00', total: '0.00',
  oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', billToName: null,
  introNotes: null, terms: null, termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
  convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null, createdBy: null, createdAt: '', updatedAt: '',
};
const line = (over: Record<string, unknown> = {}) => ({
  id: 'l1', quoteId: 'q1', blockId: 'b1', orgId: 'org1', sourceType: 'manual', catalogItemId: null,
  parentLineId: null, unitCost: null, sku: null, partNumber: null, name: 'Servers', description: null,
  quantity: '12.00', unitPrice: '40.00', taxable: false, customerVisible: true, lineTotal: '480.00',
  recurrence: 'monthly', termMonths: null, billingFrequency: null, sortOrder: 0, createdAt: '',
  contractLineType: 'per_device_role', deviceRoles: ['server'], deviceGroupId: null, deviceGroupName: null,
  siteId: null, siteName: null, includedQuantity: null, overageMode: null, overageUnitPrice: null,
  descriptorUnresolved: false, ...over,
});

function mount(lines: unknown[] = []) {
  return render(<QuoteEditor detail={{ quote, blocks: [block], lines } as never} onChanged={vi.fn()} />);
}

describe('QuoteEditor device-set lines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(addManualLine).mockResolvedValue(ok({}));
    vi.mocked(fetchWithAuth).mockImplementation(async (path) => {
      if (String(path).includes('device-set-estimate')) return ok([{ lineId: 'l1', counted: 15, billed: 15 }]);
      return ok([]);
    });
  });

  it('shows the descriptor block only for recurring lines and clears it on one-time', async () => {
    mount();
    fireEvent.click(screen.getByTestId('quote-block-add-line-toggle-b1'));
    fireEvent.click(screen.getByTestId('quote-line-mode-b1-manual'));
    expect(screen.queryByTestId('quote-manual-device-set-b1')).toBeNull();
    fireEvent.change(screen.getByTestId('quote-manual-recurrence-b1'), { target: { value: 'monthly' } });
    fireEvent.click(screen.getByTestId('quote-manual-device-set-toggle-b1'));
    expect(screen.getByTestId('quote-manual-device-set-type-b1')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('quote-manual-recurrence-b1'), { target: { value: 'one_time' } });
    expect(screen.queryByTestId('quote-manual-device-set-b1')).toBeNull();
    fireEvent.change(screen.getByTestId('quote-manual-recurrence-b1'), { target: { value: 'monthly' } });
    expect(screen.getByTestId('quote-manual-device-set-toggle-b1')).not.toBeChecked();
  });

  it('hides quantity, blocks incomplete descriptors, and omits quantity from create', async () => {
    mount();
    fireEvent.click(screen.getByTestId('quote-block-add-line-toggle-b1'));
    fireEvent.click(screen.getByTestId('quote-line-mode-b1-manual'));
    fireEvent.change(screen.getByTestId('quote-manual-name-b1'), { target: { value: 'Managed devices' } });
    fireEvent.change(screen.getByTestId('quote-manual-recurrence-b1'), { target: { value: 'monthly' } });
    fireEvent.click(screen.getByTestId('quote-manual-device-set-toggle-b1'));
    expect(screen.queryByTestId('quote-manual-qty-b1')).toBeNull();
    fireEvent.change(screen.getByTestId('quote-manual-device-set-type-b1'), { target: { value: 'per_device_role' } });
    expect(screen.getByTestId('quote-manual-add-b1')).toBeDisabled();
    fireEvent.change(screen.getByTestId('quote-manual-device-set-type-b1'), { target: { value: 'per_device' } });
    fireEvent.click(screen.getByTestId('quote-manual-add-b1'));
    await waitFor(() => expect(addManualLine).toHaveBeenCalled());
    expect(vi.mocked(addManualLine).mock.calls[0]![1]).not.toHaveProperty('quantity');
  });

  it('renders live-count drift and orphaned-reference chips', async () => {
    mount([
      line(),
      line({ id: 'l2', name: 'VIP', contractLineType: 'per_device_group', deviceRoles: null, deviceGroupName: 'VIP Laptops', descriptorUnresolved: true }),
    ]);
    expect(await screen.findByTestId('quote-line-device-set-drift-l1')).toHaveTextContent('12 → 15');
    expect(screen.getByTestId('quote-line-device-set-orphan-l2')).toHaveTextContent('VIP Laptops');
    expect(screen.queryByTestId('quote-line-qty-l1')).toBeNull();
  });

  it('uses the same canonical IoT and NAS nouns as customer renderers', async () => {
    mount([line({ deviceRoles: ['iot', 'nas'] })]);
    expect(await screen.findByTestId('quote-line-device-set-summary-l1')).toHaveTextContent('12 IoT devices, NAS devices');
  });

  it('uses fieldsets, legends, radios, and labelled inputs for both allowance editors', async () => {
    mount();
    fireEvent.click(screen.getByTestId('quote-block-add-line-toggle-b1'));
    fireEvent.click(screen.getByTestId('quote-line-mode-b1-manual'));
    fireEvent.change(screen.getByTestId('quote-manual-recurrence-b1'), { target: { value: 'monthly' } });
    fireEvent.click(screen.getByTestId('quote-manual-device-set-toggle-b1'));
    fireEvent.click(screen.getByTestId('quote-manual-device-set-allowance-b1'));

    const createAllowance = screen.getByTestId('quote-manual-device-set-allowance-group-b1');
    expect(createAllowance.tagName).toBe('FIELDSET');
    const createMode = within(createAllowance).getByRole('group', { name: 'Above the allowance' });
    expect(within(createMode).getByRole('radio', { name: 'Bill each extra unit' })).toBeChecked();
    expect(within(createMode).getByRole('radio', { name: 'Report for review' })).not.toBeChecked();
    expect(within(createAllowance).getByRole('spinbutton', { name: 'Included quantity' })).toBeInTheDocument();
    expect(within(createAllowance).getByRole('spinbutton', { name: 'Overage price' })).toBeInTheDocument();
  });

  it('uses the same allowance fieldset and radio semantics for an existing line', async () => {
    mount([line({ includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12' })]);
    const allowance = await screen.findByTestId('quote-line-device-set-allowance-l1');
    expect(allowance.tagName).toBe('FIELDSET');
    const mode = within(allowance).getByRole('group', { name: 'Above the allowance' });
    expect(within(mode).getByRole('radio', { name: 'Bill each extra unit' })).toBeChecked();
    expect(within(mode).getByRole('radio', { name: 'Report for review' })).not.toBeChecked();
    expect(within(allowance).getByRole('spinbutton', { name: 'Included quantity' })).toBeInTheDocument();
    expect(within(allowance).getByRole('spinbutton', { name: 'Overage price' })).toBeInTheDocument();
  });

  it('shows an inline error and manual runAction refresh when the live count check fails', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async (path, init) => {
      if (String(path).includes('device-set-estimate')) throw new Error('offline');
      return ok(init?.method === 'POST' ? {} : []);
    });
    mount([line()]);

    expect(await screen.findByTestId('quote-line-device-set-estimate-error-l1')).toHaveTextContent('Couldn’t check the live device count.');
    fireEvent.click(screen.getByTestId('quote-line-device-set-refresh-l1'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(
      '/quotes/q1/lines/refresh-device-counts',
      { method: 'POST' },
    ));
  });
});
