import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TicketWorkbench from './TicketWorkbench';
import { fetchWithAuth } from '../../stores/auth';
import { fetchTicketConfig, type TicketConfig } from '../../lib/ticketConfigApi';
import type { TicketDetail } from './ticketConfig';

// Mutable grant set read by usePermissions() (via the selector form). Delete is
// tickets:manage-gated; most tests run without it, delete tests opt in.
type Perm = { resource: string; action: string };
const authState = vi.hoisted(() => ({ permissions: [] as Perm[] }));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  // Selector hook stub — the composer reads the signed-in agent's name for the
  // {{agent_name}} canned-response variable; usePermissions reads user.permissions.
  useAuthStore: (selector: (s: { user: { name: string; permissions: Perm[] } | null }) => unknown) =>
    selector({ user: { name: 'Test Agent', permissions: authState.permissions } })
}));

// Stub only fetchTicketConfig; the real display/grouping helpers run unchanged.
// Capture the props the rail hands the parts card (#3775: the ticket org's currency).
const partsCardProps = vi.hoisted(() => ({ last: null as null | { ticketId: string; currencyCode?: string } }));
vi.mock('./TicketPartsCard', () => ({
  default: (p: { ticketId: string; currencyCode?: string }) => { partsCardProps.last = p; return <div data-testid="ticket-parts-card-stub" />; },
}));

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
  tags: [],
  slaBreachedAt: null,
  firstResponseAt: null,
  createdAt: '2026-06-01T10:00:00.000Z',
  updatedAt: '2026-06-01T10:00:00.000Z',
  description: null,
  submittedBy: null,
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

// Reset the grant set before every test (some opt into tickets:manage).
beforeEach(() => { authState.permissions = []; });

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

describe('TicketWorkbench ML triage suggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders suggested priority/category and applies it through runAction', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/tickets/tk-1' && (!init?.method || init.method === 'GET')) {
        return makeJsonResponse({ data: makeTicket({ id: 'tk-1', priority: 'normal', categoryId: null }) });
      }
      if (url === '/tickets/tk-1/triage-suggestion' && (!init?.method || init.method === 'GET')) {
        return makeJsonResponse({
          enabled: true,
          flagSource: 'org_settings',
          suggestion: {
            modelVersion: 'ticket-triage-rules-v0',
            confidence: 0.72,
            priority: 'high',
            categoryId: 'cat-hardware',
            categoryName: 'Hardware',
            reasons: ['high-impact keywords', 'matched Hardware'],
          },
        });
      }
      return makeJsonResponse({ success: true });
    });

    render(
      <TicketWorkbench
        ticketId="tk-1"
        assignees={[]}
        categories={[{ id: 'cat-hardware', name: 'Hardware' }]}
      />,
    );

    await screen.findByTestId('ticket-triage-suggestion');
    expect(screen.getByText(/Priority: High/i)).toBeInTheDocument();
    expect(screen.getByText(/Category: Hardware/i)).toBeInTheDocument();
    expect(screen.getByTestId('ticket-triage-reasons')).toBeInTheDocument();
    expect(screen.getByText('high-impact keywords')).toBeInTheDocument();
    expect(screen.getByText('matched Hardware')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ticket-triage-apply'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/triage-suggestion/apply',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ categoryId: 'cat-hardware', priority: 'high' }),
        }),
      );
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'success',
      message: 'Ticket triage suggestion applied',
    }));
  });

  it('lets a tech override the ticket category from the workbench', async () => {
    mockTicketApi({
      'tk-1': makeTicket({ id: 'tk-1', categoryId: 'cat-hardware' }),
    });

    render(
      <TicketWorkbench
        ticketId="tk-1"
        assignees={[]}
        categories={[
          { id: 'cat-hardware', name: 'Hardware' },
          { id: 'cat-network', name: 'Network' },
        ]}
      />,
    );

    const categorySelect = await screen.findByTestId('ticket-workbench-category');
    expect(categorySelect).toHaveValue('cat-hardware');

    fireEvent.change(categorySelect, { target: { value: 'cat-network' } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ categoryId: 'cat-network' }),
        }),
      );
    });
  });

  it('records explicit rejection feedback for a triage suggestion', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/tickets/tk-1' && (!init?.method || init.method === 'GET')) {
        return makeJsonResponse({ data: makeTicket({ id: 'tk-1', priority: 'normal', categoryId: null }) });
      }
      if (url === '/tickets/tk-1/triage-suggestion' && (!init?.method || init.method === 'GET')) {
        return makeJsonResponse({
          enabled: true,
          flagSource: 'org_settings',
          suggestion: {
            modelVersion: 'ticket-triage-rules-v0',
            confidence: 0.72,
            priority: 'high',
            categoryId: 'cat-hardware',
            categoryName: 'Hardware',
            reasons: ['matched Hardware'],
          },
        });
      }
      return makeJsonResponse({ success: true });
    });

    render(
      <TicketWorkbench
        ticketId="tk-1"
        assignees={[]}
        categories={[{ id: 'cat-hardware', name: 'Hardware' }]}
      />,
    );

    await screen.findByTestId('ticket-triage-suggestion');
    fireEvent.click(screen.getByTestId('ticket-triage-reject'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/triage-suggestion/reject',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({}),
        }),
      );
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'success',
      message: 'Ticket triage feedback saved',
    }));
    await waitFor(() => {
      expect(screen.queryByTestId('ticket-triage-suggestion')).toBeNull();
    });
  });

  it('hides the suggestion strip when triage is disabled', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/tickets/tk-1' && (!init?.method || init.method === 'GET')) {
        return makeJsonResponse({ data: makeTicket({ id: 'tk-1' }) });
      }
      if (url === '/tickets/tk-1/triage-suggestion' && (!init?.method || init.method === 'GET')) {
        return makeJsonResponse({ enabled: false, flagSource: 'default', suggestion: null });
      }
      return makeJsonResponse({ success: true });
    });

    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench');
    await waitFor(() => {
      expect(screen.queryByTestId('ticket-triage-suggestion')).toBeNull();
    });
  });
});

