const setPageContext = vi.hoisted(() => vi.fn());
vi.mock('@/stores/aiStore', () => ({ useAiStore: (select: (s: unknown) => unknown) => select({ setPageContext }) }));
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TicketWorkbench from './TicketWorkbench';
import { fetchWithAuth } from '../../stores/auth';
import type { TicketDetail } from './ticketConfig';

// Focus layout: header (Status / Priority / Assignee + More), the conversation
// with the description as message 1 and a pinned composer, and the situation
// column. Below 1024px the two become Conversation | Details tabs.

type Perm = { resource: string; action: string };
const authState = vi.hoisted(() => ({ permissions: [] as Perm[] }));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (selector: (s: { user: { name: string; permissions: Perm[] } | null }) => unknown) =>
    selector({ user: { name: 'Test Agent', permissions: authState.permissions } }),
}));
vi.mock('./TicketPartsCard', () => ({ default: () => <div data-testid="ticket-parts-card-stub" /> }));
vi.mock('./TicketChecklistCard', () => ({ default: () => <div data-testid="ticket-checklist-card-stub" /> }));
vi.mock('./TicketLinksCard', () => ({ default: () => <div data-testid="ticket-links-card-stub" /> }));
vi.mock('./TicketEndpointPanel', () => ({ default: () => <div data-testid="ticket-endpoint-panel-stub" /> }));
// The live device state is read once by the workbench and shared by the
// Details panel and the narrow-width endpoint line.
type EndpointFixture = { state: { kind: string; device?: Record<string, unknown> }; session: { value: { username: string } | null; failed: boolean } | null; alerts: unknown };
const endpoint = vi.hoisted(() => ({ value: { state: { kind: 'loading' }, session: null, alerts: null } as EndpointFixture }));
vi.mock('./useTicketEndpoint', () => ({ useTicketEndpoint: () => endpoint.value }));
vi.mock('../remote/ConnectDesktopButton', () => ({ default: () => <button type="button" data-testid="connect-desktop-mock">Remote in</button> }));
vi.mock('@/components/wisp/WispTalkButton', () => ({
  default: () => <button type="button" data-testid="wisp-talk-button-mock">Ask AI</button>,
}));
vi.mock('../../lib/ticketConfigApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/ticketConfigApi')>();
  return { ...actual, fetchTicketConfig: vi.fn().mockResolvedValue(null) };
});
const showToast = vi.hoisted(() => vi.fn());
vi.mock('../shared/Toast', () => ({ showToast }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const makeTicket = (o: Partial<TicketDetail> = {}): TicketDetail => ({
  id: 'tk-1',
  internalNumber: 'T-1001',
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
  description: 'The office printer shows error 49 since this morning.',
  submittedBy: null,
  submitterName: 'Pat Smith',
  submitterEmail: 'pat@example.com',
  pendingReason: null,
  resolutionNote: null,
  resolvedAt: null,
  comments: [],
  alertLinks: [],
  ...o,
});

function mockApi(ticket: TicketDetail) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === `/tickets/${ticket.id}`) return json({ data: ticket });
    if (url === '/users') return json({ data: [] });
    return json({ success: true });
  });
}

