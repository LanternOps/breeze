import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TicketWorkbench from './TicketWorkbench';
import { fetchWithAuth } from '../../stores/auth';
import { fetchTicketConfig, type TicketConfig } from '../../lib/ticketConfigApi';
import type { TicketDetail } from './ticketConfig';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

// Stub only fetchTicketConfig; the real display/grouping helpers run unchanged.
vi.mock('../../lib/ticketConfigApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/ticketConfigApi')>();
  return { ...actual, fetchTicketConfig: vi.fn().mockResolvedValue(null) };
});
const fetchConfigMock = vi.mocked(fetchTicketConfig);

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
  resolvedAt: null,
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
      fetchMock.mock.calls.filter(([url, init]) => init?.method === 'POST' && String(url).includes('/assign'))
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

  it('switching tickets with a non-zero refreshToken fetches the new ticket exactly once', async () => {
    mockTicketApiWithUsers({
      'tk-a': makeTicket({ id: 'tk-a', internalNumber: 'T-2026-0001' }),
      'tk-b': makeTicket({ id: 'tk-b', internalNumber: 'T-2026-0002' })
    });
    const { rerender } = render(<TicketWorkbench ticketId="tk-a" refreshToken={1} />);

    await screen.findByTestId('ticket-workbench');

    // j/k switch: only the ticketId changes; the token stays at its bumped value.
    rerender(<TicketWorkbench ticketId="tk-b" refreshToken={1} />);

    await waitFor(() => {
      expect(screen.getByTestId('ticket-workbench-number')).toHaveTextContent('T-2026-0002');
    });
    // Without the ref guard, the stale refreshToken effect re-fires on the new
    // load identity and double-fetches the ticket on every switch.
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/tickets/tk-b')).toHaveLength(1);
  });
});

/** Helper: ticket GETs succeed, but POST /tickets/:id/status fails with a 500. */
function mockTicketApiWithFailingStatus(detailById: Record<string, TicketDetail>) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/users') return makeJsonResponse({ data: [] });
    if (init?.method === 'POST' && /\/status$/.test(url)) {
      return makeJsonResponse({ error: 'boom' }, false, 500);
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

describe('TicketWorkbench forms keep input when the status POST fails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pending form stays open and retains the typed reason on a failed POST', async () => {
    mockTicketApiWithFailingStatus({ 'tk-1': makeTicket() });
    render(<TicketWorkbench ticketId="tk-1" />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'pending' } });
    fireEvent.change(screen.getByTestId('ticket-workbench-pending-reason'), {
      target: { value: 'Waiting on vendor' }
    });
    fireEvent.click(screen.getByTestId('ticket-workbench-pending-submit'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/tickets/tk-1/status', expect.objectContaining({ method: 'POST' }));
    });
    // Failure must NOT close the form or clear what the tech typed.
    expect(screen.getByTestId('ticket-workbench-pending-form')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-workbench-pending-reason')).toHaveValue('Waiting on vendor');
  });

  it('resolve form stays open and retains the typed note on a failed POST', async () => {
    mockTicketApiWithFailingStatus({ 'tk-1': makeTicket() });
    render(<TicketWorkbench ticketId="tk-1" />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'resolved' } });
    fireEvent.change(screen.getByTestId('ticket-workbench-resolve-note'), {
      target: { value: 'Replaced the toner cartridge.' }
    });
    fireEvent.click(screen.getByTestId('ticket-workbench-resolve-submit'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/tickets/tk-1/status', expect.objectContaining({ method: 'POST' }));
    });
    expect(screen.getByTestId('ticket-workbench-resolve-form')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-workbench-resolve-note')).toHaveValue('Replaced the toner cartridge.');
  });
});