describe('TicketWorkbench AI drafts (#4191, Task 11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Sets up fetchWithAuth: ticket GET, triage-suggestion GET (disabled), and
   *  a stubbed ai-drafts GET returning `drafts`. Mutations return {success:true}
   *  unless overridden by `extra`. */
  function mockDraftsApi(drafts: unknown[], extra?: (url: string, init?: RequestInit) => Response | null) {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (extra) {
        const res = extra(url, init);
        if (res) return res;
      }
      if (url === '/tickets/tk-1' && (!init?.method || init.method === 'GET')) {
        return makeJsonResponse({ data: makeTicket({ id: 'tk-1' }) });
      }
      if (url === '/tickets/tk-1/triage-suggestion' && (!init?.method || init.method === 'GET')) {
        return makeJsonResponse({ enabled: false, flagSource: 'default', suggestion: null });
      }
      if (url === '/tickets/tk-1/ai-drafts' && (!init?.method || init.method === 'GET')) {
        return makeJsonResponse({ data: drafts });
      }
      return makeJsonResponse({ success: true });
    });
  }

  const replyDraft = {
    id: 'draft-reply-1',
    kind: 'reply',
    content: 'Thanks for reaching out — please try rebooting the printer.',
    createdAt: '2026-08-01T12:00:00.000Z',
    runId: 'run-1',
  };

  const resolutionDraft = {
    id: 'draft-note-1',
    kind: 'resolution_note',
    content: 'Replaced the fuser assembly; printer now prints cleanly.',
    createdAt: '2026-08-01T12:00:00.000Z',
    runId: 'run-2',
  };

  it('renders an AI draft card with the kind label and editable content', async () => {
    mockDraftsApi([replyDraft]);
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    const card = await screen.findByTestId('ticket-ai-draft-reply');
    expect(card).toBeInTheDocument();
    const textarea = screen.getByTestId('ticket-ai-draft-reply-content') as HTMLTextAreaElement;
    expect(textarea.value).toBe(replyDraft.content);
    expect(screen.getByTestId('ticket-ai-draft-reply-send')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-ai-draft-reply-discard')).toBeInTheDocument();
  });

  it('renders a reply and a resolution_note draft simultaneously with per-kind testids', async () => {
    mockDraftsApi([replyDraft, resolutionDraft]);
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-ai-draft-reply');
    await screen.findByTestId('ticket-ai-draft-resolution_note');

    expect(screen.getByTestId('ticket-ai-draft-reply-content')).toHaveValue(replyDraft.content);
    expect(screen.getByTestId('ticket-ai-draft-resolution_note-content')).toHaveValue(resolutionDraft.content);
    expect(screen.getByTestId('ticket-ai-draft-reply-send')).toBeInTheDocument();
    // Send is reply-only — the API 409s a send on a resolution_note draft.
    expect(screen.queryByTestId('ticket-ai-draft-resolution_note-send')).toBeNull();
    expect(screen.getByTestId('ticket-ai-draft-reply-discard')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-ai-draft-resolution_note-discard')).toBeInTheDocument();
  });

  it('sends the (edited) draft content via runAction and removes the card', async () => {
    mockDraftsApi([replyDraft]);
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    const textarea = await screen.findByTestId('ticket-ai-draft-reply-content');
    fireEvent.change(textarea, { target: { value: 'Edited: please reboot the printer twice.' } });
    fireEvent.click(screen.getByTestId('ticket-ai-draft-reply-send'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/ai-drafts/draft-reply-1/send',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ content: 'Edited: please reboot the printer twice.' }),
        }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId('ticket-ai-draft-reply')).toBeNull();
    });
  });

  it('discards a draft via runAction without sending, and removes the card', async () => {
    mockDraftsApi([replyDraft]);
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-ai-draft-reply');
    fireEvent.click(screen.getByTestId('ticket-ai-draft-reply-discard'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/ai-drafts/draft-reply-1/discard',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/tickets/tk-1/ai-drafts/draft-reply-1/send',
      expect.anything(),
    );
    await waitFor(() => {
      expect(screen.queryByTestId('ticket-ai-draft-reply')).toBeNull();
    });
  });

  it('on a 409 send conflict (already sent/discarded elsewhere), refetches and drops the stale card', async () => {
    // Keyed on an explicit "consumed" flag (flipped only by the conflicting
    // POST) rather than a raw GET call counter — the initial mount can
    // legitimately re-fetch ai-drafts more than once before the user ever
    // clicks Send, and a call-count-based fixture would flake on that.
    let consumed = false;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/tickets/tk-1' && (!init?.method || init.method === 'GET')) {
        return makeJsonResponse({ data: makeTicket({ id: 'tk-1' }) });
      }
      if (url === '/tickets/tk-1/triage-suggestion' && (!init?.method || init.method === 'GET')) {
        return makeJsonResponse({ enabled: false, flagSource: 'default', suggestion: null });
      }
      if (url === '/tickets/tk-1/ai-drafts' && (!init?.method || init.method === 'GET')) {
        return makeJsonResponse({ data: consumed ? [] : [replyDraft] });
      }
      if (url === '/tickets/tk-1/ai-drafts/draft-reply-1/send' && init?.method === 'POST') {
        consumed = true;
        return makeJsonResponse({ error: 'Draft is no longer active' }, false, 409);
      }
      return makeJsonResponse({ success: true });
    });

    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-ai-draft-reply');
    fireEvent.click(screen.getByTestId('ticket-ai-draft-reply-send'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/ai-drafts/draft-reply-1/send',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    // The card can only disappear here via a refetch landing after `consumed`
    // flipped true (there is no successful-send optimistic-removal path on
    // this failing request) — so this proves the post-conflict refetch fired.
    await waitFor(() => {
      expect(screen.queryByTestId('ticket-ai-draft-reply')).toBeNull();
    });
  });

  it('prefills the resolve note from an active resolution_note draft and sends aiDraftId on resolve', async () => {
    mockDraftsApi([resolutionDraft]);
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench');
    // Wait for the resolution_note draft CARD to render — proof that aiDrafts
    // (and the aiDraftsRef it syncs to) has actually committed, not just that
    // the ai-drafts fetch was called. openResolveForm() reads the ref
    // synchronously inside the status-change handler below, so this is load-
    // bearing, not decorative.
    await screen.findByTestId('ticket-ai-draft-resolution_note');

    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'resolved' } });

    const note = screen.getByTestId('ticket-workbench-resolve-note') as HTMLTextAreaElement;
    expect(note.value).toBe(resolutionDraft.content);

    fireEvent.click(screen.getByTestId('ticket-workbench-resolve-submit'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/status',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ status: 'resolved', resolutionNote: resolutionDraft.content, aiDraftId: 'draft-note-1' }),
        }),
      );
    });
  });

  // C1 (#4191 final review): the technician editing the prefilled note before
  // submitting must NOT be silently replaced by the draft's original content.
  // Non-uniform fixture — the edited text is deliberately different from
  // resolutionDraft.content — so a regression that resends the draft's
  // content instead of the edited value fails loudly.
  it('C1: submits the technician-edited note (not the draft content) alongside aiDraftId', async () => {
    mockDraftsApi([resolutionDraft]);
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench');
    await screen.findByTestId('ticket-ai-draft-resolution_note');

    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'resolved' } });

    const note = screen.getByTestId('ticket-workbench-resolve-note') as HTMLTextAreaElement;
    expect(note.value).toBe(resolutionDraft.content);
    fireEvent.change(note, { target: { value: 'Technician-edited resolution note' } });

    fireEvent.click(screen.getByTestId('ticket-workbench-resolve-submit'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/status',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ status: 'resolved', resolutionNote: 'Technician-edited resolution note', aiDraftId: 'draft-note-1' }),
        }),
      );
    });
  });

  // I1 (#4191 final review): a 404 (stale draft id after a ticket switch,
  // e.g. resolveDraftId survived from a prior ticket's aiDrafts state) used
  // to fall through the `err.status === 409` check and loop forever. The
  // recovery must match the sibling send/discard handlers (any non-401).
  it('I1: on a 404 resolve conflict from a stale aiDraftId, drops it and retries without it (not just 409)', async () => {
    let resolveAttempts = 0;
    let consumed = false;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/tickets/tk-1' && (!init?.method || init.method === 'GET')) {
        return makeJsonResponse({ data: makeTicket({ id: 'tk-1' }) });
      }
      if (url === '/tickets/tk-1/triage-suggestion' && (!init?.method || init.method === 'GET')) {
        return makeJsonResponse({ enabled: false, flagSource: 'default', suggestion: null });
      }
      if (url === '/tickets/tk-1/ai-drafts' && (!init?.method || init.method === 'GET')) {
        return makeJsonResponse({ data: consumed ? [] : [resolutionDraft] });
      }
      if (url === '/tickets/tk-1/status' && init?.method === 'POST') {
        resolveAttempts += 1;
        if (resolveAttempts === 1) {
          consumed = true;
          return makeJsonResponse({ error: 'Draft not found' }, false, 404);
        }
        return makeJsonResponse({ data: makeTicket({ id: 'tk-1', status: 'resolved' }) });
      }
      return makeJsonResponse({ success: true });
    });

    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench');
    await screen.findByTestId('ticket-ai-draft-resolution_note');

    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'resolved' } });
    const note = screen.getByTestId('ticket-workbench-resolve-note') as HTMLTextAreaElement;
    expect(note.value).toBe(resolutionDraft.content);

    fireEvent.click(screen.getByTestId('ticket-workbench-resolve-submit'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/status',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ status: 'resolved', resolutionNote: resolutionDraft.content, aiDraftId: 'draft-note-1' }),
        }),
      );
    });

    expect(screen.getByTestId('ticket-workbench-resolve-form')).toBeInTheDocument();
    expect(note.value).toBe(resolutionDraft.content);

    fireEvent.click(screen.getByTestId('ticket-workbench-resolve-submit'));

    // The second submit must NOT loop the same 404 forever — it posts without
    // the now-dropped aiDraftId.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/status',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ status: 'resolved', resolutionNote: resolutionDraft.content }),
        }),
      );
    });
  });

  it('on a 409 resolve conflict from a stale aiDraftId, keeps the typed note and retries without it', async () => {
    let resolveAttempts = 0;
    // Same rationale as the send-409 test above: an explicit "consumed" flag
    // (flipped by the first failing /status POST), not a raw GET call count.
    let consumed = false;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/tickets/tk-1' && (!init?.method || init.method === 'GET')) {
        return makeJsonResponse({ data: makeTicket({ id: 'tk-1' }) });
      }
      if (url === '/tickets/tk-1/triage-suggestion' && (!init?.method || init.method === 'GET')) {
        return makeJsonResponse({ enabled: false, flagSource: 'default', suggestion: null });
      }
      if (url === '/tickets/tk-1/ai-drafts' && (!init?.method || init.method === 'GET')) {
        return makeJsonResponse({ data: consumed ? [] : [resolutionDraft] });
      }
      if (url === '/tickets/tk-1/status' && init?.method === 'POST') {
        resolveAttempts += 1;
        if (resolveAttempts === 1) {
          // Someone else already consumed/discarded the draft between the
          // form opening and this submit.
          consumed = true;
          return makeJsonResponse({ error: 'Draft is no longer active' }, false, 409);
        }
        return makeJsonResponse({ data: makeTicket({ id: 'tk-1', status: 'resolved' }) });
      }
      return makeJsonResponse({ success: true });
    });

    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench');
    // Same rationale as the prefill test above: wait for the card, not just
    // the fetch call.
    await screen.findByTestId('ticket-ai-draft-resolution_note');

    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'resolved' } });
    const note = screen.getByTestId('ticket-workbench-resolve-note') as HTMLTextAreaElement;
    expect(note.value).toBe(resolutionDraft.content);

    fireEvent.click(screen.getByTestId('ticket-workbench-resolve-submit'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/status',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ status: 'resolved', resolutionNote: resolutionDraft.content, aiDraftId: 'draft-note-1' }),
        }),
      );
    });

    // The 409 keeps the form open with the typed note untouched, and drops
    // the now-dead aiDraftId.
    expect(screen.getByTestId('ticket-workbench-resolve-form')).toBeInTheDocument();
    expect(note.value).toBe(resolutionDraft.content);

    fireEvent.click(screen.getByTestId('ticket-workbench-resolve-submit'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/status',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ status: 'resolved', resolutionNote: resolutionDraft.content }),
        }),
      );
    });
  });

  it('never renders a card for a draft the ai-drafts endpoint does not return (consumed/discarded)', async () => {
    mockDraftsApi([]);
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/tickets/tk-1/ai-drafts'));
    expect(screen.queryByTestId('ticket-ai-draft-reply')).toBeNull();
    expect(screen.queryByTestId('ticket-ai-draft-resolution_note')).toBeNull();
  });

  // I2 (#4191 final review): ticket A's AI-draft card must clear as soon as
  // ticketId switches — not linger until ticket B's ai-drafts fetch resolves.
  // The new ticket's GET is held open (never resolved during the assertion)
  // so a regression that only clears on refetch-complete would still show
  // ticket A's stale card at the point we check.
  it('I2: clears stale AI-draft cards immediately on ticket switch, before the new fetch resolves', async () => {
    let resolveTk2Drafts!: (value: Response) => void;
    const tk2DraftsPromise = new Promise<Response>((resolve) => { resolveTk2Drafts = resolve; });

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/tickets/tk-1' && (!init?.method || init.method === 'GET')) {
        return makeJsonResponse({ data: makeTicket({ id: 'tk-1', internalNumber: 'T-2026-0001' }) });
      }
      if (url === '/tickets/tk-2' && (!init?.method || init.method === 'GET')) {
        return makeJsonResponse({ data: makeTicket({ id: 'tk-2', internalNumber: 'T-2026-0002' }) });
      }
      if (url === '/tickets/tk-1/triage-suggestion' || url === '/tickets/tk-2/triage-suggestion') {
        return makeJsonResponse({ enabled: false, flagSource: 'default', suggestion: null });
      }
      if (url === '/tickets/tk-1/ai-drafts' && (!init?.method || init.method === 'GET')) {
        return makeJsonResponse({ data: [replyDraft] });
      }
      if (url === '/tickets/tk-2/ai-drafts' && (!init?.method || init.method === 'GET')) {
        return tk2DraftsPromise; // held open deliberately
      }
      return makeJsonResponse({ success: true });
    });

    const { rerender } = render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);
    await screen.findByTestId('ticket-ai-draft-reply');

    rerender(<TicketWorkbench ticketId="tk-2" assignees={[]} />);

    await waitFor(() => {
      expect(screen.getByTestId('ticket-workbench-number')).toHaveTextContent('T-2026-0002');
    });
    // Ticket A's card is gone even though ticket B's ai-drafts fetch is still
    // unresolved at this point.
    expect(screen.queryByTestId('ticket-ai-draft-reply')).toBeNull();

    resolveTk2Drafts(makeJsonResponse({ data: [resolutionDraft] }));
    await screen.findByTestId('ticket-ai-draft-resolution_note');
  });

  // #4469 — the two draft cards are independent operations (different draft
  // ids); acting on one must not block the other. Holds the reply's send
  // request open (never resolved during the assertion) so the resolution_note
  // card's discard click happens while sendingDraftId is still set to the
  // OTHER draft's id — a regression that guards on "any in-flight action"
  // rather than "this draft's own in-flight action" would silently swallow
  // the discard click here (the button isn't visually disabled, but the
  // handler's guard clause no-ops before the fetch fires).
  it('#4469: discarding one draft while the other is mid-send still fires the discard request', async () => {
    let resolveSend!: (value: Response) => void;
    const sendPromise = new Promise<Response>((resolve) => { resolveSend = resolve; });

    mockDraftsApi([replyDraft, resolutionDraft], (url, init) => {
      if (url === '/tickets/tk-1/ai-drafts/draft-reply-1/send' && init?.method === 'POST') {
        return sendPromise as unknown as Response;
      }
      return null;
    });

    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);
    await screen.findByTestId('ticket-ai-draft-reply');
    await screen.findByTestId('ticket-ai-draft-resolution_note');

    fireEvent.click(screen.getByTestId('ticket-ai-draft-reply-send'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/ai-drafts/draft-reply-1/send',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    // Reply's send is still in flight (sendPromise unresolved) when the
    // resolution_note card is discarded.
    fireEvent.click(screen.getByTestId('ticket-ai-draft-resolution_note-discard'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/ai-drafts/draft-note-1/discard',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    resolveSend(makeJsonResponse({ success: true }));
    await waitFor(() => {
      expect(screen.queryByTestId('ticket-ai-draft-reply')).toBeNull(); // send completed, card removed
    });
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

// ─── Subject inline edit ──────────────────────────────────────────────────────

const makeComment = (overrides: Partial<import('./ticketConfig').TicketComment> = {}): import('./ticketConfig').TicketComment => ({
  id: 'c-1',
  userId: 'u-1',
  portalUserId: null,
  authorName: 'Alice',
  authorType: 'staff',
  commentType: 'comment',
  content: 'Hello world',
  isPublic: true,
  oldValue: null,
  newValue: null,
  createdAt: '2026-06-01T10:00:00.000Z',
  editedAt: null,
  deleted: false,
  ...overrides,
});

describe('TicketWorkbench subject inline edit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Stub ResizeObserver in case any chart mounts in jsdom
    if (!window.ResizeObserver) {
      window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  it('renders an editable subject input with testid ticket-workbench-subject-edit', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ subject: 'Printer is down' }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench-subject-edit');
    expect(screen.getByTestId('ticket-workbench-subject-edit')).toBeInTheDocument();
  });

  it('saves an edited subject via PATCH /tickets/:id on blur', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ subject: 'Printer is down' }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    const input = await screen.findByTestId('ticket-workbench-subject-edit');
    fireEvent.change(input, { target: { value: 'Printer is broken' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ subject: 'Printer is broken' }) })
      );
    });
  });

  it('saves an edited subject via PATCH on Enter key', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ subject: 'Printer is down' }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    const input = await screen.findByTestId('ticket-workbench-subject-edit');
    fireEvent.change(input, { target: { value: 'Network outage' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ subject: 'Network outage' }) })
      );
    });
  });

  it('does NOT PATCH when subject is unchanged on blur', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ subject: 'Printer is down' }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    const input = await screen.findByTestId('ticket-workbench-subject-edit');
    fireEvent.blur(input); // blur without changing value

    await new Promise((r) => setTimeout(r, 50));
    expect(
      fetchMock.mock.calls.filter(([url, init]) => init?.method === 'PATCH' && String(url) === '/tickets/tk-1' && (init?.body as string | undefined)?.includes('subject'))
    ).toHaveLength(0);
  });

  it('does NOT PATCH when subject is cleared (empty) on blur', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ subject: 'Printer is down' }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    const input = await screen.findByTestId('ticket-workbench-subject-edit');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    await new Promise((r) => setTimeout(r, 50));
    expect(
      fetchMock.mock.calls.filter(([url, init]) => init?.method === 'PATCH' && String(url) === '/tickets/tk-1' && (init?.body as string | undefined)?.includes('subject'))
    ).toHaveLength(0);
  });
});

