import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { CONCERN_FEEDBACK_NOTE_MAX, CONCERN_SEVERITIES } from '@breeze/shared';
import type { Concern, ConcernSeverity, ConcernStatus } from '@breeze/shared';
import {
  dismissWispConcern,
  feedbackWispConcern,
  listWispConcerns,
  resolveWispConcern,
  snoozeWispConcern,
} from '../../lib/wispConcernsApi';
import { ActionError } from '@/lib/runAction';
import { showToast } from '@/components/shared/Toast';
import { formatRelativeTime } from '@/lib/utils';
import { concernIdFromHash } from '../wisp/wispThreadHash';
import { needsYouOrder } from '../wisp/wispHome';

const LIVE: ConcernStatus[] = ['open', 'snoozed'];
const ALL: ConcernStatus[] = ['open', 'snoozed', 'resolved', 'dismissed'];
const OUTCOME_MAX = 1000;

// High first.
const SEVERITY_ORDER: ConcernSeverity[] = [...CONCERN_SEVERITIES].reverse();

const SEVERITY_DOT: Record<ConcernSeverity, string> = {
  high: 'bg-destructive',
  medium: 'bg-amber-500',
  low: 'bg-sky-500',
  info: 'bg-muted-foreground',
};

function readHashId(): string | null {
  return concernIdFromHash(typeof window === 'undefined' ? '' : window.location.hash);
}