describe('TicketWorkbench sticky composer across refreshes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the composer mounted (and its internal-note tab selected) across a refresh after send', async () => {
    // The first GET resolves immediately; the reload GET after send stays
    // pending until we release it, so the in-flight refresh state commits
    // (instant mocks never let the loading=true render reach the DOM).
    let releaseReload: (() => void) | null = null;
    let ticketGets = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/users') return makeJsonResponse({ data: [] });
      if ((!init?.method || init.method === 'GET') && url === '/tickets/tk-1') {
        ticketGets += 1;
        if (ticketGets === 1) return makeJsonResponse({ data: makeTicket() });
        return new Promise<Response>((resolve) => {
          releaseReload = () => resolve(makeJsonResponse({ data: makeTicket() }));
        });
      }
      return makeJsonResponse({ success: true });
    });

    render(<TicketWorkbench ticketId="tk-1" />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.click(screen.getByTestId('ticket-composer-tab-internal'));
    expect(screen.getByTestId('ticket-composer-tab-internal')).toHaveAttribute('aria-selected', 'true');

    fireEvent.change(screen.getByTestId('ticket-composer-input'), { target: { value: 'internal note body' } });
    fireEvent.click(screen.getByTestId('ticket-composer-send'));

    // Send landed and the reload GET is now in flight (held open by the mock).
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/comments',
        expect.objectContaining({ method: 'POST' })
      );
    });
    await waitFor(() => {
      expect(releaseReload).not.toBeNull();
    });

    // Mid-refresh: the skeleton must NOT replace the mounted tree.
    expect(screen.queryByTestId('ticket-workbench-loading')).toBeNull();
    expect(screen.getByTestId('ticket-composer-tab-internal')).toHaveAttribute('aria-selected', 'true');

    releaseReload!();

    // After the refresh settles the composer is still on the internal tab.
    await waitFor(() => {
      expect(screen.getByTestId('ticket-workbench')).not.toHaveAttribute('aria-busy');
    });
    expect(screen.getByTestId('ticket-composer-tab-internal')).toHaveAttribute('aria-selected', 'true');
  });

  it('switching tickets still shows the skeleton and resets the composer (no draft/mode leak)', async () => {
    mockTicketApiWithUsers({
      'tk-a': makeTicket({ id: 'tk-a', internalNumber: 'T-2026-0001' }),
      'tk-b': makeTicket({ id: 'tk-b', internalNumber: 'T-2026-0002' })
    });
    const { rerender } = render(<TicketWorkbench ticketId="tk-a" />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.click(screen.getByTestId('ticket-composer-tab-internal'));
    fireEvent.change(screen.getByTestId('ticket-composer-input'), { target: { value: 'draft for ticket A' } });

    rerender(<TicketWorkbench ticketId="tk-b" />);

    await waitFor(() => {
      expect(screen.getByTestId('ticket-workbench-number')).toHaveTextContent('T-2026-0002');
    });
    // Ticket B must not inherit ticket A's draft or internal mode.
    expect(screen.getByTestId('ticket-composer-input')).toHaveValue('');
    expect(screen.getByTestId('ticket-composer-tab-reply')).toHaveAttribute('aria-selected', 'true');
  });
});

describe('TicketWorkbench host-supplied assignees prop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the provided list and never self-fetches /users', async () => {
    mockTicketApi({ 'tk-1': makeTicket() });
    const provided = [{ id: 'u-7', name: 'Hosted Hank', email: 'hank@test.com' }];
    render(<TicketWorkbench ticketId="tk-1" assignees={provided} />);

    const select = await screen.findByTestId('ticket-workbench-assignee');
    expect(select).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Hosted Hank' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/users')).toHaveLength(0);
  });

  it('assignees={null} hides the picker (degraded mode) without fetching /users', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ assignedTo: 'u-9', assigneeName: 'Alice' }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={null} />);

    await screen.findByTestId('ticket-workbench-unassign');
    expect(screen.queryByTestId('ticket-workbench-assignee')).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/users')).toHaveLength(0);
  });
});

describe('TicketWorkbench optimistic updates & background reconcile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchConfigMock.mockResolvedValue(null);
  });

  /**
   * First detail GET resolves immediately; mutations succeed; the post-mutation
   * reconcile GET stays pending until released. Lets us assert the optimistic
   * value renders BEFORE the reconcile lands, and that no skeleton/aria-busy
   * appears during a background reconcile.
   */
  function mockWithHeldReconcile(initial: TicketDetail) {
    let releaseReload: (() => void) | null = null;
    let ticketGets = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/users') return makeJsonResponse({ data: [] });
      if ((!init?.method || init.method === 'GET') && url === `/tickets/${initial.id}`) {
        ticketGets += 1;
        if (ticketGets === 1) return makeJsonResponse({ data: initial });
        // Reconcile returns the UNCHANGED ticket — if the UI were reconcile-driven
        // (not optimistic) the select would revert once this resolves.
        return new Promise<Response>((resolve) => {
          releaseReload = () => resolve(makeJsonResponse({ data: initial }));
        });
      }
      return makeJsonResponse({ success: true });
    });
    return { release: () => releaseReload?.() };
  }

  it('reflects a status change immediately and reconciles in the background (no skeleton, not aria-busy)', async () => {
    mockWithHeldReconcile(makeTicket({ status: 'open' }));
    render(<TicketWorkbench ticketId="tk-1" />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'closed' } });

    // Optimistic: the controlled select shows the new value before the reconcile GET resolves.
    await waitFor(() => {
      expect(screen.getByTestId('ticket-workbench-status')).toHaveValue('closed');
    });
    // Background reconcile must not blank the pane with the skeleton or mark it busy.
    expect(screen.queryByTestId('ticket-workbench-loading')).toBeNull();
    expect(screen.getByTestId('ticket-workbench')).not.toHaveAttribute('aria-busy');
  });

  it('reflects a priority change immediately (optimistic, before reconcile)', async () => {
    const { release } = mockWithHeldReconcile(makeTicket({ priority: 'normal' }));
    render(<TicketWorkbench ticketId="tk-1" />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.change(screen.getByTestId('ticket-workbench-priority'), { target: { value: 'high' } });

    await waitFor(() => {
      expect(screen.getByTestId('ticket-workbench-priority')).toHaveValue('high');
    });
    expect(screen.getByTestId('ticket-workbench')).not.toHaveAttribute('aria-busy');
    release(); // the held reconcile (unchanged ticket) must NOT revert the optimistic value
    await waitFor(() => {
      expect(screen.getByTestId('ticket-workbench-priority')).toHaveValue('high');
    });
  });

  it('notifies the host of the optimistic row patch via onTicketPatched', async () => {
    mockWithHeldReconcile(makeTicket({ status: 'open' }));
    const onTicketPatched = vi.fn();
    render(<TicketWorkbench ticketId="tk-1" onTicketPatched={onTicketPatched} />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'closed' } });

    await waitFor(() => {
      expect(onTicketPatched).toHaveBeenCalledWith('tk-1', expect.objectContaining({ status: 'closed' }));
    });
  });
});

