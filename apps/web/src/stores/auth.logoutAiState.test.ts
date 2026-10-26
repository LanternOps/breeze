/**
 * #9840 W3 (Task 14, Review Focus 4, Codex finding 1): logout clears the AI
 * workspace and stops every attach reader before local storage is wiped.
 *
 * evictLocalAuthState runs the registered logout hooks (workspaceStore's
 * resetForLogout, aiSessionAttach's abortAllAttaches) BEFORE its removeItem
 * calls, so the persist middleware cannot write the old tabs back, and then
 * also removes `breeze-workspace`. auth.ts imports neither store (both import
 * ./auth; a cycle would break evictLocalAuthState's synchronous contract).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth')>();
  // Only the request helper the stores use is stubbed; apiLogout and
  // evictLocalAuthState are the real ones.
  return { ...actual, fetchWithAuth: vi.fn() };
});
vi.mock('../components/shared/Toast', () => ({ showToast: vi.fn() }));

import { apiLogout, fetchWithAuth, registerLogoutHook } from './auth';
import { useWorkspaceStore, type TabState } from './workspaceStore';
import { trackAttach } from './aiSessionAttach';

const fetchMock = vi.mocked(fetchWithAuth);
const enc = new TextEncoder();

function tab(over: Partial<TabState>): TabState {
  return {
    id: 'tab-x', sessionId: null, title: 'Chat', isTitleCustom: false, contextLabel: null, pageContext: null,
    messages: [], chatRuns: {}, isStreaming: false, isLoading: false, error: null, pendingApproval: null,
    pendingPlan: null, activePlan: null, approvalMode: 'per_step', isPaused: false, isInterrupting: false,
    isFlagged: false, unreadCount: 0, hasApprovalPending: false, orgId: null, deviceId: null, deviceLabel: null,
    m365ConnectionId: null, composerDraft: '', joinedMidResponse: false, errorAction: null,
    ...over,
  };
}

const unregister: Array<() => void> = [];

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  localStorage.clear();
  useWorkspaceStore.getState().cleanupAllStreams();
  useWorkspaceStore.setState({
    tabs: [tab({ id: 'a', sessionId: 's-a' }), tab({ id: 'b', sessionId: 's-b' })],
    activeTabId: 'a',
  });
});

afterEach(() => {
  while (unregister.length) unregister.pop()!();
  vi.restoreAllMocks();
});

describe('logout hooks', () => {
  it('run before any localStorage.removeItem (order spy)', async () => {
    const order: string[] = [];
    unregister.push(registerLogoutHook(() => order.push('hook')));
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
      order.push(`remove:${key}`);
    });
    await apiLogout();
    expect(order[0]).toBe('hook');
    expect(order.filter((o) => o.startsWith('remove:'))).toEqual(
      expect.arrayContaining(['remove:breeze-auth', 'remove:breeze-org', 'remove:breeze-ai-chat', 'remove:breeze-workspace']),
    );
    expect(order.indexOf('hook')).toBeLessThan(order.findIndex((o) => o.startsWith('remove:')));
  });

  it('logout empties the workspace, removes breeze-workspace and aborts every tracked attach', async () => {
    expect(localStorage.getItem('breeze-workspace')).not.toBeNull(); // persisted by the setState above
    const controller = new AbortController();
    const untrack = trackAttach(controller);
    await apiLogout();
    untrack();
    expect(localStorage.getItem('breeze-workspace')).toBeNull();
    expect(useWorkspaceStore.getState().tabs).toEqual([]);
    expect(useWorkspaceStore.getState().activeTabId).toBeNull();
    expect(controller.signal.aborted).toBe(true);
  });

  it('a send whose response lands after logout writes nothing: breeze-workspace stays absent for the next user', async () => {
    let release!: () => void;
    fetchMock.mockImplementation(async (url) => {
      if (String(url) === '/ai/sessions/s-a/messages') {
        return new Promise<Response>((resolve) => {
          release = () => {
            const body = new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'message_start', messageId: 'm1' })}\n\n`));
                c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'content_delta', delta: 'leak' })}\n\n`));
                c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`));
                c.close();
              },
            });
            resolve({ ok: true, status: 200, body } as unknown as Response);
          };
        });
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
    const sending = useWorkspaceStore.getState().sendMessage('a', 'question');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/ai/sessions/s-a/messages', expect.anything()));

    await apiLogout();
    expect(localStorage.getItem('breeze-workspace')).toBeNull();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    release();
    await sending;
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(setItem.mock.calls.filter(([k]) => k === 'breeze-workspace')).toEqual([]);
    expect(localStorage.getItem('breeze-workspace')).toBeNull();
    expect(useWorkspaceStore.getState().tabs).toEqual([]);
  });

  it('a throwing hook does not throw out of logout, and the other hooks and removals still run', async () => {
    const after = vi.fn();
    unregister.push(registerLogoutHook(() => { throw new Error('boom'); }));
    unregister.push(registerLogoutHook(after));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    localStorage.setItem('breeze-ai-chat', '{}');
    await expect(apiLogout()).resolves.toBeDefined();
    expect(after).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('breeze-ai-chat')).toBeNull();
    expect(localStorage.getItem('breeze-workspace')).toBeNull();
  });

  it('a throwing localStorage.removeItem does not throw out of logout', async () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied'); });
    await expect(apiLogout()).resolves.toBeDefined();
  });

  it('an unregistered hook no longer runs', async () => {
    const hook = vi.fn();
    const off = registerLogoutHook(hook);
    off();
    await apiLogout();
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('auth without the AI stores', () => {
  it('logout works when workspaceStore was never imported (no hook registered)', async () => {
    vi.resetModules();
    vi.doUnmock('./auth');
    const fresh = await import('./auth');
    localStorage.setItem('breeze-workspace', '{"state":{"tabs":[]}}');
    await expect(fresh.apiLogout()).resolves.toBeDefined();
    expect(localStorage.getItem('breeze-workspace')).toBeNull();
  });
});