function tomorrowNineLocal(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

export function WispConcernsPanel({
  grantId,
  threadId,
  crossOrg = false,
  title,
  onLoaded,
}: {
  grantId: string;
  threadId: string;
  /** List the whole grant, ignoring the org switcher (the thread page); the sidebar keeps the ambient narrowing. */
  crossOrg?: boolean;
  /** Replaces the panel's own title (the Wisp home heads the section itself). */
  title?: string;
  /** Every committed load, so a host can keep its own counts in step (W08 home "needs you"). */
  onLoaded?: (concerns: Concern[]) => void;
}) {
  const { t } = useTranslation('ai');
  const [concerns, setConcerns] = useState<Concern[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snoozeMenuId, setSnoozeMenuId] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState('');
  const [feedbackNoteId, setFeedbackNoteId] = useState<string | null>(null);
  const [feedbackNote, setFeedbackNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Only the newest load may commit (grant switch, filter flip, unmount).
  const loadToken = useRef(0);
  // A ref so an inline callback from the host never re-triggers the load.
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;
  const load = useCallback(async () => {
    const token = ++loadToken.current;
    try {
      const statuses = showAll ? ALL : LIVE;
      const next = crossOrg ? await listWispConcerns(grantId, statuses, { crossOrg: true }) : await listWispConcerns(grantId, statuses);
      if (token !== loadToken.current) return;
      setConcerns(next);
      setLoadFailed(false);
      onLoadedRef.current?.(next);
    } catch (err) {
      console.error('[WispConcernsPanel] loading concerns failed', err);
      if (token === loadToken.current) setLoadFailed(true);
    } finally {
      if (token === loadToken.current) setLoaded(true);
    }
  }, [grantId, showAll, crossOrg]);

  useEffect(() => {
    void load();
    return () => { loadToken.current++; };
  }, [load, threadId]);

  useEffect(() => {
    // Adopt the deep link after mount (SSR-safe: the fragment never reaches the server; #2421).
    const onHash = () => setSelectedId(readHashId());
    onHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // A nudge link can outlive its concern's live status (resolved or dismissed
  // meanwhile): widen to every status once so the row shows its outcome,
  // rather than the link selecting nothing (W06 review focus 3).
  const widenedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded || loadFailed || showAll || !selectedId || widenedFor.current === selectedId) return;
    if (concerns.some((c) => c.id === selectedId)) return;
    widenedFor.current = selectedId;
    setShowAll(true);
  }, [loaded, loadFailed, showAll, selectedId, concerns]);

  // The hash is read-only here: `#concern=<id>` deep-links IN (w00), but this
  // panel lives in the global sidebar, so writing the hash would clobber the
  // host page's own hash state (DeviceDetails tabs, list selections).
  const select = (id: string) => {
    setSelectedId((current) => (current === id ? null : id));
  };

  const run = async (action: () => Promise<void>, onDone?: () => void) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      onDone?.();
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('wispConcerns.actionFailed') }); // ActionError already toasted
    } finally {
      setBusy(false);
    }
  };

  const snooze = (id: string, until: Date) =>
    run(() => snoozeWispConcern(id, grantId, until), () => setSnoozeMenuId(null));

  // W06 Task 16 (w00 A34): the server's recipient lands on the row at once;
  // the refetch that follows confirms it.
  const giveFeedback = (id: string, useful: boolean, note?: string) =>
    run(async () => {
      try {
        const recipient = note === undefined
          ? await feedbackWispConcern(id, grantId, useful)
          : await feedbackWispConcern(id, grantId, useful, note);
        if (recipient) setConcerns((list) => list.map((c) => (c.id === id ? { ...c, recipient } : c)));
      } catch (err) {
        // 409 = already answered (another tab, the phone): runAction toasted the
        // server's message; finish normally so the editor closes and the refetch
        // shows the recorded choice instead of buttons that can only 409 again.
        if (err instanceof ActionError && err.status === 409) return;
        throw err;
      }
    }, () => { setFeedbackNoteId(null); setFeedbackNote(''); });

  const renderFeedback = (c: Concern) => {
    const r = c.recipient;
    if (!r) return null;
    // A recorded answer outlives the nudge counter: recordFeedback resets
    // nudgeCount to 0, so check feedback before the "was it nudged" gate.
    if (r.feedback) {
      return (
        <p className="mt-1 pl-3.5 text-[11px] text-muted-foreground" data-testid={`wisp-concern-feedback-given-${c.id}`}>
          {r.feedback === 'useful' ? t('wispConcerns.feedbackGivenUseful') : t('wispConcerns.feedbackGivenNotUseful')}
        </p>
      );
    }
    if (r.nudgeCount <= 0) return null;
    const noting = feedbackNoteId === c.id;
    return (
      <div className="mt-1.5 space-y-1 pl-3.5">
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid={`wisp-concern-useful-${c.id}`}
            disabled={busy}
            onClick={() => void giveFeedback(c.id, true)}
            className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] hover:bg-muted disabled:opacity-50"
          >
            <ThumbsUp className="h-3 w-3" aria-hidden="true" />
            {t('wispConcerns.useful')}
          </button>
          <button
            type="button"
            data-testid={`wisp-concern-not-useful-${c.id}`}
            aria-expanded={noting}
            disabled={busy}
            onClick={() => { setFeedbackNote(''); setFeedbackNoteId(noting ? null : c.id); }}
            className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] hover:bg-muted disabled:opacity-50"
          >
            <ThumbsDown className="h-3 w-3" aria-hidden="true" />
            {t('wispConcerns.notUseful')}
          </button>
        </div>
        {noting && (
          <div className="flex items-center gap-1">
            <input
              type="text"
              data-testid={`wisp-concern-feedback-note-${c.id}`}
              value={feedbackNote}
              maxLength={CONCERN_FEEDBACK_NOTE_MAX}
              placeholder={t('wispConcerns.feedbackNotePlaceholder')}
              aria-label={t('wispConcerns.feedbackNotePlaceholder')}
              onChange={(e) => setFeedbackNote(e.target.value)}
              className="min-w-0 flex-1 rounded border bg-background px-2 py-0.5 text-xs"
            />
            <button
              type="button"
              data-testid={`wisp-concern-feedback-send-${c.id}`}
              disabled={busy}
              onClick={() => void giveFeedback(c.id, false, feedbackNote)}
              className="rounded bg-primary px-2 py-0.5 text-[11px] text-primary-foreground disabled:opacity-50"
            >
              {t('wispConcerns.feedbackSend')}
            </button>
          </div>
        )}
      </div>
    );
  };

  const grouped = useMemo(
    () => SEVERITY_ORDER
      // Within a severity, approvals first: they block work (W08 needsYouOrder).
      .map((severity) => ({ severity, items: needsYouOrder(concerns.filter((c) => c.severity === severity)) }))
      .filter((g) => g.items.length > 0),
    [concerns],
  );

  const renderRow = (c: Concern) => {
    const expanded = selectedId === c.id;
    const live = c.status === 'open' || c.status === 'snoozed';
    const snoozedUntil = c.recipient?.snoozedUntil ? new Date(c.recipient.snoozedUntil) : null;
    const quiet = snoozedUntil && snoozedUntil.getTime() > Date.now() ? snoozedUntil : null;
    const created = new Date(c.createdAt);
    return (
      <li
        key={c.id}
        data-testid="wisp-concern-row"
        data-concern-id={c.id}
        className={`rounded border px-2 py-1.5 ${expanded ? 'border-primary bg-primary/5' : ''}`}
      >
        <button
          type="button"
          data-testid={`wisp-concern-select-${c.id}`}
          aria-expanded={expanded}
          onClick={() => select(c.id)}
          className="flex w-full items-start gap-1.5 text-left"
        >
          <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[c.severity]}`} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="mr-1.5 rounded bg-muted px-1 py-0.5 text-[10px] font-medium uppercase text-muted-foreground" data-testid="wisp-concern-subject">
              {t(/* i18n-dynamic */ `wispConcerns.subject.${c.subject.kind}`)}
            </span>
            <span className={expanded ? 'whitespace-pre-wrap break-words' : 'line-clamp-2 break-words'}>{c.summary}</span>
          </span>
        </button>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 pl-3.5 text-[11px] text-muted-foreground">
          <span>{formatRelativeTime(created)}</span>
          {!live && <span data-testid="wisp-concern-status">{t(/* i18n-dynamic */ `wispConcerns.${c.status}`)}</span>}
          {quiet && (
            <span data-testid="wisp-concern-quiet">{t('wispConcerns.quietUntil', { when: quiet.toLocaleString() })}</span>
          )}
          {c.recipient?.digestOnly && <span data-testid="wisp-concern-digest">{t('wispConcerns.digestOnly')}</span>}
        </div>
        {expanded && c.outcome && (
          <p className="mt-1 pl-3.5 text-[11px]" data-testid={`wisp-concern-outcome-text-${c.id}`}>{c.outcome}</p>
        )}
        {c.approvalIntentId && (
          <a
            href={`/approvals#intent-${encodeURIComponent(c.approvalIntentId)}`}
            data-testid={`wisp-concern-approval-${c.id}`}
            className="mt-1 ml-3.5 inline-block text-[11px] font-medium text-primary underline-offset-2 hover:underline"
          >
            {t('wispConcerns.reviewApproval')}
          </a>
        )}
        {renderFeedback(c)}
        {live && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-3.5">
            <div className="relative">
              <button
                type="button"
                data-testid={`wisp-concern-snooze-${c.id}`}
                aria-expanded={snoozeMenuId === c.id}
                disabled={busy}
                onClick={() => setSnoozeMenuId(snoozeMenuId === c.id ? null : c.id)}
                className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-muted disabled:opacity-50"
              >
                {t('wispConcerns.snooze')}
              </button>
              {snoozeMenuId === c.id && (
                <div className="absolute left-0 z-10 mt-1 flex w-40 flex-col rounded border bg-popover p-1 shadow-md" data-testid={`wisp-concern-snooze-menu-${c.id}`}>
                  <button type="button" data-testid={`wisp-concern-snooze-1h-${c.id}`} className="rounded px-2 py-1 text-left text-[11px] hover:bg-muted"
                    onClick={() => void snooze(c.id, new Date(Date.now() + 3600_000))}>
                    {t('wispConcerns.snoozeOneHour')}
                  </button>
                  <button type="button" data-testid={`wisp-concern-snooze-tomorrow-${c.id}`} className="rounded px-2 py-1 text-left text-[11px] hover:bg-muted"
                    onClick={() => void snooze(c.id, tomorrowNineLocal())}>
                    {t('wispConcerns.snoozeTomorrow')}
                  </button>
                  <button type="button" data-testid={`wisp-concern-snooze-week-${c.id}`} className="rounded px-2 py-1 text-left text-[11px] hover:bg-muted"
                    onClick={() => void snooze(c.id, new Date(Date.now() + 7 * 86_400_000))}>
                    {t('wispConcerns.snoozeWeek')}
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              data-testid={`wisp-concern-dismiss-${c.id}`}
              disabled={busy}
              onClick={() => void run(() => dismissWispConcern(c.id, grantId))}
              className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-muted disabled:opacity-50"
            >
              {t('wispConcerns.dismiss')}
            </button>
            <button
              type="button"
              data-testid={`wisp-concern-resolve-${c.id}`}
              aria-expanded={resolvingId === c.id}
              disabled={busy}
              onClick={() => { setOutcome(''); setResolvingId(resolvingId === c.id ? null : c.id); }}
              className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-muted disabled:opacity-50"
            >
              {t('wispConcerns.resolve')}
            </button>
          </div>
        )}
        {live && resolvingId === c.id && (
          <div className="mt-1.5 space-y-1 pl-3.5">
            <textarea
              data-testid={`wisp-concern-outcome-${c.id}`}
              value={outcome}
              maxLength={OUTCOME_MAX}
              rows={2}
              placeholder={t('wispConcerns.resolveOutcomePlaceholder')}
              onChange={(e) => setOutcome(e.target.value)}
              className="w-full rounded border bg-background px-2 py-1 text-xs"
            />
            <button
              type="button"
              data-testid={`wisp-concern-resolve-submit-${c.id}`}
              disabled={busy || !outcome.trim()}
              onClick={() => void run(() => resolveWispConcern(c.id, grantId, outcome.trim()), () => { setResolvingId(null); setOutcome(''); })}
              className="rounded bg-primary px-2 py-0.5 text-[11px] text-primary-foreground disabled:opacity-50"
            >
              {t('wispConcerns.resolveSubmit')}
            </button>
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="space-y-2 border-b px-4 py-2 text-xs" data-testid="wisp-concerns">
      <div className="flex items-center justify-between">
        <span className="font-medium">{title ?? t('wispConcerns.title')}</span>
        <button
          type="button"
          data-testid="wisp-concerns-filter"
          aria-pressed={showAll}
          onClick={() => setShowAll((v) => !v)}
          className="text-[11px] text-muted-foreground hover:text-foreground"
        >
          {showAll ? t('wispConcerns.showLive') : t('wispConcerns.showAll')}
        </button>
      </div>
      {loadFailed ? (
        <p className="text-destructive" data-testid="wisp-concerns-load-error">{t('wispConcerns.loadFailed')}</p>
      ) : loaded && concerns.length === 0 ? (
        <p className="text-muted-foreground" data-testid="wisp-concerns-empty">{t('wispConcerns.empty')}</p>
      ) : (
        grouped.map((g) => (
          <section key={g.severity} className="space-y-1" data-testid={`wisp-concerns-group-${g.severity}`}>
            <h4 className="text-[10px] font-semibold uppercase text-muted-foreground">
              {t(/* i18n-dynamic */ `wispConcerns.severity.${g.severity}`)}
            </h4>
            <ul className="space-y-1">{g.items.map(renderRow)}</ul>
          </section>
        ))
      )}
    </div>
  );
}

export default WispConcernsPanel;
