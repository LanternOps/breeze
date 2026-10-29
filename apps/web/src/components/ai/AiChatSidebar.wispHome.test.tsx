/**
 * W08 (#9921) Task 10: in Wisp mode the docked panel defers to the Wisp home —
 * an "Open in Wisp" link to /wisp, and no in-panel concern list (the home's
 * "needs your attention" owns it). Plain chat is untouched.
 *
 * W05 of #10131 (#10136, spec §7): the panel's voice is decided by the grant,
 * not a toggle. Opened with an active grant it speaks as Wisp; a paused or
 * missing grant leaves it Breeze AI (with "Meet Wisp" when Wisp is on here);
 * and no /wisp/thread request is made unless the server flag, a partner token
 * and the `wisp` entitlement all pass (Review Focus 2).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  serverOn: false,
  wispEnabledOpts: [] as Array<{ enabled?: boolean } | undefined>,
  scope: 'partner' as string | null,
  entitlement: 'enabled' as 'loading' | 'enabled' | 'locked',
  /** GET /wisp/thread[?orgId=] → payload (status 200); absent = 404 no_active_grant. */
  threads: {} as Record<string, unknown>,
  /** GET /wisp/thread[?orgId=] → this failure status instead (e.g. 500, or 404 without the code). */
  threadFailures: {} as Record<string, { status: number; body: unknown }>,
}));

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(async (url: string) => {
    if (url.startsWith('/wisp/thread')) {
      const failure = h.threadFailures[url];
      if (failure) return { ok: false, status: failure.status, json: async () => failure.body };
      const hit = h.threads[url];
      if (hit === undefined) return { ok: false, status: 404, json: async () => ({ code: 'no_active_grant' }) };
      return { ok: true, status: 200, json: async () => hit };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }),
  registerOrgIdProvider: vi.fn(),
}));
vi.mock('@/stores/orgStore', async () => {
  const { create: mk } = await import('zustand');
  return { useOrgStore: mk(() => ({ organizations: [], currentOrgId: null as string | null })) };
});
vi.mock('@/lib/permissions', () => ({ usePermissions: () => ({ permissions: [], can: () => true }) }));
vi.mock('@/lib/authScope', () => ({
  useJwtClaims: () => (h.scope === null
    ? { status: 'unresolved' }
    : { status: 'resolved', claims: { scope: h.scope, partnerId: 'p-1', orgId: null } }),
}));
vi.mock('@/lib/wispVisibility', () => ({
  useWispEnabled: (opts?: { enabled?: boolean }) => {
    h.wispEnabledOpts.push(opts);
    return (opts?.enabled ?? true) && h.serverOn;
  },
}));
vi.mock('@/hooks/useEntitlement', () => ({
  useEntitlement: () => ({ state: h.entitlement, failed: false, limits: null, reload: () => {} }),
}));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('astro:transitions/client', () => ({ navigate: vi.fn() }));
// Records the last props so the panel's voice (assistantLabel, W01 #10211) can be asserted.
const kitProps = vi.hoisted(() => ({ messages: null as Record<string, unknown> | null, input: null as Record<string, unknown> | null }));
vi.mock('./AiChatMessages', () => ({ default: (p: Record<string, unknown>) => { kitProps.messages = p; return null; } }));
vi.mock('./AiChatInput', () => ({ default: (p: Record<string, unknown>) => { kitProps.input = p; return null; } }));
vi.mock('./AiContextBadge', () => ({ default: () => null }));
vi.mock('./AiCostIndicator', () => ({ default: () => null }));
vi.mock('./AiModelPicker', () => ({ default: () => null }));
vi.mock('./AiContinuationPrompt', () => ({ default: () => null }));
vi.mock('./WispThreadHeader', () => ({ default: () => <div data-testid="wisp-thread-header-mock" /> }));
vi.mock('./WispThreadAttachments', () => ({ default: () => null }));
vi.mock('./WispConcernsPanel', () => ({ WispConcernsPanel: () => <div data-testid="wisp-concerns-mock" /> }));

import AiChatSidebar from './AiChatSidebar';
import { useAiStore, type WispState } from '@/stores/aiStore';
import { useOrgStore } from '@/stores/orgStore';
import { fetchWithAuth } from '@/stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);

const wisp = (): NonNullable<WispState> => ({
  grantId: 'grant-1', threadId: 'thread-1', scopeOrgId: null, focusOrgId: null, focusOrgName: null,
  status: 'active', expiresAt: '2027-01-01T00:00:00.000Z', summary: '', budgetCentsPerDay: 200,
  floorTickMinutes: 30, wideningAvailable: false,
});

