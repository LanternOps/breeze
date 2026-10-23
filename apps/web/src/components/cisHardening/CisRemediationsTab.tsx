import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Check, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import { cn, friendlyFetchError, formatRelativeTime } from '@/lib/utils';
import { FilterSelect } from '../shared/FilterSelect';
import { fetchWithAuth, useAuthStore } from '@/stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { usePermissions } from '@/lib/permissions';
import { runAction, ActionError } from '@/lib/runAction';
import HelpTooltip from '../shared/HelpTooltip';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { showToast } from '../shared/Toast';

type Remediation = {
  id: string;
  checkId: string;
  deviceId: string;
  baselineId: string | null;
  action: string;
  status: string;
  approvalStatus: string;
  requestedBy: string | null;
  createdAt: string;
  executedAt: string | null;
  deviceHostname: string;
  deviceDisplayName?: string | null;
  baselineName: string | null;
  // Audit evidence the API already stores (#9606).
  approvedBy?: string | null;
  approverName?: string | null;
  approvedAt?: string | null;
  approvalNote?: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  rollbackHint?: string | null;
};

const deviceLabel = (rem: Remediation) => rem.deviceDisplayName || rem.deviceHostname;

const hasEvidence = (rem: Remediation) =>
  Boolean(rem.approvedBy || rem.approvedAt || rem.approvalNote || rem.beforeState || rem.afterState || rem.rollbackHint);

const statusBadge: Record<string, string> = {
  pending_approval: 'bg-amber-500/20 text-amber-800 border-amber-500/40',
  queued: 'bg-blue-500/20 text-blue-700 border-blue-500/30',
  in_progress: 'bg-sky-500/20 text-sky-700 border-sky-500/30',
  completed: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/30',
  failed: 'bg-red-500/20 text-red-700 border-red-500/40',
  cancelled: 'bg-gray-500/20 text-gray-700 border-gray-500/30',
};

const approvalBadge: Record<string, string> = {
  pending: 'bg-amber-500/20 text-amber-800 border-amber-500/40',
  approved: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/30',
  rejected: 'bg-red-500/20 text-red-700 border-red-500/40',
};

interface CisRemediationsTabProps {
  refreshKey: number;
  /** Called after an approve/reject so the page can refresh its pending-count card. */
  onMutate?: () => void;
}

type Decision = { remediation: Remediation; approved: boolean };

/** `POST /cis/remediate/approve` success bodies (approve and reject branches). */
type DecisionResult = {
  approved: boolean;
  queued?: number;
  rejected?: number;
  failedActionIds?: string[];
};

const isRetryableDecisionError = (err: unknown) =>
  !(err instanceof ActionError) ||
  err.status === 0 ||
  err.status >= 500 ||
  err.code === 'MFA_REQUIRED';

const isDecidable = (rem: Remediation) =>
  rem.status === 'pending_approval' && rem.approvalStatus === 'pending';

