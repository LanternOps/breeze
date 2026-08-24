import '@/lib/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bot, Check, Loader2, ShieldCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useEventStream } from '@/hooks/useEventStream';
import {
  CeremonyError,
  decideIntentApproval,
  isNoApproverDeviceError,
  isNotSoleApprover,
  isStepUpRequired,
} from '@/lib/intentApprovals';
import { loginPathWithNext } from '@/lib/authScope';
import { navigateTo } from '@/lib/navigation';
import { ActionError } from '@/lib/runAction';
import { formatRelativeTime } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

const LIVE_REFETCH_DEBOUNCE_MS = 750;
/** WS is only a nudge; polling is the guarantee. useEventStream gives up
 *  permanently after repeated ticket failures, and these approvals are
 *  time-boxed — with no fallback they would arrive AND expire unseen. Same
 *  cadence as NotificationCenter's POLL_INTERVAL_MS. */
const POLL_INTERVAL_MS = 30_000;
const APPROVAL_EVENTS = ['notification.created'];
const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

type RiskTier = 'low' | 'medium' | 'high' | 'critical';
type DecisionErrorKind =
  | 'noApproverDevice'
  | 'notSoleApprover'
  | 'verificationFailed'
  | 'decisionFailed';

interface PendingApproval {
  id: string;
  requestingClientLabel: string;
  requestingMachineLabel: string | null;
  actionLabel: string;
  actionToolName: string;
  actionArguments: Record<string, unknown>;
  riskTier: RiskTier;
  riskSummary: string;
  customerTenant: string | null;
  status: 'pending';
  expiresAt: string;
  decidedAt: null;
  decisionReason: null;
  executionId: string | null;
  intentId: string | null;
  approvalScope: string | null;
  isRecursive: boolean;
  createdAt: string;
  /** Wave 3b: who proposed this intent. Serialize emits it on every row;
   *  anything but 'ai_agent' renders the classic requester attribution. */
  origin: 'human' | 'ai_agent';
  agentName: string | null;
}

const riskClass: Record<RiskTier, string> = {
  low: 'bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-200',
  medium: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200',
  high: 'bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-200',
  critical: 'bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200',
};

