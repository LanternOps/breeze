import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Copy, Headphones, Link2, Plus, RefreshCw, X } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';
import { useOrgStore } from '@/stores/orgStore';
import { runAction, ActionError } from '@/lib/runAction';
import { showToast } from '@/components/shared/Toast';
import { formatDateTime, formatTime } from '@/lib/dateTimeFormat';
import { useHashState } from '@/lib/useHashState';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import ConnectDesktopButton from './ConnectDesktopButton';
import { useStableT } from '@/lib/i18n/useStableT';
import { replaceUrl } from '../../lib/replaceUrl';

/**
 * The copied link is pasted into email/chat, so it must be absolute. An API
 * without a configured public base returns a bare `/quick?code=…` path (#10508);
 * resolve it against this page's origin, which serves `/quick`.
 */
function toAbsoluteUrl(url: string): string {
  try {
    return new URL(url, window.location.origin).toString();
  } catch {
    return url;
  }
}

export type SupportSessionStatus =
  | 'pending'
  | 'claimed'
  | 'ready'
  | 'active'
  | 'ended'
  | 'expired';

export interface SupportSessionView {
  id: string;
  status: SupportSessionStatus;
  createdAt: string;
  codeExpiresAt: string;
  hardExpiresAt: string;
  deviceId: string | null;
  deviceOnline: boolean;
  attributedOrgId: string | null;
  attributionLabel: string | null;
  endedAt: string | null;
  endedReason: string | null;
  createdByUserId: string | null;
  /**
   * Present only while the session is pending and its code is inside its
   * TTL, and only for a caller allowed to create Quick Support sessions
   * (#11836). Absent otherwise — never null-with-a-meaning.
   */
  code?: string;
  landingUrl?: string;
  /** The caller may replace this session's code ("New code"). */
  canIssueNewCode?: boolean;
}

/** The create and "New code" responses. */
interface CreatedSupportSession {
  id: string;
  code: string;
  codeExpiresAt: string;
  hardExpiresAt: string;
  landingUrl: string;
}

/** mm:ss for the code countdown; never negative. */
function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

const TERMINAL_STATUSES: ReadonlySet<SupportSessionStatus> = new Set<SupportSessionStatus>([
  'ended',
  'expired',
]);

const POLL_INTERVAL_MS = 3000;

/**
 * Technician-facing Quick Support console. A tech mints a one-time code, reads
 * it to the end user, and connects with the normal remote desktop viewer once
 * the ephemeral client has enrolled.
 *
 * The selected session lives in `window.location.hash` (repo convention for
 * transient selection state), so a tech who navigates away and comes back —
 * or reloads — lands back on the same session. Selection drives ONE detail
 * panel: the one-time code block is layered on top while the selected session
 * is pending and its code is live; the status/connect/end block below it is
 * shared by every state.
 *
 * Where the code comes from (#11836): the list and detail responses carry
 * `code` + `landingUrl` for as long as the session is pending and the code is
 * inside its TTL, so a reload no longer loses it. The create / "New code"
 * response is held in `created` only to show the code before the first poll
 * lands. Once the countdown reaches zero the code is hidden and "New code"
 * is offered (when the server says `canIssueNewCode`).
 *
 * Polling uses a recursive `setTimeout` held in a ref (same shape as
 * ConnectDesktopButton) rather than setInterval: it self-terminates on a
 * terminal status and never overlaps requests, so a session that ends while
 * the page stays open cannot leave a timer polling forever.
 */