// ─── Description inline edit ─────────────────────────────────────────────────

describe('TicketWorkbench description inline edit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows an "Edit description" button when description is present', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ description: 'Existing description text' }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench');
    expect(screen.getByTestId('ticket-workbench-description-edit-btn')).toBeInTheDocument();
  });

  it('shows an "Add description" button when description is null', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ description: null }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench');
    expect(screen.getByTestId('ticket-workbench-description-edit-btn')).toBeInTheDocument();
  });

  it('clicking edit button shows a textarea; saving PATCHes description', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ description: 'Old description' }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.click(screen.getByTestId('ticket-workbench-description-edit-btn'));

    const textarea = screen.getByTestId('ticket-workbench-description-textarea');
    expect(textarea).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: 'Updated description' } });
    fireEvent.click(screen.getByTestId('ticket-workbench-description-save-btn'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ description: 'Updated description' }) })
      );
    });
  });

  it('cancel button closes the description editor without saving', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ description: 'Old description' }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.click(screen.getByTestId('ticket-workbench-description-edit-btn'));
    expect(screen.getByTestId('ticket-workbench-description-textarea')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ticket-workbench-description-cancel-btn'));
    expect(screen.queryByTestId('ticket-workbench-description-textarea')).toBeNull();

    await new Promise((r) => setTimeout(r, 50));
    expect(
      fetchMock.mock.calls.filter(([url, init]) => init?.method === 'PATCH' && String(url) === '/tickets/tk-1' && (init?.body as string | undefined)?.includes('description'))
    ).toHaveLength(0);
  });
});

