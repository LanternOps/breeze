import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TicketLinksCard from './TicketLinksCard';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));
vi.mock('../../lib/authScope', () => ({ loginPathWithNext: () => '/login?next=%2Ftickets' }));

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, statusText: '', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

type Link = {
  id: string;
  direction: 'outgoing' | 'incoming';
  linkType: 'caused_by' | 'resolves' | 'related' | 'duplicate_of';
  label: string;
  other: { id: string; ticketNumber: string; subject: string; status: string; ticketType: string };
  createdAt: string;
};

const link = (over: Partial<Link> & { id: string }): Link => ({
  direction: 'outgoing',
  linkType: 'related',
  label: 'related',
  other: { id: `t-${over.id}`, ticketNumber: 'T-2026-0100', subject: 'Other ticket', status: 'open', ticketType: 'incident' },
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

interface Api {
  links?: Link[];
  search?: Array<{ id: string; internalNumber: string | null; subject: string; status: string; ticketType?: string }>;
  post?: Response;
  del?: Response;
  listStatus?: number;
}

function mockApi(api: Api = {}) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/tickets/tk-1/links' && method === 'GET') {
      return api.listStatus && api.listStatus >= 400 ? json({ error: 'boom' }, api.listStatus) : json({ data: api.links ?? [] });
    }
    if (url === '/tickets/tk-1/links' && method === 'POST') return api.post ?? json({ success: true, data: {} }, 201);
    if (url.startsWith('/tickets/tk-1/links/') && method === 'DELETE') return api.del ?? json({ success: true });
    if (url.startsWith('/tickets?')) return json({ data: api.search ?? [] });
    return json({ error: 'unexpected' }, 404);
  });
}

const listCalls = () => fetchMock.mock.calls.filter(([u, i]) => String(u) === '/tickets/tk-1/links' && (!i?.method || i.method === 'GET'));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TicketLinksCard — list', () => {
  it('shows an empty state with an add button for writers', async () => {
    mockApi({ links: [] });
    render(<TicketLinksCard ticketId="tk-1" orgId="org-1" canWrite />);
    expect(await screen.findByTestId('ticket-links-empty')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-links-add')).toBeInTheDocument();
  });

  it('read-only users get the empty state and no add control', async () => {
    mockApi({ links: [] });
    render(<TicketLinksCard ticketId="tk-1" orgId="org-1" canWrite={false} />);
    await screen.findByTestId('ticket-links-empty');
    expect(screen.queryByTestId('ticket-links-add')).toBeNull();
  });

  it('groups links by derived label and renders number, subject, status and type', async () => {
    mockApi({
      links: [
        link({ id: 'l1', linkType: 'caused_by', direction: 'outgoing', other: { id: 'a', ticketNumber: 'T-2026-0010', subject: 'DNS outage', status: 'open', ticketType: 'problem' } }),
        // Stored on the other ticket as "resolves": from here it reads "resolved by".
        link({ id: 'l2', linkType: 'resolves', direction: 'incoming', other: { id: 'b', ticketNumber: 'T-2026-0011', subject: 'Change 11', status: 'closed', ticketType: 'change' } }),
        link({ id: 'l3', linkType: 'related', direction: 'outgoing', other: { id: 'c', ticketNumber: 'T-2026-0012', subject: 'Similar issue', status: 'pending', ticketType: 'incident' } }),
        link({ id: 'l4', linkType: 'caused_by', direction: 'incoming', other: { id: 'd', ticketNumber: 'T-2026-0013', subject: 'Downstream', status: 'new', ticketType: 'incident' } }),
      ],
    });
    render(<TicketLinksCard ticketId="tk-1" orgId="org-1" canWrite />);

    await screen.findByTestId('ticket-link-row-l1');
    expect(screen.getByTestId('ticket-links-group-caused_by')).toContainElement(screen.getByTestId('ticket-link-row-l1'));
    expect(screen.getByTestId('ticket-links-group-resolved_by')).toContainElement(screen.getByTestId('ticket-link-row-l2'));
    expect(screen.getByTestId('ticket-links-group-related')).toContainElement(screen.getByTestId('ticket-link-row-l3'));
    // The inverse direction is its own group, not merged with "caused by".
    expect(screen.getByTestId('ticket-links-group-causes')).toContainElement(screen.getByTestId('ticket-link-row-l4'));

    const row = screen.getByTestId('ticket-link-row-l1');
    expect(row).toHaveTextContent('T-2026-0010');
    expect(row).toHaveTextContent('DNS outage');
    expect(within(row).getByTestId('ticket-link-type-l1')).toHaveAttribute('data-ticket-type', 'problem');
    expect(within(row).getByTestId('ticket-link-status-l1')).toBeInTheDocument();

    const anchor = within(row).getByTestId('ticket-link-open-l1');
    expect(anchor).toHaveAttribute('href', '/tickets#T-2026-0010');
  });

  it('shows an error with retry when the load fails (not the empty state)', async () => {
    mockApi({ listStatus: 500 });
    render(<TicketLinksCard ticketId="tk-1" orgId="org-1" canWrite />);
    await screen.findByTestId('ticket-links-error');
    expect(screen.queryByTestId('ticket-links-empty')).toBeNull();

    mockApi({ links: [] });
    fireEvent.click(screen.getByTestId('ticket-links-retry'));
    await screen.findByTestId('ticket-links-empty');
  });

  it('a problem ticket shows how many linked incidents it has (client-side count)', async () => {
    mockApi({
      links: [
        link({ id: 'l1', other: { id: 'a', ticketNumber: 'T-1', subject: 's', status: 'open', ticketType: 'incident' } }),
        link({ id: 'l2', other: { id: 'b', ticketNumber: 'T-2', subject: 's', status: 'open', ticketType: 'incident' } }),
        link({ id: 'l3', other: { id: 'c', ticketNumber: 'T-3', subject: 's', status: 'open', ticketType: 'change' } }),
      ],
    });
    render(<TicketLinksCard ticketId="tk-1" orgId="org-1" ticketType="problem" canWrite />);
    expect(await screen.findByTestId('ticket-links-incident-count')).toHaveTextContent('2 linked incidents');
  });

  it('does not show the incident count on a non-problem ticket', async () => {
    mockApi({ links: [link({ id: 'l1' })] });
    render(<TicketLinksCard ticketId="tk-1" orgId="org-1" ticketType="incident" canWrite />);
    await screen.findByTestId('ticket-link-row-l1');
    expect(screen.queryByTestId('ticket-links-incident-count')).toBeNull();
  });

  it('read-only users see no remove buttons', async () => {
    mockApi({ links: [link({ id: 'l1' })] });
    render(<TicketLinksCard ticketId="tk-1" orgId="org-1" canWrite={false} />);
    await screen.findByTestId('ticket-link-row-l1');
    expect(screen.queryByTestId('ticket-link-remove-l1')).toBeNull();
  });
});

