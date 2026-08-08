import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Copy, Headphones, Link2, Plus, X } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';
import { useOrgStore } from '@/stores/orgStore';
import { runAction, ActionError } from '@/lib/runAction';
import { showToast } from '@/components/shared/Toast';
import { formatDateTime, formatTime } from '@/lib/dateTimeFormat';
import { useHashState } from '@/lib/useHashState';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import ConnectDesktopButton from './ConnectDesktopButton';

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
}

/** The create response — `code` is returned exactly once and is never retrievable again. */
interface CreatedSupportSession {
  id: string;
  code: string;
  codeExpiresAt: string;
  hardExpiresAt: string;
  landingUrl: string;
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
 * panel: the one-time code block is layered on top only while the selected
 * session is the one minted in this page load (`created.code` is held in
 * memory and is never retrievable from the API again); the
 * status/connect/end block below it is shared by both cases.
 *
 * Polling uses a recursive `setTimeout` held in a ref (same shape as
 * ConnectDesktopButton) rather than setInterval: it self-terminates on a
 * terminal status and never overlaps requests, so a session that ends while
 * the page stays open cannot leave a timer polling forever.
 */
export default function QuickSupportPage() {
  const { t } = useTranslation('remote');
  const { organizations } = useOrgStore();

  const [sessions, setSessions] = useState<SupportSessionView[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [attributedOrgId, setAttributedOrgId] = useState('');
  const [attributionLabel, setAttributionLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [ending, setEnding] = useState(false);
  const [created, setCreated] = useState<CreatedSupportSession | null>(null);
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
      setListError(t('quickSupport.errors.list'));
    }
  }, [t]);

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
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
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
          showToast({ message: t('quickSupport.errors.notFound'), type: 'warning' });
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
  }, [selectedId, loadSessions, closeDetail, t]);

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

  // The one-time code exists only in memory, only for the session minted in
  // this page load — a re-opened session can never show one.
  const createdCode = created && created.id === selectedId ? created : null;

  const currentStatus: SupportSessionStatus = selectedSession?.status ?? 'pending';
  const isTerminal = TERMINAL_STATUSES.has(currentStatus);
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
              {createdCode ? t('quickSupport.code.heading') : t('quickSupport.detail.heading')}
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

          {createdCode ? (
            <>
              <div
                data-testid="quick-support-code"
                className="mt-4 font-mono text-4xl font-bold tracking-[0.2em] sm:text-5xl"
              >
                {createdCode.code}
              </div>

              <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{t('quickSupport.code.shownOnce')}</span>
              </div>

              <p className="mt-3 text-sm text-muted-foreground">
                {t('quickSupport.code.expires', {
                  time: formatDateTime(createdCode.codeExpiresAt),
                })}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('quickSupport.code.instructions')}
              </p>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => copy(createdCode.code, t('quickSupport.code.copiedCode'))}
                  className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition hover:bg-muted"
                >
                  <Copy className="h-4 w-4" />
                  {t('quickSupport.code.copyCode')}
                </button>
                <button
                  type="button"
                  data-testid="quick-support-copy-link"
                  onClick={() => copy(createdCode.landingUrl, t('quickSupport.code.copiedLink'))}
                  className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition hover:bg-muted"
                >
                  <Link2 className="h-4 w-4" />
                  {t('quickSupport.code.copyLink')}
                </button>
              </div>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">{t('quickSupport.detail.noCode')}</p>
          )}

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
              <span className={`shrink-0 text-xs font-medium ${statusClass(session.status)}`}>
                {statusLabel(session.status)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
