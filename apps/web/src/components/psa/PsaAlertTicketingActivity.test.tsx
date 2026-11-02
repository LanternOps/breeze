import '@/lib/i18n';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PsaAlertTicketingActivity from './PsaAlertTicketingActivity';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const rows = [
  { id: 'm1', alertId: 'a1', createState: 'needs_attention', lastError: 'Outcome uncertain', createAnywayUsed: false },
  { id: 'm2', alertId: 'a2', createState: 'failed', lastError: 'Deadline elapsed' },
  { id: 'm3', alertId: 'a3', createState: 'skipped_no_company', lastError: null },
];
function install(status = 200) {
  fetchMock.mockImplementation(async (_url, init) => init?.method === 'POST'
    ? json(status === 200 ? { data: {} } : { error: 'State changed; reload' }, status)
    : json({ data: rows, counts: { created: 42, needs_attention: 1, failed: 1, skipped_no_company: 1 }, pagination: { total: 3, page: 1, limit: 20 } }));
}

describe('PsaAlertTicketingActivity', () => {
  beforeEach(() => { vi.clearAllMocks(); install(); });
  it('loads connection-scoped failures and total state counts', async () => {
    render(<PsaAlertTicketingActivity connectionId="c1" canManage />);
    expect(await screen.findByText('Outcome uncertain')).toBeInTheDocument();
    expect(screen.getByTestId('psa-ticketing-count-created')).toHaveTextContent('42');
    const url = new URL(fetchMock.mock.calls[0][0], 'https://example.test');
    expect(url.searchParams.get('connectionId')).toBe('c1');
    expect(url.searchParams.get('createState')).toBe('failed,skipped_no_company,needs_attention');
    expect(url.searchParams.get('includeCounts')).toBe('true');
    expect(screen.queryByTestId('psa-ticketing-create-anyway-m2')).not.toBeInTheDocument();
    expect(screen.getByTestId('psa-ticketing-alert-m1')).toHaveAttribute('href', '/alerts/a1');
  });
  it('re-drives only failed and missing-company states and refreshes', async () => {
    render(<PsaAlertTicketingActivity connectionId="c1" canManage />);
    await userEvent.click(await screen.findByTestId('psa-ticketing-redrive'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/psa/connections/c1/alert-ticketing/redrive', expect.objectContaining({ method: 'POST', body: JSON.stringify({ states: ['failed', 'skipped_no_company'] }) })));
    expect(fetchMock.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2);
  });
  it('requires duplicate-risk confirmation before create anyway', async () => {
    render(<PsaAlertTicketingActivity connectionId="c1" canManage />);
    await userEvent.click(await screen.findByTestId('psa-ticketing-create-anyway-m1'));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(screen.getByRole('alert')).toHaveTextContent('duplicate');
    await userEvent.click(screen.getByTestId('psa-ticketing-confirm-create-m1'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/psa/ticket-mappings/m1/create-anyway', expect.objectContaining({ method: 'POST' })));
  });
  it('marks the displayed expected state handled, without a remote action', async () => {
    render(<PsaAlertTicketingActivity connectionId="c1" canManage />);
    await userEvent.click(await screen.findByTestId('psa-ticketing-mark-handled-m2'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/psa/ticket-mappings/m2/mark-handled', expect.objectContaining({ method: 'POST', body: JSON.stringify({ expectedState: 'failed' }) })));
  });
  it('hides write controls for read-only viewers and consumed create-anyway grants', async () => {
    const { rerender } = render(<PsaAlertTicketingActivity connectionId="c1" canManage={false} />);
    await screen.findByText('Outcome uncertain');
    expect(screen.queryByTestId('psa-ticketing-redrive')).not.toBeInTheDocument();
    expect(screen.queryByTestId('psa-ticketing-mark-handled-m1')).not.toBeInTheDocument();
    fetchMock.mockResolvedValue(json({ data: [{ ...rows[0], createAnywayUsed: true }], counts: {}, pagination: { total: 1, page: 1, limit: 20 } }));
    rerender(<PsaAlertTicketingActivity connectionId="c2" canManage />);
    await waitFor(() => expect(screen.queryByTestId('psa-ticketing-create-anyway-m1')).not.toBeInTheDocument());
  });
  it('toasts conflicts once and refreshes the stale row', async () => {
    install(409);
    render(<PsaAlertTicketingActivity connectionId="c1" canManage />);
    await userEvent.click(await screen.findByTestId('psa-ticketing-mark-handled-m2'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'State changed; reload' })));
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2);
  });
  it('shows a recoverable load failure and an honest empty state', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Offline'));
    fetchMock.mockResolvedValue(json({ data: [], counts: {}, pagination: { total: 0, page: 1, limit: 20 } }));
    render(<PsaAlertTicketingActivity connectionId="c1" canManage />);
    await userEvent.click(await screen.findByTestId('psa-ticketing-refresh'));
    expect(await screen.findByTestId('psa-ticketing-empty')).toBeInTheDocument();
  });
  it('paginates the failure list without changing the connection or state filter', async () => {
    fetchMock.mockImplementation(async () => json({ data: rows, counts: { failed: 23 }, pagination: { total: 23, page: 1, limit: 20 } }));
    render(<PsaAlertTicketingActivity connectionId="c1" canManage />);
    await userEvent.click(await screen.findByTestId('psa-ticketing-next'));
    await waitFor(() => expect(fetchMock.mock.calls.at(-1)?.[0]).toContain('page=2'));
  });
  it('returns to an available page when handling the last row shrinks pagination', async () => {
    let handled = false;
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === 'POST') { handled = true; return json({ data: {} }); }
      const page = Number(new URL(url, 'https://example.test').searchParams.get('page'));
      return json({ data: handled && page === 2 ? [] : [rows[1]], counts: { failed: handled ? 20 : 21 }, pagination: { total: handled ? 20 : 21, page, limit: 20 } });
    });
    render(<PsaAlertTicketingActivity connectionId="c1" canManage />);
    await userEvent.click(await screen.findByTestId('psa-ticketing-next'));
    await waitFor(() => expect(fetchMock.mock.calls.at(-1)?.[0]).toContain('page=2'));
    await userEvent.click(await screen.findByTestId('psa-ticketing-mark-handled-m2'));
    await waitFor(() => expect(fetchMock.mock.calls.at(-1)?.[0]).toContain('page=1'));
    expect(await screen.findByText('Deadline elapsed')).toBeInTheDocument();
  });
});
