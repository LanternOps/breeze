import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateTicketFromChatInput } from '@breeze/shared';

const storageHarness = vi.hoisted(() => {
  const data = new Map<string, string>();
  const localStorageMock = {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
    clear: vi.fn(() => {
      data.clear();
    }),
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageMock,
    configurable: true,
  });
  return { data, localStorageMock };
});

vi.mock('./auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../components/shared/Toast', () => ({
  showToast: vi.fn(),
}));

import { showToast } from '../components/shared/Toast';
import { fetchWithAuth } from './auth';
import { useWorkspaceStore, type TabState } from './workspaceStore';

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);

const makeResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

function tab(over: Partial<TabState> = {}): TabState {
  return {
    id: 'tab-1',
    sessionId: 'session-1',
    title: 'Chat',
    contextLabel: null,
    pageContext: null,
    messages: [],
    isStreaming: false,
    isLoading: false,
    error: null,
    pendingApproval: null,
    pendingPlan: null,
    activePlan: null,
    approvalMode: 'auto_approve',
    isPaused: false,
    isInterrupting: false,
    isFlagged: false,
    unreadCount: 0,
    hasApprovalPending: false,
    ...over,
  };
}

const ticketPayload: CreateTicketFromChatInput = {
  subject: 'S',
  description: 'P',
  status: 'open',
  timeMinutes: 0,
  billable: true,
};

function warningToasts() {
  return showToastMock.mock.calls.filter(([toast]) => toast.type === 'warning');
}

describe('workspace store ticket actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageHarness.data.clear();
    useWorkspaceStore.setState({
      tabs: [tab()],
      activeTabId: 'tab-1',
      _readers: new Map(),
    });
  });

  it('draftTicketFromChat throws the extracted API message on failure', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeResponse({ error: 'Draft unavailable' }, false, 502));

    await expect(useWorkspaceStore.getState().draftTicketFromChat('tab-1')).rejects.toThrow('Draft unavailable');
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/ai/sessions/session-1/ticket-draft', { method: 'POST' });
  });

  it('draftTicketFromChat throws when the tab has no active session', async () => {
    useWorkspaceStore.setState({ tabs: [tab({ sessionId: null })] });

    await expect(useWorkspaceStore.getState().draftTicketFromChat('tab-1')).rejects.toThrow('No active session');
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('saveTicketFromChat maps internalNumber to ticketNumber and emits no partial-success warnings', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeResponse({ data: { internalNumber: 'INT-7' }, resolved: true, timeLogged: true }),
    );

    const result = await useWorkspaceStore.getState().saveTicketFromChat('tab-1', {
      ...ticketPayload,
      status: 'resolved',
      resolutionNote: 'Fixed',
      timeMinutes: 15,
    });

    expect(result).toEqual({ ticketNumber: 'INT-7', resolved: true, timeLogged: true });
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/ai/sessions/session-1/ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...ticketPayload, status: 'resolved', resolutionNote: 'Fixed', timeMinutes: 15 }),
    });
    expect(warningToasts()).toHaveLength(0);
  });

  it('saveTicketFromChat warns when requested resolve does not complete', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeResponse({ data: { ticketNumber: 'ORG-1' }, resolved: false, timeLogged: false }),
    );

    await useWorkspaceStore.getState().saveTicketFromChat('tab-1', {
      ...ticketPayload,
      status: 'resolved',
      resolutionNote: 'Fixed',
    });

    expect(showToastMock).toHaveBeenCalledWith({
      type: 'warning',
      message: 'Ticket created, but it could not be resolved automatically — please resolve it manually.',
    });
  });

  it('saveTicketFromChat warns when requested time does not log', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeResponse({ data: { ticketNumber: 'ORG-1' }, resolved: false, timeLogged: false }),
    );

    await useWorkspaceStore.getState().saveTicketFromChat('tab-1', {
      ...ticketPayload,
      timeMinutes: 15,
    });

    expect(showToastMock).toHaveBeenCalledWith({
      type: 'warning',
      message: 'Ticket created, but the time entry could not be logged.',
    });
  });
});
