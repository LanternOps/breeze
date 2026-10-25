/**
 * #10142: a /wisp/chat tab starts its conversation under the caller's active
 * Wisp grant for the header org (the request the side panel sends:
 * `{ orgId, wispGrantId, approvalMode }`), and stays a plain Breeze AI chat
 * when there is no grant, Wisp is off / not entitled, or the token is
 * org-scoped. An opened conversation mirrors the grant it already runs under.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { data.set(k, v); },
      removeItem: (k: string) => { data.delete(k); },
      clear: () => data.clear(),
    },
    configurable: true,
  });
  return {
    data,
    scope: 'partner' as 'partner' | 'organization' | null,
    currentOrgId: 'org-a' as string | null,
    fetchWispThread: vi.fn(),
  };
});

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../lib/authScope', () => ({
  getJwtClaims: () => ({ scope: h.scope, orgId: null, partnerId: 'p-1' }),
}));
vi.mock('../lib/wispGrant', () => ({ fetchWispThread: h.fetchWispThread }));
vi.mock('./orgStore', () => ({ useOrgStore: { getState: () => ({ currentOrgId: h.currentOrgId }) } }));

import { fetchWithAuth } from './auth';
import { useWorkspaceStore } from './workspaceStore';

const fetchMock = vi.mocked(fetchWithAuth);

const grant = (over: Record<string, unknown> = {}) => ({
  grantId: 'g-org', threadId: 'th-1', scopeOrgId: 'org-a', focusOrgId: null, focusOrgName: null,
  status: 'active', expiresAt: '2027-01-01T00:00:00Z', summary: '', budgetCentsPerDay: 200,
  floorTickMinutes: 30, wideningAvailable: false, ...over,
});

const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const stream = (): Response =>
  ({ ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }) }) as unknown as Response;

function createBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([url, init]) => url === '/ai/sessions' && (init as RequestInit)?.method === 'POST');
  expect(call).toBeDefined();
  return JSON.parse(String((call![1] as RequestInit).body));
}

/** Let the tab's grant lookup (lazy imports + awaits) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
}

function activeTab() {
  const s = useWorkspaceStore.getState();
  return s.tabs.find((t) => t.id === s.activeTabId)!;
}

describe('workspace tab under the active Wisp grant (#10142)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.data.clear();
    h.scope = 'partner';
    h.currentOrgId = 'org-a';
    h.fetchWispThread.mockReset();
    useWorkspaceStore.setState({ tabs: [], activeTabId: null, _readers: new Map() });
  });

  it('a new conversation with an active org grant creates its session under the grant', async () => {
    h.fetchWispThread.mockImplementation(async (orgId: string | null) => {
      if (orgId === 'org-a') return grant();
      throw new Error('no_active_grant');
    });
    useWorkspaceStore.getState().createTab();
    await settle();
    expect(activeTab().wisp).toEqual({ kind: 'wisp', grantId: 'g-org', orgId: 'org-a' });

    fetchMock.mockResolvedValueOnce(json({ id: 'sess-1' })).mockResolvedValueOnce(stream());
    await useWorkspaceStore.getState().sendMessage(activeTab().id, 'hello');

    expect(createBody()).toMatchObject({ orgId: 'org-a', wispGrantId: 'g-org', approvalMode: 'per_step' });
    expect(h.fetchWispThread).toHaveBeenCalledWith('org-a');
  });

  it('anchors to the thread focus org, as the side panel does', async () => {
    h.fetchWispThread.mockResolvedValue(grant({ scopeOrgId: null, focusOrgId: 'org-f', grantId: 'g-p' }));
    useWorkspaceStore.getState().createTab();
    await settle();
    fetchMock.mockResolvedValueOnce(json({ id: 'sess-1' })).mockResolvedValueOnce(stream());
    await useWorkspaceStore.getState().sendMessage(activeTab().id, 'hello');
    expect(createBody()).toMatchObject({ orgId: 'org-f', wispGrantId: 'g-p' });
  });

  it('falls back to the partner-wide grant when the header org has none', async () => {
    h.fetchWispThread.mockImplementation(async (orgId: string | null) => {
      if (orgId === null) return grant({ grantId: 'g-p', scopeOrgId: null });
      throw new Error('no_active_grant');
    });
    useWorkspaceStore.getState().createTab();
    await settle();
    expect(activeTab().wisp).toEqual({ kind: 'wisp', grantId: 'g-p', orgId: null });
    fetchMock.mockResolvedValueOnce(json({ id: 'sess-1' })).mockResolvedValueOnce(stream());
    await useWorkspaceStore.getState().sendMessage(activeTab().id, 'hello');
    const body = createBody();
    expect(body.wispGrantId).toBe('g-p');
    expect(body.orgId).toBeUndefined();
  });

  it('a send before the lookup finished waits for it rather than creating a plain session', async () => {
    let resolve!: (v: unknown) => void;
    h.fetchWispThread.mockImplementation(() => new Promise((r) => { resolve = r; }));
    useWorkspaceStore.getState().createTab();
    fetchMock.mockResolvedValueOnce(json({ id: 'sess-1' })).mockResolvedValueOnce(stream());
    const sending = useWorkspaceStore.getState().sendMessage(activeTab().id, 'hello');
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    resolve(grant());
    await sending;
    expect(createBody()).toMatchObject({ wispGrantId: 'g-org' });
  });

  it('no active grant: the tab is a plain chat and the create body is unchanged', async () => {
    h.fetchWispThread.mockRejectedValue(new Error('no_active_grant'));
    useWorkspaceStore.getState().createTab();
    await settle();
    expect(activeTab().wisp).toEqual({ kind: 'plain' });
    fetchMock.mockResolvedValueOnce(json({ id: 'sess-1' })).mockResolvedValueOnce(stream());
    await useWorkspaceStore.getState().sendMessage(activeTab().id, 'hello');
    expect(createBody()).toEqual({});
  });

  it('an org-scoped token never asks for a grant and stays plain', async () => {
    h.scope = 'organization';
    useWorkspaceStore.getState().createTab();
    await settle();
    expect(h.fetchWispThread).not.toHaveBeenCalled();
    expect(activeTab().wisp).toEqual({ kind: 'plain' });
  });

  it('a refused Wisp create on a dead grant drops the tab back to plain and keeps the error', async () => {
    h.fetchWispThread.mockResolvedValueOnce(grant()).mockRejectedValue(new Error('no_active_grant'));
    useWorkspaceStore.getState().createTab();
    await settle();
    fetchMock.mockResolvedValueOnce(json({ code: 'grant_inactive', error: 'Grant is not active' }, false, 409));
    await useWorkspaceStore.getState().sendMessage(activeTab().id, 'hello');
    await settle();
    expect(activeTab().error).toBe('Grant is not active');
    expect(activeTab().wisp).toEqual({ kind: 'plain' });
  });

  it('an opened conversation mirrors the grant it already runs under', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/ai/sessions/s-w') return json({ session: { id: 's-w', type: 'general', status: 'active', orgId: 'org-a', wispGrantId: 'g-org' }, messages: [] });
      if (url === '/ai/sessions/s-p') return json({ session: { id: 's-p', type: 'general', status: 'active', orgId: 'org-a', wispGrantId: null }, messages: [] });
      return stream();
    });
    const open = useWorkspaceStore.getState().openSession;
    void open('s-w');
    void open('s-p');
    await settle();
    const tabs = useWorkspaceStore.getState().tabs;
    expect(tabs.find((t) => t.sessionId === 's-w')?.wisp).toEqual({ kind: 'wisp', grantId: 'g-org', orgId: 'org-a' });
    expect(tabs.find((t) => t.sessionId === 's-p')?.wisp).toEqual({ kind: 'plain' });
    expect(h.fetchWispThread).not.toHaveBeenCalled();
  });
});
