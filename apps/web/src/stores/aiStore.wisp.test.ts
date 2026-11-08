import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('./orgStore', () => ({ useOrgStore: { getState: () => ({ currentOrgId: 'org-header' }) } }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/runAction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runAction')>();
  return { ...actual, runAction: vi.fn(actual.runAction) };
});

import { fetchWithAuth } from './auth';
import { isActiveGrant, useAiStore, type WispState } from './aiStore';
import { useAiModelPickerStore } from './aiModelPickerStore';
import { runAction } from '@/lib/runAction';
import { showToast } from '@/components/shared/Toast';
import { i18n } from '@/lib/i18n';

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
      if (url === '/ai/sessions/sess-plain') return response({ session: { id: 'sess-plain', type: 'general', status: 'active', orgId: 'org-a' }, messages: [] });
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
      if (url === '/ai/sessions/sess-w') return response({ session: { id: 'sess-w', type: 'general', status: 'active', orgId: 'org-a', wispGrantId: 'grant-pw' }, messages: [] });
      if (url === '/wisp/thread?orgId=org-a') return response({ data: null });
      if (url === '/wisp/thread') return response(threadBody('grant-pw', null));
      return response({ data: [] });
    });
    await useAiStore.getState().loadSession('sess-w');
    await vi.waitFor(() => expect(useAiStore.getState().wisp).toMatchObject({ grantId: 'grant-pw', threadId: 'thread-9', scopeOrgId: null }));
  });

  it('a Wisp session whose grant is no longer live stays plain (no header for a dead grant)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/ai/sessions/sess-w') return response({ session: { id: 'sess-w', type: 'general', status: 'active', orgId: 'org-a', wispGrantId: 'grant-old' }, messages: [] });
      if (url.startsWith('/wisp/thread')) return response(threadBody('grant-new', 'org-a'));
      return response({ data: [] });
    });
    await useAiStore.getState().switchSession('sess-w');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledWith('/wisp/thread?orgId=org-a', { skipOrgIdInjection: true });
    expect(useAiStore.getState().wisp).toBeNull();
  });

  it('a Wisp session whose grant thread reports it paused stays plain (W05: only an active grant gives the panel its voice)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/ai/sessions/sess-w') return response({ session: { id: 'sess-w', type: 'general', status: 'active', orgId: null, wispGrantId: 'grant-pw' }, messages: [] });
      if (url === '/wisp/thread') {
        const body = threadBody('grant-pw', null);
        return response({ data: { ...body.data, grant: { ...body.data.grant, status: 'paused' } } });
      }
      return response({ data: [] });
    });
    await useAiStore.getState().loadSession('sess-w');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledWith('/wisp/thread', { skipOrgIdInjection: true });
    expect(useAiStore.getState().wisp).toBeNull();
  });

  it('a Wisp session whose grant thread cannot be read (500) stays plain and says so in the console; no grant is quiet', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/ai/sessions/sess-w') return response({ session: { id: 'sess-w', type: 'general', status: 'active', orgId: 'org-a', wispGrantId: 'grant-pw' }, messages: [] });
      if (url === '/wisp/thread?orgId=org-a') return response({ data: null });
      if (url === '/wisp/thread') return response({ error: 'boom' }, 500);
      return response({ data: [] });
    });
    await useAiStore.getState().loadSession('sess-w');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/wisp/thread', { skipOrgIdInjection: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(useAiStore.getState().wisp).toBeNull();
    const wispWarnings = warn.mock.calls.filter(([msg]) => String(msg).includes('Wisp'));
    expect(wispWarnings).toHaveLength(1);
    warn.mockRestore();
  });

  it('loadSession of a plain session leaves Wisp mode', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/ai/sessions/sess-plain') return response({ session: { id: 'sess-plain', type: 'general', status: 'active', orgId: 'org-a' }, messages: [] });
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

  it('startPlainChat under Wisp closes the Wisp session and opens a plain Breeze AI chat (#10289)', async () => {
    useAiStore.setState({ wisp: wisp({ scopeOrgId: 'org-s' }), sessionId: 'sess-w' });
    await useAiStore.getState().startPlainChat();
    expect(fetchMock).toHaveBeenCalledWith('/ai/sessions/sess-w', expect.objectContaining({ method: 'DELETE' }));
    expect(useAiStore.getState().wisp).toBeNull();
    expect(useAiStore.getState().sessionId).toBe('sess-new');
    const body = createBodies()[0]!;
    expect(body).not.toHaveProperty('wispGrantId');
    // The grant's org must not carry over. The header org is not asserted here:
    // the close's model-picker reload races createSession's first
    // import('./orgStore'), and the loser gets the real store past vi.mock.
    // 'createSession without wisp options' covers the header org.
    expect(body.orgId).not.toBe('org-s');
  });

  it('startPlainChat from a plain chat closes it and opens another plain one (#10289)', async () => {
    useAiStore.setState({ wisp: null, sessionId: 'sess-p' });
    await useAiStore.getState().startPlainChat();
    expect(fetchMock).toHaveBeenCalledWith('/ai/sessions/sess-p', expect.objectContaining({ method: 'DELETE' }));
    expect(createBodies()[0]).not.toHaveProperty('wispGrantId');
    expect(useAiStore.getState().sessionId).toBe('sess-new');
  });

  it('a second startPlainChat during the first close wins: one plain session is created, not two (#10289 review)', async () => {
    let releaseClose!: () => void;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/ai/sessions' && init?.method === 'POST') return response({ id: 'sess-new', orgId: 'org-a' });
      if (url === '/ai/sessions/sess-p' && init?.method === 'DELETE') {
        await new Promise<void>((r) => { releaseClose = r; });
        return response({ success: true });
      }
      return response({ data: [] });
    });
    useAiStore.setState({ wisp: null, sessionId: 'sess-p' });
    const first = useAiStore.getState().startPlainChat();
    await vi.waitFor(() => expect(releaseClose).toBeTypeOf('function'));
    useAiStore.setState({ sessionId: null });
    const second = useAiStore.getState().startPlainChat();
    releaseClose();
    await Promise.all([first, second]);
    expect(createBodies()).toHaveLength(1);
    expect(useAiStore.getState().sessionId).toBe('sess-new');
  });

  it('switching to a history session on the same grant keeps Wisp mode', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/ai/sessions/sess-w2') return response({ session: { id: 'sess-w2', type: 'general', status: 'active', orgId: 'org-a', wispGrantId: 'grant-1' }, messages: [] });
      return response({ data: [] });
    });
    useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w' });
    await useAiStore.getState().switchSession('sess-w2');
    expect(useAiStore.getState().wisp?.grantId).toBe('grant-1');
  });
});

