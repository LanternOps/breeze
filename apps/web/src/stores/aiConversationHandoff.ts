// Panel <-> workspace hand-off coordinator (#9427). Coordination only: the
// destination prepares first, and the origin is released (onRelease) only once
// the destination reports success, so a failed or late hand-off leaves the
// origin untouched. Not persisted; a reload drops any pending hand-off.
import { create } from 'zustand';

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
  try {
    if (result === 'aborted') a.controller.abort();
    else a.onRelease();
  } finally {
    // A throwing onRelease must not leave the caller awaiting forever.
    a.settle(result);
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