// ─── Comment edit/delete handlers ────────────────────────────────────────────

describe('TicketWorkbench comment edit/delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Stub ResizeObserver for jsdom
    if (!window.ResizeObserver) {
      window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  it('calls PATCH /tickets/:id/comments/:cid via inline editor: open → type → save', async () => {
    const comment = makeComment({ id: 'c-42', content: 'Original text', portalUserId: null });
    mockTicketApi({ 'tk-1': makeTicket({ comments: [comment] }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    // Click the edit button to open the inline editor
    await screen.findByTestId('ticket-comment-edit-c-42');
    fireEvent.click(screen.getByTestId('ticket-comment-edit-c-42'));

    // Textarea should appear pre-filled
    const textarea = screen.getByTestId('ticket-comment-edit-textarea-c-42');
    expect(textarea).toBeInTheDocument();
    expect(textarea).toHaveValue('Original text');

    // Type new content and save
    fireEvent.change(textarea, { target: { value: 'Updated comment text' } });
    fireEvent.click(screen.getByTestId('ticket-comment-edit-save-c-42'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/comments/c-42',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ content: 'Updated comment text' }) })
      );
    });
  });

  it('does NOT PATCH when cancel is clicked in the inline editor', async () => {
    const comment = makeComment({ id: 'c-42', content: 'Original text', portalUserId: null });
    mockTicketApi({ 'tk-1': makeTicket({ comments: [comment] }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-comment-edit-c-42');
    fireEvent.click(screen.getByTestId('ticket-comment-edit-c-42'));

    const textarea = screen.getByTestId('ticket-comment-edit-textarea-c-42');
    fireEvent.change(textarea, { target: { value: 'Changed but cancelled' } });
    fireEvent.click(screen.getByTestId('ticket-comment-edit-cancel-c-42'));

    await new Promise((r) => setTimeout(r, 50));
    expect(
      fetchMock.mock.calls.filter(([url, init]) => init?.method === 'PATCH' && String(url).includes('/comments/'))
    ).toHaveLength(0);
  });

  it('calls DELETE /tickets/:id/comments/:cid via ConfirmDialog: open → confirm', async () => {
    const comment = makeComment({ id: 'c-99', content: 'Delete me', portalUserId: null });
    mockTicketApi({ 'tk-1': makeTicket({ comments: [comment] }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-comment-delete-c-99');
    fireEvent.click(screen.getByTestId('ticket-comment-delete-c-99'));

    // ConfirmDialog should be open; confirm it
    const confirmBtn = screen.getByTestId('ticket-comment-delete-confirm');
    expect(confirmBtn).toBeInTheDocument();
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/comments/c-99',
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  it('does NOT DELETE when cancel is clicked in the ConfirmDialog', async () => {
    const comment = makeComment({ id: 'c-99', content: 'Delete me', portalUserId: null });
    mockTicketApi({ 'tk-1': makeTicket({ comments: [comment] }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-comment-delete-c-99');
    fireEvent.click(screen.getByTestId('ticket-comment-delete-c-99'));

    // Cancel the dialog
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByTestId('ticket-comment-delete-confirm')).toBeNull();
    });
    expect(
      fetchMock.mock.calls.filter(([url, init]) => init?.method === 'DELETE' && String(url).includes('/comments/'))
    ).toHaveLength(0);
  });

  it('portal-authored comments do NOT show edit/delete controls (canManageComment gate)', async () => {
    const comment = makeComment({ id: 'c-portal', content: 'Portal user comment', portalUserId: 'pu-1' });
    mockTicketApi({ 'tk-1': makeTicket({ comments: [comment] }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-comment-c-portal');
    expect(screen.queryByTestId('ticket-comment-edit-c-portal')).toBeNull();
    expect(screen.queryByTestId('ticket-comment-delete-c-portal')).toBeNull();
  });

  it('staff-authored comments DO show edit/delete controls', async () => {
    const comment = makeComment({ id: 'c-staff', content: 'Staff comment', portalUserId: null });
    mockTicketApi({ 'tk-1': makeTicket({ comments: [comment] }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-comment-edit-c-staff');
    await screen.findByTestId('ticket-comment-delete-c-staff');
    expect(screen.getByTestId('ticket-comment-edit-c-staff')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-comment-delete-c-staff')).toBeInTheDocument();
  });
});

// ─── Due date, tags, device editors ──────────────────────────────────────────

describe('TicketWorkbench due-date editor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (!window.ResizeObserver) {
      window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  it('renders a date input with testid ticket-workbench-due', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ dueDate: null }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench');
    expect(screen.getByTestId('ticket-workbench-due')).toBeInTheDocument();
  });

  it('PATCHes dueDate when the date input changes', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ dueDate: null }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench-due');
    fireEvent.change(screen.getByTestId('ticket-workbench-due'), {
      target: { value: '2026-07-15' },
    });

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(
        ([url, init]) => init?.method === 'PATCH' && String(url) === '/tickets/tk-1'
      );
      expect(patchCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(patchCalls[patchCalls.length - 1][1]?.body as string);
      expect(body.dueDate).toBeTruthy();
      expect(body.dueDate).toContain('2026-07-15');
    });
  });

  it('PATCHes dueDate as null when the date input is cleared', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ dueDate: '2026-07-15T00:00:00.000Z' }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench-due');
    fireEvent.change(screen.getByTestId('ticket-workbench-due'), {
      target: { value: '' },
    });

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(
        ([url, init]) => init?.method === 'PATCH' && String(url) === '/tickets/tk-1'
      );
      expect(patchCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(patchCalls[patchCalls.length - 1][1]?.body as string);
      expect(body.dueDate).toBeNull();
    });
  });
});

describe('TicketWorkbench tags editor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (!window.ResizeObserver) {
      window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  it('renders the tag editor container with testid ticket-workbench-tags', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ tags: [] }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench');
    expect(screen.getByTestId('ticket-workbench-tags')).toBeInTheDocument();
  });

  it('PATCHes tags when a tag is added', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ tags: ['existing'] }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench-tags');
    const tagInput = screen.getByTestId('ticket-workbench-tag-input');
    fireEvent.change(tagInput, { target: { value: 'urgent' } });
    fireEvent.keyDown(tagInput, { key: 'Enter' });

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(
        ([url, init]) => init?.method === 'PATCH' && String(url) === '/tickets/tk-1'
      );
      expect(patchCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(patchCalls[patchCalls.length - 1][1]?.body as string);
      expect(body.tags).toEqual(['existing', 'urgent']);
    });
  });

  it('does NOT add a duplicate tag', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ tags: ['existing'] }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench-tags');
    const tagInput = screen.getByTestId('ticket-workbench-tag-input');
    fireEvent.change(tagInput, { target: { value: 'existing' } });
    fireEvent.keyDown(tagInput, { key: 'Enter' });

    await new Promise((r) => setTimeout(r, 50));
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => init?.method === 'PATCH' && String(url) === '/tickets/tk-1' && (init?.body as string | undefined)?.includes('tags')
      )
    ).toHaveLength(0);
  });

  it('PATCHes tags when a chip is removed', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ tags: ['alpha', 'beta'] }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench-tags');
    fireEvent.click(screen.getByTestId('ticket-workbench-tag-remove-alpha'));

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(
        ([url, init]) => init?.method === 'PATCH' && String(url) === '/tickets/tk-1'
      );
      expect(patchCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(patchCalls[patchCalls.length - 1][1]?.body as string);
      expect(body.tags).toEqual(['beta']);
    });
  });
});

