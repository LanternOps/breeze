/**
 * W08 (#9921) Task 10: in Wisp mode the docked panel defers to the Wisp home —
 * a way to /wisp ("Open Wisp home" in the header's overflow menu since
 * #critique), and no in-panel concern list (the home's "needs your attention"
 * owns it). Plain chat is untouched.
 *
 * The grant lookup (W05 of #10131, #10136): an active grant no longer decides
 * the panel's voice. It offers a Wisp tab beside the direct session, and the
 * panel goes into Wisp by itself only when the user last left it on that tab
 * (AiChatSidebar.tabs.test owns the tabs). A paused or missing grant leaves it
 * Breeze AI (with "Meet Wisp" when Wisp is on here), and no /wisp/thread
 * request is made unless the server flag, a partner token and the `wisp`
 * entitlement all pass (Review Focus 2).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  serverOn: false,
  wispEnabledOpts: [] as Array<{ enabled?: boolean } | undefined>,
  scope: 'partner' as string | null,
  entitlement: 'enabled' as 'loading' | 'enabled' | 'locked',
  /** GET /wisp/thread[?orgId=] → payload (status 200); absent = 200 { data: null } (no grant, #10200). */
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
      if (hit === undefined) return { ok: true, status: 200, json: async () => ({ data: null }) };
      return { ok: true, status: 200, json: async () => hit };
    }
    // The model menu's read. Answered empty, not 404: the app logs a refused
    // read, and the menu's reload after a cleared session sits behind a dynamic
    // import, so that log can arrive after the file's last test — which vitest
    // reports as an unhandled error at teardown ("Closing rpc while
    // onUserConsoleLog was pending"). The state is the same either way: no menu.
    if (url.startsWith('/ai/models/choices/chat')) return { ok: true, status: 200, json: async () => ({ data: null }) };
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
// The compact header is the pane's whole header in Wisp mode: it renders the
// pane's History / New / Close it is handed (its own title and menu are
// WispThreadHeader.test's).
vi.mock('./WispThreadHeader', () => ({
  default: (p: { paneActions?: React.ReactNode; closeAction?: React.ReactNode }) => (
    <div data-testid="wisp-thread-header-mock">{p.paneActions}{p.closeAction}</div>
  ),
}));
vi.mock('./WispThreadAttachments', () => ({ default: () => null }));
// #9429's bell (its behaviour is AiNotifyToggle.test's): a stub shows where it renders.
vi.mock('./AiNotifyToggle', () => ({ default: () => <span data-testid="ai-notify-toggle" /> }));
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

// Unmount, then let the work the panel and the store started finish inside the
// test, not after the file is done. The store reaches these modules through a
// dynamic import, which outlasts a timer tick.
afterEach(async () => {
  cleanup();
  await Promise.all([import('@/stores/orgStore'), import('@/stores/helpStore'), import('@/lib/wispGrant')]);
  await settle();
});

const BASE = {
  isOpen: true, showHistory: false, sessionId: null, hydratedSessionId: null, messages: [],
  isStreaming: false, isLoading: false, error: null, errorCode: null, composerDraft: '',
  topologySiteId: null, joinedMidResponse: false, wisp: null, wispPageThreadId: null,
  // setState merges: a test that picks the Wisp tab must not leak it into the next.
  panelTab: 'session' as const, plainTabSessionId: null,
};

