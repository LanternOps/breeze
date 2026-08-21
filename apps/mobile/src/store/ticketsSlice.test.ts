import { describe, it, expect, vi } from 'vitest';

// ticketsSlice -> services/tickets -> services/api, whose RN-specific leaves are
// expo-secure-store and @sentry/react-native. Mock them so the reducer can be
// exercised in the node-only vitest environment (same approach as
// logoutResetContract.test.ts).
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('@sentry/react-native', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import reducer, {
  applyStatusChange,
  setAssignee,
  setQueue,
  clearError,
} from './ticketsSlice';
import type { TicketSummary } from '../services/tickets';

function ticket(over: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: 't1',
    internalNumber: 'TKT-1041',
    subject: 'Printer offline',
    status: 'open',
    priority: 'normal',
    orgId: 'o1',
    orgName: 'Example Org',
    deviceId: null,
    deviceHostname: null,
    assignedTo: null,
    assigneeName: null,
    dueDate: null,
    slaBreachedAt: null,
    firstResponseAt: null,
    createdAt: '2026-08-18T00:00:00Z',
    updatedAt: '2026-08-18T00:00:00Z',
    statusName: null,
    statusColor: null,
    ...over,
  };
}

const seeded = (over: Partial<ReturnType<typeof reducer>> = {}) => ({
  ...reducer(undefined, { type: '@@INIT' }),
  tickets: [ticket()],
  total: 1,
  ...over,
});

describe('ticketsSlice filters', () => {
  it('sets queue and assignee independently', () => {
    let state = reducer(undefined, setQueue('closed'));
    expect(state.queue).toBe('closed');
    expect(state.assignee).toBe('me');
    state = reducer(state, setAssignee('all'));
    expect(state.queue).toBe('closed');
    expect(state.assignee).toBe('all');
  });

  it('clears the error without touching the list', () => {
    const state = reducer({ ...seeded(), error: 'boom' }, clearError());
    expect(state.error).toBeNull();
    expect(state.tickets).toHaveLength(1);
  });
});

describe('applyStatusChange', () => {
  it('updates in place when the ticket still belongs in the open queue', () => {
    const state = reducer(seeded({ queue: 'open' }), applyStatusChange({ id: 't1', status: 'pending' }));
    expect(state.tickets).toHaveLength(1);
    expect(state.tickets[0].status).toBe('pending');
    expect(state.total).toBe(1);
  });

  it('drops a resolved ticket out of the open queue and decrements the total', () => {
    const state = reducer(seeded({ queue: 'open' }), applyStatusChange({ id: 't1', status: 'resolved' }));
    expect(state.tickets).toHaveLength(0);
    expect(state.total).toBe(0);
  });

  it('keeps a resolved ticket when viewing the closed queue', () => {
    const state = reducer(
      seeded({ queue: 'closed', tickets: [ticket({ status: 'closed' })] }),
      applyStatusChange({ id: 't1', status: 'resolved' })
    );
    expect(state.tickets).toHaveLength(1);
    expect(state.tickets[0].status).toBe('resolved');
  });

  it('drops a reopened ticket out of the closed queue', () => {
    const state = reducer(
      seeded({ queue: 'closed', tickets: [ticket({ status: 'closed' })] }),
      applyStatusChange({ id: 't1', status: 'open' })
    );
    expect(state.tickets).toHaveLength(0);
  });

  it('is a no-op for an id that is not in the cached list', () => {
    const state = reducer(seeded(), applyStatusChange({ id: 'other', status: 'resolved' }));
    expect(state.tickets).toHaveLength(1);
    expect(state.total).toBe(1);
  });

  it('never drives the total negative', () => {
    const state = reducer(
      seeded({ queue: 'open', total: 0 }),
      applyStatusChange({ id: 't1', status: 'closed' })
    );
    expect(state.total).toBe(0);
  });
});

describe('fetchTickets filter guard', () => {
  // A fulfilled action only counts when it belongs to the newest started
  // request, so each case starts one first.
  const startedState = (over: Partial<ReturnType<typeof reducer>>) =>
    reducer({ ...seeded({ tickets: [], total: 0 }), ...over }, {
      type: 'tickets/fetchTickets/pending',
      meta: { requestId: 'R1' },
    });
  const fulfilled = (page: unknown, params: unknown) => ({
    type: 'tickets/fetchTickets/fulfilled',
    payload: { page, params },
    meta: { requestId: 'R1' },
  });

  it('applies a response whose filters match the current selection', () => {
    const state = reducer(
      startedState({ queue: 'open', assignee: 'me' }),
      fulfilled({ tickets: [ticket()], total: 1 }, { statusGroup: 'open', assignee: 'me' })
    );
    expect(state.tickets).toHaveLength(1);
    expect(state.total).toBe(1);
  });

  it('discards a slow response for filters the user has already moved off', () => {
    // User was on open/me, switched to closed/me; the in-flight open response
    // lands last and must not clobber the newer list.
    const state = reducer(
      startedState({ queue: 'closed', assignee: 'me' }),
      fulfilled({ tickets: [ticket(), ticket()], total: 2 }, { statusGroup: 'open', assignee: 'me' })
    );
    expect(state.tickets).toHaveLength(0);
    expect(state.total).toBe(0);
  });

  it('discards a stale response when only the assignee changed', () => {
    const state = reducer(
      startedState({ queue: 'open', assignee: 'all' }),
      fulfilled({ tickets: [ticket()], total: 1 }, { statusGroup: 'open', assignee: 'me' })
    );
    expect(state.tickets).toHaveLength(0);
  });
});

