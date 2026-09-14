// Checklist soft-confirm on resolve/close (#5808 W01 Task 12). Scaffolding
// copied from TicketWorkbench.test.tsx (same fetchWithAuth/toast/config mocks);
// TicketChecklistCard itself is stubbed here so each test can drive
// onCountsChange directly rather than wiring a real checklist fetch — the
// card's own behaviour is covered by TicketChecklistCard.test.tsx.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TicketWorkbench from './TicketWorkbench';
import { fetchWithAuth } from '../../stores/auth';
import { fetchTicketConfig } from '../../lib/ticketConfigApi';
import type { TicketDetail } from './ticketConfig';

type Perm = { resource: string; action: string };
const authState = vi.hoisted(() => ({ permissions: [] as Perm[] }));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (selector: (s: { user: { name: string; permissions: Perm[] } | null }) => unknown) =>
    selector({ user: { name: 'Test Agent', permissions: authState.permissions } }),
}));

vi.mock('./TicketPartsCard', () => ({ default: () => <div data-testid="ticket-parts-card-stub" /> }));

type Counts = { done: number; total: number; known: boolean };
const checklistStub = vi.hoisted(() => ({ onCountsChange: null as null | ((c: Counts) => void) }));
vi.mock('./TicketChecklistCard', () => ({
  default: (p: { ticketId: string; onCountsChange?: (c: Counts) => void }) => {
    checklistStub.onCountsChange = p.onCountsChange ?? null;
    return <div data-testid="ticket-checklist-card-stub" />;
  },
}));

vi.mock('../../lib/ticketConfigApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/ticketConfigApi')>();
  return { ...actual, fetchTicketConfig: vi.fn().mockResolvedValue(null) };
});
const fetchConfigMock = vi.mocked(fetchTicketConfig);
void fetchConfigMock;

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
    json: vi.fn().mockResolvedValue(payload),
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
  ...overrides,
});

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

const emitCounts = (counts: Counts) => act(() => checklistStub.onCountsChange?.(counts));

beforeEach(() => {
  vi.clearAllMocks();
  authState.permissions = [];
  checklistStub.onCountsChange = null;
});

describe('TicketWorkbench checklist resolve/close confirm', () => {
  it('confirms before resolving when the checklist has unticked steps', async () => {
    mockTicketApi({ 'tk-1': makeTicket() });
    render(<TicketWorkbench ticketId="tk-1" />);
    await screen.findByTestId('ticket-workbench');
    emitCounts({ done: 1, total: 3, known: true });

    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'resolved' } });

    expect(await screen.findByTestId('ticket-checklist-resolve-confirm')).toBeInTheDocument();
    expect(screen.queryByTestId('ticket-workbench-resolve-form')).toBeNull();
    expect(mutationCalls()).toHaveLength(0);
  });

  it('confirms before closing when the checklist has unticked steps', async () => {
    mockTicketApi({ 'tk-1': makeTicket() });
    render(<TicketWorkbench ticketId="tk-1" />);
    await screen.findByTestId('ticket-workbench');
    emitCounts({ done: 0, total: 2, known: true });

    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'closed' } });

    expect(await screen.findByTestId('ticket-checklist-resolve-confirm')).toBeInTheDocument();
    expect(mutationCalls()).toHaveLength(0);
  });

  it('proceeds with the close on accept', async () => {
    mockTicketApi({ 'tk-1': makeTicket() });
    render(<TicketWorkbench ticketId="tk-1" />);
    await screen.findByTestId('ticket-workbench');
    emitCounts({ done: 0, total: 2, known: true });

    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'closed' } });
    fireEvent.click(await screen.findByTestId('ticket-checklist-resolve-confirm-accept'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/status',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ status: 'closed' }) }),
      );
    });
    expect(screen.queryByTestId('ticket-checklist-resolve-confirm')).toBeNull();
  });

  it('proceeds with the resolve form on accept', async () => {
    mockTicketApi({ 'tk-1': makeTicket() });
    render(<TicketWorkbench ticketId="tk-1" />);
    await screen.findByTestId('ticket-workbench');
    emitCounts({ done: 1, total: 3, known: true });

    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'resolved' } });
    fireEvent.click(await screen.findByTestId('ticket-checklist-resolve-confirm-accept'));

    expect(await screen.findByTestId('ticket-workbench-resolve-form')).toBeInTheDocument();
    expect(screen.queryByTestId('ticket-checklist-resolve-confirm')).toBeNull();
  });

  it('does not confirm when the checklist is fully ticked (3/3)', async () => {
    mockTicketApi({ 'tk-1': makeTicket() });
    render(<TicketWorkbench ticketId="tk-1" />);
    await screen.findByTestId('ticket-workbench');
    emitCounts({ done: 3, total: 3, known: true });

    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'resolved' } });

    expect(screen.queryByTestId('ticket-checklist-resolve-confirm')).toBeNull();
    expect(await screen.findByTestId('ticket-workbench-resolve-form')).toBeInTheDocument();
  });

  it('does not confirm when the ticket has no checklist (0/0)', async () => {
    mockTicketApi({ 'tk-1': makeTicket() });
    render(<TicketWorkbench ticketId="tk-1" />);
    await screen.findByTestId('ticket-workbench');
    emitCounts({ done: 0, total: 0, known: true });

    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'closed' } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/status',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ status: 'closed' }) }),
      );
    });
    expect(screen.queryByTestId('ticket-checklist-resolve-confirm')).toBeNull();
  });

  it('FAILS CLOSED: confirms when the checklist could not be loaded, even though the counts read 0/0', async () => {
    // A failed fetch leaves the card at 0/0, byte-identical to "no checklist".
    // Treating that as empty would silently skip the prompt on a network blip —
    // exactly when the technician most needs to be asked. `known: false` is the
    // discriminator, and the gate must fail closed on it.
    mockTicketApi({ 'tk-1': makeTicket() });
    render(<TicketWorkbench ticketId="tk-1" />);
    await screen.findByTestId('ticket-workbench');
    emitCounts({ done: 0, total: 0, known: false });

    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'closed' } });

    expect(await screen.findByTestId('ticket-checklist-resolve-confirm')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/tickets/tk-1/status',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('does not confirm for statuses other than resolved/closed', async () => {
    mockTicketApi({ 'tk-1': makeTicket({ status: 'new' }) });
    render(<TicketWorkbench ticketId="tk-1" />);
    await screen.findByTestId('ticket-workbench');
    emitCounts({ done: 1, total: 3, known: true });

    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'open' } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/tickets/tk-1/status',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ status: 'open' }) }),
      );
    });
    expect(screen.queryByTestId('ticket-checklist-resolve-confirm')).toBeNull();
  });

  it('cancel dismisses the confirm without mutating', async () => {
    mockTicketApi({ 'tk-1': makeTicket() });
    render(<TicketWorkbench ticketId="tk-1" />);
    await screen.findByTestId('ticket-workbench');
    emitCounts({ done: 1, total: 3, known: true });

    fireEvent.change(screen.getByTestId('ticket-workbench-status'), { target: { value: 'closed' } });
    fireEvent.click(await screen.findByTestId('ticket-checklist-resolve-confirm-cancel'));

    expect(screen.queryByTestId('ticket-checklist-resolve-confirm')).toBeNull();
    expect(mutationCalls()).toHaveLength(0);
  });
});
