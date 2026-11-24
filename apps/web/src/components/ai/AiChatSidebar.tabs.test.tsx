/**
 * The side panel has two tabs when the caller holds an active Wisp grant:
 * "Direct session" (Breeze AI: you work on the record yourself and approve
 * each step) and "Wisp" (the standing assistant, which hands longer jobs to
 * specialists). The panel opens on the tab the user last picked, and that is
 * the direct session until they pick Wisp: a grant no longer turns the panel
 * into Wisp by itself.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const BASE = {
  isOpen: true, showHistory: false, sessionId: null, hydratedSessionId: null, messages: [],
  isStreaming: false, isLoading: false, error: null, errorCode: null, composerDraft: '',
  topologySiteId: null, joinedMidResponse: false, wisp: null, wispPageThreadId: null,
};

const PARTNER_THREAD = '/wisp/thread';

describe('AiChatSidebar tabs: a direct session or Wisp', () => {
  const enterWispMode = vi.fn(async () => true);
  const selectPanelTab = vi.fn(async () => {});
  const createSession = vi.fn(async () => {});
  const closeSession = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    h.serverOn = true;
    h.scope = 'partner';
    h.entitlement = 'enabled';
    h.threads = {};
    h.threadFailures = {};
    useOrgStore.setState({ currentOrgId: null });
    useAiStore.setState({ ...BASE, panelTab: 'session', plainTabSessionId: null, enterWispMode, selectPanelTab, createSession, closeSession });
  });

  const tab = (id: 'session' | 'wisp') => screen.getByTestId(`ai-panel-tab-${id}`);

  it('an active grant does not turn the panel into Wisp: it opens on the direct session, with Wisp one tab away', async () => {
    h.threads[PARTNER_THREAD] = threadBody('grant-1', 'active');
    render(<AiChatSidebar />);
    await waitFor(() => expect(screen.getByTestId('ai-panel-tabs')).toBeInTheDocument());
    expect(tab('session')).toHaveAttribute('aria-selected', 'true');
    expect(tab('wisp')).toHaveAttribute('aria-selected', 'false');
    expect(enterWispMode).not.toHaveBeenCalled();
    expect(selectPanelTab).not.toHaveBeenCalled();
    expect(kitProps.messages?.assistantLabel).toBeUndefined();
  });

  it('the Wisp tab enters Wisp under the grant as it is now', async () => {
    h.threads[PARTNER_THREAD] = threadBody('grant-1', 'active');
    render(<AiChatSidebar />);
    await waitFor(() => expect(screen.getByTestId('ai-panel-tabs')).toBeInTheDocument());
    const before = wispThreadCalls().length;
    fireEvent.click(tab('wisp'));
    await waitFor(() => expect(selectPanelTab).toHaveBeenCalledTimes(1));
    expect(selectPanelTab).toHaveBeenCalledWith('wisp', expect.objectContaining({ grantId: 'grant-1' }));
    // Read again on the click, not trusted from when the panel opened.
    expect(wispThreadCalls().length).toBeGreaterThan(before);
  });

  it('a grant that ended since the panel opened: the Wisp tab enters nothing and the tabs go away', async () => {
    h.threads[PARTNER_THREAD] = threadBody('grant-1', 'active');
    render(<AiChatSidebar />);
    await waitFor(() => expect(screen.getByTestId('ai-panel-tabs')).toBeInTheDocument());
    h.threads = {};
    fireEvent.click(tab('wisp'));
    await waitFor(() => expect(screen.queryByTestId('ai-panel-tabs')).toBeNull());
    expect(selectPanelTab).not.toHaveBeenCalled();
    expect(screen.getByTestId('wisp-sidebar-meet')).toBeInTheDocument();
  });

  it('under Wisp the Wisp tab is selected, and the direct-session tab leaves without ending the grant', async () => {
    h.threads[PARTNER_THREAD] = threadBody('grant-1', 'active');
    useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w', hydratedSessionId: 'sess-w', panelTab: 'wisp' });
    render(<AiChatSidebar />);
    expect(tab('wisp')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(tab('session'));
    await waitFor(() => expect(selectPanelTab).toHaveBeenCalledWith('session'));
    // The store leaves Wisp: the tabs stay, because the grant is still there.
    act(() => { useAiStore.setState({ wisp: null, sessionId: null, hydratedSessionId: null, panelTab: 'session' }); });
    expect(screen.getByTestId('ai-panel-tabs')).toBeInTheDocument();
    await settle();
    expect(screen.getByTestId('ai-panel-tabs')).toBeInTheDocument();
    expect(tab('session')).toHaveAttribute('aria-selected', 'true');
    expect(enterWispMode).not.toHaveBeenCalled();
  });

  it('a panel last left on the Wisp tab opens as Wisp', async () => {
    h.threads[PARTNER_THREAD] = { data: { ...threadBody('grant-1', 'active').data, thread: { id: 'thread-1', summary: '', focusOrgId: null, lastSessionId: 'sess-w' } } };
    useAiStore.setState({ panelTab: 'wisp' });
    render(<AiChatSidebar />);
    await waitFor(() => expect(enterWispMode).toHaveBeenCalledTimes(1));
    expect(enterWispMode).toHaveBeenCalledWith(expect.objectContaining({ grantId: 'grant-1' }));
  });

  it('a panel last left on the Wisp tab does not abandon a direct session that is open', async () => {
    h.threads[PARTNER_THREAD] = threadBody('grant-1', 'active');
    useAiStore.setState({ panelTab: 'wisp', sessionId: 'sess-p', hydratedSessionId: 'sess-p' });
    render(<AiChatSidebar />);
    await waitFor(() => expect(screen.getByTestId('ai-panel-tabs')).toBeInTheDocument());
    expect(enterWispMode).not.toHaveBeenCalled();
    expect(tab('session')).toHaveAttribute('aria-selected', 'true');
  });

  it('clicking the tab already on screen still makes it the picked tab', async () => {
    // A device task showed the direct session over a panel last left on Wisp.
    h.threads[PARTNER_THREAD] = threadBody('grant-1', 'active');
    useAiStore.setState({ panelTab: 'wisp', sessionId: 'sess-p', hydratedSessionId: 'sess-p' });
    render(<AiChatSidebar />);
    await waitFor(() => expect(screen.getByTestId('ai-panel-tabs')).toBeInTheDocument());
    fireEvent.click(tab('session'));
    await waitFor(() => expect(selectPanelTab).toHaveBeenCalledWith('session', undefined));
  });

  it('the arrow keys move between the tabs', async () => {
    h.threads[PARTNER_THREAD] = threadBody('grant-1', 'active');
    render(<AiChatSidebar />);
    await waitFor(() => expect(screen.getByTestId('ai-panel-tabs')).toBeInTheDocument());
    expect(tab('session')).toHaveAttribute('tabindex', '0');
    expect(tab('wisp')).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(tab('session'), { key: 'ArrowRight' });
    await waitFor(() => expect(selectPanelTab).toHaveBeenCalledWith('wisp', expect.objectContaining({ grantId: 'grant-1' })));
    expect(tab('wisp')).toHaveFocus();
  });

  it('New conversation on the direct session stays direct, even with an active grant', async () => {
    h.threads[PARTNER_THREAD] = threadBody('grant-1', 'active');
    useAiStore.setState({ sessionId: 'sess-p', hydratedSessionId: 'sess-p' });
    render(<AiChatSidebar />);
    await waitFor(() => expect(screen.getByTestId('ai-panel-tabs')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('ai-chat-new-conversation'));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(enterWispMode).not.toHaveBeenCalled();
    expect(selectPanelTab).not.toHaveBeenCalled();
  });

  it('the tabs replace the "+" menu and the "not Wisp" label', async () => {
    h.threads[PARTNER_THREAD] = threadBody('grant-1', 'active');
    useAiStore.setState({ sessionId: 'sess-p', hydratedSessionId: 'sess-p' });
    render(<AiChatSidebar />);
    await waitFor(() => expect(screen.getByTestId('ai-panel-tabs')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-chat-new-menu')).toBeNull();
    expect(screen.queryByTestId('ai-chat-new-plain')).toBeNull();
    expect(screen.queryByTestId('ai-chat-mode-plain')).toBeNull();
  });

  it('no grant: no tabs, and Meet Wisp points at the home', async () => {
    render(<AiChatSidebar />);
    await waitFor(() => expect(screen.getByTestId('wisp-sidebar-meet')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-panel-tabs')).toBeNull();
  });

  it('a paused grant: no tabs', async () => {
    h.threads[PARTNER_THREAD] = threadBody('grant-1', 'paused');
    render(<AiChatSidebar />);
    await settle();
    expect(screen.queryByTestId('ai-panel-tabs')).toBeNull();
    expect(enterWispMode).not.toHaveBeenCalled();
  });

  it('History and a pane handed off to the Wisp page show no tabs', async () => {
    useAiStore.setState({ wisp: wisp(), sessionId: 'sess-w', hydratedSessionId: 'sess-w', panelTab: 'wisp', wispPageThreadId: 'thread-1' });
    const view = render(<AiChatSidebar />);
    expect(screen.getByTestId('ai-chat-handed-off')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-panel-tabs')).toBeNull();
    view.unmount();
    useAiStore.setState({ wispPageThreadId: null, showHistory: true });
    render(<AiChatSidebar />);
    expect(screen.queryByTestId('ai-panel-tabs')).toBeNull();
  });
});
