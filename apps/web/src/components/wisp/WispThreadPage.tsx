import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '@/stores/auth';
import { useAiStore, type WispState } from '@/stores/aiStore';
import { useOrgStore } from '@/stores/orgStore';
import { wispStateFromThread } from '@/lib/wispGrant';
import WispThreadHeader from '../ai/WispThreadHeader';
import { WispConcernsPanel } from '../ai/WispConcernsPanel';
import WispActivityPanel from './WispActivityPanel';
import { fetchWispActivity } from './wispActivity';
import type { CurrentActivity } from '@breeze/shared';

type Wisp = NonNullable<WispState>;
type View =
  | { kind: 'loading' }
  | { kind: 'notFound' }
  | { kind: 'error' }
  | { kind: 'ready'; wisp: Wisp; current: CurrentActivity };

/** The live line and spend meter refresh at this cadence while the tab is visible (w00 A31). */
const POLL_MS = 30_000;

/**
 * A poll replaces the server-owned fields but keeps what the thread payload
 * does not carry: a pause reason learned from the grant list or a pause
 * answer survives as long as the status it explains is unchanged.
 */
function mergePolled(prev: Wisp | null, next: Wisp): Wisp {
  if (prev && next.pausedReason === undefined && prev.status === next.status) {
    return { ...next, pausedReason: prev.pausedReason };
  }
  return next;
}

/**
 * The Wisp thread page (W06 Task 7, spec §7.4): where an in-app nudge lands
 * (`/ai/wisp/thread/:threadId#concern=:id`). Header (scope, status, spend,
 * pause, live line), the grant's concerns with the hash-selected row
 * expanded, and the activity timeline. Chatting happens in the docked panel.
 */