describe('TicketWorkbench device link/unlink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (!window.ResizeObserver) {
      window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  it('renders the device container with testid ticket-workbench-device', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ deviceId: null, deviceHostname: null }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench');
    expect(screen.getByTestId('ticket-workbench-device')).toBeInTheDocument();
  });

  it('shows "No device" when deviceId is null', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ deviceId: null, deviceHostname: null }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench-device');
    expect(screen.getByTestId('ticket-workbench-device')).toHaveTextContent('No device');
  });

  it('shows the device hostname when linked', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ deviceId: 'dev-1', deviceHostname: 'DESKTOP-123' }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench-device');
    expect(screen.getByTestId('ticket-workbench-device')).toHaveTextContent('DESKTOP-123');
  });

  it('clears the device link when Unlink is clicked (PATCHes {deviceId: null})', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ deviceId: 'dev-1', deviceHostname: 'DESKTOP-123' }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench-device');
    fireEvent.click(screen.getByTestId('ticket-workbench-device-unlink'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ deviceId: null }) })
      );
    });
  });

  it('does NOT show an Unlink button when deviceId is null', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ deviceId: null, deviceHostname: null }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench-device');
    expect(screen.queryByTestId('ticket-workbench-device-unlink')).toBeNull();
  });
});

// ─── Requester editing + clickable device link ────────────────────────────────

