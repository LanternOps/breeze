import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, MessagesSquare, Sparkles } from 'lucide-react';
import { LIVE_CONCERN_STATUSES, type CurrentActivity, type WispHomePayload, type WispThreadLink } from '@breeze/shared';
import { FeatureLock } from '@/components/shared/FeatureLock';
import { useEntitlement } from '@/hooks/useEntitlement';
import { useAiStore, type WispState } from '@/stores/aiStore';
import { useOrgStore } from '@/stores/orgStore';
import WispGrantStepUpModal from '../ai/WispGrantStepUpModal';
import WispCompanionShell from './WispCompanionShell';
import WispHomeThread from './WispHomeThread';
import WispRail from './WispRail';
import { fetchWispHome, fetchWispPartnerEnabled, homeSectionFromHash } from './wispHome';

type Wisp = NonNullable<WispState>;
type View =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'locked' }
  | { kind: 'forbidden' }
  /** No usable grant: `partnerEnabled` false shows why there is no start button. */
  | { kind: 'start'; partnerEnabled: boolean }
  | { kind: 'ready'; payload: WispHomePayload; wisp: Wisp; current: CurrentActivity; links: WispThreadLink[]; stale: boolean };

/** The live line, spend meter and links refresh at this cadence while the tab is visible (as the thread page, w00 A31). */
const POLL_MS = 30_000;
const STALE_AFTER_FAILED_POLLS = 2;

const CHATS_HREF = '/ai/chat';
const MEMORY_HREF = '/settings/wisp-memory';
const SETTINGS_HREF = '/settings/ai-agents';

/** What the needs-you count shows: the same live rule `WispNeedsYou` lists by. */
const LIVE_STATUSES: readonly string[] = LIVE_CONCERN_STATUSES;

/**
 * The Wisp home's body (W08 Task 9; W01 #10211, companion spec §4.1): one read
 * (`GET /wisp/home`, no model call) for first paint, then a quiet poll.
 * Ready: the conversation is the page. `WispCompanionShell` lays out the
 * thread column at reading width (the thread's timeline with Wisp's posts:
 * briefs, nudges, digests, W02b; the composer anchored at the bottom) and the rail at the right from `lg` up:
 * identity and grant controls, what needs you, workers, linked items, the
 * activity timeline, and the chats and memory links. Below `lg` the rail
 * collapses to a status strip that opens it in a drawer. No page heading: the
 * identity card carries the name.
 * Other states keep the framed heading: not entitled → FeatureLock; no grant
 * → start card (or, with the partner switch off, why not); a broken read →
 * retry, never a guessed state.
 */
