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

  it('non-resolved, non-gated status change (e.g. open→closed) posts immediately without any form', async () => {
    mockTicketApi({ 'tk-1': makeTicket() });
    render(<TicketWorkbench ticketId="tk-1" />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'closed' } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/status',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ status: 'closed' }) })
      );
    });
    expect(screen.queryByTestId('ticket-workbench-resolve-form')).toBeNull();
    expect(screen.queryByTestId('ticket-workbench-pending-form')).toBeNull();
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

  it('404 shows the updated not-found copy including access hint', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'Not found' }, false, 404));
    render(<TicketWorkbench ticketId="tk-gone" />);

    await screen.findByTestId('ticket-workbench-error');
    expect(screen.getByText(/may not have access to it/i)).toBeInTheDocument();
  });
});

/** Helper: mock ticket + /users with a given list of users (or fail the /users call). */
function mockTicketApiWithUsers(
  detailById: Record<string, TicketDetail>,
  users: Array<{ id: string; name: string | null; email: string }> | 'fail' = []
) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/users') {
      if (users === 'fail') return makeJsonResponse({ error: 'forbidden' }, false, 403);
      return makeJsonResponse({ data: users });
    }
    if (!init?.method || init.method === 'GET') {
      const match = url.match(/^\/tickets\/([^/]+)$/);
      if (match && detailById[match[1]]) {
        return makeJsonResponse({ data: detailById[match[1]] });
      }
    }
    return makeJsonResponse({ success: true });
  });
}

describe('TicketWorkbench assignee picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows an assignee select when /users succeeds; changing value POSTs /assign', async () => {
    const users = [{ id: 'u-9', name: 'Alice', email: 'alice@test.com' }];
    mockTicketApiWithUsers({ 'tk-1': makeTicket() }, users);
    render(<TicketWorkbench ticketId="tk-1" />);

    const select = await screen.findByTestId('ticket-workbench-assignee');
    expect(select).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'u-9' } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/assign',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ assigneeId: 'u-9' }) })
      );
    });
  });

  it('no-op guard: changing select to empty on unassigned ticket does NOT POST', async () => {
    const users = [{ id: 'u-9', name: 'Alice', email: 'alice@test.com' }];
    mockTicketApiWithUsers({ 'tk-1': makeTicket({ assignedTo: null }) }, users);
    render(<TicketWorkbench ticketId="tk-1" />);

    const select = await screen.findByTestId('ticket-workbench-assignee');
    // Ticket is unassigned (value=''); changing to '' is a no-op
    fireEvent.change(select, { target: { value: '' } });

    await new Promise((r) => setTimeout(r, 50));
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST' && String(fetchMock.mock.calls[0][0]).includes('/assign'))
    ).toHaveLength(0);
  });

  it('changing select to empty on an assigned ticket POSTs assigneeId null', async () => {
    const users = [{ id: 'u-9', name: 'Alice', email: 'alice@test.com' }];
    mockTicketApiWithUsers({ 'tk-1': makeTicket({ assignedTo: 'u-9', assigneeName: 'Alice' }) }, users);
    render(<TicketWorkbench ticketId="tk-1" />);

    const select = await screen.findByTestId('ticket-workbench-assignee');
    fireEvent.change(select, { target: { value: '' } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/assign',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ assigneeId: null }) })
      );
    });
  });

  it('RLS-invisible assignee shows a redacted "MSP staff" option', async () => {
    // Ticket has assignedTo='partner-u' but /users does not include that id
    const users = [{ id: 'u-9', name: 'Alice', email: 'alice@test.com' }];
    mockTicketApiWithUsers(
      { 'tk-1': makeTicket({ assignedTo: 'partner-u', assigneeName: null }) },
      users
    );
    render(<TicketWorkbench ticketId="tk-1" />);

    await screen.findByTestId('ticket-workbench-assignee');
    expect(screen.getByRole('option', { name: 'MSP staff' })).toBeInTheDocument();
  });

  it('/users failure on assigned ticket: degraded unassign button works', async () => {
    mockTicketApiWithUsers({ 'tk-1': makeTicket({ assignedTo: 'u-9', assigneeName: 'Alice' }) }, 'fail');
    render(<TicketWorkbench ticketId="tk-1" />);

    const unassignBtn = await screen.findByTestId('ticket-workbench-unassign');
    expect(unassignBtn).toBeInTheDocument();
    expect(screen.queryByTestId('ticket-workbench-assignee')).toBeNull();

    fireEvent.click(unassignBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/assign',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ assigneeId: null }) })
      );
    });
  });

  it('/users failure on unassigned ticket: plain "Unassigned" span, no POST possible', async () => {
    mockTicketApiWithUsers({ 'tk-1': makeTicket({ assignedTo: null }) }, 'fail');
    render(<TicketWorkbench ticketId="tk-1" />);

    const span = await screen.findByTestId('ticket-workbench-unassigned');
    expect(span).toBeInTheDocument();
    expect(screen.queryByTestId('ticket-workbench-assignee')).toBeNull();
    expect(screen.queryByTestId('ticket-workbench-unassign')).toBeNull();
  });
});