describe('aiStore — Wisp rolls to a fresh session at the turn limit', () => {
  const sse = (events: unknown[]): Response => {
    const bytes = new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
    return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }) } as unknown as Response;
  };
  const messagePosts = () => fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith('/messages') && (init as RequestInit | undefined)?.method === 'POST')
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown> }));

  beforeEach(() => {
    vi.clearAllMocks();
    useAiStore.setState({
      sessionId: 'sess-old', sessionOrgId: 'org-a', hydratedSessionId: 'sess-old', messages: [], isLoading: false, isStreaming: false,
      error: null, errorCode: null, pageContext: null, wisp: wisp(),
    });
  });

  it('a 409 turn_limit_reached before the turn ran: closes the session, opens one on the grant, re-sends the same message once', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/ai/sessions/sess-old/messages') return response({ error: 'Session turn limit reached (50)', code: 'turn_limit_reached', recoverable: true }, 409);
      if (url === '/ai/sessions/sess-new/messages') return sse([{ type: 'done' }]);
      if (url === '/ai/sessions' && init?.method === 'POST') return response({ id: 'sess-new', orgId: 'org-a' });
      if (init?.method === 'DELETE') return response({ success: true });
      return response({ data: [] });
    });
    await useAiStore.getState().sendMessage('what changed overnight?');

    expect(fetchMock).toHaveBeenCalledWith('/ai/sessions/sess-old', { method: 'DELETE' });
    expect(createBodies()[0]).toMatchObject({ wispGrantId: 'grant-1' });
    const posts = messagePosts();
    expect(posts.map((p) => p.url)).toEqual(['/ai/sessions/sess-old/messages', '/ai/sessions/sess-new/messages']);
    expect(posts[1]!.body.content).toBe('what changed overnight?');
    const s = useAiStore.getState();
    expect(s.sessionId).toBe('sess-new');
    expect(s.wisp?.grantId).toBe('grant-1');
    expect(s.error).toBeNull();
    expect(s.messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('the model picked for the refused message rides the rollover onto the fresh session (#10419 review)', async () => {
    useAiModelPickerStore.setState({
      choices: { surface: 'chat', allowUserChoice: true, defaultOfferingId: 'def', choices: [], current: { offeringId: 'def', options: null } },
      selection: { offeringId: 'haiku', options: { budgetThinking: 'on' } },
      loading: false,
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/ai/sessions/sess-old/messages') return response({ error: 'Session turn limit reached (50)', code: 'turn_limit_reached', recoverable: true }, 409);
      if (url === '/ai/sessions/sess-new/messages') return sse([{ type: 'done' }]);
      if (url === '/ai/sessions' && init?.method === 'POST') return response({ id: 'sess-new', orgId: 'org-a' });
      if (init?.method === 'DELETE') return response({ success: true });
      return response({ data: [] });
    });
    await useAiStore.getState().sendMessage('what changed overnight?');

    const posts = messagePosts();
    expect(posts[0]!.body.model).toEqual({ offeringId: 'haiku', options: { budgetThinking: 'on' } });
    expect(createBodies()[0]).toMatchObject({ wispGrantId: 'grant-1', offeringId: 'haiku', options: { budgetThinking: 'on' } });
    expect(posts.map((p) => p.url)).toEqual(['/ai/sessions/sess-old/messages', '/ai/sessions/sess-new/messages']);
    expect(useAiStore.getState().sessionId).toBe('sess-new');
  });

  it('a model picked on an earlier message (now the session\'s current) also carries over on the rollover', async () => {
    useAiModelPickerStore.setState({
      choices: { surface: 'chat', allowUserChoice: true, defaultOfferingId: 'def', choices: [], current: { offeringId: 'haiku', options: { speed: 'fast' } } },
      selection: null,
      loading: false,
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/ai/sessions/sess-old/messages') return response({ error: 'Session turn limit reached (50)', code: 'turn_limit_reached', recoverable: true }, 409);
      if (url === '/ai/sessions/sess-new/messages') return sse([{ type: 'done' }]);
      if (url === '/ai/sessions' && init?.method === 'POST') return response({ id: 'sess-new', orgId: 'org-a' });
      if (init?.method === 'DELETE') return response({ success: true });
      return response({ data: [] });
    });
    await useAiStore.getState().sendMessage('hello');
    expect(createBodies()[0]).toMatchObject({ wispGrantId: 'grant-1', offeringId: 'haiku', options: { speed: 'fast' } });
  });

  it('a close that fails during the rollover is logged, not hidden (#10419 review)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/ai/sessions/sess-old/messages') return response({ error: 'Session turn limit reached (50)', code: 'turn_limit_reached', recoverable: true }, 409);
      if (url === '/ai/sessions/sess-new/messages') return sse([{ type: 'done' }]);
      if (url === '/ai/sessions' && init?.method === 'POST') return response({ id: 'sess-new', orgId: 'org-a' });
      if (init?.method === 'DELETE') return response({ error: 'boom' }, 500);
      return response({ data: [] });
    });
    await useAiStore.getState().sendMessage('hello');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sess-old'), expect.anything());
    expect(useAiStore.getState().sessionId).toBe('sess-new');
    warn.mockRestore();
  });

  it('a second turn_limit_reached on the fresh session is shown, not retried forever', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/messages')) return response({ error: 'Session turn limit reached (1)', code: 'turn_limit_reached' }, 409);
      if (url === '/ai/sessions' && init?.method === 'POST') return response({ id: 'sess-new', orgId: 'org-a' });
      if (init?.method === 'DELETE') return response({ success: true });
      return response({ data: [] });
    });
    await useAiStore.getState().sendMessage('hello');
    expect(messagePosts()).toHaveLength(2);
    expect(useAiStore.getState().errorCode).toBe('turn_limit_reached');
    expect(useAiStore.getState().error).toBe('Session turn limit reached (1)');
  });

  it('the limit hit mid-turn (stream error turn_limit_reached): rolls the session and asks for the message again, no auto re-send', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/ai/sessions/sess-old/messages') return sse([
        { type: 'message_start', messageId: 'a1' },
        { type: 'error', message: 'Maximum conversation turns reached.', code: 'turn_limit_reached' },
      ]);
      if (url === '/ai/sessions' && init?.method === 'POST') return response({ id: 'sess-new', orgId: 'org-a' });
      if (init?.method === 'DELETE') return response({ success: true });
      return response({ data: [] });
    });
    await useAiStore.getState().sendMessage('dig into the printer alerts');

    expect(fetchMock).toHaveBeenCalledWith('/ai/sessions/sess-old', { method: 'DELETE' });
    expect(createBodies()[0]).toMatchObject({ wispGrantId: 'grant-1' });
    expect(messagePosts()).toHaveLength(1);
    const s = useAiStore.getState();
    expect(s.sessionId).toBe('sess-new');
    expect(s.errorCode).toBe('turn_limit_reached');
    expect(s.error).toBe(i18n.t('ai:wisp.turnLimitRolled'));
  });

  it('a plain chat (no Wisp) at the turn limit keeps the coded error for the panel; no session is rolled', async () => {
    useAiStore.setState({ wisp: null });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/messages')) return response({ error: 'Session turn limit reached (50)', code: 'turn_limit_reached' }, 409);
      return response({ data: [] });
    });
    await useAiStore.getState().sendMessage('hello');
    expect(createBodies()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalledWith('/ai/sessions/sess-old', { method: 'DELETE' });
    expect(useAiStore.getState()).toMatchObject({ sessionId: 'sess-old', errorCode: 'turn_limit_reached', error: 'Session turn limit reached (50)' });
  });
});

