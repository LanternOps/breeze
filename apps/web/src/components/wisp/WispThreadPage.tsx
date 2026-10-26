import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '@/stores/auth';
import { useAiStore, type WispState } from '@/stores/aiStore';
import { useOrgStore } from '@/stores/orgStore';
import { wispStateFromThread } from '@/lib/wispGrant';
import WispCompanionShell from './WispCompanionShell';
import WispHomeThread from './WispHomeThread';
import WispRail from './WispRail';
import { fetchWispActivity } from './wispActivity';
import type { CurrentActivity } from '@breeze/shared';

type Wisp = NonNullable<WispState>;
type View =
  | { kind: 'loading' }
  | { kind: 'notFound' }
  | { kind: 'error' }
  /** `stale`: background refreshes keep failing, so what is shown may be out of date. */
  | { kind: 'ready'; wisp: Wisp; lastSessionId: string | null; current: CurrentActivity; stale: boolean };

/** The live line and spend meter refresh at this cadence while the tab is visible (w00 A31). */
const POLL_MS = 30_000;
/** One failed poll is noise; this many in a row is worth telling the user. */
const STALE_AFTER_FAILED_POLLS = 2;

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

/** The thread DTO's last stamped session; `wispStateFromThread` does not carry it. */
function lastSessionIdFrom(body: unknown): string | null {
  const value = (body as { data?: { thread?: { lastSessionId?: unknown } } } | null)?.data?.thread?.lastSessionId;
  return typeof value === 'string' ? value : null;
}

/** No links on this page: the column gets `links={null}` (no "Link an item"), the rail hides the section. */
const ignoreLinks = () => {};

/**
 * The Wisp thread page (W06 Task 7, spec §7.4), on the Wisp home's companion
 * layout (W01 #10211, spec §4.1): where an in-app nudge lands
 * (`/ai/wisp/thread/:threadId#concern=:id`). The conversation runs inline in
 * the column, the thread summary as its first post; the rail carries the
 * grant controls and live line, the grant's concerns (WispNeedsYou loads them
 * and expands the hash-selected row), workers and the activity timeline.
 */
export default function WispThreadPage({ threadId }: { threadId: string }) {
  const { t } = useTranslation('ai');
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [activityKey, setActivityKey] = useState(0);
  const organizations = useOrgStore((s) => s.organizations);
  const storeWisp = useAiStore((s) => s.wisp);
  const updateStoreWisp = useAiStore((s) => s.updateWisp);
  const exitWispMode = useAiStore((s) => s.exitWispMode);

  const viewRef = useRef(view);
  viewRef.current = view;
  const loadToken = useRef(0);
  const failedPolls = useRef(0);

  /** `silent` = a background poll: a failure keeps the page, and repeated failures mark it stale. */
  const load = useCallback(async (silent: boolean) => {
    const token = ++loadToken.current;
    if (!silent) setView({ kind: 'loading' });
    // The live line comes from the activity route's `current` (W06a). A failed
    // read drops the line: a stale "Checking …" would claim work that may be over.
    const currentRead = fetchWispActivity(threadId, null, 1).then(
      (page) => page.current,
      (err: unknown): CurrentActivity => {
        console.error('[WispThreadPage] reading the live activity line failed', err);
        return null;
      },
    );
    try {
      // Id-addressed: the switcher's org must not narrow it (routeScope: partner-settings).
      const [res, current] = await Promise.all([
        fetchWithAuth(`/wisp/thread/${encodeURIComponent(threadId)}`, { skipOrgIdInjection: true }),
        currentRead,
      ]);
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
      const prev = viewRef.current.kind === 'ready' ? viewRef.current.wisp : null;
      failedPolls.current = 0;
      setView({ kind: 'ready', wisp: mergePolled(prev, next), lastSessionId: lastSessionIdFrom(body), current, stale: false });
    } catch (err) {
      console.error('[WispThreadPage] loading the thread failed', err);
      if (token !== loadToken.current) return;
      if (silent && viewRef.current.kind === 'ready') {
        failedPolls.current += 1;
        if (failedPolls.current >= STALE_AFTER_FAILED_POLLS) setView((v) => (v.kind === 'ready' ? { ...v, stale: true } : v));
        return;
      }
      setView({ kind: 'error' });
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
    // The server just answered this change: a poll already in flight carries
    // the state from before it and must not overwrite it.
    loadToken.current++;
    setView((v) => (v.kind === 'ready' ? { ...v, wisp: { ...v.wisp, ...patch } } : v));
    if (ownsStore) updateStoreWisp(patch);
  };

  const onRevoked = async () => {
    if (ownsStore) await exitWispMode();
    await load(false);
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

  const { wisp, lastSessionId, current, stale } = view;
  const orgName = wisp.scopeOrgId ? ((organizations ?? []).find((o) => o.id === wisp.scopeOrgId)?.name ?? null) : null;
  const scopeLabel = wisp.scopeOrgId === null ? t('wisp.header.scopeAll') : (orgName ?? '');

  return (
    <WispCompanionShell
      testId="wisp-thread-page"
      wisp={wisp}
      current={current}
      needsYouCount={0}
      banners={stale && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300" data-testid="wisp-thread-stale" role="status">
          <span>{t('wisp.thread.stale')}</span>
          <button type="button" data-testid="wisp-thread-stale-retry" onClick={() => void load(true)} className="font-medium underline underline-offset-2">
            {t('wisp.thread.retry')}
          </button>
        </div>
      )}
      column={
        <WispHomeThread
          wisp={wisp}
          lastSessionId={lastSessionId}
          scopeLabel={scopeLabel}
          links={null}
          onLinksChange={ignoreLinks}
          leading={wisp.summary ? (
            <article className="space-y-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('wisp.post.summary')}</p>
              <p className="whitespace-pre-wrap text-sm" data-testid="wisp-thread-summary">{wisp.summary}</p>
            </article>
          ) : null}
        />
      }
      rail={
        <WispRail
          wisp={wisp}
          orgName={orgName}
          current={current}
          needsYou={[]}
          links={null}
          onLinksChange={ignoreLinks}
          onWispChange={onWispChange}
          onRevoked={onRevoked}
          activityKey={activityKey}
        />
      }
    />
  );
}
