import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('./orgStore', () => ({ useOrgStore: { getState: () => ({ currentOrgId: 'org-header' }) } }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/runAction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runAction')>();
  return { ...actual, runAction: vi.fn(actual.runAction) };
});

import { fetchWithAuth } from './auth';
import { useAiStore, type WispState } from './aiStore';
import { runAction } from '@/lib/runAction';
import { showToast } from '@/components/shared/Toast';

const fetchMock = vi.mocked(fetchWithAuth);

const response = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function wisp(overrides: Partial<NonNullable<WispState>> = {}): NonNullable<WispState> {
  return {
    grantId: 'grant-1',
    threadId: 'thread-1',
    scopeOrgId: null,
    focusOrgId: null,
    focusOrgName: null,
    status: 'active',
    expiresAt: '2027-01-01T00:00:00.000Z',
    summary: '',
    budgetCentsPerDay: 200,
    floorTickMinutes: 30,
    wideningAvailable: false,
    ...overrides,
  };
}

/** The JSON body of the n-th POST /ai/sessions call. */
function createBodies(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([url, init]) => url === '/ai/sessions' && (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

describe('aiStore — Wisp slice (W04 Task 7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAiStore.setState({
      sessionId: null,
      sessionOrgId: null,
      hydratedSessionId: null,
      messages: [],
      isLoading: false,
      isStreaming: false,
      error: null,
      pageContext: null,
      wisp: null,
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/ai/sessions' && init?.method === 'POST') return response({ id: 'sess-new', orgId: 'org-a' });
      if (url.startsWith('/ai/sessions/') && init?.method === 'DELETE') return response({ success: true });
      if (url.startsWith('/ai/models')) return response({ data: [] });
      return response({});
    });
  });

  it('createSession sends wispGrantId and orgId when given', async () => {
    await useAiStore.getState().createSession({ wispGrantId: 'grant-1', orgId: 'org-a' });
    expect(createBodies()[0]).toMatchObject({ wispGrantId: 'grant-1', orgId: 'org-a' });
  });

  it('createSession without wisp options sends a body without wispGrantId (unchanged)', async () => {
    await useAiStore.getState().createSession();
    const body = createBodies()[0]!;
    expect(body).not.toHaveProperty('wispGrantId');
    expect(body.orgId).toBe('org-header');
  });

  it('createSession while Wisp is on keeps the new conversation on the grant, anchored to the focus org', async () => {
    useAiStore.setState({ wisp: wisp({ focusOrgId: 'org-f', focusOrgName: 'Focus Co' }) });
    await useAiStore.getState().createSession();
    expect(createBodies()[0]).toMatchObject({ wispGrantId: 'grant-1', orgId: 'org-f' });
  });

  it('enterWispMode sets wisp then creates a session with the grant', async () => {
    await useAiStore.getState().enterWispMode(wisp({ scopeOrgId: 'org-s' }));
    expect(useAiStore.getState().wisp?.grantId).toBe('grant-1');
    expect(createBodies()[0]).toMatchObject({ wispGrantId: 'grant-1', orgId: 'org-s' });
    expect(useAiStore.getState().sessionId).toBe('sess-new');
  });

  it('enterWispMode under a focused thread sends orgId = focusOrgId; a create response with wispFocusOrgId null clears wisp.focusOrgId', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/ai/sessions' && init?.method === 'POST') {
        return response({ id: 'sess-new', orgId: 'org-a', wispThreadId: 'thread-1', wispFocusOrgId: null });
      }
      return response({ data: [] });
    });
    await useAiStore.getState().enterWispMode(wisp({ focusOrgId: 'org-f', focusOrgName: 'Focus Co' }));
    expect(createBodies()[0]).toMatchObject({ wispGrantId: 'grant-1', orgId: 'org-f' });
    expect(useAiStore.getState().wisp).toMatchObject({ focusOrgId: null, focusOrgName: null });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ message: 'Customer focus cleared' }));
  });

  it('a Wisp session create refused for a recoverable reason (focus_mismatch) keeps Wisp on with the error visible', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/ai/sessions' && init?.method === 'POST') return response({ error: 'Focus changed in another tab', code: 'focus_mismatch' }, 409);
      return response({ data: [] });
    });
    await useAiStore.getState().enterWispMode(wisp());
    expect(useAiStore.getState().error).toBe('Focus changed in another tab');
    expect(useAiStore.getState().errorCode).toBe('focus_mismatch');
    expect(useAiStore.getState().sessionId).toBeNull();
    expect(useAiStore.getState().wisp).not.toBeNull();
  });

  it('exitWispMode closes the session and clears wisp', async () => {
    useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w' });
    await useAiStore.getState().exitWispMode();
    expect(fetchMock).toHaveBeenCalledWith('/ai/sessions/sess-w', { method: 'DELETE' });
    expect(useAiStore.getState().wisp).toBeNull();
    expect(useAiStore.getState().sessionId).toBeNull();
  });

  it('setWispFocus PATCHes /wisp/thread/:id/focus through runAction, updates focusOrgId/focusOrgName and creates a session anchored to the new org', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/wisp/thread/thread-1/focus') return response({ data: { focusOrgId: 'org-b', focusOrgName: 'Bravo' } });
      if (url === '/ai/sessions' && init?.method === 'POST') return response({ id: 'sess-b', orgId: 'org-b', wispFocusOrgId: 'org-b' });
      if (init?.method === 'DELETE') return response({ success: true });
      return response({ data: [] });
    });
    useAiStore.setState({ wisp: wisp(), sessionId: 'sess-old' });
    await useAiStore.getState().setWispFocus('org-b', 'Bravo');

    expect(runAction).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/wisp/thread/thread-1/focus', { method: 'PATCH', body: JSON.stringify({ orgId: 'org-b' }) });
    expect(useAiStore.getState().wisp).toMatchObject({ focusOrgId: 'org-b', focusOrgName: 'Bravo' });
    // The old session is closed so its summary lands on the thread; the next turn is anchored to the new focus.
    expect(fetchMock).toHaveBeenCalledWith('/ai/sessions/sess-old', { method: 'DELETE' });
    expect(createBodies()[0]).toMatchObject({ wispGrantId: 'grant-1', orgId: 'org-b' });
    expect(useAiStore.getState().sessionId).toBe('sess-b');
  });

  it('setWispFocus that the server refuses leaves the focus and the session untouched', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/wisp/thread/thread-1/focus') return response({ error: 'outside', code: 'wisp_outside_ceiling' }, 403);
      return response({ data: [] });
    });
    useAiStore.setState({ wisp: wisp({ focusOrgId: 'org-a', focusOrgName: 'Alpha' }), sessionId: 'sess-old' });
    await useAiStore.getState().setWispFocus('org-x', 'Xray');
    expect(useAiStore.getState().wisp).toMatchObject({ focusOrgId: 'org-a', focusOrgName: 'Alpha' });
    expect(useAiStore.getState().sessionId).toBe('sess-old');
    expect(createBodies()).toHaveLength(0);
  });

  it('switching to a history session that is not on the current grant leaves Wisp mode', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/ai/sessions/sess-plain') return response({ session: { id: 'sess-plain', status: 'active', orgId: 'org-a' }, messages: [] });
      return response({ data: [] });
    });
    useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w' });
    await useAiStore.getState().switchSession('sess-plain');
    expect(useAiStore.getState().wisp).toBeNull();
  });

  const threadBody = (grantId: string, orgId: string | null) => ({
    data: {
      thread: { id: 'thread-9', summary: '', focusOrgId: null },
      focusOrgName: null,
      grant: { id: grantId, status: 'active', orgId, expiresAt: '2027-01-01T00:00:00.000Z', budgetCentsPerDay: 200, floorTickMinutes: 30 },
      wideningAvailable: false,
    },
  });

  it('restoring a Wisp session after a reload (wisp null) rehydrates Wisp mode from its grant', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/ai/sessions/sess-w') return response({ session: { id: 'sess-w', status: 'active', orgId: 'org-a', wispGrantId: 'grant-pw' }, messages: [] });
      if (url === '/wisp/thread?orgId=org-a') return response({ code: 'no_active_grant' }, 404);
      if (url === '/wisp/thread') return response(threadBody('grant-pw', null));
      return response({ data: [] });
    });
    await useAiStore.getState().loadSession('sess-w');
    await vi.waitFor(() => expect(useAiStore.getState().wisp).toMatchObject({ grantId: 'grant-pw', threadId: 'thread-9', scopeOrgId: null }));
  });

  it('a Wisp session whose grant is no longer live stays plain (no header for a dead grant)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/ai/sessions/sess-w') return response({ session: { id: 'sess-w', status: 'active', orgId: 'org-a', wispGrantId: 'grant-old' }, messages: [] });
      if (url.startsWith('/wisp/thread')) return response(threadBody('grant-new', 'org-a'));
      return response({ data: [] });
    });
    await useAiStore.getState().switchSession('sess-w');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledWith('/wisp/thread?orgId=org-a');
    expect(useAiStore.getState().wisp).toBeNull();
  });

  it('loadSession of a plain session leaves Wisp mode', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/ai/sessions/sess-plain') return response({ session: { id: 'sess-plain', status: 'active', orgId: 'org-a' }, messages: [] });
      return response({ data: [] });
    });
    useAiStore.setState({ wisp: wisp() });
    await useAiStore.getState().loadSession('sess-plain');
    expect(useAiStore.getState().wisp).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/wisp/thread'))).toBe(false);
  });

  it('a Wisp session create refused because the grant is unusable leaves Wisp mode and keeps the reason', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/ai/sessions' && init?.method === 'POST') return response({ error: 'Grant revoked', code: 'grant_inactive' }, 409);
      return response({ data: [] });
    });
    useAiStore.setState({ wisp: wisp(), sessionId: null });
    await useAiStore.getState().createSession();
    expect(useAiStore.getState().wisp).toBeNull();
    expect(useAiStore.getState().error).toBe('Grant revoked');
  });

  it('exitWispMode does not leave a stale close-failure banner in plain chat', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return response({ error: 'nope' }, 500);
      return response({ data: [] });
    });
    useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w' });
    await useAiStore.getState().exitWispMode();
    expect(useAiStore.getState().wisp).toBeNull();
    expect(useAiStore.getState().sessionId).toBeNull();
    expect(useAiStore.getState().error).toBeNull();
  });

  it('switching to a history session on the same grant keeps Wisp mode', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/ai/sessions/sess-w2') return response({ session: { id: 'sess-w2', status: 'active', orgId: 'org-a', wispGrantId: 'grant-1' }, messages: [] });
      return response({ data: [] });
    });
    useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w' });
    await useAiStore.getState().switchSession('sess-w2');
    expect(useAiStore.getState().wisp?.grantId).toBe('grant-1');
  });
});