describe('AiChatSidebar in Wisp mode defers to the home (W08 Task 10)', () => {
  beforeEach(() => {
    h.serverOn = false;
    useAiStore.setState(BASE);
  });

  it('Wisp mode: the compact header (whose menu opens the Wisp home) stays and the concern list is gone', () => {
    useAiStore.setState({ wisp: wisp() });
    render(<AiChatSidebar />);
    expect(screen.getByTestId('wisp-thread-header-mock')).toBeInTheDocument();
    // "Open Wisp home" is an item in the header's overflow menu now (WispThreadHeader.test).
    expect(screen.queryByTestId('wisp-concerns-mock')).toBeNull();
  });

  // #9429 × #critique: collapsing the Wisp header must not drop the notification bell.
  it('the notification bell sits beside Close in the compact Wisp header and in the handed-off header', () => {
    useAiStore.setState({ wisp: wisp() });
    const view = render(<AiChatSidebar />);
    const header = screen.getByTestId('wisp-thread-header-mock');
    expect(header).toContainElement(screen.getByTestId('ai-notify-toggle'));
    expect(screen.getByTestId('ai-notify-toggle').nextElementSibling).toBe(screen.getByTestId('ai-chat-close'));
    view.unmount();
    useAiStore.setState({ wisp: wisp(), sessionId: 's-w', hydratedSessionId: 's-w', wispPageThreadId: 'thread-1' });
    render(<AiChatSidebar />);
    expect(screen.getByTestId('ai-chat-handed-off')).toBeInTheDocument();
    expect(screen.getAllByTestId('ai-notify-toggle')).toHaveLength(1);
    expect(screen.getByTestId('ai-notify-toggle').nextElementSibling).toBe(screen.getByTestId('ai-chat-close'));
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

describe('AiChatSidebar looks up the grant behind the Wisp tab (W05 #10136)', () => {
  const enterWispMode = vi.fn(async (w: NonNullable<WispState>) => { useAiStore.setState({ wisp: w }); return true; });
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

  it('an active grant opens the panel on the direct session, with the Wisp tab offered and Wisp not entered', async () => {
    h.threads['/wisp/thread'] = threadBody('grant-pw', 'active');
    render(<AiChatSidebar />);
    expect(await screen.findByTestId('ai-panel-tabs')).toBeInTheDocument();
    expect(screen.getByTestId('ai-panel-tab-session')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('ai-panel-tab-wisp')).toHaveAttribute('aria-selected', 'false');
    await settle();
    expect(enterWispMode).not.toHaveBeenCalled();
    expect(useAiStore.getState().wisp).toBeNull();
    // The direct session's own header; a grant is not "no grant", so no Meet Wisp.
    expect(screen.getByText('Breeze AI')).toBeInTheDocument();
    expect(screen.queryByTestId('wisp-thread-header-mock')).toBeNull();
    expect(screen.queryByTestId('wisp-sidebar-meet')).toBeNull();
  });

  it('#11672: a panel left on the Wisp tab hands enterWispMode the thread\'s last session, so it continues the conversation', async () => {
    const body = threadBody('grant-pw', 'active');
    h.threads['/wisp/thread'] = { data: { ...body.data, thread: { ...body.data.thread, lastSessionId: 'sess-from-wisp-page' } } };
    useAiStore.setState({ panelTab: 'wisp' });
    render(<AiChatSidebar />);
    await waitFor(() => expect(enterWispMode).toHaveBeenCalledTimes(1));
    expect(enterWispMode.mock.calls[0][0]).toMatchObject({ grantId: 'grant-pw', lastSessionId: 'sess-from-wisp-page' });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('on the Wisp tab, finds a grant scoped to the selected organization when there is no partner-wide one', async () => {
    useOrgStore.setState({ currentOrgId: 'org-a' });
    useAiStore.setState({ panelTab: 'wisp' });
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

  it('never abandons a conversation already open, even on the Wisp tab; "+" on it starts another direct one without re-reading the grant', async () => {
    h.threads['/wisp/thread'] = threadBody('grant-pw', 'active');
    useAiStore.setState({ panelTab: 'wisp', sessionId: 'sess-plain', hydratedSessionId: 'sess-plain' });
    render(<AiChatSidebar />);
    expect(await screen.findByTestId('ai-panel-tabs')).toBeInTheDocument();
    await settle();
    expect(enterWispMode).not.toHaveBeenCalled();
    expect(screen.queryByTestId('wisp-sidebar-meet')).toBeNull();
    const reads = wispThreadCalls().length;

    fireEvent.click(screen.getByTestId('ai-chat-new-conversation'));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(closeSession.mock.invocationCallOrder[0]).toBeLessThan(createSession.mock.invocationCallOrder[0]);
    await settle();
    expect(enterWispMode).not.toHaveBeenCalled();
    expect(wispThreadCalls()).toHaveLength(reads);
  });

  it('under Wisp, "+" is one button that starts another conversation on the grant without leaving Wisp', async () => {
    useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w', hydratedSessionId: 'sess-w', panelTab: 'wisp' });
    render(<AiChatSidebar />);
    fireEvent.click(screen.getByTestId('ai-chat-new-conversation'));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(closeSession.mock.invocationCallOrder[0]).toBeLessThan(createSession.mock.invocationCallOrder[0]);
    // createSession sends the grant because `wisp` is still set (aiStore.wisp.test).
    expect(useAiStore.getState().wisp?.grantId).toBe('grant-1');
    expect(enterWispMode).not.toHaveBeenCalled();
    expect(wispThreadCalls()).toEqual([]);
  });

  it('New conversation without a grant is a plain new conversation', async () => {
    useAiStore.setState({ sessionId: 'sess-plain', hydratedSessionId: 'sess-plain' });
    render(<AiChatSidebar />);
    await screen.findByTestId('wisp-sidebar-meet');
    fireEvent.click(screen.getByTestId('ai-chat-new-conversation'));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(enterWispMode).not.toHaveBeenCalled();
  });

  it('a failed read (500) stays Breeze AI without Meet Wisp or tabs, and the next open asks again and offers the Wisp tab', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.threadFailures['/wisp/thread'] = { status: 500, body: { error: 'boom' } };
    render(<AiChatSidebar />);
    await waitFor(() => expect(wispThreadCalls()).toHaveLength(1));
    await settle();
    expect(enterWispMode).not.toHaveBeenCalled();
    expect(screen.queryByTestId('wisp-sidebar-meet')).toBeNull();
    expect(screen.queryByTestId('ai-panel-tabs')).toBeNull();
    expect(warn).toHaveBeenCalled();

    delete h.threadFailures['/wisp/thread'];
    h.threads['/wisp/thread'] = threadBody('grant-pw', 'active');
    act(() => useAiStore.setState({ isOpen: false }));
    act(() => useAiStore.setState({ isOpen: true }));
    expect(await screen.findByTestId('ai-panel-tabs')).toBeInTheDocument();
    expect(wispThreadCalls()).toHaveLength(2);
    expect(screen.getByTestId('ai-panel-tab-session')).toHaveAttribute('aria-selected', 'true');
    expect(enterWispMode).not.toHaveBeenCalled();
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
  const enterWispMode = vi.fn(async (w: NonNullable<WispState>) => { useAiStore.setState({ wisp: w }); return true; });

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
    useAiStore.setState({ wisp: { ...wisp(), firstLookState: 'looking' }, sessionId: 'sess-w', hydratedSessionId: 'sess-w', sendMessage });
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
    useAiStore.setState({ wisp: { ...wisp(), scopeOrgId: 'org-a', firstLookState: 'looking' }, sessionId: 'sess-w', hydratedSessionId: 'sess-w' });
    render(<AiChatSidebar />);
    render(<>{kitProps.messages?.emptyState as React.ReactNode}</>);
    expect(screen.getByTestId('wisp-welcome')).toHaveTextContent("I'm looking around Acme.");
  });

  it.each([
    ['couldnt_look', "I couldn't look at All organizations yet."],
    ['done', "I've had a first look at All organizations."],
  ] as const)('#11145: a %s grant does not say "looking around" in the panel', (firstLookState, text) => {
    useAiStore.setState({ wisp: { ...wisp(), firstLookState }, sessionId: 'sess-w', hydratedSessionId: 'sess-w' });
    render(<AiChatSidebar />);
    render(<>{kitProps.messages?.emptyState as React.ReactNode}</>);
    expect(screen.getByTestId('wisp-welcome')).toHaveTextContent(text);
    expect(screen.getByTestId('wisp-welcome')).not.toHaveTextContent('looking around');
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

  it('on the Wisp tab, a grant that ended is never re-entered on the strength of a stale read (no create/drop loop)', async () => {
    // The Wisp tab, so only the ended-grant guard (not the tab) keeps the read from re-entering.
    useAiStore.setState({ wisp: wisp(), sessionId: null, panelTab: 'wisp' });
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

  it('on the Wisp tab, another live grant takes over an empty panel when the one it spoke under ends', async () => {
    useOrgStore.setState({ currentOrgId: 'org-a' });
    useAiStore.setState({ wisp: wisp(), sessionId: null, panelTab: 'wisp' });
    render(<AiChatSidebar />);
    await settle();
    h.threads['/wisp/thread?orgId=org-a'] = threadBody('grant-org', 'active', 'org-a');
    act(() => useAiStore.setState({ wisp: null }));
    await waitFor(() => expect(enterWispMode).toHaveBeenCalledTimes(1));
    expect(enterWispMode.mock.calls[0][0]).toMatchObject({ grantId: 'grant-org' });
  });

  it('on the direct-session tab, another live grant only offers the Wisp tab when the one shown ends', async () => {
    useOrgStore.setState({ currentOrgId: 'org-a' });
    useAiStore.setState({ wisp: wisp(), sessionId: null });
    render(<AiChatSidebar />);
    await settle();
    h.threads['/wisp/thread?orgId=org-a'] = threadBody('grant-org', 'active', 'org-a');
    act(() => useAiStore.setState({ wisp: null }));
    await waitFor(() => expect(wispThreadCalls()).toContain('/wisp/thread?orgId=org-a'));
    await settle();
    expect(screen.getByTestId('ai-panel-tabs')).toBeInTheDocument();
    expect(screen.getByTestId('ai-panel-tab-session')).toHaveAttribute('aria-selected', 'true');
    expect(enterWispMode).not.toHaveBeenCalled();
  });
});

/**
 * On a page whose own composer shows the Wisp thread (the Wisp home, a thread
 * page) that composer is the conversation: the AI shortcut focuses it instead
 * of opening the pane, and a pane open on the same thread hands off to it
 * rather than repeating the header and the transcript. A different
 * conversation keeps working in the pane.
 */
describe('AiChatSidebar hands off to the page composer on /wisp', () => {
  const shortcut = () => act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', metaKey: true, shiftKey: true, cancelable: true }));
  });

  beforeEach(() => {
    h.serverOn = false;
    kitProps.input = null;
    useAiStore.setState({ ...BASE, isOpen: false, wispPageThreadId: null, wispPageComposerFocusRequest: 0 });
  });

  it('Cmd+Shift+A on the Wisp home focuses the page composer and leaves the pane closed', () => {
    useAiStore.setState({ wisp: wisp(), sessionId: 's-w', hydratedSessionId: 's-w', wispPageThreadId: 'thread-1' });
    render(<AiChatSidebar />);
    shortcut();
    expect(useAiStore.getState().isOpen).toBe(false);
    expect(useAiStore.getState().wispPageComposerFocusRequest).toBe(1);
    shortcut();
    expect(useAiStore.getState().isOpen).toBe(false);
    expect(useAiStore.getState().wispPageComposerFocusRequest).toBe(2);
  });

  it('off the Wisp home (or with another conversation in the store) Cmd+Shift+A toggles the pane as before', () => {
    useAiStore.setState({ wisp: wisp(), sessionId: 's-w', hydratedSessionId: 's-w' });
    const view = render(<AiChatSidebar />);
    shortcut();
    expect(useAiStore.getState().isOpen).toBe(true);
    shortcut();
    expect(useAiStore.getState().isOpen).toBe(false);
    expect(useAiStore.getState().wispPageComposerFocusRequest).toBe(0);
    view.unmount();
    // The page shows thread-1, the store holds another thread: the pane is that conversation.
    useAiStore.setState({ wisp: { ...wisp(), grantId: 'grant-2', threadId: 'thread-2' }, wispPageThreadId: 'thread-1' });
    render(<AiChatSidebar />);
    shortcut();
    expect(useAiStore.getState().isOpen).toBe(true);
    expect(useAiStore.getState().wispPageComposerFocusRequest).toBe(0);
  });

  it('a pane open on the page’s thread renders one calm line and no compact header or transcript', () => {
    useAiStore.setState({ isOpen: true, wisp: wisp(), sessionId: 's-w', hydratedSessionId: 's-w', wispPageThreadId: 'thread-1' });
    render(<AiChatSidebar />);
    const handedOff = screen.getByTestId('ai-chat-handed-off');
    expect(handedOff).toHaveTextContent('This conversation is open on the page.');
    expect(screen.queryByTestId('wisp-thread-header-mock')).toBeNull();
    expect(kitProps.input).toBeNull();
    // The pane can still be closed from its own header.
    expect(screen.getByTestId('ai-chat-close')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-chat-handed-off-focus'));
    expect(useAiStore.getState().isOpen).toBe(false);
    expect(useAiStore.getState().wispPageComposerFocusRequest).toBe(1);
  });

  it('a pane holding a different session keeps working as today', () => {
    useAiStore.setState({
      isOpen: true, wisp: { ...wisp(), grantId: 'grant-2', threadId: 'thread-2' }, sessionId: 's-2', hydratedSessionId: 's-2',
      wispPageThreadId: 'thread-1',
    });
    const view = render(<AiChatSidebar />);
    expect(screen.queryByTestId('ai-chat-handed-off')).toBeNull();
    expect(screen.getByTestId('wisp-thread-header-mock')).toBeInTheDocument();
    expect(kitProps.input).not.toBeNull();
    view.unmount();
    // A plain chat (no Wisp at all) beside the page: the ordinary Breeze AI pane.
    kitProps.input = null;
    useAiStore.setState({ wisp: null, sessionId: 's-plain', hydratedSessionId: 's-plain' });
    render(<AiChatSidebar />);
    expect(screen.queryByTestId('ai-chat-handed-off')).toBeNull();
    expect(screen.getByText('Breeze AI')).toBeInTheDocument();
    expect(kitProps.input).not.toBeNull();
  });
});
