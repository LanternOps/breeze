import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InvoiceEditor from './InvoiceEditor';
import type { InvoiceDetail } from './invoiceTypes';
import { fetchWithAuth } from '../../stores/auth';

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
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function draft(lines: InvoiceDetail['lines'], extra: Partial<InvoiceDetail['invoice']> = {}): InvoiceDetail {
  return {
    invoice: {
      id: 'inv-1', invoiceNumber: null, orgId: 'org-1', siteId: null, status: 'draft',
      currencyCode: 'USD', issueDate: null, dueDate: null, sentAt: null, subtotal: '0.00', taxRate: null,
      taxTotal: '0.00', total: '0.00', amountPaid: '0.00', balance: '0.00', billToName: 'Acme',
      notes: '', termsAndConditions: null, sellerSnapshot: null, createdAt: '2026-06-01T00:00:00Z',
      ...extra,
    },
    lines,
  };
}

const manualLine: InvoiceDetail['lines'][number] = {
  id: 'line-1', invoiceId: 'inv-1', sourceType: 'manual', parentLineId: null, catalogItemId: null,
  name: null, description: 'Consulting', quantity: '2.00', unitPrice: '50.00', costBasis: null, revenueAllocation: null,
  taxable: false, customerVisible: true, lineTotal: '100.00', isUnapprovedTime: false, sortOrder: 1,
};