describe('TicketLinksCard — remove', () => {
  it('asks for confirmation, then DELETEs and reloads', async () => {
    mockApi({ links: [link({ id: 'l1' })] });
    render(<TicketLinksCard ticketId="tk-1" orgId="org-1" canWrite />);
    await screen.findByTestId('ticket-link-row-l1');

    fireEvent.click(screen.getByTestId('ticket-link-remove-l1'));
    // Nothing is sent until the confirm.
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(false);

    mockApi({ links: [] });
    fireEvent.click(await screen.findByTestId('ticket-link-remove-confirm'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/tickets/tk-1/links/l1', expect.objectContaining({ method: 'DELETE' }));
    });
    await screen.findByTestId('ticket-links-empty');
  });

  it('cancel sends nothing', async () => {
    mockApi({ links: [link({ id: 'l1' })] });
    render(<TicketLinksCard ticketId="tk-1" orgId="org-1" canWrite />);
    await screen.findByTestId('ticket-link-row-l1');
    fireEvent.click(screen.getByTestId('ticket-link-remove-l1'));
    await screen.findByTestId('ticket-link-remove-confirm');
    // ConfirmDialog exposes no cancel test id; its cancel is the only other button.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(false);
  });
});

describe('TicketLinksCard — add', () => {
  async function openAndPick(subject = 'Root cause') {
    fireEvent.click(await screen.findByTestId('ticket-links-add'));
    fireEvent.change(await screen.findByTestId('ticket-link-search'), { target: { value: 'root' } });
    const result = await screen.findByText(subject, {}, { timeout: 3000 });
    fireEvent.click(result);
  }

  it('searches within the ticket org, excludes the ticket itself, and POSTs targetTicketId + linkType', async () => {
    mockApi({
      links: [],
      search: [
        { id: 'tk-1', internalNumber: 'T-2026-0001', subject: 'Self ticket', status: 'open' },
        { id: 'tk-9', internalNumber: 'T-2026-0009', subject: 'Root cause', status: 'open', ticketType: 'problem' },
      ],
    });
    render(<TicketLinksCard ticketId="tk-1" orgId="org-1" canWrite />);
    await openAndPick();

    const searchUrl = fetchMock.mock.calls.map(([u]) => String(u)).find((u) => u.startsWith('/tickets?')) ?? '';
    expect(searchUrl).toContain('orgId=org-1');
    expect(searchUrl).toContain('search=root');
    expect(screen.queryByText('Self ticket')).toBeNull();

    fireEvent.change(screen.getByTestId('ticket-link-type-select'), { target: { value: 'caused_by' } });
    mockApi({ links: [link({ id: 'new', linkType: 'caused_by' })] });
    fireEvent.click(screen.getByTestId('ticket-link-submit'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([u, i]) => String(u) === '/tickets/tk-1/links' && i?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post![1]!.body))).toEqual({ targetTicketId: 'tk-9', linkType: 'caused_by' });
    });
    await screen.findByTestId('ticket-link-row-new');
  });

  it('submit is disabled until a ticket is picked', async () => {
    mockApi({ links: [] });
    render(<TicketLinksCard ticketId="tk-1" orgId="org-1" canWrite />);
    fireEvent.click(await screen.findByTestId('ticket-links-add'));
    expect(await screen.findByTestId('ticket-link-submit')).toBeDisabled();
  });

  it('offers the four link types', async () => {
    mockApi({ links: [] });
    render(<TicketLinksCard ticketId="tk-1" orgId="org-1" canWrite />);
    fireEvent.click(await screen.findByTestId('ticket-links-add'));
    const select = (await screen.findByTestId('ticket-link-type-select')) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['related', 'caused_by', 'resolves', 'duplicate_of']);
  });

  it.each([
    ['ALREADY_LINKED', 409],
    ['LINK_CYCLE', 409],
    ['LINK_LIMIT', 409],
    ['SOURCE_ALREADY_DUPLICATE', 409],
    ['SOURCE_HAS_DUPLICATES', 409],
    ['DUPLICATE_TARGET_IS_DUPLICATE', 409],
    ['CROSS_ORG', 422],
    ['SELF_LINK', 422],
    ['NOT_FOUND', 404],
  ])('maps %s to a specific message (not the generic fallback or the raw code)', async (code, status) => {
    mockApi({
      links: [],
      search: [{ id: 'tk-9', internalNumber: 'T-2026-0009', subject: 'Root cause', status: 'open' }],
      post: json({ error: `server prose for ${code}`, code }, status),
    });
    render(<TicketLinksCard ticketId="tk-1" orgId="org-1" canWrite />);
    await openAndPick();
    fireEvent.click(screen.getByTestId('ticket-link-submit'));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    const toast = showToast.mock.calls[0][0] as { message: string; type: string };
    expect(toast.type).toBe('error');
    expect(toast.message).not.toBe('');
    expect(toast.message).not.toContain(code);
    expect(toast.message).not.toContain('server prose');
    // Specific, not the shared fallback.
    expect(toast.message).not.toBe('Could not add the link.');
  });

  it('an unknown error code falls back to the generic message', async () => {
    mockApi({
      links: [],
      search: [{ id: 'tk-9', internalNumber: 'T-2026-0009', subject: 'Root cause', status: 'open' }],
      post: json({ error: 'weird', code: 'SOMETHING_NEW' }, 409),
    });
    render(<TicketLinksCard ticketId="tk-1" orgId="org-1" canWrite />);
    await openAndPick();
    fireEvent.click(screen.getByTestId('ticket-link-submit'));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect((showToast.mock.calls[0][0] as { message: string }).message).toBe('weird');
  });

  it('keeps the dialog open after a failed add so the user can adjust', async () => {
    mockApi({
      links: [],
      search: [{ id: 'tk-9', internalNumber: 'T-2026-0009', subject: 'Root cause', status: 'open' }],
      post: json({ error: 'cap', code: 'LINK_LIMIT' }, 409),
    });
    render(<TicketLinksCard ticketId="tk-1" orgId="org-1" canWrite />);
    await openAndPick();
    fireEvent.click(screen.getByTestId('ticket-link-submit'));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(screen.getByTestId('ticket-link-submit')).toBeInTheDocument();
  });
});

describe('TicketLinksCard — ticket switch', () => {
  it('reloads when the ticket changes', async () => {
    mockApi({ links: [] });
    const { rerender } = render(<TicketLinksCard ticketId="tk-1" orgId="org-1" canWrite />);
    await screen.findByTestId('ticket-links-empty');
    expect(listCalls()).toHaveLength(1);

    fetchMock.mockImplementation(async (input) => {
      if (String(input) === '/tickets/tk-2/links') return json({ data: [link({ id: 'x' })] });
      return json({ error: 'unexpected' }, 404);
    });
    rerender(<TicketLinksCard ticketId="tk-2" orgId="org-1" canWrite />);
    await screen.findByTestId('ticket-link-row-x');
  });
});
