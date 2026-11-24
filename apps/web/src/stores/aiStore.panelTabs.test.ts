/**
 * The side panel's two tabs: "Breeze AI" (a direct session — you work on the
 * record yourself and approve each step) and "Wisp" (the standing assistant,
 * which hands longer jobs to specialists). They share this one store, so a tab
 * is a swap of the bound session, and the swap must lose nothing: no session
 * is closed, none is created, and each tab comes back to its own conversation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('./orgStore', () => ({ useOrgStore: { getState: () => ({ currentOrgId: 'org-header', organizations: [] }) } }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

import { fetchWithAuth } from './auth';
import { useAiStore, type WispState } from './aiStore';

const fetchMock = vi.mocked(fetchWithAuth);

const response = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function wisp(overrides: Partial<NonNullable<WispState>> = {}): NonNullable<WispState> {
  return {
    grantId: 'grant-1', threadId: 'thread-1', scopeOrgId: null, focusOrgId: null, focusOrgName: null,
    status: 'active', expiresAt: '2027-01-01T00:00:00.000Z', summary: '', budgetCentsPerDay: 200,
    floorTickMinutes: 30, wideningAvailable: false,
    ...overrides,
  };
}

const now = () => new Date().toISOString();
const SESSIONS: Record<string, Record<string, unknown>> = {
  'sess-p': { id: 'sess-p', type: 'general', status: 'active', orgId: 'org-a' },
  'sess-w': { id: 'sess-w', type: 'general', status: 'active', orgId: 'org-a', wispGrantId: 'grant-1' },
  'sess-w2': { id: 'sess-w2', type: 'general', status: 'active', orgId: 'org-a', wispGrantId: 'grant-1' },
  'sess-new': { id: 'sess-new', type: 'general', status: 'active', orgId: 'org-a' },
  'sess-closed': { id: 'sess-closed', type: 'general', status: 'closed', orgId: 'org-a' },
};

const calls = (method: string, match: (url: string) => boolean) =>
  fetchMock.mock.calls.filter(([url, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === method && match(String(url)));
const creates = () => calls('POST', (url) => url === '/ai/sessions');
const closes = () => calls('DELETE', (url) => /^\/ai\/sessions\/[^/]+$/.test(url));
const createBody = (n = 0) => JSON.parse(String((creates()[n]![1] as RequestInit).body)) as Record<string, unknown>;

describe('aiStore — side panel tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAiStore.setState(useAiStore.getInitialState(), true);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url === '/ai/sessions' && method === 'POST') return response({ id: 'sess-new', orgId: 'org-a' });
      const id = /^\/ai\/sessions\/([^/?]+)$/.exec(url)?.[1];
      if (id && method === 'DELETE') return response({ success: true });
      if (id && method === 'GET') {
        const session = SESSIONS[id];
        if (!session) return response({ error: 'not found' }, 404);
        return response({ session: { ...session, createdAt: now(), lastActivityAt: now() }, messages: [] });
      }
      // A partner-wide grant is live, for the header rehydrate of a loaded Wisp session.
      if (url.startsWith('/wisp/thread')) return response({ data: null });
      return response({ data: [] });
    });
  });

  it('starts on the Breeze AI tab', () => {
    expect(useAiStore.getInitialState().panelTab).toBe('session');
    expect(useAiStore.getInitialState().plainTabSessionId).toBeNull();
  });

  it('a round trip between the tabs returns each to its own conversation: nothing closed, nothing created', async () => {
    useAiStore.setState({ sessionId: 'sess-p', hydratedSessionId: 'sess-p' });

    await useAiStore.getState().selectPanelTab('wisp', wisp({ lastSessionId: 'sess-w' }));
    expect(useAiStore.getState()).toMatchObject({ sessionId: 'sess-w', panelTab: 'wisp' });
    expect(useAiStore.getState().wisp?.grantId).toBe('grant-1');

    await useAiStore.getState().selectPanelTab('session');
    expect(useAiStore.getState()).toMatchObject({ sessionId: 'sess-p', panelTab: 'session', wisp: null });

    // The panel's grant read is from before the Wisp session existed (no
    // lastSessionId): the session just left is still the thread's conversation.
    await useAiStore.getState().selectPanelTab('wisp', wisp({ lastSessionId: null }));
    expect(useAiStore.getState()).toMatchObject({ sessionId: 'sess-w', panelTab: 'wisp' });

    expect(creates()).toHaveLength(0);
    expect(closes()).toHaveLength(0);
  });

  it('leaving Wisp with no direct session yet shows an empty Breeze AI tab without closing the Wisp session', async () => {
    useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w', panelTab: 'wisp' });
    await useAiStore.getState().selectPanelTab('session');
    expect(useAiStore.getState()).toMatchObject({ sessionId: null, wisp: null, panelTab: 'session', error: null });
    expect(closes()).toHaveLength(0);
    expect(creates()).toHaveLength(0);
  });

  it('a remembered direct session that is gone leaves an empty Breeze AI tab, with no error', async () => {
    useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w', panelTab: 'wisp', plainTabSessionId: 'sess-gone' });
    await useAiStore.getState().selectPanelTab('session');
    expect(useAiStore.getState()).toMatchObject({ sessionId: null, wisp: null, error: null, plainTabSessionId: null });
  });

  it('closing the direct session forgets it: the tab does not come back to a closed conversation', async () => {
    await useAiStore.getState().switchSession('sess-p');
    expect(useAiStore.getState().plainTabSessionId).toBe('sess-p');
    await useAiStore.getState().closeSession();
    expect(useAiStore.getState().plainTabSessionId).toBeNull();
  });

  it('the direct session is remembered however Wisp gets bound, not only through enterWispMode', async () => {
    await useAiStore.getState().createSession();
    expect(useAiStore.getState().sessionId).toBe('sess-new');
    // "Talk to Wisp" with a focus switch binds the grant and clears the session itself.
    useAiStore.setState({ wisp: wisp(), sessionId: null, hydratedSessionId: null, messages: [] });
    await useAiStore.getState().selectPanelTab('session');
    expect(useAiStore.getState()).toMatchObject({ sessionId: 'sess-new', wisp: null });
  });

  it('a Wisp session picked from History is not taken for the direct session', async () => {
    await useAiStore.getState().switchSession('sess-p');
    await useAiStore.getState().switchSession('sess-w');
    expect(useAiStore.getState().sessionId).toBe('sess-w');
    expect(useAiStore.getState().plainTabSessionId).toBe('sess-p');
  });

  it('going back to a direct session that belongs to another organization than the page drops it (#5684)', async () => {
    useAiStore.setState({
      wisp: wisp(), sessionId: 'sess-w', panelTab: 'wisp', plainTabSessionId: 'sess-p',
      pageContext: { type: 'device', id: 'dev-9', hostname: 'OTHER-01', orgId: 'org-b' },
    });
    await useAiStore.getState().selectPanelTab('session');
    expect(useAiStore.getState()).toMatchObject({ sessionId: null, wisp: null, plainTabSessionId: null, error: null });
  });

  it('going back to a direct session that is no longer active leaves an empty tab', async () => {
    useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w', panelTab: 'wisp', plainTabSessionId: 'sess-closed' });
    await useAiStore.getState().selectPanelTab('session');
    expect(useAiStore.getState()).toMatchObject({ sessionId: null, wisp: null, plainTabSessionId: null, error: null });
  });

  it('the Wisp tab follows the thread: its last session, as read now, wins over the one the panel left (#11672)', async () => {
    // Another window moved the thread on to sess-w2 while this panel was on the direct session.
    useAiStore.setState({ wispTabResume: { grantId: 'grant-1', sessionId: 'sess-w' } });
    await useAiStore.getState().selectPanelTab('wisp', wisp({ lastSessionId: 'sess-w2' }));
    expect(useAiStore.getState().sessionId).toBe('sess-w2');
    expect(creates()).toHaveLength(0);
  });

  it('the Wisp tab falls back to the session the panel left when the thread names one that is gone', async () => {
    useAiStore.setState({ wispTabResume: { grantId: 'grant-1', sessionId: 'sess-w' } });
    await useAiStore.getState().selectPanelTab('wisp', wisp({ lastSessionId: 'sess-gone' }));
    expect(useAiStore.getState().sessionId).toBe('sess-w');
    expect(creates()).toHaveLength(0);
  });

  it('a Wisp session restored after a reload (its grant not read yet) is not remembered as the direct session', async () => {
    // Reload on the Wisp tab: the persisted session is the Wisp one and `wisp` is still null.
    useAiStore.setState({ sessionId: 'sess-w', panelTab: 'wisp', plainTabSessionId: 'sess-p' });
    await useAiStore.getState().enterWispMode(wisp({ lastSessionId: 'sess-w' }));
    expect(useAiStore.getState().plainTabSessionId).toBe('sess-p');
    await useAiStore.getState().selectPanelTab('session');
    expect(useAiStore.getState()).toMatchObject({ sessionId: 'sess-p', wisp: null });
  });

  it('opening the pane on the Breeze AI tab leaves a Wisp thread a page bound to the store, and restores the direct session', async () => {
    // The Wisp home bound the shared store to its thread; the user then went to a device page.
    await useAiStore.getState().switchSession('sess-p');
    await useAiStore.getState().enterWispMode(wisp({ lastSessionId: 'sess-w' }));
    expect(useAiStore.getState()).toMatchObject({ sessionId: 'sess-w', panelTab: 'session' });

    // Awaitable: a caller that sends right after (a fleet quick action) must not post into Wisp.
    await useAiStore.getState().openOnPickedTab();
    expect(useAiStore.getState()).toMatchObject({ sessionId: 'sess-p', wisp: null, isOpen: true });
    expect(closes()).toHaveLength(0);
    expect(creates()).toHaveLength(0);
  });

  it('open() shows what a caller just bound: a Wisp session opened from History, a notification or "Talk to Wisp" stays', async () => {
    useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w', panelTab: 'session', plainTabSessionId: 'sess-p' });
    useAiStore.getState().open();
    await Promise.resolve();
    expect(useAiStore.getState()).toMatchObject({ sessionId: 'sess-w', isOpen: true });
    expect(useAiStore.getState().wisp?.grantId).toBe('grant-1');
  });

  it('a Wisp page still binding its thread is not interrupted by the header button', async () => {
    useAiStore.setState({ wisp: wisp(), sessionId: null, isLoading: true, plainTabSessionId: 'sess-p' });
    useAiStore.getState().toggle();
    await Promise.resolve();
    expect(useAiStore.getState().wisp?.grantId).toBe('grant-1');
    expect(useAiStore.getState().sessionId).toBeNull();
  });

  it('toggle reasserts the Breeze AI tab the same way', async () => {
    useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w', plainTabSessionId: 'sess-p' });
    useAiStore.getState().toggle();
    await vi.waitFor(() => expect(useAiStore.getState().sessionId).toBe('sess-p'));
    expect(useAiStore.getState().wisp).toBeNull();
  });

  it('opening the pane on the Wisp tab keeps Wisp', async () => {
    useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w', panelTab: 'wisp', plainTabSessionId: 'sess-p' });
    useAiStore.getState().openOnPickedTab();
    await Promise.resolve();
    expect(useAiStore.getState()).toMatchObject({ sessionId: 'sess-w', isOpen: true });
    expect(useAiStore.getState().wisp?.grantId).toBe('grant-1');
  });

  it('a device task under Wisp starts a direct session: no grant on the create, the Wisp session left open', async () => {
    useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w', panelTab: 'wisp' });
    await useAiStore.getState().startDeviceTask('dev-1', { type: 'device', id: 'dev-1', hostname: 'HL-DC-01', orgId: 'org-a' });
    expect(createBody()).toMatchObject({ deviceId: 'dev-1' });
    expect(createBody()).not.toHaveProperty('wispGrantId');
    expect(useAiStore.getState()).toMatchObject({ sessionId: 'sess-new', wisp: null });
    expect(closes()).toHaveLength(0);
  });

  it('"Ask AI about this" under Wisp opens a direct session without closing the Wisp session', async () => {
    useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w', panelTab: 'wisp' });
    await useAiStore.getState().openPlainChatAbout({ kind: 'device', id: 'dev-1', orgId: 'org-a', label: 'HL-DC-01' });
    expect(createBody()).not.toHaveProperty('wispGrantId');
    expect(useAiStore.getState()).toMatchObject({ sessionId: 'sess-new', wisp: null, isOpen: true });
    expect(closes()).toHaveLength(0);
  });

  it('after a tab switch away and back, a device task does not resume as Wisp', async () => {
    await useAiStore.getState().switchSession('sess-p');
    await useAiStore.getState().selectPanelTab('wisp', wisp({ lastSessionId: 'sess-w' }));
    await useAiStore.getState().selectPanelTab('session');
    await useAiStore.getState().startDeviceTask('dev-1', { type: 'device', id: 'dev-1', hostname: 'HL-DC-01', orgId: 'org-a' });
    expect(createBody()).not.toHaveProperty('wispGrantId');
  });

  describe('what a reload restores', () => {
    const persisted = () => useAiStore.persist.getOptions().partialize!(useAiStore.getState()) as Record<string, unknown>;

    it('on the Breeze AI tab, a Wisp thread a page bound is not what the panel comes back to', () => {
      useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w', panelTab: 'session', plainTabSessionId: 'sess-p' });
      expect(persisted()).toMatchObject({ sessionId: 'sess-p', panelTab: 'session' });
    });

    it('on the Breeze AI tab with no direct session, the panel comes back empty', () => {
      useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w', sessionOrgId: 'org-a', panelTab: 'session', plainTabSessionId: null });
      expect(persisted()).toMatchObject({ sessionId: null, sessionOrgId: null });
    });

    it('on the Wisp tab, the Wisp session and the remembered direct session both persist', () => {
      useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w', panelTab: 'wisp', plainTabSessionId: 'sess-p' });
      expect(persisted()).toMatchObject({ sessionId: 'sess-w', panelTab: 'wisp', plainTabSessionId: 'sess-p' });
    });

    it('a direct session persists as before', () => {
      useAiStore.setState({ sessionId: 'sess-p', sessionOrgId: 'org-a' });
      expect(persisted()).toMatchObject({ sessionId: 'sess-p', sessionOrgId: 'org-a', panelTab: 'session' });
    });
  });
});