describe('InvoiceEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      return json({ data: {} });
    });
  });

  it('disables Issue when there are no customer-visible lines', async () => {
    render(<InvoiceEditor detail={draft([])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());
    expect(screen.getByTestId('invoice-issue')).toBeDisabled();
    expect(screen.getByTestId('invoice-issue-send')).toBeDisabled();
    expect(screen.getByTestId('invoice-no-visible-hint')).toBeInTheDocument();
  });

  it('enables Issue when a visible line exists and shows the total', async () => {
    render(<InvoiceEditor detail={draft([manualLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());
    expect(screen.getByTestId('invoice-issue')).not.toBeDisabled();
    expect(screen.getByTestId('invoice-line-line-1')).toHaveTextContent('Consulting');
  });

  it('warns when a line is taxable but no tax rate is configured', async () => {
    const taxable = { ...manualLine, taxable: true };
    const { rerender } = render(<InvoiceEditor detail={draft([taxable])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());
    expect(screen.getByTestId('invoice-tax-rate-hint')).toHaveTextContent('no tax rate is set');

    // Once a real rate exists the hint disappears (and the Tax row shows the percent).
    rerender(<InvoiceEditor detail={draft([taxable], { taxRate: '0.07', taxTotal: '7.00' })} onChanged={vi.fn()} />);
    expect(screen.queryByTestId('invoice-tax-rate-hint')).not.toBeInTheDocument();
  });

  it('adds a manual line and triggers a reload (onChanged)', async () => {
    const onChanged = vi.fn();
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1/lines' && opts?.method === 'POST') return json({ data: { id: 'line-2' } });
      return json({ data: {} });
    });
    render(<InvoiceEditor detail={draft([])} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    // Catalog is the default add mode now; switch to the manual line form.
    fireEvent.click(screen.getByTestId('invoice-add-mode-manual'));
    fireEvent.change(screen.getByTestId('invoice-manual-desc'), { target: { value: 'New work' } });
    fireEvent.change(screen.getByTestId('invoice-manual-qty'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('invoice-manual-price'), { target: { value: '20' } });
    fireEvent.click(screen.getByTestId('invoice-add-line-submit'));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const postCall = fetchMock.mock.calls.find((c) => c[0] === '/invoices/inv-1/lines');
    expect(postCall).toBeTruthy();
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toMatchObject({
      description: 'New work', quantity: 3, unitPrice: 20, taxable: false,
    });
  });

  it('adds a catalog item via the typeahead picker', async () => {
    const catItem = (over: Record<string, unknown>) => ({
      id: 'cat-1', partnerId: 'p1', itemType: 'service', name: 'Onboarding', sku: 'ONB-1',
      description: null, billingType: 'one_time', unitPrice: '500.00', costBasis: null,
      markupPercent: null, unitOfMeasure: 'each', taxable: true, taxCategory: null,
      isBundle: false, isActive: true, createdAt: '', updatedAt: '', ...over,
    });
    const onChanged = vi.fn();
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [catItem({}), catItem({ id: 'bun-1', name: 'Starter Bundle', isBundle: true })] });
      if (input === '/invoices/inv-1/lines/catalog' && opts?.method === 'POST') return json({ data: { id: 'line-9' } });
      return json({ data: {} });
    });
    render(<InvoiceEditor detail={draft([])} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    // Catalog is the default mode — search and pick via the typeahead.
    fireEvent.change(screen.getByTestId('invoice-catalog-picker-input'), { target: { value: 'Onb' } });
    fireEvent.click(await screen.findByTestId('invoice-catalog-picker-option-cat-1'));
    fireEvent.change(screen.getByTestId('invoice-pick-qty'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('invoice-catalog-add'));

    await waitFor(() => {
      const c = fetchMock.mock.calls.find((call) => call[0] === '/invoices/inv-1/lines/catalog');
      expect(c).toBeTruthy();
      expect(JSON.parse((c![1] as RequestInit).body as string)).toMatchObject({ catalogItemId: 'cat-1', quantity: 2 });
    });
  });

  it('renders the internal margin summary from line costs', async () => {
    const costedLine = { ...manualLine, id: 'line-c', costBasis: '30.00', quantity: '2.00', unitPrice: '50.00', lineTotal: '100.00' };
    render(<InvoiceEditor detail={draft([costedLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());
    // revenue 100 − cost (30×2 = 60) = 40 net.
    expect(screen.getByTestId('invoice-margin-cost')).toHaveTextContent('$60.00');
    expect(screen.getByTestId('invoice-margin-net-onetime')).toHaveTextContent('$40.00');
    expect(screen.queryByTestId('invoice-margin-net-monthly')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-margin-missing-cost')).not.toBeInTheDocument();
  });

  it('flags a missing cost in the margin summary', async () => {
    // manualLine has costBasis null → excluded from net and counted as missing.
    render(<InvoiceEditor detail={draft([manualLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());
    expect(screen.getByTestId('invoice-margin-missing-cost')).toHaveTextContent('1 line missing a cost');
  });

  it('flags unapproved-time lines with a warning banner', async () => {
    const unapproved = { ...manualLine, id: 'line-u', isUnapprovedTime: true };
    render(<InvoiceEditor detail={draft([unapproved])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-unapproved-warning')).toBeInTheDocument());
  });

  it('Issue & Send shows a success toast when the email was dispatched (emailed:true)', async () => {
    const onChanged = vi.fn();
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1/issue' && opts?.method === 'POST') return json({ data: { id: 'inv-1', status: 'sent' } });
      if (input === '/invoices/inv-1/send' && opts?.method === 'POST') return json({ data: { invoice: { id: 'inv-1', status: 'sent' }, emailed: true } });
      return json({ data: {} });
    });
    render(<InvoiceEditor detail={draft([manualLine])} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('invoice-issue-send'));
    fireEvent.click(await screen.findByTestId('invoice-issue-send-confirm'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Invoice issued and sent' }));
  });

  it('shows an "Issuing…" label on the Issue button while the mutation is in flight (#1418)', async () => {
    let resolveIssue: (r: Response) => void = () => {};
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1/issue' && opts?.method === 'POST') {
        return new Promise<Response>((res) => { resolveIssue = res; });
      }
      return json({ data: {} });
    });
    render(<InvoiceEditor detail={draft([manualLine])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('invoice-issue'));

    // In flight: button is disabled AND relabelled so it never reads as a stuck "Issue".
    await waitFor(() => expect(screen.getByTestId('invoice-issue')).toHaveTextContent('Issuing…'));
    expect(screen.getByTestId('invoice-issue')).toBeDisabled();

    resolveIssue(json({ data: { id: 'inv-1', status: 'sent' } }));
    await waitFor(() => expect(screen.getByTestId('invoice-issue')).toHaveTextContent('Issue'));
  });

  it('Issue & Send shows a WARNING toast (not error) when nothing was emailed (emailed:false)', async () => {
    const onChanged = vi.fn();
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1/issue' && opts?.method === 'POST') return json({ data: { id: 'inv-1', status: 'sent' } });
      if (input === '/invoices/inv-1/send' && opts?.method === 'POST') return json({ data: { invoice: { id: 'inv-1', status: 'sent' }, emailed: false, reason: 'no_billing_contact' } });
      return json({ data: {} });
    });
    render(<InvoiceEditor detail={draft([manualLine])} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('invoice-issue-send'));
    fireEvent.click(await screen.findByTestId('invoice-issue-send-confirm'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
    // never a success "sent" claim when nothing went out
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Invoice issued and sent' }));
  });

  it('editing the T&C textarea and blurring issues PATCH /invoices/:id with { termsAndConditions }', async () => {
    const onChanged = vi.fn();
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (input.startsWith('/catalog')) return json({ data: [] });
      if (input === '/invoices/inv-1' && opts?.method === 'PATCH') return json({ data: {} });
      return json({ data: {} });
    });
    render(<InvoiceEditor detail={draft([])} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('invoice-editor')).toBeInTheDocument());

    const textarea = screen.getByTestId('invoice-terms');
    fireEvent.change(textarea, { target: { value: 'Net 30' } });
    fireEvent.blur(textarea);

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        (c) => c[0] === '/invoices/inv-1' && (c[1] as RequestInit)?.method === 'PATCH',
      );
      expect(patchCall).toBeTruthy();
      expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toMatchObject({
        termsAndConditions: 'Net 30',
      });
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Terms saved' }));
  });
});