describe('TicketWorkbench pending/on_hold prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('choosing pending does not POST immediately; pending form appears', async () => {
    mockTicketApiWithUsers({ 'tk-1': makeTicket() });
    render(<TicketWorkbench ticketId="tk-1" />);

    await screen.findByTestId('ticket-workbench');
    expect(screen.queryByTestId('ticket-workbench-pending-form')).toBeNull();

    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'pending' } });

    expect(screen.getByTestId('ticket-workbench-pending-form')).toBeInTheDocument();
    expect(mutationCalls()).toHaveLength(0);
  });

  it('pending submit with reason POSTs {status:pending, pendingReason}', async () => {
    mockTicketApiWithUsers({ 'tk-1': makeTicket() });
    render(<TicketWorkbench ticketId="tk-1" />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'pending' } });

    fireEvent.change(screen.getByTestId('ticket-workbench-pending-reason'), {
      target: { value: 'Waiting on vendor' },
    });
    fireEvent.click(screen.getByTestId('ticket-workbench-pending-submit'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/status',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ status: 'pending', pendingReason: 'Waiting on vendor' }),
        })
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId('ticket-workbench-pending-form')).toBeNull();
    });
  });

  it('pending submit with empty reason POSTs {status:pending} only (no pendingReason key)', async () => {
    mockTicketApiWithUsers({ 'tk-1': makeTicket() });
    render(<TicketWorkbench ticketId="tk-1" />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'pending' } });
    fireEvent.click(screen.getByTestId('ticket-workbench-pending-submit'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/status',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ status: 'pending' }),
        })
      );
    });
  });

  it('on_hold opens the same pending form with "Put on hold" button label', async () => {
    mockTicketApiWithUsers({ 'tk-1': makeTicket() });
    render(<TicketWorkbench ticketId="tk-1" />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'on_hold' } });

    expect(screen.getByTestId('ticket-workbench-pending-form')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-workbench-pending-submit')).toHaveTextContent('Put on hold');
  });
});

describe('TicketWorkbench rail and resolution note visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolutionNote is NOT shown when status is open', async () => {
    mockTicketApiWithUsers({
      'tk-1': makeTicket({ status: 'open', resolutionNote: 'Fixed the thing' }),
    });
    render(<TicketWorkbench ticketId="tk-1" />);

    await screen.findByTestId('ticket-workbench-rail');
    expect(screen.queryByText('Fixed the thing')).toBeNull();
  });

  it('resolutionNote IS shown when status is resolved', async () => {
    mockTicketApiWithUsers({
      'tk-1': makeTicket({ status: 'resolved', resolutionNote: 'Fixed the thing' }),
    });
    render(<TicketWorkbench ticketId="tk-1" />);

    await screen.findByTestId('ticket-workbench-rail');
    expect(screen.getByText('Fixed the thing')).toBeInTheDocument();
  });
});

describe('TicketWorkbench refreshToken prop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bumping refreshToken refetches the ticket detail', async () => {
    mockTicketApiWithUsers({ 'tk-1': makeTicket() });
    const { rerender } = render(<TicketWorkbench ticketId="tk-1" refreshToken={0} />);

    await screen.findByTestId('ticket-workbench');
    const initialFetchCount = fetchMock.mock.calls.filter(([url]) => String(url) === '/tickets/tk-1').length;

    rerender(<TicketWorkbench ticketId="tk-1" refreshToken={1} />);

    await waitFor(() => {
      const newCount = fetchMock.mock.calls.filter(([url]) => String(url) === '/tickets/tk-1').length;
      expect(newCount).toBeGreaterThan(initialFetchCount);
    });
  });
});