describe('TicketWorkbench requester editing + device link', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  function mockApiWithRequesters(
    ticket: TicketDetail,
    requesters: Array<{ id: string; name: string | null; email: string }>
  ) {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (!init?.method || init.method === 'GET') {
        if (url.startsWith('/tickets/requesters?orgId=')) {
          return makeJsonResponse({ data: requesters });
        }
        const m = url.match(/^\/tickets\/([^/?]+)$/);
        if (m && m[1] === ticket.id) return makeJsonResponse({ data: ticket });
      }
      return makeJsonResponse({ success: true });
    });
  }

  it('renders the device hostname as a link to the device page', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ deviceId: 'dev-1', deviceHostname: 'DESKTOP-123' }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    const link = await screen.findByTestId('ticket-workbench-device-link');
    expect(link).toHaveAttribute('href', '/devices/dev-1');
    expect(link).toHaveTextContent('DESKTOP-123');
  });

  it('renders no device link when the ticket has no device', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ deviceId: null, deviceHostname: null }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench-device');
    expect(screen.queryByTestId('ticket-workbench-device-link')).toBeNull();
  });

  it('edits the requester to a picked portal user (PATCHes submittedBy + backfilled name/email)', async () => {
    mockApiWithRequesters(
      makeTicket({ submittedBy: null, submitterName: 'Pat', submitterEmail: null }),
      [{ id: 'pu-1', name: 'Jane Doe', email: 'jane@example.com' }]
    );
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.click(screen.getByTestId('ticket-workbench-requester-edit'));
    await screen.findByRole('option', { name: 'Jane Doe (jane@example.com)' });
    fireEvent.change(screen.getByTestId('ticket-workbench-requester-select'), { target: { value: 'pu-1' } });
    fireEvent.click(screen.getByTestId('ticket-workbench-requester-save'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/tickets/tk-1', expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ submittedBy: 'pu-1', submitterName: 'Jane Doe', submitterEmail: 'jane@example.com' })
      }));
    });
  });

  it('edits the requester to free text (PATCHes submittedBy:null + name)', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ submittedBy: null, submitterName: 'Pat', submitterEmail: null }) });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.click(screen.getByTestId('ticket-workbench-requester-edit'));
    fireEvent.change(screen.getByTestId('ticket-workbench-requester-select'), { target: { value: '__manual__' } });
    fireEvent.change(screen.getByTestId('ticket-workbench-requester-name'), { target: { value: 'Walk-in User' } });
    fireEvent.click(screen.getByTestId('ticket-workbench-requester-save'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/tickets/tk-1', expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ submittedBy: null, submitterName: 'Walk-in User', submitterEmail: null })
      }));
    });
  });

  it('does NOT PATCH when the requester editor is opened and saved unchanged', async () => {
    // #3258 W03: an emailed ticket has no portal login, so the editor opens on
    // "someone else" with the snapshot pre-filled. Saving it untouched used to
    // POST {submittedBy: null, submitterName, submitterEmail} — which the API
    // read as a requester change and used to clear requester_contact_id,
    // removing the customer's own ticket from their portal with no way back.
    mockTicketApi({
      'tk-1': makeTicket({ submittedBy: null, submitterName: 'Jane Doe', submitterEmail: 'jane@acme.test' })
    });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.click(screen.getByTestId('ticket-workbench-requester-edit'));
    fireEvent.click(screen.getByTestId('ticket-workbench-requester-save'));

    const patches = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
    expect(patches).toHaveLength(0);
    // The editor still closes — an unchanged save is a successful no-op, not a
    // stuck form.
    await waitFor(() => expect(screen.queryByTestId('ticket-workbench-requester-save')).toBeNull());
  });

  it('still PATCHes when only the requester EMAIL is edited', async () => {
    // The dirty check must compare all three fields, not just the picker.
    mockTicketApi({
      'tk-1': makeTicket({ submittedBy: null, submitterName: 'Jane Doe', submitterEmail: 'jane@acme.test' })
    });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.click(screen.getByTestId('ticket-workbench-requester-edit'));
    fireEvent.change(screen.getByTestId('ticket-workbench-requester-email'), { target: { value: 'bob@acme.test' } });
    fireEvent.click(screen.getByTestId('ticket-workbench-requester-save'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/tickets/tk-1', expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ submittedBy: null, submitterName: 'Jane Doe', submitterEmail: 'bob@acme.test' })
      }));
    });
  });
});

// ─── Move to another org ──────────────────────────────────────────────────────

describe('TicketWorkbench move-org action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (!window.ResizeObserver) {
      window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  /** Sets up fetchWithAuth to handle ticket GET, /orgs/organizations, triage, and mutations. */
  function mockTicketApiWithOrgs(
    ticket: TicketDetail,
    orgs: Array<{ id: string; name: string }> = [
      { id: 'org-1', name: 'Acme Corp' },
      { id: 'org-2', name: 'Globex Inc' },
    ]
  ) {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('/orgs/organizations')) {
        return makeJsonResponse({ data: orgs });
      }
      if (!init?.method || init.method === 'GET') {
        const match = url.match(/^\/tickets\/([^/]+)$/);
        if (match && match[1] === ticket.id) {
          return makeJsonResponse({ data: ticket });
        }
      }
      return makeJsonResponse({ success: true });
    });
  }

  it('POSTs move-org with the selected org', async () => {
    const ticket = makeTicket({ id: 'tk-1', orgId: 'org-1', orgName: 'Acme Corp' });
    mockTicketApiWithOrgs(ticket);
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench');

    // Open the move-org UI
    fireEvent.click(screen.getByTestId('ticket-workbench-move-org'));

    // The picker should appear; select org-2 (Globex Inc)
    const picker = await screen.findByTestId('ticket-workbench-move-org-select');
    fireEvent.change(picker, { target: { value: 'org-2' } });

    // Confirm the move
    fireEvent.click(screen.getByTestId('ticket-workbench-move-org-confirm'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/move-org',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ orgId: 'org-2' }),
        })
      );
    });
  });

  it('current org is excluded from the picker options', async () => {
    const ticket = makeTicket({ id: 'tk-1', orgId: 'org-1', orgName: 'Acme Corp' });
    mockTicketApiWithOrgs(ticket);
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.click(screen.getByTestId('ticket-workbench-move-org'));

    const picker = await screen.findByTestId('ticket-workbench-move-org-select');
    const options = Array.from(picker.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value);
    expect(options).not.toContain('org-1');
    expect(options).toContain('org-2');
  });

  // Multi-currency wave 4 (#3776): a cross-currency move with unbilled monetary
  // rows answers 409 TICKET_MOVE_CURRENCY_BLOCKED. The dialog must stay mounted
  // so the guidance has somewhere to render, and "move anyway" is a deliberate
  // two-step (checkbox + button) that re-POSTs acceptCurrencyMismatch: true.
  const BLOCKED_409 = {
    error: 'Ticket has unbilled EUR work; Globex Inc bills in USD',
    code: 'TICKET_MOVE_CURRENCY_BLOCKED',
    details: { sourceCurrency: 'EUR', targetCurrency: 'USD', unbilledTimeEntries: 2, unbilledParts: 1, accepted: false },
  };
  const moveCalls = () =>
    fetchMock.mock.calls.filter(([url, init]) => init?.method === 'POST' && String(url).includes('/move-org'));
  const ticketGets = () =>
    fetchMock.mock.calls.filter(([url, init]) => (!init?.method || init.method === 'GET') && String(url) === '/tickets/tk-1');

  /** Like mockTicketApiWithOrgs, but the FIRST move-org POST answers 409 blocked. */
  function mockBlockedMove(ticket: TicketDetail) {
    let moves = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('/orgs/organizations')) {
        return makeJsonResponse({ data: [{ id: 'org-1', name: 'Acme Corp' }, { id: 'org-2', name: 'Globex Inc' }] });
      }
      if (!init?.method || init.method === 'GET') {
        const match = url.match(/^\/tickets\/([^/]+)$/);
        if (match && match[1] === ticket.id) return makeJsonResponse({ data: ticket });
      }
      if (init?.method === 'POST' && url.includes('/move-org')) {
        moves += 1;
        if (moves === 1) return makeJsonResponse(BLOCKED_409, false, 409);
      }
      return makeJsonResponse({ success: true });
    });
  }

  it('a successful first move closes the form', async () => {
    const ticket = makeTicket({ id: 'tk-1', orgId: 'org-1', orgName: 'Acme Corp' });
    mockTicketApiWithOrgs(ticket);
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);
    await screen.findByTestId('ticket-workbench');
    fireEvent.click(screen.getByTestId('ticket-workbench-move-org'));
    fireEvent.change(await screen.findByTestId('ticket-workbench-move-org-select'), { target: { value: 'org-2' } });
    fireEvent.click(screen.getByTestId('ticket-workbench-move-org-confirm'));
    await waitFor(() => expect(screen.queryByTestId('ticket-workbench-move-org-form')).toBeNull());
    expect(moveCalls()).toHaveLength(1);
  });

  it('on 409 TICKET_MOVE_CURRENCY_BLOCKED the form stays open with guidance and a gated "move anyway"', async () => {
    const ticket = makeTicket({ id: 'tk-1', orgId: 'org-1', orgName: 'Acme Corp' });
    mockBlockedMove(ticket);
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);
    await screen.findByTestId('ticket-workbench');
    fireEvent.click(screen.getByTestId('ticket-workbench-move-org'));
    fireEvent.change(await screen.findByTestId('ticket-workbench-move-org-select'), { target: { value: 'org-2' } });
    fireEvent.click(screen.getByTestId('ticket-workbench-move-org-confirm'));

    const guidance = await screen.findByTestId('ticket-move-blocked-currency');
    expect(screen.getByTestId('ticket-workbench-move-org-confirm')).toBeInTheDocument();
    expect(guidance).toHaveTextContent('EUR');
    expect(guidance).toHaveTextContent('USD');
    expect(guidance).toHaveTextContent('Globex Inc');
    // The server message was toasted by runAction (bill first, or explicitly accept).
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: BLOCKED_409.error }));

    const accept = screen.getByTestId('ticket-workbench-move-org-accept');
    expect(accept).toBeDisabled();
    fireEvent.click(screen.getByTestId('ticket-move-accept-currency'));
    expect(accept).not.toBeDisabled();

    const getsBefore = ticketGets().length;
    fireEvent.click(accept);
    await waitFor(() => expect(moveCalls()).toHaveLength(2));
    expect(JSON.parse(String(moveCalls()[1][1]?.body))).toEqual({ orgId: 'org-2', acceptCurrencyMismatch: true });
    await waitFor(() => expect(screen.queryByTestId('ticket-workbench-move-org-form')).toBeNull());
    await waitFor(() => expect(ticketGets().length).toBeGreaterThan(getsBefore));
  });

  it('changing the target org after a block resets the acceptance checkbox', async () => {
    const ticket = makeTicket({ id: 'tk-1', orgId: 'org-1', orgName: 'Acme Corp' });
    mockBlockedMove(ticket);
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);
    await screen.findByTestId('ticket-workbench');
    fireEvent.click(screen.getByTestId('ticket-workbench-move-org'));
    const picker = await screen.findByTestId('ticket-workbench-move-org-select');
    fireEvent.change(picker, { target: { value: 'org-2' } });
    fireEvent.click(screen.getByTestId('ticket-workbench-move-org-confirm'));
    await screen.findByTestId('ticket-move-blocked-currency');
    fireEvent.click(screen.getByTestId('ticket-move-accept-currency'));
    expect(screen.getByTestId('ticket-workbench-move-org-accept')).not.toBeDisabled();

    fireEvent.change(picker, { target: { value: '' } });
    expect(screen.queryByTestId('ticket-move-blocked-currency')).toBeNull();
    expect(screen.queryByTestId('ticket-workbench-move-org-accept')).toBeNull();
  });

  it('cancel button closes the move-org form without POSTing', async () => {
    const ticket = makeTicket({ id: 'tk-1', orgId: 'org-1', orgName: 'Acme Corp' });
    mockTicketApiWithOrgs(ticket);
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.click(screen.getByTestId('ticket-workbench-move-org'));

    await screen.findByTestId('ticket-workbench-move-org-select');
    fireEvent.click(screen.getByTestId('ticket-workbench-move-org-cancel'));

    expect(screen.queryByTestId('ticket-workbench-move-org-select')).toBeNull();

    await new Promise((r) => setTimeout(r, 50));
    expect(
      fetchMock.mock.calls.filter(([url, init]) => init?.method === 'POST' && String(url).includes('/move-org'))
    ).toHaveLength(0);
  });
});