// #11430: a session the server expired between the bind and the first send
// (idled out, 24 h cap, or a restart left the row behind) answers 410. Nothing
// ran, so under Wisp the store opens a fresh session on the grant and re-sends
// the message once, with no error banner or toast. The expired session is not
// DELETEd: it is already retired, and a close would re-stamp it 'closed'.
describe('aiStore — Wisp rolls to a fresh session when the bound one expired (#11430)', () => {
  const sse = (events: unknown[]): Response => {
    const bytes = new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
    return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }) } as unknown as Response;
  };
  const messagePosts = () => fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith('/messages') && (init as RequestInit | undefined)?.method === 'POST')
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown> }));
  const expired410 = () => response({ error: 'Session has expired due to inactivity. Please start a new session.', code: 'session_expired' }, 410);

  beforeEach(() => {
    vi.clearAllMocks();
    useAiStore.setState({
      sessionId: 'sess-old', sessionOrgId: 'org-a', hydratedSessionId: 'sess-old', messages: [], isLoading: false, isStreaming: false,
      error: null, errorCode: null, composerDraft: '', pageContext: null, wisp: wisp(),
    });
  });

  it('a 410 on the first send opens a session on the grant and re-sends the same message once, with no error shown', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/ai/sessions/sess-old/messages') return expired410();
      if (url === '/ai/sessions/sess-new/messages') return sse([{ type: 'done' }]);
      if (url === '/ai/sessions' && init?.method === 'POST') return response({ id: 'sess-new', orgId: 'org-a' });
      if (init?.method === 'DELETE') return response({ success: true });
      return response({ data: [] });
    });
    await useAiStore.getState().sendMessage('what changed overnight?');

    expect(createBodies()).toHaveLength(1);
    expect(createBodies()[0]).toMatchObject({ wispGrantId: 'grant-1' });
    const posts = messagePosts();
    expect(posts.map((p) => p.url)).toEqual(['/ai/sessions/sess-old/messages', '/ai/sessions/sess-new/messages']);
    expect(posts[1]!.body.content).toBe('what changed overnight?');
    expect(fetchMock).not.toHaveBeenCalledWith('/ai/sessions/sess-old', { method: 'DELETE' });
    const s = useAiStore.getState();
    expect(s.sessionId).toBe('sess-new');
    expect(s.wisp?.grantId).toBe('grant-1');
    expect(s.error).toBeNull();
    expect(s.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a second 410 on the fresh session is shown, not retried forever, and the text goes back to the composer', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/messages')) return expired410();
      if (url === '/ai/sessions' && init?.method === 'POST') return response({ id: 'sess-new', orgId: 'org-a' });
      return response({ data: [] });
    });
    await useAiStore.getState().sendMessage('hello');

    expect(messagePosts()).toHaveLength(2);
    expect(createBodies()).toHaveLength(1);
    const s = useAiStore.getState();
    expect(s.error).toContain('expired');
    expect(s.composerDraft).toBe('hello');
    expect(s.messages.filter((m) => m.role === 'user')).toHaveLength(0);
  });

  it('the model picked for the refused message rides the roll onto the fresh session', async () => {
    useAiModelPickerStore.setState({
      choices: { surface: 'chat', allowUserChoice: true, defaultOfferingId: 'def', choices: [], current: { offeringId: 'def', options: null } },
      selection: { offeringId: 'haiku', options: { budgetThinking: 'on' } },
      loading: false,
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/ai/sessions/sess-old/messages') return expired410();
      if (url === '/ai/sessions/sess-new/messages') return sse([{ type: 'done' }]);
      if (url === '/ai/sessions' && init?.method === 'POST') return response({ id: 'sess-new', orgId: 'org-a' });
      return response({ data: [] });
    });
    await useAiStore.getState().sendMessage('what changed overnight?');

    expect(createBodies()[0]).toMatchObject({ wispGrantId: 'grant-1', offeringId: 'haiku', options: { budgetThinking: 'on' } });
    expect(messagePosts().map((p) => p.url)).toEqual(['/ai/sessions/sess-old/messages', '/ai/sessions/sess-new/messages']);
  });

  it('a roll whose session create fails keeps the create\'s own error, re-sends nothing, and gives the text back', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/messages')) return expired410();
      if (url === '/ai/sessions' && init?.method === 'POST') return response({ error: 'Wisp is paused for this organization' }, 403);
      return response({ data: [] });
    });
    await useAiStore.getState().sendMessage('hello');

    expect(messagePosts()).toHaveLength(1);
    expect(createBodies()).toHaveLength(1);
    const s = useAiStore.getState();
    expect(s.error).toBeTruthy();
    expect(s.error).not.toContain('expired');
    expect(s.composerDraft).toBe('hello');
    expect(s.messages.filter((m) => m.role === 'user')).toHaveLength(0);
  });

  it('an uncoded 410 is not taken for an expired session: shown, no roll', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/messages')) return response({ error: 'Gone' }, 410);
      return response({ data: [] });
    });
    await useAiStore.getState().sendMessage('hello');

    expect(createBodies()).toHaveLength(0);
    expect(useAiStore.getState()).toMatchObject({ sessionId: 'sess-old', composerDraft: 'hello', error: 'Gone' });
  });

  it('a plain chat (no Wisp) keeps the 410 as an error; no session is created', async () => {
    useAiStore.setState({ wisp: null });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/messages')) return expired410();
      return response({ data: [] });
    });
    await useAiStore.getState().sendMessage('hello');

    expect(createBodies()).toHaveLength(0);
    expect(useAiStore.getState()).toMatchObject({ sessionId: 'sess-old', composerDraft: 'hello' });
    expect(useAiStore.getState().error).toContain('expired');
  });
});

describe('isActiveGrant (W05 #10136)', () => {
  it('is true only for a grant the server reports active', () => {
    expect(isActiveGrant(wisp())).toBe(true);
    expect(isActiveGrant(wisp({ status: 'paused' }))).toBe(false);
    expect(isActiveGrant(wisp({ status: 'revoked' }))).toBe(false);
    expect(isActiveGrant(wisp({ status: 'expired' }))).toBe(false);
    expect(isActiveGrant(null)).toBe(false);
  });
});
