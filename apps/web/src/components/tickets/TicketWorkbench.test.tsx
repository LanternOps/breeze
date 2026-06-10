import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TicketWorkbench from './TicketWorkbench';
import { fetchWithAuth } from '../../stores/auth';
import type { TicketDetail } from './ticketConfig';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const makeTicket = (overrides: Partial<TicketDetail> = {}): TicketDetail => ({
  id: 'tk-1',
  internalNumber: 'T-2026-0001',
  subject: 'Printer is down',
  status: 'open',
  priority: 'normal',
  source: 'portal',
  orgId: 'org-1',
  orgName: 'Acme Corp',
  deviceId: null,
  deviceHostname: null,
  assignedTo: null,
  assigneeName: null,
  categoryId: null,
  dueDate: null,
  slaBreachedAt: null,
  firstResponseAt: null,
  createdAt: '2026-06-01T10:00:00.000Z',
  updatedAt: '2026-06-01T10:00:00.000Z',
  description: null,
  submitterName: 'Pat',
  submitterEmail: null,
  pendingReason: null,
  resolutionNote: null,
  comments: [],
  alertLinks: [],
  ...overrides
});

/** Mock GET /tickets/:id for any ticket id; POST/PATCH mutations return {success:true}. */
function mockTicketApi(detailById: Record<string, TicketDetail>) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (!init?.method || init.method === 'GET') {
      const match = url.match(/^\/tickets\/([^/]+)$/);
      if (match && detailById[match[1]]) {
        return makeJsonResponse({ data: detailById[match[1]] });
      }
    }
    return makeJsonResponse({ success: true });
  });
}

const mutationCalls = () =>
  fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET');

describe('TicketWorkbench resolve-flow gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('selecting resolved opens the resolve form without firing any mutation', async () => {
    mockTicketApi({ 'tk-1': makeTicket() });
    render(<TicketWorkbench ticketId="tk-1" />);

    await screen.findByTestId('ticket-workbench');
    expect(screen.queryByTestId('ticket-workbench-resolve-form')).toBeNull();

    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'resolved' } });

    expect(screen.getByTestId('ticket-workbench-resolve-form')).toBeInTheDocument();
    expect(mutationCalls()).toHaveLength(0);
  });

  it('non-resolved status change posts immediately without the resolve form', async () => {
    mockTicketApi({ 'tk-1': makeTicket() });
    render(<TicketWorkbench ticketId="tk-1" />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'pending' } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/status',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ status: 'pending' }) })
      );
    });
    expect(screen.queryByTestId('ticket-workbench-resolve-form')).toBeNull();
  });

  it('resolve submit is disabled until a note is entered, then posts status+resolutionNote', async () => {
    mockTicketApi({ 'tk-1': makeTicket() });
    render(<TicketWorkbench ticketId="tk-1" />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'resolved' } });

    const submit = screen.getByTestId('ticket-workbench-resolve-submit');
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByTestId('ticket-workbench-resolve-note'), {
      target: { value: 'Replaced the toner cartridge.' }
    });
    expect(submit).not.toBeDisabled();

    fireEvent.click(submit);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/status',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ status: 'resolved', resolutionNote: 'Replaced the toner cartridge.' })
        })
      );
    });

    // Form closes after a successful resolve.
    await waitFor(() => {
      expect(screen.queryByTestId('ticket-workbench-resolve-form')).toBeNull();
    });
  });

  it('resolveRequestToken increment opens the resolve form', async () => {
    mockTicketApi({ 'tk-1': makeTicket() });
    const { rerender } = render(<TicketWorkbench ticketId="tk-1" resolveRequestToken={0} />);

    await screen.findByTestId('ticket-workbench');
    expect(screen.queryByTestId('ticket-workbench-resolve-form')).toBeNull();

    rerender(<TicketWorkbench ticketId="tk-1" resolveRequestToken={1} />);

    expect(screen.getByTestId('ticket-workbench-resolve-form')).toBeInTheDocument();
  });

  it('switching tickets closes the resolve form and clears the note', async () => {
    mockTicketApi({
      'tk-a': makeTicket({ id: 'tk-a', internalNumber: 'T-2026-0001', subject: 'Ticket A' }),
      'tk-b': makeTicket({ id: 'tk-b', internalNumber: 'T-2026-0002', subject: 'Ticket B' })
    });
    const { rerender } = render(<TicketWorkbench ticketId="tk-a" />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'resolved' } });
    fireEvent.change(screen.getByTestId('ticket-workbench-resolve-note'), {
      target: { value: 'Note meant for ticket A only' }
    });

    rerender(<TicketWorkbench ticketId="tk-b" />);

    await waitFor(() => {
      expect(screen.getByTestId('ticket-workbench-number')).toHaveTextContent('T-2026-0002');
    });
    expect(screen.queryByTestId('ticket-workbench-resolve-form')).toBeNull();

    // Re-open the form on ticket B: the note from ticket A must be gone.
    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'resolved' } });
    expect(screen.getByTestId('ticket-workbench-resolve-note')).toHaveValue('');
    expect(mutationCalls()).toHaveLength(0);
  });
});

describe('TicketWorkbench load errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('404 shows "Ticket not found" with a back link and no Retry button', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'Not found' }, false, 404));
    render(<TicketWorkbench ticketId="tk-gone" />);

    await screen.findByTestId('ticket-workbench-error');
    expect(screen.getByText(/Ticket not found/i)).toBeInTheDocument();
    const back = screen.getByTestId('ticket-workbench-back');
    expect(back).toHaveAttribute('href', '/tickets');
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('500 shows the load error with a Retry button', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'boom' }, false, 500));
    render(<TicketWorkbench ticketId="tk-1" />);

    await screen.findByTestId('ticket-workbench-error');
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByTestId('ticket-workbench-back')).toBeNull();
  });
});