describe('TicketWorkbench create-invoice blocked by currency (#3776)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const invoiceCalls = () =>
    fetchMock.mock.calls.filter(([url, init]) => init?.method === 'POST' && String(url).includes('/invoice'));

  it('on 409 ALL_BLOCKED_BY_CURRENCY offers to assemble in the blocked currency via ?currencyCode=', async () => {
    const ticket = makeTicket({ id: 'tk-1' });
    let posts = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (!init?.method || init.method === 'GET') {
        if (url === '/tickets/tk-1') return makeJsonResponse({ data: ticket });
      }
      if (init?.method === 'POST' && url.startsWith('/tickets/tk-1/invoice')) {
        posts += 1;
        if (posts === 1) {
          return makeJsonResponse({
            error: 'All unbilled work is in EUR; this draft is in USD',
            code: 'ALL_BLOCKED_BY_CURRENCY',
            details: { blockedByCurrency: [{ currencyCode: 'EUR', count: 2, amount: '250.00' }] },
          }, false, 409);
        }
        return makeJsonResponse({ data: { invoice: { id: 'inv-eur' }, lines: [], blockedByCurrency: [] } });
      }
      return makeJsonResponse({ success: true });
    });
    render(<TicketWorkbench ticketId="tk-1" />);
    await screen.findByTestId('ticket-workbench');

    fireEvent.click(screen.getByTestId('ticket-workbench-create-invoice'));
    const btn = await screen.findByTestId('ticket-assemble-in-EUR');
    expect(navigateTo).not.toHaveBeenCalled();
    expect(invoiceCalls()[0][0]).toBe('/tickets/tk-1/invoice');

    fireEvent.click(btn);
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/billing/invoices/inv-eur'));
    expect(invoiceCalls()).toHaveLength(2);
    expect(invoiceCalls()[1][0]).toBe('/tickets/tk-1/invoice?currencyCode=EUR');
  });

  // Review #3 (#3776): a partial success carries BOTH the draft and the rows it
  // left out. Navigating straight to the draft would hide them — the draft
  // itself gives no hint that EUR work is still unbilled.
  it('on partial success keeps the user here, offers the per-currency shortcut and an "open draft" link', async () => {
    const ticket = makeTicket({ id: 'tk-1' });
    let posts = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (!init?.method || init.method === 'GET') {
        if (url === '/tickets/tk-1') return makeJsonResponse({ data: ticket });
      }
      if (init?.method === 'POST' && url.startsWith('/tickets/tk-1/invoice')) {
        posts += 1;
        if (posts === 1) {
          return makeJsonResponse({
            data: {
              invoice: { id: 'inv-usd' }, lines: [],
              blockedByCurrency: [{ currencyCode: 'EUR', count: 3, amount: '410.00' }],
              missingRate: [],
            },
          });
        }
        return makeJsonResponse({ data: { invoice: { id: 'inv-eur' }, lines: [], blockedByCurrency: [], missingRate: [] } });
      }
      return makeJsonResponse({ success: true });
    });
    render(<TicketWorkbench ticketId="tk-1" />);
    await screen.findByTestId('ticket-workbench');

    fireEvent.click(screen.getByTestId('ticket-workbench-create-invoice'));
    const panel = await screen.findByTestId('ticket-invoice-blocked');
    expect(navigateTo).not.toHaveBeenCalled();
    expect(panel.textContent).toContain('EUR');
    expect(screen.getByTestId('ticket-invoice-open-draft').getAttribute('href')).toBe('/billing/invoices/inv-usd');

    fireEvent.click(screen.getByTestId('ticket-assemble-in-EUR'));
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/billing/invoices/inv-eur'));
    expect(invoiceCalls()[1][0]).toBe('/tickets/tk-1/invoice?currencyCode=EUR');
  });

  it('navigates straight to the draft when nothing was left out', async () => {
    const ticket = makeTicket({ id: 'tk-1' });
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if ((!init?.method || init.method === 'GET') && url === '/tickets/tk-1') return makeJsonResponse({ data: ticket });
      if (init?.method === 'POST' && url === '/tickets/tk-1/invoice') {
        return makeJsonResponse({ data: { invoice: { id: 'inv-1' }, lines: [], blockedByCurrency: [], missingRate: [] } });
      }
      return makeJsonResponse({ success: true });
    });
    render(<TicketWorkbench ticketId="tk-1" />);
    await screen.findByTestId('ticket-workbench');
    fireEvent.click(screen.getByTestId('ticket-workbench-create-invoice'));
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/billing/invoices/inv-1'));
    expect(screen.queryByTestId('ticket-invoice-blocked')).toBeNull();
  });

  // Review #1 (#3776): rate-less entries are never billed at zero; the response
  // lists them under missingRate so the tech can set a rate and try again.
  it('lists missingRate entries from a partial success with a link to set a rate', async () => {
    const ticket = makeTicket({ id: 'tk-1' });
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if ((!init?.method || init.method === 'GET') && url === '/tickets/tk-1') return makeJsonResponse({ data: ticket });
      if (init?.method === 'POST' && url === '/tickets/tk-1/invoice') {
        return makeJsonResponse({
          data: {
            invoice: { id: 'inv-1' }, lines: [], blockedByCurrency: [],
            missingRate: [{ timeEntryId: 'te-9', ticketId: 'tk-1', description: 'Unrated work', hours: '1.50' }],
          },
        });
      }
      return makeJsonResponse({ success: true });
    });
    render(<TicketWorkbench ticketId="tk-1" />);
    await screen.findByTestId('ticket-workbench');
    fireEvent.click(screen.getByTestId('ticket-workbench-create-invoice'));
    const row = await screen.findByTestId('ticket-invoice-missing-rate-te-9');
    expect(row.textContent).toContain('Unrated work');
    expect(row.textContent).toContain('1.50');
    expect(navigateTo).not.toHaveBeenCalled();
    expect(screen.getByTestId('ticket-invoice-set-rate').getAttribute('href')).toBe('/timesheet');
    expect(screen.getByTestId('ticket-invoice-open-draft').getAttribute('href')).toBe('/billing/invoices/inv-1');
  });

  it('on 409 ALL_MISSING_RATE lists the entries with the set-rate link and no draft link', async () => {
    const ticket = makeTicket({ id: 'tk-1' });
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if ((!init?.method || init.method === 'GET') && url === '/tickets/tk-1') return makeJsonResponse({ data: ticket });
      if (init?.method === 'POST' && url === '/tickets/tk-1/invoice') {
        return makeJsonResponse({
          error: '1 billable time entry has no hourly rate in USD',
          code: 'ALL_MISSING_RATE',
          details: { missingRate: [{ timeEntryId: 'te-9', ticketId: 'tk-1', description: 'Unrated work', hours: '0.25' }] },
        }, false, 409);
      }
      return makeJsonResponse({ success: true });
    });
    render(<TicketWorkbench ticketId="tk-1" />);
    await screen.findByTestId('ticket-workbench');
    fireEvent.click(screen.getByTestId('ticket-workbench-create-invoice'));
    await screen.findByTestId('ticket-invoice-missing-rate-te-9');
    expect(screen.getByTestId('ticket-invoice-set-rate')).toBeTruthy();
    expect(screen.queryByTestId('ticket-invoice-open-draft')).toBeNull();
    expect(screen.queryByTestId(/^ticket-assemble-in-/)).toBeNull();
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it('on 409 ALL_BLOCKED_BY_CURRENCY also lists the missingRate entries carried in details', async () => {
    const ticket = makeTicket({ id: 'tk-1' });
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if ((!init?.method || init.method === 'GET') && url === '/tickets/tk-1') return makeJsonResponse({ data: ticket });
      if (init?.method === 'POST' && url === '/tickets/tk-1/invoice') {
        return makeJsonResponse({
          error: 'All unbilled work is in EUR',
          code: 'ALL_BLOCKED_BY_CURRENCY',
          details: {
            blockedByCurrency: [{ currencyCode: 'EUR', count: 1, amount: '100.00' }],
            missingRate: [{ timeEntryId: 'te-9', ticketId: 'tk-1', description: 'Unrated work', hours: '0.25' }],
          },
        }, false, 409);
      }
      return makeJsonResponse({ success: true });
    });
    render(<TicketWorkbench ticketId="tk-1" />);
    await screen.findByTestId('ticket-workbench');
    fireEvent.click(screen.getByTestId('ticket-workbench-create-invoice'));
    await screen.findByTestId('ticket-assemble-in-EUR');
    expect(screen.getByTestId('ticket-invoice-missing-rate-te-9')).toBeTruthy();
  });
});