const threadBody = (grantId: string, status: string, orgId: string | null = null) => ({
  data: {
    thread: { id: `thread-of-${grantId}`, summary: '', focusOrgId: null },
    focusOrgName: null,
    grant: { id: grantId, status, orgId, expiresAt: '2099-01-01T00:00:00.000Z', budgetCentsPerDay: 200, floorTickMinutes: 30 },
    wideningAvailable: false,
  },
});

const wispThreadCalls = () => fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith('/wisp/thread'));

/** Let the mount effect's lookups settle. */
const settle = () => new Promise((r) => setTimeout(r, 0)).then(() => new Promise((r) => setTimeout(r, 0)));

const BASE = {
  isOpen: true, showHistory: false, sessionId: null, hydratedSessionId: null, messages: [],
  isStreaming: false, isLoading: false, error: null, errorCode: null, composerDraft: '',
  topologySiteId: null, joinedMidResponse: false, wisp: null,
};

describe('AiChatSidebar in Wisp mode defers to the home (W08 Task 10)', () => {
  beforeEach(() => {
    h.serverOn = false;
    useAiStore.setState(BASE);
  });

  it('Wisp mode: "Open in Wisp" links to /wisp and the concern list is gone (the header stays)', () => {
    useAiStore.setState({ wisp: wisp() });
    render(<AiChatSidebar />);
    expect(screen.getByTestId('wisp-thread-header-mock')).toBeInTheDocument();
    const link = screen.getByTestId('wisp-sidebar-open-home');
    expect(link).toHaveAttribute('href', '/wisp');
    expect(link).toHaveTextContent('Open in Wisp');
    expect(screen.queryByTestId('wisp-concerns-mock')).toBeNull();
  });

  it('plain chat: no Wisp link', () => {
    render(<AiChatSidebar />);
    expect(screen.queryByTestId('wisp-sidebar-open-home')).toBeNull();
  });

  it('labels replies "Wisp" in Wisp mode and leaves the Breeze AI default otherwise; dense panel layout either way', () => {
    useAiStore.setState({ wisp: wisp(), sessionId: 's1', hydratedSessionId: 's1', messages: [{ id: 'm', role: 'user', content: 'q', createdAt: new Date() }] });
    const view = render(<AiChatSidebar />);
    expect(kitProps.messages).toMatchObject({ assistantLabel: 'Wisp' });
    expect(kitProps.messages?.layout).toBeUndefined();
    expect(kitProps.messages?.showTimeDividers).toBeUndefined();
    view.unmount();
    useAiStore.setState({ wisp: null });
    render(<AiChatSidebar />);
    expect(kitProps.messages?.assistantLabel).toBeUndefined();
  });
});