export default function CisRemediationsTab({ refreshKey, onMutate }: CisRemediationsTabProps) {
  const { t } = useTranslation('security');
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const currentUserId = useAuthStore((s) => s.user?.id);
  // Mirrors the route's `requireCisExecute` (devices:execute). UX only — the
  // API re-checks it, plus MFA, site scope and maker/checker.
  const { can } = usePermissions();
  const canDecide = can('devices', 'execute');
  const [decision, setDecision] = useState<Decision | null>(null);
  const [decisionNote, setDecisionNote] = useState('');
  const [deciding, setDeciding] = useState(false);
  const [remediations, setRemediations] = useState<Remediation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [statusFilter, setStatusFilter] = useState('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    setError(undefined);
    setLoading(true);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const params = new URLSearchParams({ limit: '200' });
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (currentOrgId) params.set('orgId', currentOrgId);

      const response = await fetchWithAuth(`/cis/remediations?${params.toString()}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

      const payload = await response.json();
      setRemediations(Array.isArray(payload.data) ? payload.data : []);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(friendlyFetchError(err));
    } finally {
      // An aborted request still runs its `finally`; clearing the flag there
      // would show the empty state while its replacement is still loading.
      if (abortRef.current === controller) setLoading(false);
    }
  }, [statusFilter, currentOrgId]);

  useEffect(() => {
    fetchData();
    return () => abortRef.current?.abort();
  }, [fetchData, refreshKey]);

  const openDecision = (remediation: Remediation, approved: boolean) => {
    setDecisionNote('');
    setDecision({ remediation, approved });
  };

  const closeDecision = () => {
    if (deciding) return;
    setDecision(null);
  };

  const handleDecide = async () => {
    if (!decision) return;
    const { remediation, approved } = decision;
    const errorFallback = approved
      ? t('cisHardeningCisRemediationsTab.decision.approveFailed')
      : t('cisHardeningCisRemediationsTab.decision.rejectFailed');
    const note = decisionNote.trim();
    setDeciding(true);
    try {
      const result = await runAction<DecisionResult>({
        request: () => fetchWithAuth('/cis/remediate/approve', {
          method: 'POST',
          body: JSON.stringify({
            actionIds: [remediation.id],
            approved,
            ...(note ? { note } : {}),
          }),
        }),
        errorFallback,
        friendly: (code) =>
          code === 'MFA_REQUIRED' ? t('cisHardeningCisRemediationsTab.decision.mfaRequired') : undefined,
      });
      // The route answers 200 even when the approval was recorded but the job
      // could not be queued — it reverts those rows to pending and lists them in
      // `failedActionIds`. A success toast there would claim a fix is on its way
      // when nothing was dispatched.
      if (approved && (result?.failedActionIds?.length ?? 0) > 0) {
        showToast({ type: 'warning', message: t('cisHardeningCisRemediationsTab.decision.queueFailed') });
      } else {
        showToast({
          type: 'success',
          message: approved
            ? t('cisHardeningCisRemediationsTab.decision.approved', { checkId: remediation.checkId })
            : t('cisHardeningCisRemediationsTab.decision.rejected', { checkId: remediation.checkId }),
        });
      }
      setDecision(null);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: errorFallback });
      // Keep the dialog (and its note) open only when a retry can succeed:
      // network failure, a server error, or MFA (after signing in again).
      // Any other 4xx (already decided by someone else, gone, out of scope,
      // own request) would fail the same way again, so close it.
      if (!isRetryableDecisionError(err)) setDecision(null);
      // The row may have been decided by someone else meanwhile: refetch either way.
    } finally {
      setDeciding(false);
    }
    // The page's refresh bumps `refreshKey`, which refetches this table too.
    if (onMutate) onMutate();
    else fetchData();
  };

  const columnCount = canDecide ? 10 : 9;

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs" data-testid="cis-remediations-tab">
      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          {t('cisHardeningCisRemediationsTab.title')}
          <HelpTooltip text={t('cisHardeningCisRemediationsTab.tooltip')} />
        </h3>
        <FilterSelect
          label={t('cisHardeningCisRemediationsTab.filters.statusFilterLabel')}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-10"
        >
          <option value="all">{t('cisHardeningCisRemediationsTab.filters.allStatuses')}</option>
          <option value="pending_approval">{t('cisHardeningCisRemediationsTab.status.pendingApproval')}</option>
          <option value="queued">{t('cisHardeningCisRemediationsTab.status.queued')}</option>
          <option value="in_progress">{t('cisHardeningCisRemediationsTab.status.inProgress')}</option>
          <option value="completed">{t('cisHardeningCisRemediationsTab.status.completed')}</option>
          <option value="failed">{t('cisHardeningCisRemediationsTab.status.failed')}</option>
          <option value="cancelled">{t('cisHardeningCisRemediationsTab.status.cancelled')}</option>
        </FilterSelect>
      </div>

      <div className="mt-4 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="w-8 px-4 py-3" />
              <th className="px-4 py-3">{t('cisHardeningCisRemediationsTab.table.checkId')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisRemediationsTab.table.device')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisRemediationsTab.table.baseline')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisRemediationsTab.table.action')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisRemediationsTab.table.status')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisRemediationsTab.table.approval')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisRemediationsTab.table.requested')}</th>
              <th className="px-4 py-3">{t('cisHardeningCisRemediationsTab.table.completed')}</th>
              {canDecide && (
                <th className="px-4 py-3 text-right">{t('cisHardeningCisRemediationsTab.table.decision')}</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td colSpan={columnCount} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('cisHardeningCisRemediationsTab.loading')}
                  </span>
                </td>
              </tr>
            ) : remediations.length === 0 ? (
              <tr>
                <td colSpan={columnCount} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {t('cisHardeningCisRemediationsTab.empty')}
                </td>
              </tr>
            ) : (
              remediations.map((rem) => (
                <Fragment key={rem.id}>
                <tr className="text-sm" data-testid={`cis-remediation-row-${rem.id}`}>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => setExpandedId(expandedId === rem.id ? null : rem.id)}
                      aria-expanded={expandedId === rem.id}
                      aria-label={t('cisHardeningCisRemediationsTab.detail.toggle')}
                      data-testid={`cis-remediation-toggle-${rem.id}`}
                      className="rounded-md p-1 hover:bg-muted"
                    >
                      {expandedId === rem.id ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <code className="font-mono text-xs">{rem.checkId}</code>
                  </td>
                  <td className="px-4 py-3 font-medium" title={rem.deviceHostname}>{deviceLabel(rem)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{rem.baselineName ?? '-'}</td>
                  <td className="px-4 py-3 capitalize text-muted-foreground">
                    {t(/* i18n-dynamic */ `cisHardeningCisRemediationsTab.actions.${rem.action}`, { defaultValue: rem.action })}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold capitalize',
                        statusBadge[rem.status] ?? statusBadge.cancelled
                      )}
                    >
                      {t(/* i18n-dynamic */ `cisHardeningCisRemediationsTab.status.${rem.status}`, {
                        defaultValue: rem.status.replace(/_/g, ' '),
                      })}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold capitalize',
                        approvalBadge[rem.approvalStatus] ?? approvalBadge.pending
                      )}
                    >
                      {t(/* i18n-dynamic */ `cisHardeningCisRemediationsTab.approval.${rem.approvalStatus}`, {
                        defaultValue: rem.approvalStatus.replace(/_/g, ' '),
                      })}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {formatRelativeTime(new Date(rem.createdAt))}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {rem.executedAt ? formatRelativeTime(new Date(rem.executedAt)) : '-'}
                  </td>
                  {canDecide && (
                    <td className="px-4 py-3 text-right">
                      {isDecidable(rem) && (() => {
                        // Maker/checker: the route refuses to let the requester
                        // approve their own action (rejecting it is allowed).
                        const ownRequest = !!currentUserId && rem.requestedBy === currentUserId;
                        return (
                          <div className="inline-flex gap-2">
                            {/* The hint sits on a wrapper (the disabled button passes pointer events
                                through to it): a disabled button fires none, so its own `title` is unreliable. */}
                            <span title={ownRequest ? t('cisHardeningCisRemediationsTab.decision.ownRequest') : undefined}>
                              <button
                                type="button"
                                onClick={() => openDecision(rem, true)}
                                disabled={ownRequest}
                                aria-label={ownRequest
                                  ? `${t('cisHardeningCisRemediationsTab.decision.approve')}: ${t('cisHardeningCisRemediationsTab.decision.ownRequest')}`
                                  : undefined}
                                data-testid={`cis-remediation-approve-${rem.id}`}
                                className="inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-xs font-medium hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                              >
                                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                                {t('cisHardeningCisRemediationsTab.decision.approve')}
                              </button>
                            </span>
                            <button
                              type="button"
                              onClick={() => openDecision(rem, false)}
                              data-testid={`cis-remediation-reject-${rem.id}`}
                              className="inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-xs font-medium text-destructive hover:bg-destructive/10"
                            >
                              <X className="h-3.5 w-3.5" aria-hidden="true" />
                              {t('cisHardeningCisRemediationsTab.decision.reject')}
                            </button>
                          </div>
                        );
                      })()}
                    </td>
                  )}
                </tr>
                {expandedId === rem.id && (
                  <tr data-testid={`cis-remediation-detail-${rem.id}`}>
                    <td colSpan={columnCount} className="bg-muted/20 px-4 py-3">
                      {hasEvidence(rem) ? (
                        <dl className="grid gap-3 text-sm sm:grid-cols-2">
                          <div>
                            <dt className="text-xs font-semibold uppercase text-muted-foreground">
                              {t('cisHardeningCisRemediationsTab.detail.approvedBy')}
                            </dt>
                            <dd>{rem.approverName ?? (rem.approvedBy ? t('cisHardeningCisRemediationsTab.detail.unknownApprover') : '-')}</dd>
                          </div>
                          <div>
                            <dt className="text-xs font-semibold uppercase text-muted-foreground">
                              {t('cisHardeningCisRemediationsTab.detail.approvedAt')}
                            </dt>
                            <dd>{rem.approvedAt ? new Date(rem.approvedAt).toLocaleString() : '-'}</dd>
                          </div>
                          {rem.approvalNote && (
                            <div className="sm:col-span-2">
                              <dt className="text-xs font-semibold uppercase text-muted-foreground">
                                {t('cisHardeningCisRemediationsTab.detail.note')}
                              </dt>
                              <dd>{rem.approvalNote}</dd>
                            </div>
                          )}
                          <div>
                            <dt className="text-xs font-semibold uppercase text-muted-foreground">
                              {t('cisHardeningCisRemediationsTab.detail.beforeState')}
                            </dt>
                            <dd>
                              <pre className="overflow-x-auto rounded-md border bg-card p-2 text-xs">{rem.beforeState ? JSON.stringify(rem.beforeState, null, 2) : '-'}</pre>
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs font-semibold uppercase text-muted-foreground">
                              {t('cisHardeningCisRemediationsTab.detail.afterState')}
                            </dt>
                            <dd>
                              <pre className="overflow-x-auto rounded-md border bg-card p-2 text-xs">{rem.afterState ? JSON.stringify(rem.afterState, null, 2) : '-'}</pre>
                            </dd>
                          </div>
                          <div className="sm:col-span-2">
                            <dt className="text-xs font-semibold uppercase text-muted-foreground">
                              {t('cisHardeningCisRemediationsTab.detail.rollbackHint')}
                            </dt>
                            <dd>{rem.rollbackHint ?? '-'}</dd>
                          </div>
                        </dl>
                      ) : (
                        <p className="text-center text-sm text-muted-foreground">
                          {t('cisHardeningCisRemediationsTab.detail.noEvidence')}
                        </p>
                      )}
                    </td>
                  </tr>
                )}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={decision !== null}
        onClose={closeDecision}
        onConfirm={() => void handleDecide()}
        variant={decision?.approved ? 'warning' : 'destructive'}
        isLoading={deciding}
        confirmTestId="cis-remediation-decision-confirm"
        title={decision?.approved
          ? t('cisHardeningCisRemediationsTab.decision.approveTitle')
          : t('cisHardeningCisRemediationsTab.decision.rejectTitle')}
        message={!decision
          ? ''
          : decision.approved
            ? t('cisHardeningCisRemediationsTab.decision.approveMessage', {
                checkId: decision.remediation.checkId,
                device: deviceLabel(decision.remediation),
              })
            : t('cisHardeningCisRemediationsTab.decision.rejectMessage', {
                checkId: decision.remediation.checkId,
                device: deviceLabel(decision.remediation),
              })}
        confirmLabel={decision?.approved
          ? t('cisHardeningCisRemediationsTab.decision.approve')
          : t('cisHardeningCisRemediationsTab.decision.reject')}
      >
        <label className="block text-sm font-medium" htmlFor="cis-remediation-decision-note">
          {t('cisHardeningCisRemediationsTab.decision.noteLabel')}
        </label>
        <textarea
          id="cis-remediation-decision-note"
          data-testid="cis-remediation-decision-note"
          value={decisionNote}
          onChange={(e) => setDecisionNote(e.target.value)}
          maxLength={1000}
          rows={3}
          className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
      </ConfirmDialog>
    </div>
  );
}