export default function QuickSupportPage() {
  const { t } = useTranslation('remote');
  // Effects use the stable translator so a locale change does not re-run them
  // (#3632); JSX keeps the plain `t` so rendered text still re-translates.
  const stableT = useStableT(t);
  const { organizations } = useOrgStore();

  const [sessions, setSessions] = useState<SupportSessionView[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [attributedOrgId, setAttributedOrgId] = useState('');
  const [attributionLabel, setAttributionLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [ending, setEnding] = useState(false);
  const [reissuing, setReissuing] = useState(false);
  // Bumped by "New code": a reaper-expired session is pending again, and its
  // poller had stopped on the terminal status, so it must start over.
  const [pollNonce, setPollNonce] = useState(0);
  const [created, setCreated] = useState<CreatedSupportSession | null>(null);
  // Wall clock for the code countdown; only ticks while a code is on screen.
  const [now, setNow] = useState(() => Date.now());
  // Freshest server view of the selected session, refreshed by the poller.
  const [selectedDetail, setSelectedDetail] = useState<SupportSessionView | null>(null);
  // Selected session id, adopted from the hash post-mount (#2421 — never in a
  // useState initializer) and kept in sync with back/forward navigation.
  const [selectedId, setSelectedId] = useHashState<string | null>(null, (hash) => hash || undefined);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/remote/support-sessions?limit=50');
      if (!response.ok) throw new Error('list_failed');
      const data = await response.json();
      setSessions(Array.isArray(data?.sessions) ? data.sessions : []);
      setListError(null);
    } catch {
      setListError(stableT('quickSupport.errors.list'));
    }
  }, [stableT]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // Drop a detail payload belonging to a previously selected session so the
  // panel never shows one session's status under another's heading.
  useEffect(() => {
    setSelectedDetail((current) => (current && current.id === selectedId ? current : null));
  }, [selectedId]);

  const closeDetail = useCallback(() => {
    setSelectedDetail(null);
    setSelectedId(null);
    // Strip the fragment without leaving a bare "#" (and without a hashchange
    // round-trip — the state is already cleared above).
    replaceUrl(`${window.location.pathname}${window.location.search}`);
  }, [setSelectedId]);

  // Poll the selected session until it reaches a terminal state. The first pass
  // doubles as the loader for a hash-restored selection.
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;

    const stopTimer = () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };

    const poll = async () => {
      let terminal = false;
      try {
        const response = await fetchWithAuth(`/remote/support-sessions/${selectedId}`);
        if (response.ok) {
          const data = (await response.json()) as SupportSessionView;
          if (cancelled) return;
          if (data && typeof data.status === 'string') {
            setSelectedDetail(data);
            terminal = TERMINAL_STATUSES.has(data.status);
          }
        } else if (response.status === 404 || response.status === 403) {
          // The hash now seeds selection on mount, so it can point at a session
          // that was deleted, hard-expired, or belongs to another org. Those
          // are definitively terminal — not transient — so give up polling,
          // clear the dead selection (closing the panel and stripping the
          // hash), and tell the tech why the panel vanished. Anything else
          // (5xx, and the network `catch` below) stays on the retry path.
          if (cancelled) return;
          stopTimer();
          closeDetail();
          showToast({ message: stableT('quickSupport.errors.notFound'), type: 'warning' });
          return;
        }
      } catch {
        /* transient network error — keep polling */
      }
      if (cancelled) return;
      if (terminal) {
        // Terminal: stop polling entirely and refresh the history list once.
        stopTimer();
        loadSessions();
        return;
      }
      pollTimerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
    };

    poll();

    return () => {
      cancelled = true;
      stopTimer();
    };
  }, [selectedId, loadSessions, closeDetail, stableT, pollNonce]);

  const openSession = useCallback(
    (session: SupportSessionView) => {
      // Seed from the list row so the panel is populated before the first poll.
      setSelectedDetail(session);
      setSelectedId(session.id);
      window.location.hash = session.id;
    },
    [setSelectedId],
  );

  const copy = useCallback(
    async (value: string, successMessage: string) => {
      try {
        await navigator.clipboard.writeText(value);
        showToast({ message: successMessage, type: 'success' });
      } catch {
        showToast({ message: t('quickSupport.code.copyFailed'), type: 'error' });
      }
    },
    [t],
  );

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      const trimmedLabel = attributionLabel.trim();
      const body: { attributedOrgId?: string; attributionLabel?: string } = {};
      if (attributedOrgId) body.attributedOrgId = attributedOrgId;
      if (trimmedLabel) body.attributionLabel = trimmedLabel;

      const session = await runAction<CreatedSupportSession>({
        request: () =>
          fetchWithAuth('/remote/support-sessions', {
            method: 'POST',
            body: JSON.stringify(body),
          }),
        errorFallback: t('quickSupport.errors.create'),
        parseSuccess: (data) => {
          const parsed = data as CreatedSupportSession | null;
          if (!parsed?.id || !parsed?.code) throw new Error('malformed_create_response');
          return parsed;
        },
      });

      setCreated(session);
      setSelectedDetail(null);
      setSelectedId(session.id);
      window.location.hash = session.id;
      setDialogOpen(false);
      setAttributionLabel('');
      loadSessions();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ message: t('quickSupport.errors.create'), type: 'error' });
      }
    } finally {
      setCreating(false);
    }
  }, [attributedOrgId, attributionLabel, loadSessions, setSelectedId, t]);

  const handleEnd = useCallback(
    async (sessionId: string) => {
      setEnding(true);
      try {
        await runAction({
          request: () =>
            fetchWithAuth(`/remote/support-sessions/${sessionId}/end`, { method: 'POST' }),
          errorFallback: t('quickSupport.end.error'),
          successMessage: t('quickSupport.end.success'),
        });
        setSelectedDetail((current) =>
          current && current.id === sessionId
            ? { ...current, status: 'ended' as const }
            : current,
        );
        loadSessions();
      } catch (err) {
        if (err instanceof ActionError && err.status === 401) return;
        if (err instanceof ActionError && err.status === 409) {
          // Already ended server-side — reconcile the view instead of leaving a
          // stale "in progress" panel with a dead End button.
          showToast({ message: t('quickSupport.end.alreadyEnded'), type: 'warning' });
          loadSessions();
          return;
        }
        if (!(err instanceof ActionError)) {
          showToast({ message: t('quickSupport.end.error'), type: 'error' });
        }
      } finally {
        setEnding(false);
      }
    },
    [loadSessions, t],
  );

  const handleNewCode = useCallback(
    async (sessionId: string) => {
      setReissuing(true);
      try {
        const fresh = await runAction<CreatedSupportSession>({
          request: () =>
            fetchWithAuth(`/remote/support-sessions/${sessionId}/code`, { method: 'POST' }),
          errorFallback: t('quickSupport.code.newCodeError'),
          successMessage: t('quickSupport.code.newCodeSuccess'),
          parseSuccess: (data) => {
            const parsed = data as CreatedSupportSession | null;
            if (!parsed?.id || !parsed?.code) throw new Error('malformed_new_code_response');
            return parsed;
          },
        });
        setCreated(fresh);
        setNow(Date.now());
        setPollNonce((n) => n + 1);
        // A reaper-expired session is pending again; reflect it before the
        // next poll so the panel does not flash the old state.
        setSelectedDetail((current) =>
          current && current.id === sessionId
            ? {
                ...current,
                status: 'pending' as const,
                code: fresh.code,
                landingUrl: fresh.landingUrl,
                codeExpiresAt: fresh.codeExpiresAt,
                endedAt: null,
                endedReason: null,
                canIssueNewCode: true,
              }
            : current,
        );
        loadSessions();
      } catch (err) {
        if (err instanceof ActionError && err.status === 401) return;
        if (err instanceof ActionError && err.status === 409) {
          // Claimed or ended in the meantime: refresh so the panel shows why.
          loadSessions();
          return;
        }
        if (!(err instanceof ActionError)) {
          showToast({ message: t('quickSupport.code.newCodeError'), type: 'error' });
        }
      } finally {
        setReissuing(false);
      }
    },
    [loadSessions, t],
  );

  const statusLabel = (status: SupportSessionStatus): string => {
    switch (status) {
      case 'pending':
        return t('quickSupport.status.pending');
      case 'claimed':
        return t('quickSupport.status.claimed');
      case 'ready':
        return t('quickSupport.status.ready');
      case 'active':
        return t('quickSupport.status.active');
      case 'ended':
        return t('quickSupport.status.ended');
      case 'expired':
        return t('quickSupport.status.expired');
      default:
        return status;
    }
  };

  const statusClass = (status: SupportSessionStatus): string => {
    if (status === 'ready' || status === 'active') return 'text-green-600 dark:text-green-500';
    if (status === 'ended' || status === 'expired') return 'text-muted-foreground';
    return 'text-amber-600 dark:text-amber-500';
  };

  // Poll payload wins; the list row is the stand-in while a hash-restored
  // selection waits for its first detail response.
  const selectedSession: SupportSessionView | null =
    selectedDetail && selectedDetail.id === selectedId
      ? selectedDetail
      : (sessions.find((session) => session.id === selectedId) ?? null);

  // The code on screen: the server's copy (survives reloads) or the one just
  // minted in this page load, whichever expires later — so a poll that left
  // before a "New code" landed cannot put the replaced code back up.
  const createdForSelected = created && created.id === selectedId ? created : null;
  const serverCode =
    selectedSession?.code && selectedSession.landingUrl
      ? {
          code: selectedSession.code,
          landingUrl: selectedSession.landingUrl,
          codeExpiresAt: selectedSession.codeExpiresAt,
        }
      : null;
  const createdStillPending =
    createdForSelected && (selectedSession?.status ?? 'pending') === 'pending' ? createdForSelected : null;
  const codeSource =
    serverCode && createdStillPending
      ? Date.parse(createdStillPending.codeExpiresAt) > Date.parse(serverCode.codeExpiresAt)
        ? createdStillPending
        : serverCode
      : (serverCode ?? createdStillPending);
  const codeMsLeft = codeSource ? Date.parse(codeSource.codeExpiresAt) - now : 0;
  const shownCode = codeSource && codeMsLeft > 0 ? codeSource : null;

  const currentStatus: SupportSessionStatus = selectedSession?.status ?? 'pending';
  const isTerminal = TERMINAL_STATUSES.has(currentStatus);
  const canIssueNewCode = selectedSession?.canIssueNewCode ?? Boolean(createdForSelected);
  // The session is waiting on a code that has run out (whether or not the
  // server has expired the session yet), as opposed to one that never had a
  // readable code here (created before codes were kept, or not ours to read).
  const codeLapsed =
    !shownCode
    && (currentStatus === 'pending' || canIssueNewCode)
    && (codeSource !== null
      || (selectedSession ? Date.parse(selectedSession.codeExpiresAt) <= now : false));

  // Tick the countdown (and the lapse check) only while it can change.
  const clockRunning =
    (Boolean(selectedId) && (currentStatus === 'pending' || canIssueNewCode))
    || sessions.some((session) => Boolean(session.code));
  useEffect(() => {
    if (!clockRunning) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [clockRunning]);
  const canConnect = Boolean(
    selectedSession?.deviceId && selectedSession.deviceOnline && !isTerminal,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('quickSupport.title')}</h1>
          <p className="text-muted-foreground">{t('quickSupport.subtitle')}</p>
        </div>
        <button
          type="button"
          data-testid="quick-support-new"
          onClick={() => setDialogOpen(true)}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          {t('quickSupport.newSession')}
        </button>
      </div>

      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
            <div className="flex items-start justify-between gap-4">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <Headphones className="h-5 w-5" />
                {t('quickSupport.form.title')}
              </h2>
              <button
                type="button"
                onClick={() => setDialogOpen(false)}
                aria-label={t('common:actions.close')}
                className="text-muted-foreground transition hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-4">
              <div>
                <label
                  htmlFor="quick-support-org"
                  className="block text-sm font-medium"
                >
                  {t('quickSupport.form.attributionOrg')}
                </label>
                <select
                  id="quick-support-org"
                  value={attributedOrgId}
                  onChange={(e) => setAttributedOrgId(e.target.value)}
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                >
                  <option value="">{t('quickSupport.form.attributionOrgNone')}</option>
                  {organizations.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('quickSupport.form.attributionOrgHint')}
                </p>
              </div>

              <div>
                <label
                  htmlFor="quick-support-label"
                  className="block text-sm font-medium"
                >
                  {t('quickSupport.form.attributionLabel')}
                </label>
                <input
                  id="quick-support-label"
                  type="text"
                  maxLength={200}
                  value={attributionLabel}
                  onChange={(e) => setAttributionLabel(e.target.value)}
                  placeholder={t('quickSupport.form.attributionLabelPlaceholder')}
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDialogOpen(false)}
                className="rounded-md border px-4 py-2 text-sm transition hover:bg-muted"
              >
                {t('common:actions.cancel')}
              </button>
              <button
                type="button"
                data-testid="quick-support-create"
                disabled={creating}
                onClick={handleCreate}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
              >
                {creating ? t('quickSupport.form.submitting') : t('quickSupport.form.submit')}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedId && (
        <div data-testid="quick-support-detail" className="rounded-lg border bg-card p-6">
          <div className="flex items-start justify-between gap-4">
            <h2 className="text-lg font-semibold">
              {shownCode ? t('quickSupport.code.heading') : t('quickSupport.detail.heading')}
            </h2>
            <button
              type="button"
              onClick={closeDetail}
              aria-label={t('quickSupport.detail.close')}
              className="text-muted-foreground transition hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {shownCode ? (
            <>
              <div
                data-testid="quick-support-code"
                className="mt-4 font-mono text-4xl font-bold tracking-[0.2em] sm:text-5xl"
              >
                {shownCode.code}
              </div>

              <p className="mt-3 text-sm text-muted-foreground">
                {t('quickSupport.code.visibleWhilePending')}
              </p>

              <p className="mt-3 text-sm text-muted-foreground">
                <span data-testid="quick-support-code-countdown" className="font-medium text-foreground">
                  {t('quickSupport.code.expiresIn', { time: formatCountdown(codeMsLeft) })}
                </span>
                {' · '}
                {t('quickSupport.code.expires', {
                  time: formatDateTime(shownCode.codeExpiresAt),
                })}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('quickSupport.code.instructions')}
              </p>
              <p
                data-testid="quick-support-landing-link"
                className="mt-2 break-all font-mono text-xs text-muted-foreground"
              >
                {toAbsoluteUrl(shownCode.landingUrl)}
              </p>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  data-testid="quick-support-copy-code"
                  onClick={() => copy(shownCode.code, t('quickSupport.code.copiedCode'))}
                  className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition hover:bg-muted"
                >
                  <Copy className="h-4 w-4" />
                  {t('quickSupport.code.copyCode')}
                </button>
                <button
                  type="button"
                  data-testid="quick-support-copy-link"
                  onClick={() => copy(toAbsoluteUrl(shownCode.landingUrl), t('quickSupport.code.copiedLink'))}
                  className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition hover:bg-muted"
                >
                  <Link2 className="h-4 w-4" />
                  {t('quickSupport.code.copyLink')}
                </button>
                {canIssueNewCode && selectedId && (
                  <button
                    type="button"
                    data-testid="quick-support-new-code"
                    disabled={reissuing}
                    onClick={() => handleNewCode(selectedId)}
                    className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition hover:bg-muted disabled:opacity-50"
                  >
                    <RefreshCw className="h-4 w-4" />
                    {reissuing ? t('quickSupport.code.newCodeSubmitting') : t('quickSupport.code.newCode')}
                  </button>
                )}
              </div>
            </>
          ) : codeLapsed || currentStatus === 'pending' ? (
            <div className="mt-2 space-y-3">
              {codeLapsed ? (
                <div
                  data-testid="quick-support-code-expired"
                  className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{t('quickSupport.code.expired')}</span>
                </div>
              ) : (
                <p data-testid="quick-support-no-code" className="text-sm text-muted-foreground">
                  {t('quickSupport.detail.noCode')}
                </p>
              )}
              {canIssueNewCode && selectedId && (
                <button
                  type="button"
                  data-testid="quick-support-new-code"
                  disabled={reissuing}
                  onClick={() => handleNewCode(selectedId)}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
                >
                  <RefreshCw className="h-4 w-4" />
                  {reissuing ? t('quickSupport.code.newCodeSubmitting') : t('quickSupport.code.newCode')}
                </button>
              )}
            </div>
          ) : null}

          {selectedSession && (
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">
                  {t('quickSupport.detail.attribution')}
                </dt>
                <dd className="mt-0.5 truncate font-medium">
                  {selectedSession.attributionLabel || t('quickSupport.list.unlabeled')}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  {t('quickSupport.list.columnCreated')}
                </dt>
                <dd className="mt-0.5">{formatDateTime(selectedSession.createdAt)}</dd>
              </div>
              {selectedSession.endedAt && (
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t('quickSupport.list.columnEnded')}
                  </dt>
                  <dd className="mt-0.5">{formatDateTime(selectedSession.endedAt)}</dd>
                </div>
              )}
            </dl>
          )}

          <div className="mt-6 border-t pt-4">
            <h3 className="text-sm font-medium text-muted-foreground">
              {t('quickSupport.status.heading')}
            </h3>
            <p
              data-testid="quick-support-status"
              className={`mt-1 text-base font-medium ${statusClass(currentStatus)}`}
            >
              {statusLabel(currentStatus)}
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {canConnect && selectedSession?.deviceId ? (
                <span data-testid="quick-support-connect">
                  <ConnectDesktopButton deviceId={selectedSession.deviceId} compact />
                </span>
              ) : (
                !isTerminal && (
                  <span className="text-sm text-muted-foreground">
                    {t('quickSupport.connect.waitingForDevice')}
                  </span>
                )
              )}
              {!isTerminal && (
                <button
                  type="button"
                  data-testid="quick-support-end"
                  disabled={ending}
                  onClick={() => handleEnd(selectedId)}
                  className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm text-red-600 transition hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950"
                >
                  <X className="h-4 w-4" />
                  {t('quickSupport.end.button')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="rounded-lg border bg-card">
        <div className="border-b px-6 py-4">
          <h2 className="font-semibold">{t('quickSupport.list.heading')}</h2>
        </div>
        <div data-testid="quick-support-list" className="divide-y">
          {listError && <p className="px-6 py-4 text-sm text-red-600">{listError}</p>}
          {!listError && sessions.length === 0 && (
            <p className="px-6 py-4 text-sm text-muted-foreground">
              {t('quickSupport.list.empty')}
            </p>
          )}
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              data-testid="quick-support-row"
              title={t('quickSupport.list.openSession')}
              aria-current={session.id === selectedId ? 'true' : undefined}
              onClick={() => openSession(session)}
              className={`flex w-full flex-wrap items-center justify-between gap-3 px-6 py-3 text-left text-sm transition hover:bg-muted ${
                session.id === selectedId ? 'bg-muted' : ''
              }`}
            >
              {/* Spans, not <p>: a button may only contain phrasing content. */}
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {session.attributionLabel || t('quickSupport.list.unlabeled')}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t('quickSupport.list.columnCreated')}: {formatDateTime(session.createdAt)}
                  {session.endedAt
                    ? ` · ${t('quickSupport.list.columnEnded')}: ${formatTime(session.endedAt)}`
                    : ''}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-3">
                {session.code && Date.parse(session.codeExpiresAt) > now && (
                  <span
                    data-testid="quick-support-row-code"
                    className="font-mono text-sm font-semibold tracking-wider"
                  >
                    {session.code}
                  </span>
                )}
                <span className={`text-xs font-medium ${statusClass(session.status)}`}>
                  {statusLabel(session.status)}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