// ─── Custom statuses (config path) ───────────────────────────────────────────

const makeConfig = (overrides: Partial<TicketConfig> = {}): TicketConfig => ({
  statuses: [
    { id: 'st-new', name: 'New', coreStatus: 'new', color: null, sortOrder: 0, isSystem: true, isActive: true },
    { id: 'st-open', name: 'Open', coreStatus: 'open', color: null, sortOrder: 0, isSystem: true, isActive: true },
    { id: 'st-waiting', name: 'Waiting on customer', coreStatus: 'pending', color: '#ffaa00', sortOrder: 1, isSystem: false, isActive: true },
    { id: 'st-pending', name: 'Pending', coreStatus: 'pending', color: null, sortOrder: 0, isSystem: true, isActive: true },
    { id: 'st-hold', name: 'On hold', coreStatus: 'on_hold', color: null, sortOrder: 0, isSystem: true, isActive: true },
    { id: 'st-done', name: 'Done & verified', coreStatus: 'resolved', color: '#00aa55', sortOrder: 1, isSystem: false, isActive: true },
    { id: 'st-resolved', name: 'Resolved', coreStatus: 'resolved', color: null, sortOrder: 0, isSystem: true, isActive: true },
    { id: 'st-closed', name: 'Closed', coreStatus: 'closed', color: null, sortOrder: 0, isSystem: true, isActive: true }
  ],
  priorities: {
    urgent: { label: 'Urgent', responseSlaMinutes: null, resolutionSlaMinutes: null },
    high: { label: 'High', responseSlaMinutes: null, resolutionSlaMinutes: null },
    normal: { label: 'Normal', responseSlaMinutes: null, resolutionSlaMinutes: null },
    low: { label: 'Low', responseSlaMinutes: null, resolutionSlaMinutes: null }
  },
  ...overrides
});