describe('fetchTickets request-id ordering', () => {
  const pending = (requestId: string) => ({
    type: 'tickets/fetchTickets/pending',
    meta: { requestId },
  });
  const fulfilledWith = (requestId: string, page: unknown, params: unknown) => ({
    type: 'tickets/fetchTickets/fulfilled',
    payload: { page, params },
    meta: { requestId },
  });
  const rejectedWith = (requestId: string, message: string) => ({
    type: 'tickets/fetchTickets/rejected',
    payload: message,
    meta: { requestId },
  });
  const sameFilters = { statusGroup: 'open', assignee: 'me' };

  it('ignores an older same-filter response that lands after a newer one', () => {
    let state = reducer(seeded({ tickets: [], total: 0 }), pending('A'));
    state = reducer(state, pending('B'));
    // B is newest; it wins.
    state = reducer(state, fulfilledWith('B', { tickets: [ticket()], total: 1 }, sameFilters));
    expect(state.total).toBe(1);
    // A finishes last with two rows and must be discarded.
    state = reducer(
      state,
      fulfilledWith('A', { tickets: [ticket(), ticket()], total: 2 }, sameFilters)
    );
    expect(state.total).toBe(1);
    expect(state.tickets).toHaveLength(1);
  });

  it('ignores a rejection from an abandoned request', () => {
    let state = reducer(seeded(), pending('A'));
    state = reducer(state, pending('B'));
    state = reducer(state, rejectedWith('A', 'stale failure'));
    expect(state.error).toBeNull();
    // ...and it must not clear the spinner while B is still running.
    expect(state.isLoading).toBe(true);
  });

  it('surfaces a rejection from the current request', () => {
    let state = reducer(seeded(), pending('B'));
    state = reducer(state, rejectedWith('B', 'real failure'));
    expect(state.error).toBe('real failure');
    expect(state.isLoading).toBe(false);
  });
});

describe('applyStatusChange custom labels', () => {
  it('clears a stale custom status label when the status moves', () => {
    const state = reducer(
      seeded({ queue: 'open', tickets: [ticket({ statusName: 'Investigating' })] }),
      applyStatusChange({ id: 't1', status: 'pending' })
    );
    // statusLabel() prefers statusName, so keeping it would show
    // "Investigating" on a pending ticket.
    expect(state.tickets[0].statusName).toBeNull();
    expect(state.tickets[0].status).toBe('pending');
  });

  it('adopts a new custom label when one is supplied', () => {
    const state = reducer(
      seeded({ queue: 'open', tickets: [ticket({ statusName: 'Investigating' })] }),
      applyStatusChange({ id: 't1', status: 'pending', statusName: 'Awaiting parts' })
    );
    expect(state.tickets[0].statusName).toBe('Awaiting parts');
  });
});

describe('spinner ownership', () => {
  const pending = (requestId: string) => ({
    type: 'tickets/fetchTickets/pending',
    meta: { requestId },
  });
  const fulfilledWith = (requestId: string, params: unknown) => ({
    type: 'tickets/fetchTickets/fulfilled',
    payload: { page: { tickets: [ticket()], total: 1 }, params },
    meta: { requestId },
  });

  it('clears isLoading when the CURRENT request lands with filters the user moved off', () => {
    // The request is still the newest, so nobody else will clear the spinner.
    // Discard its data, but do not strand isLoading=true.
    let state = reducer(seeded({ queue: 'open', tickets: [], total: 0 }), pending('A'));
    state = reducer(state, setQueue('closed'));
    state = reducer(state, fulfilledWith('A', { statusGroup: 'open', assignee: 'me' }));
    expect(state.isLoading).toBe(false);
    expect(state.tickets).toHaveLength(0);
  });

  it('leaves isLoading true when an OLDER request lands and a newer one is running', () => {
    let state = reducer(seeded({ tickets: [], total: 0 }), pending('A'));
    state = reducer(state, pending('B'));
    state = reducer(state, fulfilledWith('A', { statusGroup: 'open', assignee: 'me' }));
    expect(state.isLoading).toBe(true);
  });
});
