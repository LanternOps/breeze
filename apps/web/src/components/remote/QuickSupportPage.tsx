import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Copy, Headphones, Link2, Plus, X } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';
import { useOrgStore } from '@/stores/orgStore';
import { runAction, ActionError } from '@/lib/runAction';
import { showToast } from '@/components/shared/Toast';
import { formatDateTime, formatTime } from '@/lib/dateTimeFormat';
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
  const [activeSession, setActiveSession] = useState<SupportSessionView | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionId = created?.id ?? null;

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

  // Poll the freshly created session until it reaches a terminal state.
  useEffect(() => {
    if (!activeSessionId) return;
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
        const response = await fetchWithAuth(`/remote/support-sessions/${activeSessionId}`);
        if (response.ok) {
          const data = (await response.json()) as SupportSessionView;
          if (cancelled) return;
          if (data && typeof data.status === 'string') {
            setActiveSession(data);
            terminal = TERMINAL_STATUSES.has(data.status);
          }
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
  }, [activeSessionId, loadSessions]);

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
      setActiveSession(null);
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
  }, [attributedOrgId, attributionLabel, loadSessions, t]);

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
        setActiveSession((current) =>
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

  const currentStatus: SupportSessionStatus = activeSession?.status ?? 'pending';
  const isTerminal = TERMINAL_STATUSES.has(currentStatus);
  const canConnect = Boolean(activeSession?.deviceId && activeSession.deviceOnline && !isTerminal);

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

      {created && (
        <div className="rounded-lg border bg-card p-6">
          <h2 className="text-lg font-semibold">{t('quickSupport.code.heading')}</h2>

          <div
            data-testid="quick-support-code"
            className="mt-4 font-mono text-4xl font-bold tracking-[0.2em] sm:text-5xl"
          >
            {created.code}
          </div>

          <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t('quickSupport.code.shownOnce')}</span>
          </div>

          <p className="mt-3 text-sm text-muted-foreground">
            {t('quickSupport.code.expires', { time: formatDateTime(created.codeExpiresAt) })}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('quickSupport.code.instructions')}
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => copy(created.code, t('quickSupport.code.copiedCode'))}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition hover:bg-muted"
            >
              <Copy className="h-4 w-4" />
              {t('quickSupport.code.copyCode')}
            </button>
            <button
              type="button"
              data-testid="quick-support-copy-link"
              onClick={() => copy(created.landingUrl, t('quickSupport.code.copiedLink'))}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition hover:bg-muted"
            >
              <Link2 className="h-4 w-4" />
              {t('quickSupport.code.copyLink')}
            </button>
          </div>

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
              {canConnect && activeSession?.deviceId ? (
                <span data-testid="quick-support-connect">
                  <ConnectDesktopButton deviceId={activeSession.deviceId} compact />
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
                  onClick={() => handleEnd(created.id)}
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
            <div
              key={session.id}
              className="flex flex-wrap items-center justify-between gap-3 px-6 py-3 text-sm"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {session.attributionLabel || t('quickSupport.list.unlabeled')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('quickSupport.list.columnCreated')}: {formatDateTime(session.createdAt)}
                  {session.endedAt
                    ? ` · ${t('quickSupport.list.columnEnded')}: ${formatTime(session.endedAt)}`
                    : ''}
                </p>
              </div>
              <span className={`shrink-0 text-xs font-medium ${statusClass(session.status)}`}>
                {statusLabel(session.status)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