describe('TicketWorkbench soft-delete (tickets:manage)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides the Delete button without tickets:manage', async () => {
    mockTicketApi({ 'tk-1': makeTicket() });
    render(<TicketWorkbench ticketId="tk-1" />);

    await screen.findByTestId('ticket-workbench');
    expect(screen.queryByTestId('ticket-delete-button')).toBeNull();
  });

  it('confirms first, then DELETEs the ticket and signals the host via onChanged', async () => {
    authState.permissions = [{ resource: 'tickets', action: 'manage' }];
    mockTicketApi({ 'tk-1': makeTicket() });
    const onChanged = vi.fn();
    render(<TicketWorkbench ticketId="tk-1" onChanged={onChanged} />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.click(screen.getByTestId('ticket-delete-button'));

    // Dialog is up; no DELETE fired yet.
    expect(
      fetchMock.mock.calls.some(([url, init]) => init?.method === 'DELETE' && String(url) === '/tickets/tk-1')
    ).toBe(false);

    fireEvent.click(await screen.findByTestId('ticket-delete-confirm'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/tickets/tk-1', expect.objectContaining({ method: 'DELETE' }));
    });
    await waitFor(() => {
      expect(onChanged).toHaveBeenCalled();
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Ticket deleted' }));
    // Split-pane mode: the host handles re-selection, so no navigation here.
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it('in full-page (expanded) mode, navigates back to the queue after delete', async () => {
    authState.permissions = [{ resource: 'tickets', action: 'manage' }];
    mockTicketApi({ 'tk-1': makeTicket() });
    render(<TicketWorkbench ticketId="tk-1" expanded />);

    await screen.findByTestId('ticket-workbench');
    fireEvent.click(screen.getByTestId('ticket-delete-button'));
    fireEvent.click(await screen.findByTestId('ticket-delete-confirm'));

    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledWith('/tickets');
    });
  });
});

describe('TicketWorkbench → TicketPartsCard currency (#3775)', () => {
  beforeEach(() => { vi.clearAllMocks(); partsCardProps.last = null; });

  it('passes the ticket org\'s currencyCode from the org list to the parts card', async () => {
    const ticket = makeTicket({ id: 'tk-1', orgId: 'org-2', orgName: 'Globex Inc' });
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('/orgs/organizations')) {
        return makeJsonResponse({ data: [
          { id: 'org-1', name: 'Acme Corp', currencyCode: 'USD' },
          { id: 'org-2', name: 'Globex Inc', currencyCode: 'EUR' },
        ] });
      }
      if ((!init?.method || init.method === 'GET') && url === '/tickets/tk-1') return makeJsonResponse({ data: ticket });
      return makeJsonResponse({ success: true });
    });
    render(<TicketWorkbench ticketId="tk-1" assignees={[]} />);
    await screen.findByTestId('ticket-parts-card-stub');
    await waitFor(() => expect(partsCardProps.last?.currencyCode).toBe('EUR'));
    expect(partsCardProps.last?.ticketId).toBe('tk-1');
  });
});