export default function WispThreadPage({ threadId }: { threadId: string }) {
  const { t } = useTranslation('ai');
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [activityKey, setActivityKey] = useState(0);
  const organizations = useOrgStore((s) => s.organizations);
  const storeWisp = useAiStore((s) => s.wisp);
  const enterWispMode = useAiStore((s) => s.enterWispMode);
  const openPanel = useAiStore((s) => s.open);
  const updateStoreWisp = useAiStore((s) => s.updateWisp);
  const exitWispMode = useAiStore((s) => s.exitWispMode);
  const [opening, setOpening] = useState(false);

  const viewRef = useRef(view);
  viewRef.current = view;
  const loadToken = useRef(0);

  /** `silent` = a background poll: a failure keeps the page as it is. */
  const load = useCallback(async (silent: boolean) => {
    const token = ++loadToken.current;
    if (!silent) setView({ kind: 'loading' });
    // The live line comes from the activity route's `current` (W06a); a failed
    // read keeps the last known line (undefined) rather than failing the page.
    const currentRead = fetchWispActivity(threadId, null, 1).then(
      (page): CurrentActivity | undefined => page.current,
      (err: unknown) => {
        console.error('[WispThreadPage] reading the live activity line failed', err);
        return undefined;
      },
    );
    try {
      const [res, current] = await Promise.all([fetchWithAuth(`/wisp/thread/${encodeURIComponent(threadId)}`), currentRead]);
      if (token !== loadToken.current) return;
      if (res.status === 404) {
        setView({ kind: 'notFound' });
        return;
      }
      if (!res.ok) throw new Error(`wisp thread read failed: ${res.status}`);
      const body = await res.json();
      if (token !== loadToken.current) return;
      const next = wispStateFromThread(body);
      if (!next) throw new Error('wisp thread read: malformed payload');
      const prev = viewRef.current.kind === 'ready' ? viewRef.current : null;
      setView({ kind: 'ready', wisp: mergePolled(prev?.wisp ?? null, next), current: current === undefined ? (prev?.current ?? null) : current });
    } catch (err) {
      console.error('[WispThreadPage] loading the thread failed', err);
      if (token === loadToken.current && !(silent && viewRef.current.kind === 'ready')) setView({ kind: 'error' });
    }
  }, [threadId]);

  useEffect(() => {
    void load(false);
    return () => { loadToken.current++; };
  }, [load]);

  // Poll only while the tab is visible; catch up at once when it comes back.
  useEffect(() => {
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const timer = setInterval(() => { if (visible() && viewRef.current.kind === 'ready') void load(true); }, POLL_MS);
    const onVisibility = () => { if (visible() && viewRef.current.kind === 'ready') void load(true); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  // A check starting or finishing is when new activity appears: refresh the timeline then, not every poll.
  const liveKey = view.kind === 'ready' ? (view.current?.startedAt ?? 'idle') : null;
  const lastLiveKey = useRef<string | null>(null);
  useEffect(() => {
    if (liveKey === null) return;
    if (lastLiveKey.current !== null && lastLiveKey.current !== liveKey) setActivityKey((k) => k + 1);
    lastLiveKey.current = liveKey;
  }, [liveKey]);

  const ownsStore = storeWisp?.threadId === threadId;

  const onWispChange = (patch: Partial<Wisp>) => {
    setView((v) => (v.kind === 'ready' ? { ...v, wisp: { ...v.wisp, ...patch } } : v));
    if (ownsStore) updateStoreWisp(patch);
  };

  const onRevoked = async () => {
    if (ownsStore) await exitWispMode();
    await load(false);
  };

  const openInChat = async (wisp: Wisp) => {
    setOpening(true);
    try {
      await enterWispMode(wisp);
      openPanel();
    } finally {
      setOpening(false);
    }
  };

  if (view.kind === 'loading') {
    return <div className="p-6 text-sm text-muted-foreground" data-testid="wisp-thread-loading" aria-busy="true" />;
  }
  if (view.kind === 'notFound') {
    return <p className="p-6 text-sm text-muted-foreground" data-testid="wisp-thread-not-found">{t('wisp.thread.notFound')}</p>;
  }
  if (view.kind === 'error') {
    return (
      <div className="space-y-2 p-6 text-sm" data-testid="wisp-thread-load-error">
        <p className="text-destructive">{t('wisp.thread.loadFailed')}</p>
        <button type="button" data-testid="wisp-thread-retry" onClick={() => void load(false)} className="rounded border px-3 py-1 hover:bg-muted">
          {t('wisp.thread.retry')}
        </button>
      </div>
    );
  }

  const { wisp, current } = view;
  const orgName = wisp.scopeOrgId ? ((organizations ?? []).find((o) => o.id === wisp.scopeOrgId)?.name ?? null) : null;
  const active = wisp.status === 'active';

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4" data-testid="wisp-thread-page">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{t('wisp.thread.title')}</h1>
        <button
          type="button"
          data-testid="wisp-thread-open-chat"
          disabled={!active || opening}
          title={active ? undefined : t('wisp.thread.openChatInactive')}
          onClick={() => void openInChat(wisp)}
          className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          <MessageSquare className="h-4 w-4" />
          {t('wisp.thread.openChat')}
        </button>
      </div>

      <section className="overflow-hidden rounded-lg border bg-card">
        <WispThreadHeader
          wisp={wisp}
          orgName={orgName}
          wideningAvailable={false}
          showFocus={false}
          currentActivity={current}
          onWispChange={onWispChange}
          onRevoked={onRevoked}
        />
        {wisp.summary && (
          <p className="whitespace-pre-wrap px-4 py-3 text-sm" data-testid="wisp-thread-summary">{wisp.summary}</p>
        )}
      </section>

      <section className="overflow-hidden rounded-lg border bg-card">
        <WispConcernsPanel key={wisp.grantId} grantId={wisp.grantId} threadId={wisp.threadId} />
      </section>

      <section className="overflow-hidden rounded-lg border bg-card">
        <WispActivityPanel threadId={wisp.threadId} refreshKey={activityKey} />
      </section>
    </div>
  );
}
