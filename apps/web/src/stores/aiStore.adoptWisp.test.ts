/**
 * #10032 (fixed in #9840 W4): adoptSession — the workspace → side panel move,
 * now also reachable from the History list — handles Wisp state the way
 * loadSession / switchSession do: a session under a grant gets its Wisp
 * header back from that grant's thread, and a plain conversation adopted into
 * a panel that is in Wisp mode leaves Wisp mode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('./orgStore', () => ({ useOrgStore: { getState: () => ({ currentOrgId: 'org-a' }) } }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

import { fetchWithAuth } from './auth';
import { useAiStore, type WispState } from './aiStore';
import { abortAllAttaches } from './aiSessionAttach';

const fetchMock = vi.mocked(fetchWithAuth);
const enc = new TextEncoder();

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload), body: null }) as unknown as Response;
const idleStream = (): Response => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(`data: ${JSON.stringify({
        type: 'attach_state', turn: 'idle', turnId: null, lastSeq: 0, turnUserMessageId: null,
        partial: false, replay: [], pendingCards: [], activePlan: null, turnModel: null,
      })}\n\n`));
      c.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
};

function wisp(over: Partial<NonNullable<WispState>> = {}): NonNullable<WispState> {
  return {
    grantId: 'grant-1', threadId: 'thread-1', scopeOrgId: null, focusOrgId: null, focusOrgName: null,
    status: 'active', expiresAt: '2027-01-01T00:00:00.000Z', summary: '', budgetCentsPerDay: 200,
    floorTickMinutes: 30, wideningAvailable: false, ...over,
  };
}
const threadBody = (grantId: string, orgId: string | null) => ({
  data: {
    thread: { id: 'thread-9', summary: '', focusOrgId: null, focusOrgName: null },
    grant: { id: grantId, status: 'active', orgId, expiresAt: '2027-01-01T00:00:00.000Z', budgetCentsPerDay: 200, floorTickMinutes: 30 },
    wideningAvailable: false,
  },
});

const S = '0f8fad5b-d9cb-469f-a165-70867728950e';

beforeEach(() => {
  vi.clearAllMocks();
  useAiStore.setState({
    isOpen: false, sessionId: null, sessionOrgId: null, hydratedSessionId: null, messages: [],
    isLoading: false, isStreaming: false, error: null, errorCode: null, composerDraft: '', wisp: null,
  });
});

afterEach(() => abortAllAttaches());

describe('adoptSession and Wisp state (#10032)', () => {
  it('adopting a session that runs under a grant restores its Wisp header from the grant thread', async () => {
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u === `/ai/sessions/${S}`) {
        return json({ session: { id: S, type: 'general', status: 'active', orgId: 'org-a', wispGrantId: 'grant-pw' }, messages: [] });
      }
      if (u === `/ai/sessions/${S}/stream`) return idleStream();
      if (u === '/wisp/thread?orgId=org-a') return json({ code: 'no_active_grant' }, 404);
      if (u === '/wisp/thread') return json(threadBody('grant-pw', null));
      return json({ data: [] });
    });
    await expect(useAiStore.getState().adoptSession(S)).resolves.toBe('ok');
    await vi.waitFor(() => expect(useAiStore.getState().wisp).toMatchObject({ grantId: 'grant-pw', threadId: 'thread-9' }));
    expect(useAiStore.getState().sessionId).toBe(S);
  });

  it('adopting a plain conversation into a panel in Wisp mode leaves Wisp mode (wisp === null)', async () => {
    useAiStore.setState({ wisp: wisp(), sessionId: 'sess-wisp-thread' });
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u === `/ai/sessions/${S}`) return json({ session: { id: S, type: 'general', status: 'active', orgId: 'org-a' }, messages: [] });
      if (u === `/ai/sessions/${S}/stream`) return idleStream();
      return json({ data: [] });
    });
    await expect(useAiStore.getState().adoptSession(S)).resolves.toBe('ok');
    expect(useAiStore.getState().sessionId).toBe(S);
    expect(useAiStore.getState().wisp).toBeNull();
    // A plain session asks no grant thread for anything.
    expect(fetchMock.mock.calls.map(([u]) => String(u)).some((u) => u.startsWith('/wisp/'))).toBe(false);
  });

  it('adopting a session under another grant drops the shown one at once, then installs that grant', async () => {
    useAiStore.setState({ wisp: wisp({ grantId: 'grant-1' }), sessionId: 'sess-other' });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u === `/ai/sessions/${S}`) {
        return json({ session: { id: S, type: 'general', status: 'active', orgId: 'org-a', wispGrantId: 'grant-2' }, messages: [] });
      }
      if (u === `/ai/sessions/${S}/stream`) return idleStream();
      if (u === '/wisp/thread?orgId=org-a') { await gate; return json(threadBody('grant-2', 'org-a')); }
      return json({ data: [] });
    });
    await expect(useAiStore.getState().adoptSession(S)).resolves.toBe('ok');
    expect(useAiStore.getState().wisp).toBeNull();
    release();
    await vi.waitFor(() => expect(useAiStore.getState().wisp).toMatchObject({ grantId: 'grant-2' }));
  });

  it('a grant thread that resolves after the panel moved on writes nothing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u === `/ai/sessions/${S}`) {
        return json({ session: { id: S, type: 'general', status: 'active', orgId: 'org-a', wispGrantId: 'grant-pw' }, messages: [] });
      }
      if (u === `/ai/sessions/${S}/stream`) return idleStream();
      if (u.startsWith('/wisp/thread')) { await gate; return json(threadBody('grant-pw', 'org-a')); }
      return json({ data: [] });
    });
    await expect(useAiStore.getState().adoptSession(S)).resolves.toBe('ok');
    useAiStore.setState({ sessionId: 'sess-elsewhere' });
    release();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/wisp/thread'))).toBe(true);
    expect(useAiStore.getState().wisp).toBeNull();
  });

  it('a grant thread that fails leaves the adopted session plain, without throwing', async () => {
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u === `/ai/sessions/${S}`) {
        return json({ session: { id: S, type: 'general', status: 'active', orgId: 'org-a', wispGrantId: 'grant-pw' }, messages: [] });
      }
      if (u === `/ai/sessions/${S}/stream`) return idleStream();
      if (u.startsWith('/wisp/thread')) throw new Error('network');
      return json({ data: [] });
    });
    await expect(useAiStore.getState().adoptSession(S)).resolves.toBe('ok');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(useAiStore.getState()).toMatchObject({ sessionId: S, wisp: null });
  });

  it('adopting a session under the grant the panel already shows keeps that Wisp state', async () => {
    const live = wisp({ grantId: 'grant-1', threadId: 'thread-1' });
    useAiStore.setState({ wisp: live, sessionId: 'sess-other' });
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u === `/ai/sessions/${S}`) {
        return json({ session: { id: S, type: 'general', status: 'active', orgId: 'org-a', wispGrantId: 'grant-1' }, messages: [] });
      }
      if (u === `/ai/sessions/${S}/stream`) return idleStream();
      return json({ data: [] });
    });
    await expect(useAiStore.getState().adoptSession(S)).resolves.toBe('ok');
    expect(useAiStore.getState().wisp).toEqual(live);
  });
});