describe('TicketWorkbench custom-status select (config path)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchConfigMock.mockResolvedValue(null);
  });

  it('renders optgroups from config and selecting a non-gated custom status posts {statusId}', async () => {
    fetchConfigMock.mockResolvedValue(makeConfig());
    mockTicketApi({ 'tk-1': makeTicket({ status: 'open' }) });
    render(<TicketWorkbench ticketId="tk-1" />);

    const select = await screen.findByTestId('ticket-workbench-status');
    // optgroups render once config resolves.
    await waitFor(() => {
      expect(select.querySelectorAll('optgroup').length).toBeGreaterThan(0);
    });
    expect(screen.getByRole('option', { name: 'Waiting on customer' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Done & verified' })).toBeInTheDocument();

    // Pick the built-in Closed row → posts statusId, never status.
    fireEvent.change(select, { target: { value: 'st-closed' } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/status',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ statusId: 'st-closed' }) })
      );
    });
  });

  it('picking a custom RESOLVED-core status opens the resolve form and submits {statusId, resolutionNote}', async () => {
    fetchConfigMock.mockResolvedValue(makeConfig());
    mockTicketApi({ 'tk-1': makeTicket({ status: 'open' }) });
    render(<TicketWorkbench ticketId="tk-1" />);

    const select = await screen.findByTestId('ticket-workbench-status');
    await waitFor(() => expect(select.querySelectorAll('optgroup').length).toBeGreaterThan(0));

    fireEvent.change(select, { target: { value: 'st-done' } });

    // Same resolve form as the core path; no mutation until the note submits.
    expect(screen.getByTestId('ticket-workbench-resolve-form')).toBeInTheDocument();
    expect(mutationCalls()).toHaveLength(0);

    fireEvent.change(screen.getByTestId('ticket-workbench-resolve-note'), {
      target: { value: 'Verified the fix.' }
    });
    fireEvent.click(screen.getByTestId('ticket-workbench-resolve-submit'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/status',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ statusId: 'st-done', resolutionNote: 'Verified the fix.' })
        })
      );
    });
  });

  it('picking a custom PENDING-core status opens the pending form and submits {statusId, pendingReason}', async () => {
    fetchConfigMock.mockResolvedValue(makeConfig());
    mockTicketApi({ 'tk-1': makeTicket({ status: 'open' }) });
    render(<TicketWorkbench ticketId="tk-1" />);

    const select = await screen.findByTestId('ticket-workbench-status');
    await waitFor(() => expect(select.querySelectorAll('optgroup').length).toBeGreaterThan(0));

    fireEvent.change(select, { target: { value: 'st-waiting' } });

    expect(screen.getByTestId('ticket-workbench-pending-form')).toBeInTheDocument();
    expect(mutationCalls()).toHaveLength(0);

    fireEvent.change(screen.getByTestId('ticket-workbench-pending-reason'), {
      target: { value: 'Awaiting reply' }
    });
    fireEvent.click(screen.getByTestId('ticket-workbench-pending-submit'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/status',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ statusId: 'st-waiting', pendingReason: 'Awaiting reply' })
        })
      );
    });
  });

  it('fallback path: with config null the select posts {status} (core enum), never statusId', async () => {
    fetchConfigMock.mockResolvedValue(null);
    mockTicketApi({ 'tk-1': makeTicket({ status: 'open' }) });
    render(<TicketWorkbench ticketId="tk-1" />);

    const select = await screen.findByTestId('ticket-workbench-status');
    // No optgroups in the fallback select.
    expect(select.querySelectorAll('optgroup')).toHaveLength(0);

    fireEvent.change(select, { target: { value: 'closed' } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/status',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ status: 'closed' }) })
      );
    });
  });

  it('current status display prefers statusName over the core label', async () => {
    fetchConfigMock.mockResolvedValue(makeConfig());
    mockTicketApi({ 'tk-1': makeTicket({ status: 'pending', statusName: 'Waiting on customer' }) });
    render(<TicketWorkbench ticketId="tk-1" />);

    const select = await screen.findByTestId('ticket-workbench-status') as HTMLSelectElement;
    await waitFor(() => expect(select.querySelectorAll('optgroup').length).toBeGreaterThan(0));
    // Selected option is the matching custom row.
    await waitFor(() => expect(select.value).toBe('st-waiting'));
  });

  it('cancelling the resolve form clears pendingStatusId so a subsequent `e` shortcut posts {status:resolved}', async () => {
    fetchConfigMock.mockResolvedValue(makeConfig());
    mockTicketApi({ 'tk-1': makeTicket({ status: 'open' }) });
    const { rerender } = render(<TicketWorkbench ticketId="tk-1" resolveRequestToken={0} />);

    const select = await screen.findByTestId('ticket-workbench-status');
    await waitFor(() => expect(select.querySelectorAll('optgroup').length).toBeGreaterThan(0));

    // Step 1: pick the custom resolved-core status → sets pendingStatusId='st-done', opens resolve form.
    fireEvent.change(select, { target: { value: 'st-done' } });
    expect(screen.getByTestId('ticket-workbench-resolve-form')).toBeInTheDocument();

    // Step 2: click Cancel → form closes, pendingStatusId must be cleared.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('ticket-workbench-resolve-form')).toBeNull();

    // Step 3: press `e` (resolveRequestToken increment) → reopens the resolve form.
    rerender(<TicketWorkbench ticketId="tk-1" resolveRequestToken={1} />);
    expect(screen.getByTestId('ticket-workbench-resolve-form')).toBeInTheDocument();

    // Step 4: submit with a note → must POST {status:'resolved'}, NOT {statusId:'st-done'}.
    fireEvent.change(screen.getByTestId('ticket-workbench-resolve-note'), {
      target: { value: 'Fixed it.' }
    });
    fireEvent.click(screen.getByTestId('ticket-workbench-resolve-submit'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/status',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ status: 'resolved', resolutionNote: 'Fixed it.' })
        })
      );
    });
    // Sanity: must NOT have posted statusId at all.
    const statusCalls = fetchMock.mock.calls.filter(
      ([url, init]) => init?.method === 'POST' && String(url).endsWith('/status')
    );
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0][1]?.body).not.toContain('statusId');
  });
});