describe('AiChatSidebar voice is decided by the grant (W05 #10136)', () => {
  const enterWispMode = vi.fn(async (w: NonNullable<WispState>) => { useAiStore.setState({ wisp: w }); });
  const closeSession = vi.fn(async () => { useAiStore.setState({ sessionId: null }); });
  const createSession = vi.fn(async () => {});

  beforeEach(() => {
    fetchMock.mockClear();
    enterWispMode.mockClear();
    closeSession.mockClear();
    createSession.mockClear();
    h.serverOn = true;
    h.wispEnabledOpts = [];
    h.scope = 'partner';
    h.entitlement = 'enabled';
    h.threads = {};
    h.threadFailures = {};
    useOrgStore.setState({ currentOrgId: null });
    useAiStore.setState({ ...BASE, enterWispMode, closeSession, createSession });
  });

  it('enters Wisp mode on open when an active grant exists', async () => {
    h.threads['/wisp/thread'] = threadBody('grant-pw', 'active');
    render(<AiChatSidebar />);
    await waitFor(() => expect(enterWispMode).toHaveBeenCalledTimes(1));
    expect(enterWispMode.mock.calls[0][0]).toMatchObject({ grantId: 'grant-pw', threadId: 'thread-of-grant-pw', status: 'active' });
    await waitFor(() => expect(screen.getByText('Wisp')).toBeInTheDocument());
    expect(screen.queryByTestId('wisp-sidebar-meet')).toBeNull();
    // No toggle anywhere: the grant decides (spec §11 decision 4).
    expect(screen.queryByTestId('wisp-toggle')).toBeNull();
    expect(screen.queryByText('Turn on Wisp')).toBeNull();
  });

  it('finds a grant scoped to the selected organization when there is no partner-wide one', async () => {
    useOrgStore.setState({ currentOrgId: 'org-a' });
    h.threads['/wisp/thread?orgId=org-a'] = threadBody('grant-org', 'active', 'org-a');
    render(<AiChatSidebar />);
    await waitFor(() => expect(enterWispMode).toHaveBeenCalledTimes(1));
    expect(enterWispMode.mock.calls[0][0]).toMatchObject({ grantId: 'grant-org', scopeOrgId: 'org-a' });
    expect(wispThreadCalls()).toEqual(['/wisp/thread', '/wisp/thread?orgId=org-a']);
  });

  it('stays Breeze AI when the grant is paused', async () => {
    h.threads['/wisp/thread'] = threadBody('grant-pw', 'paused');
    render(<AiChatSidebar />);
    await waitFor(() => expect(wispThreadCalls()).toContain('/wisp/thread'));
    await settle();
    expect(enterWispMode).not.toHaveBeenCalled();
    expect(useAiStore.getState().wisp).toBeNull();
    expect(screen.getByText('Breeze AI')).toBeInTheDocument();
    expect(screen.queryByTestId('wisp-thread-header-mock')).toBeNull();
  });

  it('stays Breeze AI and offers Meet Wisp when there is no grant', async () => {
    render(<AiChatSidebar />);
    const meet = await screen.findByTestId('wisp-sidebar-meet');
    expect(meet).toHaveAttribute('href', '/wisp');
    expect(meet).toHaveTextContent('Meet Wisp');
    expect(enterWispMode).not.toHaveBeenCalled();
    expect(screen.getByText('Breeze AI')).toBeInTheDocument();
  });

  it('never calls /wisp/thread when the server has Wisp off', async () => {
    h.serverOn = false;
    h.threads['/wisp/thread'] = threadBody('grant-pw', 'active');
    render(<AiChatSidebar />);
    await settle();
    expect(wispThreadCalls()).toEqual([]);
    expect(enterWispMode).not.toHaveBeenCalled();
    expect(screen.queryByTestId('wisp-sidebar-meet')).toBeNull();
    expect(screen.getByText('Breeze AI')).toBeInTheDocument();
  });

  it('never calls /wisp/thread for an org-scoped token, and never asks the partner route for one', async () => {
    h.scope = 'organization';
    h.threads['/wisp/thread'] = threadBody('grant-pw', 'active');
    render(<AiChatSidebar />);
    await settle();
    expect(wispThreadCalls()).toEqual([]);
    expect(h.wispEnabledOpts.every((o) => o?.enabled === false)).toBe(true);
    expect(screen.queryByTestId('wisp-sidebar-meet')).toBeNull();
  });

  it('never calls /wisp/thread without the wisp entitlement (locked or still loading)', async () => {
    h.threads['/wisp/thread'] = threadBody('grant-pw', 'active');
    h.entitlement = 'loading';
    const { rerender } = render(<AiChatSidebar />);
    await settle();
    expect(wispThreadCalls()).toEqual([]);
    expect(screen.queryByTestId('wisp-sidebar-meet')).toBeNull();
    h.entitlement = 'locked';
    rerender(<AiChatSidebar />);
    await settle();
    expect(wispThreadCalls()).toEqual([]);
    // Wisp is on here but this plan lacks it: the home explains the upgrade.
    expect(screen.getByTestId('wisp-sidebar-meet')).toHaveAttribute('href', '/wisp');
  });

  it('does not look up a grant while the panel is closed', async () => {
    h.threads['/wisp/thread'] = threadBody('grant-pw', 'active');
    useAiStore.setState({ isOpen: false });
    render(<AiChatSidebar />);
    await settle();
    expect(wispThreadCalls()).toEqual([]);
  });

  it('never abandons a conversation already open: the next new conversation starts under the grant', async () => {
    h.threads['/wisp/thread'] = threadBody('grant-pw', 'active');
    useAiStore.setState({ sessionId: 'sess-plain', hydratedSessionId: 'sess-plain' });
    render(<AiChatSidebar />);
    await waitFor(() => expect(wispThreadCalls()).toContain('/wisp/thread'));
    await settle();
    expect(enterWispMode).not.toHaveBeenCalled();
    expect(screen.queryByTestId('wisp-sidebar-meet')).toBeNull();

    fireEvent.click(screen.getByTestId('ai-chat-new-conversation'));
    await waitFor(() => expect(enterWispMode).toHaveBeenCalledTimes(1));
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(createSession).not.toHaveBeenCalled();
    expect(enterWispMode.mock.calls[0][0]).toMatchObject({ grantId: 'grant-pw' });
  });

  it('New conversation re-reads the grant: one that ended since the panel opened starts a plain chat and offers Meet Wisp', async () => {
    h.threads['/wisp/thread'] = threadBody('grant-pw', 'active');
    useAiStore.setState({ sessionId: 'sess-plain', hydratedSessionId: 'sess-plain' });
    render(<AiChatSidebar />);
    await waitFor(() => expect(wispThreadCalls()).toHaveLength(1));
    await settle();
    // Revoked (or paused, or expired) elsewhere: the server now answers no_active_grant.
    delete h.threads['/wisp/thread'];

    fireEvent.click(screen.getByTestId('ai-chat-new-conversation'));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(wispThreadCalls()).toHaveLength(2);
    expect(enterWispMode).not.toHaveBeenCalled();
    expect(await screen.findByTestId('wisp-sidebar-meet')).toHaveAttribute('href', '/wisp');
  });

  it('New conversation without a grant is a plain new conversation', async () => {
    useAiStore.setState({ sessionId: 'sess-plain', hydratedSessionId: 'sess-plain' });
    render(<AiChatSidebar />);
    await screen.findByTestId('wisp-sidebar-meet');
    fireEvent.click(screen.getByTestId('ai-chat-new-conversation'));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(enterWispMode).not.toHaveBeenCalled();
  });

  it('a failed read (500) stays Breeze AI without Meet Wisp, and the next open asks again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.threadFailures['/wisp/thread'] = { status: 500, body: { error: 'boom' } };
    render(<AiChatSidebar />);
    await waitFor(() => expect(wispThreadCalls()).toHaveLength(1));
    await settle();
    expect(enterWispMode).not.toHaveBeenCalled();
    expect(screen.queryByTestId('wisp-sidebar-meet')).toBeNull();
    expect(warn).toHaveBeenCalled();

    delete h.threadFailures['/wisp/thread'];
    h.threads['/wisp/thread'] = threadBody('grant-pw', 'active');
    act(() => useAiStore.setState({ isOpen: false }));
    act(() => useAiStore.setState({ isOpen: true }));
    await waitFor(() => expect(enterWispMode).toHaveBeenCalledTimes(1));
    expect(wispThreadCalls()).toHaveLength(2);
    warn.mockRestore();
  });

  it('a 404 that is not no_active_grant (Wisp switched off mid-page) is a failure, not "no grant": no Meet Wisp', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.threadFailures['/wisp/thread'] = { status: 404, body: { error: 'Not found' } };
    render(<AiChatSidebar />);
    await waitFor(() => expect(wispThreadCalls()).toHaveLength(1));
    await settle();
    expect(screen.queryByTestId('wisp-sidebar-meet')).toBeNull();
    warn.mockRestore();
  });

  it('a paused grant also offers Meet Wisp (the home is where it is resumed)', async () => {
    h.threads['/wisp/thread'] = threadBody('grant-pw', 'paused');
    render(<AiChatSidebar />);
    expect(await screen.findByTestId('wisp-sidebar-meet')).toBeInTheDocument();
    expect(enterWispMode).not.toHaveBeenCalled();
  });

  it('a session the store already shows as Wisp is left alone (no second lookup, no new session)', async () => {
    useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w', hydratedSessionId: 'sess-w' });
    render(<AiChatSidebar />);
    await settle();
    expect(wispThreadCalls()).toEqual([]);
    expect(enterWispMode).not.toHaveBeenCalled();
  });
});

