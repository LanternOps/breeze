import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import AutopayListPage from './AutopayListPage';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchWithAuth).mockImplementation(async (_url, init) => Response.json(init?.method === 'POST'
    ? { requested: [], skipped: [{ orgId: id, reason: 'no_billing_contact' }] }
    : { data: [{ orgId: id, orgName: 'Example client', billingContact: null, status: 'not_requested', enrollment: null, method: null }], notRequestedCount: 1 }));
});
it('does not label all-skipped bulk failure as success and retains per-org reason', async () => {
  render(<AutopayListPage />);
  fireEvent.click(await screen.findByTestId('autopay-send-now'));
  expect(await screen.findByTestId('autopay-bulk-result')).toHaveTextContent('No billing contact email is available');
  expect(vi.mocked(showToast).mock.calls.some(([toast]) => toast.type === 'success')).toBe(false);
  const call = vi.mocked(fetchWithAuth).mock.calls.find(([, i]) => i?.method === 'POST')!;
  expect(JSON.parse(call[1]!.body as string)).toEqual({ orgIds: [id] });
});
it('dismisses only the local prompt and never sends a request', async () => {
  render(<AutopayListPage />);
  fireEvent.click(await screen.findByTestId('autopay-dismiss'));
  expect(screen.queryByTestId('autopay-unasked')).toBeNull();
  expect(vi.mocked(fetchWithAuth).mock.calls.every(([, i]) => !i?.method)).toBe(true);
});

it('does not label partial bulk failure as success and shows both requested count and skipped client reason', async () => {
  const requestedId = '22222222-2222-4222-8222-222222222222';
  vi.mocked(fetchWithAuth).mockImplementation(async (_url, init) => Response.json(init?.method === 'POST'
    ? { requested: [requestedId], skipped: [{ orgId: id, reason: 'no_billing_contact' }] }
    : { data: [
      { orgId: id, orgName: 'Skipped client', billingContact: null, status: 'not_requested', enrollment: null, method: null },
      { orgId: requestedId, orgName: 'Requested client', billingContact: { email: 'billing@example.test' }, status: 'not_requested', enrollment: null, method: null },
    ], notRequestedCount: 2 }));
  render(<AutopayListPage />);
  fireEvent.click(await screen.findByTestId('autopay-send-now'));
  const result = await screen.findByTestId('autopay-bulk-result');
  expect(result).toHaveAttribute('role','alert');
  expect(result).toHaveTextContent('Request sent to 1 client.');
  expect(result).toHaveTextContent('Skipped client: No billing contact email is available');
  expect(vi.mocked(showToast).mock.calls.some(([toast]) => toast.type === 'success')).toBe(false);
  const call = vi.mocked(fetchWithAuth).mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(JSON.parse(call[1]!.body as string)).toEqual({ orgIds: [id, requestedId] });
});
it('shows failed email delivery on the list and allows resending',async()=>{
 vi.mocked(fetchWithAuth).mockImplementation(async()=>Response.json({data:[{orgId:id,orgName:'Example',status:'requested',enrollment:{status:'requested'},method:null,requestNoticeStatus:'failed'}]}));
 render(<AutopayListPage/>);
 expect(await screen.findByTestId(`autopay-delivery-${id}`)).toHaveTextContent('Request email could not be delivered');
 expect(screen.getByTestId(`autopay-resend-${id}`)).toBeEnabled();
});

it.each(['processing','failed'])('shows the last %s charge and aged notice on the real list',async state=>{
 vi.mocked(fetchWithAuth).mockResolvedValue(Response.json({data:[{orgId:id,orgName:'Example',status:'active',enrollment:{status:'active'},method:null,
 lastCharge:{state,createdAt:'2026-10-01T00:00:00Z',principalAmount:'100.00',currency:'USD'},
 awaitingNotice:{count:1,oldestCreatedAt:'2026-09-30T00:00:00Z',reason:'delivery_failed',invoiceId:'inv-1'}}]}));
 render(<AutopayListPage/>);expect(await screen.findByTestId('autopay-last-charge')).toHaveTextContent(state==='processing'?'Processing':'Failed');
 expect(screen.getByTestId('autopay-notice-stuck')).toHaveAttribute('href','/billing/invoices/inv-1');
});

const activeRow = { orgId: id, orgName: 'Example client', billingContact: { email: 'billing@example.test' }, status: 'not_requested',
  enrollment: null, requestNoticeStatus: 'failed',
  method: { type: 'card', cardBrand: 'visa', cardFunding: 'credit', cardLast4: '4242', cardExpMonth: 12, cardExpYear: 2031, bankName: null, bankLast4: null, status: 'active' },
  lastCharge: { state: 'succeeded', createdAt: '2026-10-01T00:00:00Z', principalAmount: '100.00', currency: 'USD' },
  awaitingNotice: { count: 1, oldestCreatedAt: '2026-09-30T00:00:00Z', reason: 'delivery_failed', invoiceId: 'inv-1' } };
it('renders inside the dashboard layout without a second <main>', async () => {
  const { container } = render(<AutopayListPage />);
  await screen.findByTestId('autopay-list');
  expect(container.querySelector('main')).toBeNull();
  expect(screen.getByRole('heading', { level: 1, name: 'Automatic payment' })).toHaveAttribute('data-testid', 'autopay-heading');
});
it('stacks each client as a card at phone width with the same facts and actions as the table row', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async (_url, init) => Response.json(init?.method === 'POST'
    ? { requested: [id], skipped: [] } : { data: [activeRow] }));
  render(<AutopayListPage />);
  const desktop = await screen.findByTestId('responsive-table-desktop');
  expect(within(desktop).getByTestId('autopay-table')).toBeInTheDocument();
  const card = within(screen.getByTestId('responsive-table-cards')).getByTestId(`autopay-card-${id}`);
  expect(card).toHaveTextContent('Example client');
  expect(card).toHaveTextContent('Not requested');
  expect(card).toHaveTextContent('Visa ••4242 12/2031');
  expect(card).toHaveTextContent('Payment received');
  expect(within(card).getByTestId(`autopay-card-notice-stuck-${id}`)).toHaveAttribute('href', '/billing/invoices/inv-1');
  expect(within(card).getByTestId(`autopay-card-delivery-${id}`)).toHaveTextContent('Request email could not be delivered');
  // Selecting on the card selects the same client the table row does.
  fireEvent.click(within(card).getByTestId(`autopay-card-select-${id}`));
  expect(screen.getByTestId(`autopay-select-${id}`)).toBeChecked();
  fireEvent.click(screen.getByTestId('autopay-bulk-send'));
  await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
  const call = vi.mocked(fetchWithAuth).mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(JSON.parse(call[1]!.body as string)).toEqual({ orgIds: [id] });
});
it('uses the styled autopay buttons', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async () => Response.json({ data: [activeRow] }));
  render(<AutopayListPage />);
  expect(await screen.findByTestId('autopay-bulk-send')).toHaveClass('bg-primary');
  expect(screen.getByTestId('autopay-send-now')).toHaveClass('bg-primary');
  expect(screen.getByTestId('autopay-dismiss')).toHaveClass('border');
  expect(screen.getByTestId(`autopay-resend-${id}`)).toHaveClass('border');
  expect(screen.getByTestId(`autopay-card-resend-${id}`)).toHaveClass('border');
});