export default function WispHomeContent() {
  const { t } = useTranslation('ai');
  const entitlement = useEntitlement('wisp');
  const organizations = useOrgStore((s) => s.organizations);
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const storeWisp = useAiStore((s) => s.wisp);
  const updateStoreWisp = useAiStore((s) => s.updateWisp);
  const exitWispMode = useAiStore((s) => s.exitWispMode);
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [startOpen, setStartOpen] = useState(false);
  const [activityKey, setActivityKey] = useState(0);
  const [threadKey, setThreadKey] = useState(0);

  const viewRef = useRef(view);
  viewRef.current = view;
  const loadToken = useRef(0);
  const failedPolls = useRef(0);

  /** `silent` = a background poll: a failure keeps the page, and repeated failures mark it stale. */
  const load = useCallback(async (silent: boolean) => {
    const token = ++loadToken.current;
    if (!silent) setView({ kind: 'loading' });
    try {
      const home = await fetchWispHome();
      if (token !== loadToken.current) return;
      failedPolls.current = 0;
      if (home.kind === 'locked') { setView({ kind: 'locked' }); return; }
      if (home.kind === 'forbidden') {
        // A 403 on a background poll must not tear down a working page: treat it as a failed poll.
        if (silent && viewRef.current.kind === 'ready') throw new Error('wisp home poll refused (403)');
        setView({ kind: 'forbidden' });
        return;
      }
      if (home.kind === 'noGrant') {
        // A missing switch read must not hide the start card: the grant route refuses PARTNER_DISABLED itself.
        const partnerEnabled = await fetchWispPartnerEnabled().catch((err: unknown) => {
          console.error('[WispHomeContent] reading the partner Wisp switch failed', err);
          return true;
        });
        if (token === loadToken.current) setView({ kind: 'start', partnerEnabled });
        return;
      }
      setView({ kind: 'ready', payload: home.payload, wisp: home.wisp, current: home.payload.current, links: home.payload.links, stale: false });
    } catch (err) {
      console.error('[WispHomeContent] loading the Wisp home failed', err);
      if (token !== loadToken.current) return;
      if (silent && viewRef.current.kind === 'ready') {
        failedPolls.current += 1;
        if (failedPolls.current >= STALE_AFTER_FAILED_POLLS) setView((v) => (v.kind === 'ready' ? { ...v, stale: true } : v));
        return;
      }
      setView({ kind: 'error' });
    }
  }, []);

  // The entitlement hook is the page-level gate (cached module-wide); the home read waits for it.
  const entitled = entitlement.state === 'enabled';
  useEffect(() => {
    if (entitled) void load(false);
    return () => { loadToken.current++; };
  }, [entitled, load]);

  useEffect(() => {
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const tick = () => { if (visible() && viewRef.current.kind === 'ready') void load(true); };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [load]);

  // A check starting or finishing is when new activity appears: refresh the timeline then.
  // So is a grant status change (#10104): Resume, or a poll that finds the
  // grant paused / resumed, re-runs the rail's concerns and activity reads.
  const liveKey = view.kind === 'ready' ? `${view.wisp.status}|${view.current?.startedAt ?? 'idle'}` : null;
  const lastLiveKey = useRef<string | null>(null);
  useEffect(() => {
    if (liveKey === null) return;
    if (lastLiveKey.current !== null && lastLiveKey.current !== liveKey) setActivityKey((k) => k + 1);
    lastLiveKey.current = liveKey;
  }, [liveKey]);

  // W02b: Wisp's posts reach the thread through its timeline. A check starting
  // or finishing, a newer brief, or a change in the concerns is when a new post
  // can exist: re-read the thread's newest page then, not on every poll.
  const postsSignal = view.kind === 'ready'
    ? `${liveKey}|${view.payload.brief?.sentAt ?? ''}|${view.payload.needsYou.map((c) => c.id).sort().join(',')}`
    : null;
  const lastPostsSignal = useRef<string | null>(null);
  useEffect(() => {
    if (postsSignal === null) return;
    if (lastPostsSignal.current !== null && lastPostsSignal.current !== postsSignal) setThreadKey((k) => k + 1);
    lastPostsSignal.current = postsSignal;
  }, [postsSignal]);

  // `#needs-you`, `#links`, `#concern=<id>` …: bring the section into view once it exists.
  // Below `lg` the rail sections sit in the closed drawer, so a rail hash has nothing to scroll to there.
  const ready = view.kind === 'ready';
  useEffect(() => {
    if (!ready) return;
    const scroll = () => {
      const section = homeSectionFromHash(window.location.hash);
      // Briefs are posts in the thread now, not a section of their own.
      const id = section === 'brief' ? 'thread' : section;
      if (id) document.getElementById(id)?.scrollIntoView?.({ block: 'start' });
    };
    scroll();
    window.addEventListener('hashchange', scroll);
    return () => window.removeEventListener('hashchange', scroll);
  }, [ready]);

  if (entitlement.state === 'locked' || view.kind === 'locked') {
    return (
      <HomeFrame>
        <FeatureLock locked why={t('wisp.locked.why')} upgradeHref="/settings/plan" testId="wisp-home-locked">
          <StartCard onStart={() => {}} />
        </FeatureLock>
      </HomeFrame>
    );
  }

  if (entitlement.state === 'loading' && entitlement.failed) {
    return (
      <HomeFrame>
        <LoadFailed onRetry={entitlement.reload} />
      </HomeFrame>
    );
  }

  if (entitlement.state === 'loading' || view.kind === 'loading') {
    return <HomeFrame><div className="p-6" data-testid="wisp-home-loading-body" aria-busy="true" /></HomeFrame>;
  }

  if (view.kind === 'forbidden') {
    return (
      <HomeFrame links={false}>
        <p className="p-6 text-sm text-muted-foreground" data-testid="wisp-home-forbidden" role="status">{t('wisp.home.noAccess')}</p>
      </HomeFrame>
    );
  }

  if (view.kind === 'error') {
    return <HomeFrame><LoadFailed onRetry={() => void load(false)} /></HomeFrame>;
  }

  if (view.kind === 'start') {
    return (
      <HomeFrame>
        {view.partnerEnabled ? <StartCard onStart={() => setStartOpen(true)} /> : <DisabledCard />}
        <WispGrantStepUpModal
          open={startOpen}
          defaultOrgId={currentOrgId ?? null}
          onClose={() => setStartOpen(false)}
          onGranted={async () => {
            setStartOpen(false);
            await load(false);
          }}
        />
      </HomeFrame>
    );
  }

  const { payload, wisp, current, links, stale } = view;
  const ownsStore = storeWisp?.threadId === wisp.threadId;
  const orgName = wisp.scopeOrgId ? ((organizations ?? []).find((o) => o.id === wisp.scopeOrgId)?.name ?? null) : null;

  const onWispChange = (patch: Partial<Wisp>) => {
    // The server just answered this change: a poll already in flight carries the state from before it.
    loadToken.current++;
    setView((v) => (v.kind === 'ready' ? { ...v, wisp: { ...v.wisp, ...patch } } : v));
    if (ownsStore) updateStoreWisp(patch);
  };

  const onRevoked = async () => {
    if (ownsStore) await exitWispMode();
    await load(false);
  };

  const onLinksChange = (next: SetStateAction<WispThreadLink[]>) => {
    // Same as onWispChange: a poll already in flight read the links before this change.
    loadToken.current++;
    setView((v) => (v.kind === 'ready' ? { ...v, links: typeof next === 'function' ? next(v.links) : next } : v));
  };

  const scopeLabel = wisp.scopeOrgId === null ? t('wisp.header.scopeAll') : (orgName ?? '');
  const liveNeedsYouCount = payload.needsYou.filter((c) => LIVE_STATUSES.includes(c.status)).length;

  return (
    <WispCompanionShell
      testId="wisp-home"
      wisp={wisp}
      current={current}
      needsYouCount={liveNeedsYouCount}
      banners={
        <>
          {stale && (
            <div className="flex flex-wrap items-center gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300" data-testid="wisp-home-stale" role="status">
              <span>{t('wisp.thread.stale')}</span>
              <button type="button" onClick={() => void load(true)} className="font-medium underline underline-offset-2">{t('wisp.thread.retry')}</button>
            </div>
          )}
          {!payload.partner.enabled && <DisabledCard />}
        </>
      }
      column={
        <WispHomeThread
          wisp={wisp}
          lastSessionId={payload.thread.lastSessionId}
          scopeLabel={scopeLabel}
          links={links}
          onLinksChange={onLinksChange}
          refreshKey={threadKey}
        />
      }
      rail={
        <WispRail
          wisp={wisp}
          orgName={orgName}
          current={current}
          needsYou={payload.needsYou}
          links={links}
          onLinksChange={onLinksChange}
          onWispChange={onWispChange}
          onRevoked={onRevoked}
          activityKey={activityKey}
        />
      }
    />
  );
}

/** `links` false: the caller may not use the chats or Wisp memory either (a Partner Viewer, #10200), so no links into them. */
function HomeFrame({ children, links = true }: { children: React.ReactNode; links?: boolean }) {
  const { t } = useTranslation(['pages', 'ai']);
  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4" data-testid="wisp-home">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Sparkles className="h-5 w-5 text-primary" aria-hidden="true" />
          {t('pages:titles.wisp')}
        </h1>
        {links && (
          <nav className="flex items-center gap-1 text-sm" aria-label={t('pages:titles.wisp')}>
            <a href={CHATS_HREF} data-testid="wisp-home-chats" className="flex items-center gap-1.5 rounded px-2 py-1 hover:bg-muted">
              <MessagesSquare className="h-4 w-4" aria-hidden="true" />
              {t('ai:wisp.home.openChats')}
            </a>
            <a href={MEMORY_HREF} data-testid="wisp-home-memory" className="flex items-center gap-1.5 rounded px-2 py-1 hover:bg-muted">
              <Brain className="h-4 w-4" aria-hidden="true" />
              {t('ai:wisp.home.memory')}
            </a>
          </nav>
        )}
      </div>
      {children}
    </div>
  );
}