describe('AiChatSidebar speaks one voice and follows the grant live (#10195)', () => {
  const enterWispMode = vi.fn(async (w: NonNullable<WispState>) => { useAiStore.setState({ wisp: w }); });

  beforeEach(() => {
    fetchMock.mockClear();
    enterWispMode.mockClear();
    h.serverOn = true;
    h.scope = 'partner';
    h.entitlement = 'enabled';
    h.threads = {};
    h.threadFailures = {};
    useOrgStore.setState({ currentOrgId: null });
    useAiStore.setState({ ...BASE, enterWispMode });
  });

  it('under a Wisp header the empty state and the composer are Wisp too, not the generic Breeze AI prompts', () => {
    const sendMessage = vi.fn(async () => {});
    useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w', hydratedSessionId: 'sess-w', sendMessage });
    render(<AiChatSidebar />);
    expect(kitProps.input?.placeholder).toBe('Message Wisp');
    render(<>{kitProps.messages?.emptyState as React.ReactNode}</>);
    expect(screen.getByTestId('wisp-welcome')).toHaveTextContent("I'm looking around All organizations.");
    expect(screen.getByTestId('wisp-welcome')).not.toHaveTextContent('first brief');
    fireEvent.click(screen.getAllByTestId('wisp-suggestion')[0]);
    expect(sendMessage).toHaveBeenCalledWith('What needs my attention today? Keep it short.');
  });

  it('an org-scoped Wisp session greets with the organization name', () => {
    useOrgStore.setState({ organizations: [{ id: 'org-a', name: 'Acme' }] } as never);
    useAiStore.setState({ wisp: { ...wisp(), scopeOrgId: 'org-a' }, sessionId: 'sess-w', hydratedSessionId: 'sess-w' });
    render(<AiChatSidebar />);
    render(<>{kitProps.messages?.emptyState as React.ReactNode}</>);
    expect(screen.getByTestId('wisp-welcome')).toHaveTextContent("I'm looking around Acme.");
  });

  it('a plain chat keeps the Breeze AI empty state and placeholder', () => {
    h.serverOn = false;
    render(<AiChatSidebar />);
    expect(kitProps.messages?.emptyState).toBeUndefined();
    expect(kitProps.input?.placeholder).toBeUndefined();
  });

  it('a grant that ends elsewhere while the panel is open (revoked on /wisp) re-asks, so Meet Wisp appears', async () => {
    useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w', hydratedSessionId: 'sess-w' });
    render(<AiChatSidebar />);
    await settle();
    expect(wispThreadCalls()).toEqual([]);
    // /wisp revokes the grant: the home calls exitWispMode on the shared store.
    act(() => useAiStore.setState({ wisp: null, sessionId: null, hydratedSessionId: null }));
    expect(await screen.findByTestId('wisp-sidebar-meet')).toHaveAttribute('href', '/wisp');
    expect(wispThreadCalls()).toEqual(['/wisp/thread']);
    expect(enterWispMode).not.toHaveBeenCalled();
    expect(screen.getByText('Breeze AI')).toBeInTheDocument();
  });

  it('a grant that ended is never re-entered on the strength of a stale read (no create/drop loop)', async () => {
    useAiStore.setState({ wisp: wisp(), sessionId: null });
    render(<AiChatSidebar />);
    await settle();
    // e.g. the session create was refused grant_inactive and dropped Wisp, but the thread read still says active.
    expect(wisp().grantId).toBe('grant-1');
    h.threads['/wisp/thread'] = threadBody('grant-1', 'active');
    act(() => useAiStore.setState({ wisp: null }));
    await waitFor(() => expect(wispThreadCalls()).toEqual(['/wisp/thread']));
    await settle();
    expect(enterWispMode).not.toHaveBeenCalled();

    // The guard is spent by that one read: the next lookup (here an org change) decides afresh.
    act(() => useOrgStore.setState({ currentOrgId: 'org-b' }));
    await waitFor(() => expect(enterWispMode).toHaveBeenCalledTimes(1));
    expect(enterWispMode.mock.calls[0][0]).toMatchObject({ grantId: 'grant-1' });
  });

  it('entering or switching grants is not an end: no extra lookup', async () => {
    render(<AiChatSidebar />);
    await waitFor(() => expect(wispThreadCalls()).toEqual(['/wisp/thread']));
    await settle();
    act(() => useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w', hydratedSessionId: 'sess-w' }));
    await settle();
    act(() => useAiStore.setState({ wisp: { ...wisp(), grantId: 'grant-2', threadId: 'thread-2' } }));
    await settle();
    expect(wispThreadCalls()).toEqual(['/wisp/thread']);
    expect(enterWispMode).not.toHaveBeenCalled();
  });

  it('another live grant takes over an empty panel when the one it spoke under ends', async () => {
    useOrgStore.setState({ currentOrgId: 'org-a' });
    useAiStore.setState({ wisp: wisp(), sessionId: null });
    render(<AiChatSidebar />);
    await settle();
    h.threads['/wisp/thread?orgId=org-a'] = threadBody('grant-org', 'active', 'org-a');
    act(() => useAiStore.setState({ wisp: null }));
    await waitFor(() => expect(enterWispMode).toHaveBeenCalledTimes(1));
    expect(enterWispMode.mock.calls[0][0]).toMatchObject({ grantId: 'grant-org' });
  });
});