function setViewport(wide: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes('min-width: 1024px') ? wide : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const originalMatchMedia = window.matchMedia;
beforeEach(() => {
  vi.clearAllMocks();
  authState.permissions = [];
  endpoint.value = { state: { kind: 'loading' }, session: null, alerts: null };
});

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const ONLINE_DEVICE = {
  id: 'dev-1', hostname: 'e2e-windows.local', displayName: null, status: 'online', osType: 'windows', osVersion: '11',
  lastSeenAt: new Date().toISOString(), lastUser: null, uptimeSeconds: 3600, pendingReboot: false,
  desktopAccess: { mode: 'available' }, isHeadless: false, remoteAccessPolicy: null, helperLifecycleMode: null,
};
afterEach(() => { window.matchMedia = originalMatchMedia; });

describe('TicketWorkbench focus layout — below 1024px', () => {
  beforeEach(() => setViewport(false));

  it('splits into Conversation | Details tabs, Conversation first', async () => {
    mockApi(makeTicket());
    render(<TicketWorkbench ticketId="tk-1" />);
    const tablist = await screen.findByRole('tablist', { name: 'Ticket sections' });
    const conversationTab = within(tablist).getByTestId('ticket-workbench-tab-conversation');
    const detailsTab = within(tablist).getByTestId('ticket-workbench-tab-details');
    expect(conversationTab).toHaveAttribute('aria-selected', 'true');
    expect(detailsTab).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('ticket-workbench-conversation')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('ticket-workbench-rail')).toHaveAttribute('hidden');
  });

  it('the Details tab reaches the situation column (SLA, time, requester, device) and keeps the draft', async () => {
    mockApi(makeTicket());
    render(<TicketWorkbench ticketId="tk-1" />);
    const input = await screen.findByTestId('ticket-composer-input');
    fireEvent.change(input, { target: { value: 'Half-written reply' } });

    fireEvent.click(screen.getByTestId('ticket-workbench-tab-details'));
    const rail = screen.getByTestId('ticket-workbench-rail');
    expect(rail).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('ticket-workbench-conversation')).toHaveAttribute('hidden');
    expect(within(rail).getByTestId('ticket-workbench-requester')).toHaveTextContent('Pat Smith');
    expect(within(rail).getByTestId('ticket-endpoint-panel-stub')).toBeInTheDocument();
    expect(within(rail).getByTestId('ticket-details-billing')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ticket-workbench-tab-conversation'));
    expect(screen.getByTestId('ticket-composer-input')).toHaveValue('Half-written reply');
  });

  it('keeps the worst live SLA in the header beside Status, at narrow width too', async () => {
    mockApi(makeTicket({ slaBreachedAt: inMinutes(-30) }));
    render(<TicketWorkbench ticketId="tk-1" />);
    const header = await screen.findByTestId('ticket-focus-header');
    expect(within(header).getByTestId('ticket-workbench-sla')).toHaveTextContent('Breached');
  });

  it('shows the endpoint as one line under the header; clicking it opens Details', async () => {
    authState.permissions = [{ resource: 'devices', action: 'read' }, { resource: 'remote', action: 'access' }];
    endpoint.value = {
      state: { kind: 'ready', device: ONLINE_DEVICE },
      session: { value: { username: 'jordan' }, failed: false },
      alerts: [{ id: 'a1', title: 'Disk', severity: 'critical' }, { id: 'a2', title: 'CPU', severity: 'high' }],
    };
    mockApi(makeTicket({ deviceId: 'dev-1', deviceHostname: 'e2e-windows.local' }));
    render(<TicketWorkbench ticketId="tk-1" />);
    const line = await screen.findByTestId('ticket-endpoint-line');
    expect(line).toHaveTextContent('e2e-windows.local');
    expect(line).toHaveTextContent('Online');
    expect(line).toHaveTextContent('jordan signed in');
    expect(line).toHaveTextContent('2 alerts');
    // The alert count follows the device and never truncates; the signed-in
    // user goes first when the line is short of room.
    const count = within(line).getByTestId('ticket-endpoint-line-alerts');
    expect(count).toHaveTextContent('2 alerts');
    expect(count.className).toContain('shrink-0');
    const state = within(line).getByTestId('ticket-endpoint-line-state');
    expect(count.compareDocumentPosition(state) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(state.textContent).toMatch(/Online.*jordan signed in/);
    expect(within(line).getByTestId('connect-desktop-mock')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ticket-endpoint-line-open'));
    expect(screen.getByTestId('ticket-workbench-tab-details')).toHaveAttribute('aria-selected', 'true');
  });

  it('the endpoint line says Offline with the last-seen age and offers no Remote in', async () => {
    authState.permissions = [{ resource: 'devices', action: 'read' }, { resource: 'remote', action: 'access' }];
    endpoint.value = {
      state: { kind: 'ready', device: { ...ONLINE_DEVICE, status: 'offline', lastSeenAt: inMinutes(-26 * 60) } },
      session: { value: null, failed: false },
      alerts: [],
    };
    mockApi(makeTicket({ deviceId: 'dev-1', deviceHostname: 'e2e-windows.local' }));
    render(<TicketWorkbench ticketId="tk-1" />);
    const line = await screen.findByTestId('ticket-endpoint-line');
    expect(line).toHaveTextContent('Offline');
    expect(line).toHaveTextContent(/1 day ago/);
    expect(within(line).queryByTestId('connect-desktop-mock')).toBeNull();
  });

  it('phone width: the assignee is a compact initials control on the status row, driving the same select', async () => {
    mockApi(makeTicket({ assignedTo: 'u-1', assigneeName: 'Breeze Admin' }));
    render(<TicketWorkbench ticketId="tk-1" assignees={[{ id: 'u-1', name: 'Breeze Admin', email: 'a@example.com' }]} />);
    const avatar = await screen.findByTestId('ticket-workbench-assignee-avatar');
    expect(avatar).toHaveTextContent('BA');
    expect(avatar.className).toContain('sm:hidden');
    const select = screen.getByTestId('ticket-workbench-assignee');
    // Invisible over the avatar below 640px, a normal select from sm up.
    expect(select.className).toContain('opacity-0');
    expect(select.className).toContain('sm:opacity-100');
    expect(select).toHaveValue('u-1');
    expect(select).toHaveAccessibleName('Assignee');
    // Same row as Status: no full-width assignee row on a phone.
    expect(select.className).not.toContain('min-w-[9rem]');
  });

  it('phone width: the header scrolls away with the thread; the tab bar and composer stay pinned', async () => {
    mockApi(makeTicket());
    render(<TicketWorkbench ticketId="tk-1" />);
    const root = await screen.findByTestId('ticket-workbench');
    expect(root.className).toContain('max-sm:overflow-y-auto');
    expect(screen.getByTestId('ticket-workbench-tabs').className).toContain('max-sm:sticky');
    const zone = screen.getByTestId('ticket-composer-zone');
    expect(zone.className).toContain('max-sm:sticky');
    expect(zone.className).toContain('max-sm:bottom-0');
  });

  it('arrow keys move between the two tabs', async () => {
    mockApi(makeTicket());
    render(<TicketWorkbench ticketId="tk-1" />);
    const conversationTab = await screen.findByTestId('ticket-workbench-tab-conversation');
    conversationTab.focus();
    fireEvent.keyDown(conversationTab, { key: 'ArrowRight' });
    expect(screen.getByTestId('ticket-workbench-tab-details')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('ticket-workbench-tab-details')).toHaveFocus();
  });
});

describe('TicketWorkbench focus layout — 1024px and up', () => {
  beforeEach(() => setViewport(true));

  it('shows the conversation and the situation column side by side, with no tabs', async () => {
    mockApi(makeTicket());
    render(<TicketWorkbench ticketId="tk-1" />);
    await screen.findByTestId('ticket-workbench');
    expect(screen.queryByRole('tablist', { name: 'Ticket sections' })).toBeNull();
    expect(screen.getByTestId('ticket-workbench-conversation')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('ticket-workbench-rail')).not.toHaveAttribute('hidden');
  });

  it('renders the description as message 1, by the requester, at the created time, with its edit affordance', async () => {
    mockApi(makeTicket({ comments: [{ id: 'c-1', userId: 'u', portalUserId: null, authorName: 'Tech', authorType: 'internal', commentType: 'comment', content: 'On it', isPublic: true, oldValue: null, newValue: null, createdAt: '2026-06-01T11:00:00.000Z' }] }));
    render(<TicketWorkbench ticketId="tk-1" />);
    const first = await screen.findByTestId('ticket-description-message');
    expect(first).toHaveTextContent('Pat Smith');
    expect(first).toHaveTextContent('The office printer shows error 49');
    expect(first.querySelector('time')).toHaveAttribute('dateTime', '2026-06-01T10:00:00.000Z');
    expect(within(first).getByTestId('ticket-workbench-description-edit-btn')).toBeInTheDocument();
    // Message 1 comes before the first comment.
    const comment = screen.getByTestId('ticket-comment-c-1');
    expect(first.compareDocumentPosition(comment) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('header carries Status, Priority and Assignee inline; Type, Category and billing live in Details', async () => {
    mockApi(makeTicket());
    authState.permissions = [{ resource: 'tickets', action: 'write' }];
    render(<TicketWorkbench ticketId="tk-1" categories={[{ id: 'cat-1', name: 'Hardware' }]} />);
    const header = await screen.findByTestId('ticket-focus-header');
    expect(within(header).getByTestId('ticket-workbench-status')).toBeInTheDocument();
    expect(within(header).getByTestId('ticket-workbench-priority')).toBeInTheDocument();
    expect(within(header).queryByTestId('ticket-workbench-type')).toBeNull();
    expect(within(header).queryByTestId('ticket-workbench-category')).toBeNull();
    expect(within(header).queryByTestId('ticket-workbench-create-invoice')).toBeNull();
    expect(within(header).getByTestId('ticket-workbench-meta')).toHaveTextContent('Acme Corp');
    expect(within(header).getByTestId('ticket-workbench-meta')).toHaveTextContent('Pat Smith');

    const props = screen.getByTestId('ticket-details-properties');
    expect(within(props).getByTestId('ticket-workbench-type')).toBeInTheDocument();
    expect(within(props).getByTestId('ticket-workbench-category')).toBeInTheDocument();
    const billing = screen.getByTestId('ticket-details-billing');
    expect(within(billing).getByTestId('ticket-workbench-create-invoice')).toBeInTheDocument();
    // Closed by default, each summary carrying its key fact.
    expect(props).not.toHaveAttribute('open');
    expect(billing).not.toHaveAttribute('open');
    expect(within(props).getByTestId('ticket-details-properties-summary')).toHaveTextContent('Incident');
  });

  it('More holds Move to another org, Merge into and Delete (with its confirm)', async () => {
    mockApi(makeTicket());
    authState.permissions = [{ resource: 'tickets', action: 'write' }, { resource: 'tickets', action: 'manage' }];
    render(<TicketWorkbench ticketId="tk-1" />);
    await screen.findByTestId('ticket-focus-header');
    expect(screen.queryByTestId('ticket-delete-button')).toBeNull();

    fireEvent.click(screen.getByTestId('ticket-workbench-more'));
    expect(screen.getByTestId('ticket-workbench-move-org')).toHaveAttribute('role', 'menuitem');
    expect(screen.getByTestId('ticket-merge-open')).toHaveAttribute('role', 'menuitem');
    fireEvent.click(screen.getByTestId('ticket-delete-button'));
    expect(await screen.findByTestId('ticket-delete-confirm')).toBeInTheDocument();
  });

  it('Ask AI sits in the composer toolbar', async () => {
    mockApi(makeTicket());
    render(<TicketWorkbench ticketId="tk-1" />);
    const toolbar = await screen.findByTestId('ticket-composer-toolbar');
    expect(within(toolbar).getByTestId('wisp-talk-button-mock')).toBeInTheDocument();
  });

  it('hands the composer the requester email for its recipient line', async () => {
    mockApi(makeTicket());
    render(<TicketWorkbench ticketId="tk-1" />);
    expect(await screen.findByTestId('ticket-composer-recipient')).toHaveTextContent('Emails Pat Smith <pat@example.com>');
  });

  it('a resolved ticket reads as resolved in the header once (the Status select), with its resolution line', async () => {
    mockApi(makeTicket({ status: 'resolved', resolutionNote: 'Replaced the fuser' }));
    render(<TicketWorkbench ticketId="tk-1" />);
    const header = await screen.findByTestId('ticket-focus-header');
    expect(within(header).getByTestId('ticket-workbench-status')).toHaveValue('resolved');
    expect(within(header).queryByTestId('ticket-workbench-state-chip')).toBeNull();
    expect(screen.getByTestId('ticket-workbench-resolution')).toHaveTextContent('Replaced the fuser');
  });

  it('the resolve form replaces the composer in the composer zone without dropping the draft', async () => {
    mockApi(makeTicket());
    render(<TicketWorkbench ticketId="tk-1" />);
    const input = await screen.findByTestId('ticket-composer-input');
    fireEvent.change(input, { target: { value: 'Draft before resolving' } });
    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'resolved' } });

    const zone = screen.getByTestId('ticket-composer-zone');
    expect(within(zone).getByTestId('ticket-workbench-resolve-form')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-composer')).toHaveAttribute('hidden');

    fireEvent.click(within(zone).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByTestId('ticket-composer')).not.toHaveAttribute('hidden'));
    expect(screen.getByTestId('ticket-composer-input')).toHaveValue('Draft before resolving');
  });

  it('reads an at-risk SLA in the header as time left, in the at-risk style', async () => {
    mockApi(makeTicket({ resolutionDueAt: inMinutes(254), resolutionWarnAt: inMinutes(-5) }));
    render(<TicketWorkbench ticketId="tk-1" />);
    const sla = within(await screen.findByTestId('ticket-focus-header')).getByTestId('ticket-workbench-sla');
    expect(sla).toHaveTextContent(/4h 1[34]m left/);
    expect(sla.innerHTML).toContain('warning');
  });

  it('has no endpoint line when the Details column is already beside the thread', async () => {
    endpoint.value = { state: { kind: 'ready', device: ONLINE_DEVICE }, session: null, alerts: [] };
    mockApi(makeTicket({ deviceId: 'dev-1', deviceHostname: 'e2e-windows.local' }));
    render(<TicketWorkbench ticketId="tk-1" />);
    await screen.findByTestId('ticket-focus-header');
    expect(screen.queryByTestId('ticket-endpoint-line')).toBeNull();
  });

  it('Log time in the composer toolbar opens the time entry in the composer zone and saves it once', async () => {
    mockApi(makeTicket());
    render(<TicketWorkbench ticketId="tk-1" />);
    const toggle = await screen.findByTestId('ticket-composer-log-time');
    expect(within(screen.getByTestId('ticket-composer-toolbar')).getByTestId('ticket-composer-log-time')).toBe(toggle);
    fireEvent.click(toggle);
    const panel = within(screen.getByTestId('ticket-composer-zone')).getByTestId('ticket-log-time-panel');
    fireEvent.change(within(panel).getByTestId('ticket-log-time-minutes'), { target: { value: '15' } });
    fireEvent.click(within(panel).getByTestId('ticket-log-time-submit'));
    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([url, init]) => String(url) === '/time-entries' && init?.method === 'POST');
      expect(posts).toHaveLength(1);
      const body = JSON.parse(String(posts[0]![1]!.body));
      expect(body.ticketId).toBe('tk-1');
      expect(new Date(body.endedAt).getTime() - new Date(body.startedAt).getTime()).toBe(15 * 60_000);
    });
    await waitFor(() => expect(screen.queryByTestId('ticket-log-time-panel')).toBeNull());
  });

  it('the composer zone spans the column; only its contents keep the thread measure', async () => {
    mockApi(makeTicket());
    render(<TicketWorkbench ticketId="tk-1" />);
    const zone = await screen.findByTestId('ticket-composer-zone');
    // The rule and the internal wash run the full column width…
    expect(zone.className).not.toContain('max-w');
    expect(screen.getByTestId('ticket-composer').className).not.toContain('max-w');
    expect(screen.queryByTestId('ticket-composer-zone-measure')).toBeNull();
    // …while what is written keeps the feed's right edge.
    expect(screen.getByTestId('ticket-composer-content').className).toContain('max-w-[78ch]');
    expect(screen.getByTestId('ticket-workbench-rail').className).toContain('w-[360px]');
  });

  it('resolving without the success toast when the host shows its own next-ticket strip', async () => {
    mockApi(makeTicket());
    render(<TicketWorkbench ticketId="tk-1" resolveToast={false} />);
    await screen.findByTestId('ticket-composer-input');
    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'resolved' } });
    fireEvent.change(screen.getByTestId('ticket-workbench-resolve-note'), { target: { value: 'Fixed' } });
    fireEvent.click(screen.getByTestId('ticket-workbench-resolve-submit'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/tickets/tk-1/status' && init?.method === 'POST')).toBe(true));
    await waitFor(() => expect(screen.queryByTestId('ticket-workbench-resolve-form')).toBeNull());
    expect(showToast.mock.calls.some(([arg]) => (arg as { message?: string }).message === 'Ticket resolved')).toBe(false);
  });

  it('moves Related tickets out of the conversation into Details', async () => {
    mockApi(makeTicket());
    render(<TicketWorkbench ticketId="tk-1" />);
    await screen.findByTestId('ticket-workbench');
    expect(within(screen.getByTestId('ticket-workbench-conversation')).queryByTestId('ticket-links-card-stub')).toBeNull();
    expect(within(screen.getByTestId('ticket-details-related')).getByTestId('ticket-links-card-stub')).toBeInTheDocument();
  });
});