function StartCard({ onStart }: { onStart: () => void }) {
  const { t } = useTranslation('ai');
  return (
    <section className="mx-auto max-w-xl space-y-3 rounded-lg border bg-card p-6 text-center" data-testid="wisp-home-start">
      <Sparkles className="mx-auto h-8 w-8 text-primary" aria-hidden="true" />
      <h2 className="text-base font-semibold">{t('wisp.home.startTitle')}</h2>
      <p className="text-sm text-muted-foreground">{t('wisp.home.startBody')}</p>
      <button type="button" data-testid="wisp-home-start-button" onClick={onStart} className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
        {t('wisp.home.startAction')}
      </button>
    </section>
  );
}

function DisabledCard() {
  const { t } = useTranslation('ai');
  return (
    <section className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm" data-testid="wisp-home-disabled" role="status">
      <h2 className="font-semibold">{t('wisp.home.disabledTitle')}</h2>
      <p className="text-muted-foreground">{t('wisp.home.disabledBody')}</p>
      <a href={SETTINGS_HREF} className="text-xs font-medium underline underline-offset-2">{t('wisp.home.disabledSettings')}</a>
    </section>
  );
}

function LoadFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation('ai');
  return (
    <div className="space-y-2 p-6 text-sm" data-testid="wisp-home-load-error">
      <p className="text-destructive">{t('wisp.home.loadFailed')}</p>
      <button type="button" data-testid="wisp-home-retry" onClick={onRetry} className="rounded border px-3 py-1 hover:bg-muted">
        {t('wisp.thread.retry')}
      </button>
    </div>
  );
}
