/**
 * #9429: each workspace tab's stream (send or attach) feeds the notification
 * tracker for that tab; reading the tab (switchTab / markTabRead / closeTab)
 * closes its notifications. The event mapping and visibility rule are tested
 * in lib/aiNotifications.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('../components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/aiNotifications', () => ({
  noteAiTurnEvent: vi.fn(),
  noteAiStreamFailure: vi.fn(),
  resetAiTurnNotify: vi.fn(),
  closeAiNotification: vi.fn(),
}));

import { fetchWithAuth } from './auth';
import { useWorkspaceStore, type TabState } from './workspaceStore';
import { abortAllAttaches } from './aiSessionAttach';
import {
  closeAiNotification,
  noteAiStreamFailure,
  noteAiTurnEvent,
  resetAiTurnNotify,
  type AiNotifyContext,
} from '@/lib/aiNotifications';

const fetchMock = vi.mocked(fetchWithAuth);
const noteEvent = vi.mocked(noteAiTurnEvent);
const T1 = 'tab-a';
const T2 = 'tab-b';
const surface = (tabId: string) => ({ kind: 'workspace', tabId });

const sse = (events: unknown[]): Response => {
  const bytes = new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
  return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }) } as unknown as Response;
};
const okTurn = () => sse([
  { type: 'message_start', messageId: 'srv-a1' },
  { type: 'content_delta', delta: 'All good.' },
  { type: 'done' },
]);

function tab(id: string, sessionId: string, over: Partial<TabState> = {}): TabState {
  return {
    id, sessionId, title: 'Chat', isTitleCustom: false, contextLabel: null, pageContext: null,
    messages: [], chatRuns: {}, isStreaming: false, isLoading: false, error: null, errorCode: null, errorDetail: null,
    retryTarget: null, pendingApproval: null, pendingPlan: null, activePlan: null, approvalMode: 'per_step',
    isPaused: false, isInterrupting: false, isFlagged: false, unreadCount: 0, hasApprovalPending: false, orgId: null,
    deviceId: null, deviceLabel: null, m365ConnectionId: null, composerDraft: '', joinedMidResponse: false,
    errorAction: null, wisp: { kind: 'plain' },
    ...over,
  };
}
const store = () => useWorkspaceStore.getState();
const tabOf = (id: string) => store().tabs.find((t) => t.id === id)!;
const callsFor = (tabId: string) => noteEvent.mock.calls.filter(([, s]) => (s as { tabId?: string }).tabId === tabId);
const lastCtxFor = (tabId: string) => callsFor(tabId).at(-1)![2] as AiNotifyContext;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  store().cleanupAllStreams();
  useWorkspaceStore.setState({ tabs: [tab(T1, 's1'), tab(T2, 's2')], activeTabId: T1 });
});

afterEach(() => {
  store().cleanupAllStreams();
  abortAllAttaches();
});

describe('workspaceStore notifications (#9429)', () => {
  it('a background tab hands its events to the tracker with surfaceVisible=false', async () => {
    fetchMock.mockResolvedValueOnce(okTurn());
    await store().sendMessage(T2, 'hello');
    expect(callsFor(T2).map(([type]) => type)).toEqual(['message_start', 'content_delta', 'done']);
    expect(lastCtxFor(T2)).toMatchObject({ sessionId: 's2', surfaceVisible: false });
    expect(callsFor(T1)).toHaveLength(0);
  });

  it('the active tab reports surfaceVisible=true (the lib then stays quiet unless the page is hidden)', async () => {
    fetchMock.mockResolvedValueOnce(okTurn());
    await store().sendMessage(T1, 'hello');
    expect(lastCtxFor(T1)).toMatchObject({ sessionId: 's1', surfaceVisible: true });
  });

  it('starts each turn with a clean failure state for that tab', async () => {
    fetchMock.mockResolvedValueOnce(okTurn());
    await store().sendMessage(T2, 'hello');
    expect(resetAiTurnNotify).toHaveBeenCalledWith(surface(T2));
    expect(vi.mocked(resetAiTurnNotify).mock.invocationCallOrder[0]!)
      .toBeLessThan(noteEvent.mock.invocationCallOrder[0]!);
  });

  it('a background approval still raises the tab badge (existing behaviour) and reaches the tracker', async () => {
    fetchMock.mockResolvedValueOnce(sse([
      { type: 'approval_required', executionId: 'e1', toolName: 'run_script', input: {}, description: 'x' },
    ]));
    await store().sendMessage(T2, 'hello');
    expect(tabOf(T2).hasApprovalPending).toBe(true);
    expect(callsFor(T2).map(([type]) => type)).toEqual(['approval_required']);
  });

  it('a click switches to the tab', async () => {
    fetchMock.mockResolvedValueOnce(okTurn());
    await store().sendMessage(T2, 'hello');
    lastCtxFor(T2).onOpen();
    expect(store().activeTabId).toBe(T2);
  });

  it('a click for a tab closed since does nothing', async () => {
    fetchMock.mockResolvedValueOnce(okTurn());
    await store().sendMessage(T2, 'hello');
    const ctx = lastCtxFor(T2);
    store().closeTab(T2);
    expect(() => ctx.onOpen()).not.toThrow();
    expect(store().activeTabId).toBe(T1);
  });

  it('a request that throws reports one stream failure for that tab', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await store().sendMessage(T2, 'hello');
    expect(noteAiStreamFailure).toHaveBeenCalledTimes(1);
    expect(vi.mocked(noteAiStreamFailure).mock.calls[0]![0]).toEqual(surface(T2));
  });

  it('a throwing tracker does not break the turn', async () => {
    noteEvent.mockImplementation(() => { throw new Error('notify broke'); });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(okTurn());
    await store().sendMessage(T2, 'hello');
    expect(tabOf(T2).isStreaming).toBe(false);
    expect(tabOf(T2).error).toBeNull();
    expect(tabOf(T2).messages.some((m) => m.role === 'assistant' && m.content === 'All good.')).toBe(true);
  });

  it('switchTab, markTabRead and closeTab close that tab\'s notifications', () => {
    store().switchTab(T2);
    expect(closeAiNotification).toHaveBeenLastCalledWith(surface(T2), 's2');
    store().markTabRead(T1);
    expect(closeAiNotification).toHaveBeenLastCalledWith(surface(T1), 's1');
    store().closeTab(T2);
    expect(closeAiNotification).toHaveBeenLastCalledWith(surface(T2), 's2');
  });

  it('attach-delivered events reach the tracker for that tab, after a reset', async () => {
    // A send refused with turn_in_progress joins the running turn (#9427).
    fetchMock.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/messages') && (init as RequestInit | undefined)?.method === 'POST') {
        return { ok: false, status: 409, json: async () => ({ code: 'turn_in_progress' }) } as unknown as Response;
      }
      if (u.endsWith('/stream')) {
        return sse([
          { type: 'attach_state', turn: 'running', turnId: 't1', lastSeq: 0, turnUserMessageId: null, partial: false, replay: [], pendingCards: [], activePlan: null, turnModel: null },
          { type: 'done' },
        ]);
      }
      return { ok: true, status: 200, json: async () => ({ session: { id: 's2' }, messages: [] }) } as unknown as Response;
    });
    await store().sendMessage(T2, 'hello');
    await vi.waitFor(() => expect(callsFor(T2).map(([type]) => type)).toEqual(['attach_state', 'done']));
    // Once for the refused send, once for the attach that follows the running turn.
    expect(vi.mocked(resetAiTurnNotify).mock.calls).toEqual([[surface(T2)], [surface(T2)]]);
  });
});
