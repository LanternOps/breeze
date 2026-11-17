/**
 * #9429 end to end: the real stores with the real notification lib (only the
 * browser Notification API is faked). Proves the seam the per-side tests mock
 * away: a real error→done turn shows exactly one "failed", the next turn
 * shows "ready", and the visibility rule holds with each store's own flag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({ user: { id: 'u1' } as { id: string } | null }));
vi.mock('./auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: { getState: () => authState },
}));
vi.mock('./orgStore', () => ({ useOrgStore: { getState: () => ({ currentOrgId: null }) } }));
vi.mock('../components/shared/Toast', () => ({ showToast: vi.fn() }));

import { fetchWithAuth } from './auth';
import { useAiStore } from './aiStore';
import { useWorkspaceStore, type TabState } from './workspaceStore';
import { abortAllAttaches } from './aiSessionAttach';
import { resetAiNotificationsForTests, setNotifyOptIn } from '@/lib/aiNotifications';

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn();
  static instances: FakeNotification[] = [];
  options: NotificationOptions;
  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn(() => { this.onclose?.(); });
  constructor(_title: string, options: NotificationOptions) {
    this.options = options;
    FakeNotification.instances.push(this);
  }
}
const g = globalThis as unknown as { Notification?: unknown };
const fetchMock = vi.mocked(fetchWithAuth);
const bodies = () => FakeNotification.instances.map((n) => n.options.body);

function setDocumentState(visibility: 'visible' | 'hidden', focused: boolean) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused);
}

const sse = (events: unknown[]): Response => {
  const bytes = new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
  return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }) } as unknown as Response;
};
const failedTurn = () => sse([
  { type: 'message_start', messageId: 'a1' },
  { type: 'error', message: 'AI request timed out.', code: 'timeout' },
  { type: 'done' },
]);
const okTurn = () => sse([{ type: 'message_start', messageId: 'a2' }, { type: 'content_delta', delta: 'ok' }, { type: 'done' }]);
const approvalTurn = () => sse([{ type: 'approval_required', executionId: 'e1', toolName: 'run_script', input: {}, description: 'x' }]);

function tab(id: string, sessionId: string): TabState {
  return {
    id, sessionId, title: 'Chat', isTitleCustom: false, contextLabel: null, pageContext: null,
    messages: [], chatRuns: {}, isStreaming: false, isLoading: false, error: null, errorCode: null, errorDetail: null,
    retryTarget: null, pendingApproval: null, pendingPlan: null, activePlan: null, approvalMode: 'per_step',
    isPaused: false, isInterrupting: false, isFlagged: false, unreadCount: 0, hasApprovalPending: false, orgId: null,
    deviceId: null, deviceLabel: null, m365ConnectionId: null, composerDraft: '', joinedMidResponse: false,
    errorAction: null, wisp: { kind: 'plain' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  FakeNotification.permission = 'granted';
  FakeNotification.instances = [];
  g.Notification = FakeNotification;
  authState.user = { id: 'u1' };
  localStorage.clear();
  resetAiNotificationsForTests();
  setNotifyOptIn('u1', true);
  setDocumentState('hidden', false);
  useAiStore.setState({
    isOpen: false, sessionId: 's1', messages: [], isStreaming: false, isLoading: false,
    error: null, errorCode: null, errorDetail: null, retryTarget: null,
    pageContext: null, pendingApproval: null, topologySiteId: null, composerDraft: '', wisp: null,
  });
  useWorkspaceStore.getState().cleanupAllStreams();
  useWorkspaceStore.setState({ tabs: [tab('t1', 'w1'), tab('t2', 'w2')], activeTabId: 't1' });
});

afterEach(() => {
  useWorkspaceStore.getState().cleanupAllStreams();
  abortAllAttaches();
  vi.restoreAllMocks();
  delete g.Notification;
});

describe('side panel, real lib (#9429)', () => {
  it('error then done shows exactly one "failed"; the next turn shows "ready"', async () => {
    fetchMock.mockResolvedValueOnce(failedTurn());
    await useAiStore.getState().sendMessage('first');
    expect(bodies()).toEqual(['Response failed']);
    fetchMock.mockResolvedValueOnce(okTurn());
    await useAiStore.getState().sendMessage('second');
    expect(bodies()).toEqual(['Response failed', 'Response ready']);
  });

  it('a request that throws shows one "failed"; the next turn shows "ready"', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await useAiStore.getState().sendMessage('first');
    fetchMock.mockResolvedValueOnce(okTurn());
    await useAiStore.getState().sendMessage('second');
    expect(bodies()).toEqual(['Response failed', 'Response ready']);
  });

  it('open and focused: silent for "ready"; closed on a focused page: notifies only for approval', async () => {
    setDocumentState('visible', true);
    useAiStore.setState({ isOpen: true });
    fetchMock.mockResolvedValueOnce(okTurn());
    await useAiStore.getState().sendMessage('a');
    expect(bodies()).toEqual([]);
    useAiStore.setState({ isOpen: false });
    fetchMock.mockResolvedValueOnce(okTurn());
    await useAiStore.getState().sendMessage('b');
    expect(bodies()).toEqual([]);
    fetchMock.mockResolvedValueOnce(approvalTurn());
    await useAiStore.getState().sendMessage('c');
    expect(bodies()).toEqual(['Needs your approval']);
  });

  it('clicking opens the panel; opening the panel closes the notification', async () => {
    vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(okTurn());
    await useAiStore.getState().sendMessage('a');
    const n = FakeNotification.instances[0]!;
    n.onclick?.();
    expect(useAiStore.getState().isOpen).toBe(true);
    expect(n.close).toHaveBeenCalled();
  });
});

describe('workspace, real lib (#9429)', () => {
  it('error then done on a tab shows one "failed"; its next turn shows "ready"', async () => {
    fetchMock.mockResolvedValueOnce(failedTurn());
    await useWorkspaceStore.getState().sendMessage('t2', 'first');
    fetchMock.mockResolvedValueOnce(okTurn());
    await useWorkspaceStore.getState().sendMessage('t2', 'second');
    expect(bodies()).toEqual(['Response failed', 'Response ready']);
  });

  it('on a focused page: the active tab stays silent, a background tab notifies only for approval', async () => {
    setDocumentState('visible', true);
    fetchMock.mockResolvedValueOnce(okTurn());
    await useWorkspaceStore.getState().sendMessage('t1', 'a');
    fetchMock.mockResolvedValueOnce(okTurn());
    await useWorkspaceStore.getState().sendMessage('t2', 'b');
    expect(bodies()).toEqual([]);
    fetchMock.mockResolvedValueOnce(approvalTurn());
    await useWorkspaceStore.getState().sendMessage('t2', 'c');
    expect(bodies()).toEqual(['Needs your approval']);
  });

  it('switching to the tab closes its notification; a click switches to the tab', async () => {
    vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(okTurn());
    await useWorkspaceStore.getState().sendMessage('t2', 'a');
    fetchMock.mockResolvedValueOnce(approvalTurn());
    await useWorkspaceStore.getState().sendMessage('t2', 'b');
    const [ready, approval] = FakeNotification.instances;
    useWorkspaceStore.getState().switchTab('t2');
    expect(ready!.close).toHaveBeenCalled();
    expect(approval!.close).toHaveBeenCalled();

    useWorkspaceStore.getState().switchTab('t1');
    fetchMock.mockResolvedValueOnce(okTurn());
    await useWorkspaceStore.getState().sendMessage('t2', 'c');
    FakeNotification.instances.at(-1)!.onclick?.();
    expect(useWorkspaceStore.getState().activeTabId).toBe('t2');
  });

  it('a tab closed after a broken turn does not suppress "ready" for a new tab with the same id', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await useWorkspaceStore.getState().sendMessage('t2', 'a');
    useWorkspaceStore.getState().closeTab('t2');
    useWorkspaceStore.setState((s) => ({ tabs: [...s.tabs, tab('t2', 'w3')] }));
    fetchMock.mockResolvedValueOnce(okTurn());
    await useWorkspaceStore.getState().sendMessage('t2', 'b');
    expect(bodies()).toEqual(['Response failed', 'Response ready']);
  });
});