export default function ApprovalsInbox() {
  const { t } = useTranslation('approvals');
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, DecisionErrorKind>>({});
  const [denyingId, setDenyingId] = useState<string | null>(null);
  const [denyReason, setDenyReason] = useState('');
  const liveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors `approvals` so the silent-failure branch of loadApprovals (empty
  // deps) can see whether anything is currently on screen.
  const approvalsRef = useRef<PendingApproval[]>([]);

  const loadApprovals = useCallback(async (options?: { silent?: boolean }) => {
    // Silent reloads (WS nudge, poll, reconnect, post-decision refresh) must
    // not flash the already-rendered list back to a spinner.
    const silent = options?.silent === true;
    if (!silent) {
      setLoading(true);
      setLoadError(false);
    }
    try {
      const response = await fetchWithAuth('/approvals/pending?limit=25');
      if (response.status === 401) {
        UNAUTHORIZED();
        return;
      }
      if (!response.ok) throw new Error('Unable to load approvals');
      const body = (await response.json()) as { approvals?: PendingApproval[] };
      const rows = Array.isArray(body.approvals) ? body.approvals : [];
      approvalsRef.current = rows;
      setApprovals(rows);
      setLoadError(false);
    } catch {
      // A failed silent refresh keeps the list the user already has instead of
      // blanking it to the error card — unless there is nothing on screen, in
      // which case repeated failure must still surface.
      if (!silent || approvalsRef.current.length === 0) setLoadError(true);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const { connected, subscribe, unsubscribe } = useEventStream({
    onEvent: (event) => {
      if (event.type !== 'notification.created') return;
      // notification.created is content-free by contract. Debounce the nudge
      // and reload the authoritative approval rows from the API.
      if (liveDebounceRef.current) clearTimeout(liveDebounceRef.current);
      liveDebounceRef.current = setTimeout(() => {
        void loadApprovals({ silent: true });
      }, LIVE_REFETCH_DEBOUNCE_MS);
    },
  });

  useEffect(() => {
    void loadApprovals();
  }, [loadApprovals]);

  // Polling fallback: the WS layer can die permanently and silently
  // (useEventStream stops retrying after 5 ticket failures), and approvals
  // expire in minutes. The nudge makes the inbox fast; this makes it correct.
  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadApprovals({ silent: true });
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadApprovals]);

  // Refetch on WS reconnect: anything that arrived during the outage produced
  // no nudge, so a fresh connection means our snapshot may be stale.
  const wasConnectedRef = useRef(connected);
  useEffect(() => {
    if (connected && !wasConnectedRef.current) {
      void loadApprovals({ silent: true });
    }
    wasConnectedRef.current = connected;
  }, [connected, loadApprovals]);

  useEffect(() => {
    subscribe(APPROVAL_EVENTS);
    return () => {
      unsubscribe(APPROVAL_EVENTS);
      if (liveDebounceRef.current) clearTimeout(liveDebounceRef.current);
    };
  }, [subscribe, unsubscribe]);

  const setDecisionError = (id: string, kind: DecisionErrorKind) => {
    setRowErrors((current) => ({ ...current, [id]: kind }));
  };

  /** Relative expiry for a row. These requests are minutes-long, so an inbox
   *  that shows only when a request arrived tells the approver nothing about
   *  how long they still have to decide. */
  const expiryLabel = (expiresAt: string): string => {
    const remainingMs = new Date(expiresAt).getTime() - Date.now();
    if (!Number.isFinite(remainingMs) || remainingMs < 60_000) return t('expiresSoon');
    return t('expiresIn', { minutes: Math.floor(remainingMs / 60_000) });
  };

  const openDenyForm = (id: string) => {
    if (decidingId) return;
    setDenyReason('');
    setDenyingId((current) => (current === id ? null : id));
  };

  const decide = async (
    approval: PendingApproval,
    decision: 'approve' | 'deny',
    reason?: string,
  ) => {
    if (decidingId) return;

    setDecidingId(approval.id);
    setRowErrors((current) => {
      const next = { ...current };
      delete next[approval.id];
      return next;
    });

    try {
      const outcome =
        decision === 'approve'
          ? await decideIntentApproval(approval.id, 'approve')
          : await decideIntentApproval(approval.id, 'deny', reason?.trim() || undefined);
      if (outcome === 'needs_device') {
        setDecisionError(approval.id, 'noApproverDevice');
        return;
      }
      if (outcome === 'not_sole_approver') {
        setDecisionError(approval.id, 'notSoleApprover');
        return;
      }
      setDenyingId(null);
      await loadApprovals({ silent: true });
    } catch (err) {
      if (isNoApproverDeviceError(err) || isStepUpRequired(err)) {
        setDecisionError(approval.id, 'noApproverDevice');
        return;
      }
      if (isNotSoleApprover(err)) {
        setDecisionError(approval.id, 'notSoleApprover');
        return;
      }
      if (err instanceof CeremonyError) {
        setDecisionError(approval.id, 'verificationFailed');
        return;
      }
      // 401 is NOT handled upstream here: decideIntentApproval opts out of the
      // auth layer's refresh-and-redirect (skipUnauthorizedRetry +
      // treatUnauthorizedAsError), so nobody else is redirecting. The decide
      // route answers 401 for two very different things (routes/approvals.ts):
      // `assertion_failed` / `reauth_required` are server-side WebAuthn PROOF
      // rejections — surface those inline exactly like a client-side
      // CeremonyError. Any other 401 is genuine session expiry, so send the
      // user to login the same way loadApprovals does.
      if (err instanceof ActionError && err.status === 401) {
        const token = (err.body as { error?: unknown } | null | undefined)?.error;
        if (token === 'assertion_failed' || token === 'reauth_required') {
          setDecisionError(approval.id, 'verificationFailed');
          return;
        }
        UNAUTHORIZED();
        return;
      }
      // An ActionError was already toasted by runAction, but the toast is
      // transient and the row is where the retry lives — so both kinds of
      // failure also get an inline message.
      setDecisionError(approval.id, 'decisionFailed');
    } finally {
      setDecidingId(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6" data-testid="approvals-inbox">
      <header className="flex items-start gap-3">
        <div className="mt-0.5 rounded-xl bg-emerald-100 p-2 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-200">
          <ShieldCheck className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {t('description')}
          </p>
        </div>
      </header>

      {loading ? (
        <div
          className="rounded-xl border bg-card px-5 py-10 text-center"
          data-testid="approvals-loading"
        >
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">{t('loading')}</p>
        </div>
      ) : loadError ? (
        <div
          className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-5 py-4 text-destructive"
          data-testid="approvals-error"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('loadError')}</p>
            <button
              type="button"
              className="text-sm font-medium underline underline-offset-4"
              onClick={() => void loadApprovals()}
            >
              {t('retry')}
            </button>
          </div>
        </div>
      ) : approvals.length === 0 ? (
        <div
          className="rounded-xl border border-dashed px-5 py-12 text-center"
          data-testid="approvals-empty"
        >
          <ShieldCheck className="mx-auto h-7 w-7 text-muted-foreground" aria-hidden="true" />
          <h2 className="mt-3 text-base font-semibold">{t('empty.title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('empty.description')}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          {approvals.map((approval) => {
            const isDeciding = decidingId === approval.id;
            const rowError = rowErrors[approval.id];
            return (
              <article
                key={approval.id}
                className="border-b px-5 py-5 last:border-b-0"
                data-testid={`approval-row-${approval.id}`}
              >
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold text-foreground">
                        {approval.actionLabel}
                      </h2>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${riskClass[approval.riskTier]}`}
                      >
                        {t(/* i18n-dynamic */ `risk.${approval.riskTier}`)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {approval.origin === 'ai_agent' ? (
                        <>
                          {/* Purple Bot badge matches NotificationCenter's `ai` typeConfig. */}
                          <span
                            className="mr-1.5 inline-flex items-center rounded-full bg-purple-100 px-1.5 py-0.5 align-middle text-purple-700 dark:bg-purple-900/40 dark:text-purple-200"
                            data-testid={`approval-agent-badge-${approval.id}`}
                          >
                            <Bot className="h-3.5 w-3.5" aria-hidden="true" />
                          </span>
                          {t('proposedByAgent', {
                            agent: approval.agentName ?? approval.requestingClientLabel,
                          })}
                        </>
                      ) : (
                        t('requestedBy', { client: approval.requestingClientLabel })
                      )}
                      <span aria-hidden="true"> &middot; </span>
                      {formatRelativeTime(new Date(approval.createdAt))}
                      <span aria-hidden="true"> &middot; </span>
                      <span data-testid={`approval-expiry-${approval.id}`}>
                        {expiryLabel(approval.expiresAt)}
                      </span>
                    </p>
                    {approval.riskSummary && (
                      <p className="mt-3 max-w-3xl text-sm text-foreground/80">
                        {approval.riskSummary}
                      </p>
                    )}
                    {denyingId === approval.id && (
                      <div
                        className="mt-4 rounded-lg border bg-muted/40 p-3"
                        data-testid={`approval-deny-form-${approval.id}`}
                      >
                        <label
                          className="text-sm font-medium"
                          htmlFor={`approval-deny-reason-${approval.id}`}
                        >
                          {t('denyPrompt')}
                        </label>
                        <textarea
                          id={`approval-deny-reason-${approval.id}`}
                          className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
                          rows={2}
                          // Mirrors the server's z.string().max(500): without a
                          // client cap the 400 surfaces as generic copy and the
                          // typed reason's rejection is opaque.
                          maxLength={500}
                          value={denyReason}
                          placeholder={t('denyReasonPlaceholder')}
                          onChange={(event) => setDenyReason(event.target.value)}
                          data-testid={`approval-deny-reason-${approval.id}`}
                        />
                        <div className="mt-2 flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setDenyingId(null)}
                            disabled={isDeciding}
                            className="inline-flex h-9 items-center rounded-lg border px-3 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                            data-testid={`approval-deny-cancel-${approval.id}`}
                          >
                            {t('cancel')}
                          </button>
                          <button
                            type="button"
                            onClick={() => void decide(approval, 'deny', denyReason)}
                            disabled={isDeciding}
                            className="inline-flex h-9 items-center gap-2 rounded-lg bg-destructive px-3 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
                            data-testid={`approval-deny-confirm-${approval.id}`}
                          >
                            {isDeciding && (
                              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                            )}
                            {isDeciding ? t('deciding') : t('confirmDeny')}
                          </button>
                        </div>
                      </div>
                    )}
                    {rowError && (
                      <div
                        className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
                        data-testid={`approval-error-${approval.id}`}
                        role="alert"
                      >
                        {t(/* i18n-dynamic */ `errors.${rowError}`)}
                        {rowError === 'noApproverDevice' && (
                          <>
                            {' '}
                            <a className="font-medium underline underline-offset-4" href="/settings/profile">
                              {t('registerDevice')}
                            </a>
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2 md:pt-0.5">
                    <button
                      type="button"
                      onClick={() => openDenyForm(approval.id)}
                      disabled={Boolean(decidingId)}
                      aria-expanded={denyingId === approval.id}
                      className="inline-flex h-10 items-center gap-2 rounded-lg border px-4 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                      data-testid={`approval-deny-${approval.id}`}
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                      {t('deny')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void decide(approval, 'approve')}
                      disabled={Boolean(decidingId)}
                      className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-emerald-950 transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                      data-testid={`approval-approve-${approval.id}`}
                    >
                      {isDeciding ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <Check className="h-4 w-4" aria-hidden="true" />
                      )}
                      {isDeciding ? t('deciding') : t('approve')}
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
