// Panel <-> workspace hand-off coordinator (#9427). Coordination only: the
// destination prepares first, and the origin is released (onRelease) only once
// the destination reports success, so a failed or late hand-off leaves the
// origin untouched. Not persisted; a reload drops any pending hand-off.
// moveToAssistant / continueInSidePanel (bottom) are the two UI-level moves.
import { create } from 'zustand';
import { navigate } from 'astro:transitions/client';
import { i18n } from '@/lib/i18n';
import { showToast } from '../components/shared/Toast';
import { useAiStore } from './aiStore';

export interface PendingHandoff {
  sessionId: string;
  origin: 'panel' | 'workspace';
  originTabId?: string;
  draft?: string;
  startedAt: number;
}

export const HANDOFF_TIMEOUT_MS = 15_000;

export const useHandoffStore = create<{ pending: PendingHandoff | null }>(() => ({ pending: null }));

interface Active {
  sessionId: string;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  onRelease: () => void;
  settle: (r: 'completed' | 'aborted') => void;
}

let active: Active | null = null;

function finish(a: Active, result: 'completed' | 'aborted'): void {
  clearTimeout(a.timer);
  if (active === a) {
    active = null;
    useHandoffStore.setState({ pending: null });
  }
  // The signal fires on abort so a late destination does not commit a tab or
  // bind the panel while the origin is kept (that would mirror the session).
  if (result === 'aborted') {
    a.controller.abort();
    a.settle('aborted');
    return;
  }
  try {
    a.onRelease();
    a.settle('completed');
  } catch (err) {
    // The origin was NOT released, so report the hand-off as aborted rather
    // than completed; never rethrow into completeHandoff's caller or a timer.
    console.error('[AI] Hand-off origin release failed', err);
    a.settle('aborted');
  }
}

export function beginHandoff(
  p: Omit<PendingHandoff, 'startedAt'>,
  onRelease: () => void,
): Promise<'completed' | 'aborted'> {
  if (active) finish(active, 'aborted');
  return new Promise((resolve) => {
    const a: Active = {
      sessionId: p.sessionId,
      controller: new AbortController(),
      timer: setTimeout(() => finish(a, 'aborted'), HANDOFF_TIMEOUT_MS),
      onRelease,
      settle: resolve,
    };
    active = a;
    useHandoffStore.setState({ pending: { ...p, startedAt: Date.now() } });
  });
}

export function completeHandoff(sessionId: string): void {
  if (active && active.sessionId === sessionId) finish(active, 'completed');
}

export function abortHandoff(sessionId: string): void {
  if (active && active.sessionId === sessionId) finish(active, 'aborted');
}

/** Destination side: the draft is handed over once; the signal tells it to stop if the hand-off dies. */
export function takeHandoff(sessionId: string): { draft?: string; signal: AbortSignal } | undefined {
  const pending = useHandoffStore.getState().pending;
  if (!active || !pending || active.sessionId !== sessionId || pending.sessionId !== sessionId) return undefined;
  const draft = pending.draft;
  if (draft !== undefined) useHandoffStore.setState({ pending: { ...pending, draft: undefined } });
  return { draft, signal: active.controller.signal };
}

// ── The two moves (#9427 W3, T13) ───────────────────────────────────────────

const onWorkspacePage = () => /^\/workspace\/?$/.test(window.location.pathname);

/**
 * Side panel → AI Assistant. The tab cap is checked first (panel untouched,
 * no navigation). Then the hand-off starts — NOT awaited — and the browser
 * goes to `/workspace#session=<id>`; the workspace opens the tab and calls
 * completeHandoff, the only place the panel is released. A destination that
 * never answers leaves the panel as it was after HANDOFF_TIMEOUT_MS. Never a
 * DELETE: release is local.
 */
export async function moveToAssistant(
  sessionId: string,
  opts: { draft?: string } = {},
): Promise<'moved' | 'tab_cap' | 'aborted'> {
  // Lazy: keeps workspaceStore out of the side panel's bundle.
  const { useWorkspaceStore, MAX_TABS } = await import('./workspaceStore');
  const { tabs } = useWorkspaceStore.getState();
  if (!tabs.some((t) => t.sessionId === sessionId) && tabs.length >= MAX_TABS) {
    showToast({ type: 'warning', message: i18n.t('ai:aiConversationMove.closeTabInAssistant') });
    return 'tab_cap';
  }

  const result = beginHandoff(
    { sessionId, origin: 'panel', draft: opts.draft },
    () => useAiStore.getState().releaseSession(sessionId),
  );
  const target = `session=${sessionId}`;
  if (onWorkspacePage()) {
    // The workspace listens for a real hashchange; assigning the hash it
    // already has fires none, so announce that case explicitly.
    if (window.location.hash === `#${target}`) window.dispatchEvent(new HashChangeEvent('hashchange'));
    else window.location.hash = target;
  } else {
    navigate(`/workspace#${target}`);
  }
  return (await result) === 'completed' ? 'moved' : 'aborted';
}

/**
 * AI Assistant tab → side panel. Origin and destination live in one document,
 * so D3's "release only after the destination is ready" is met by ordering:
 * the tab closes only once adoptSession resolved 'ok' (on its attach's ready).
 * Replacing a panel conversation that has unsent text or a running reply asks
 * first; the replaced conversation stays in history (nothing is closed).
 */
export async function continueInSidePanel(
  tabId: string,
  opts: { confirm: () => Promise<boolean> },
): Promise<'moved' | 'cancelled' | 'failed'> {
  const { useWorkspaceStore } = await import('./workspaceStore');
  const tab = useWorkspaceStore.getState().tabs.find((t) => t.id === tabId);
  const sessionId = tab?.sessionId;
  if (!tab || !sessionId) return 'failed';

  const panel = useAiStore.getState();
  const panelBusy = panel.sessionId !== null && panel.sessionId !== sessionId
    && (panel.isStreaming || panel.composerDraft.trim() !== '');
  if (panelBusy && !(await opts.confirm())) return 'cancelled';

  const adopted = await useAiStore.getState().adoptSession(sessionId, { draft: tab.composerDraft });
  if (adopted === 'ok') {
    const still = useWorkspaceStore.getState().tabs.find((t) => t.id === tabId);
    if (still?.sessionId === sessionId) useWorkspaceStore.getState().closeTab(tabId);
    return 'moved';
  }
  showToast({
    type: 'error',
    message: adopted === 'closed'
      ? i18n.t('ai:aiConversationMove.wasClosed')
      : i18n.t('ai:aiConversationMove.notAvailable'),
  });
  return 'failed';
}
