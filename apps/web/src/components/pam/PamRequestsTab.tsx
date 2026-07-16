import '@/lib/i18n';
import { useCallback, useEffect, useState } from 'react';
import { Inbox } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { formatDateTime } from '@/lib/dateTimeFormat';
import PamRespondModal from './PamRespondModal';
import PamRevokeModal from './PamRevokeModal';
import PamRuleModal from './PamRuleModal';
import {
  ACTIVE_STATUSES,
  type ElevationFlowType,
  type ElevationRequest,
  type ElevationStatus,
  FLOW_LABELS,
  type Pagination,
  STATUS_LABELS,
  decisionAttribution,
  requestTarget,
  requestToRuleDraft,
} from './types';
import {
  EmptyState,
  ErrorAlert,
  FlowCell,
  Pager,
  RiskTierBadge,
  StatusBadge,
  TableSkeleton,
  btnOutlineClass,
  btnOutlineDestructiveClass,
  selectClass,
  tableClass,
  tableWrapClass,
  tbodyClass,
  tdClass,
  thClass,
  theadClass,
  theadRowClass,
  rowClass,
} from './ui';

const STATUS_OPTIONS: Array<ElevationStatus | ''> = [
  '',
  'pending',
  'approved',
  'auto_approved',
  'actuating',
  'denied',
  'expired',
  'revoked',
];
const FLOW_OPTIONS: Array<ElevationFlowType | ''> = ['', 'uac_intercept', 'tech_jit_admin', 'ai_tool_action'];

export default function PamRequestsTab({ liveTick }: { liveTick: number }) {
  const { t } = useTranslation('security');
  const [requests, setRequests] = useState<ElevationRequest[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0 });
  const [status, setStatus] = useState<ElevationStatus | ''>('pending');
  const [flowType, setFlowType] = useState<ElevationFlowType | ''>('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [responding, setResponding] = useState<ElevationRequest | null>(null);
  const [revoking, setRevoking] = useState<ElevationRequest | null>(null);
  const [ruleDraft, setRuleDraft] = useState<ElevationRequest | null>(null);

  const fetchRequests = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (status) params.set('status', status);
        if (flowType) params.set('flowType', flowType);
        params.set('page', String(page));
        params.set('limit', '50');
        const res = await fetchWithAuth(`/pam/elevation-requests?${params.toString()}`, { signal });
        if (!res.ok) {
          if (res.status === 401) {
            void navigateTo('/login', { replace: true });
            return;
          }
          throw new Error(
            t('pamPamRequestsTab.errors.loadWithStatus', {
              defaultValue: 'Failed to load requests (HTTP {{status}})',
              status: res.status,
            }),
          );
        }
        const body = await res.json();
        setRequests((body.requests ?? []) as ElevationRequest[]);
        setPagination((body.pagination ?? { page: 1, limit: 50, total: 0 }) as Pagination);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(
          err instanceof Error
            ? err.message
            : t('pamPamRequestsTab.errors.load', { defaultValue: 'Failed to load requests' }),
        );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [status, flowType, page, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetchRequests(controller.signal);
    return () => controller.abort();
  }, [fetchRequests, liveTick]);

  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.limit));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="font-medium text-muted-foreground">
            {t('pamPamRequestsTab.filters.status', { defaultValue: 'Status' })}
          </span>
          <select
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value as ElevationStatus | '');
            }}
            data-testid="pam-filter-status"
            className={selectClass}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s || 'all'} value={s}>
                {s ? STATUS_LABELS[s] : t('pamPamRequestsTab.filters.allStatuses', { defaultValue: 'All statuses' })}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="font-medium text-muted-foreground">
            {t('pamPamRequestsTab.filters.flow', { defaultValue: 'Flow' })}
          </span>
          <select
            value={flowType}
            onChange={(e) => {
              setPage(1);
              setFlowType(e.target.value as ElevationFlowType | '');
            }}
            data-testid="pam-filter-flow"
            className={selectClass}
          >
            {FLOW_OPTIONS.map((f) => (
              <option key={f || 'all'} value={f}>
                {f ? FLOW_LABELS[f] : t('pamPamRequestsTab.filters.allFlows', { defaultValue: 'All flows' })}
              </option>
            ))}
          </select>
        </label>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {t('pamPamRequestsTab.summary.requestCount', {
            defaultValue: '{{count}} request',
            defaultValue_plural: '{{count}} requests',
            count: pagination.total,
          })}
        </span>
      </div>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      {loading ? (
        <TableSkeleton label={t('pamPamRequestsTab.loading', { defaultValue: 'Loading requests…' })} />
      ) : requests.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={t('pamPamRequestsTab.empty.title', { defaultValue: 'No elevation requests' })}
          description={
            status === 'pending'
              ? t('pamPamRequestsTab.empty.pendingDescription', {
                  defaultValue:
                    'Nothing waiting on you. New UAC prompts, JIT admin requests, and AI tool actions queue here.',
                })
              : t('pamPamRequestsTab.empty.filteredDescription', {
                  defaultValue: 'Requests matching the current filters will appear here.',
                })
          }
        >
          <p className="mx-auto mt-3 max-w-md text-xs text-muted-foreground">
            {t('pamPamRequestsTab.empty.policyPrefix', {
              defaultValue: 'Not seeing expected requests? UAC capture is controlled per device by',
            })}{' '}
            <a
              href="/configuration-policies"
              className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
            >
              {t('pamPamRequestsTab.empty.policyLink', {
                defaultValue: 'Configuration Policies → Privileged Access',
              })}
            </a>.
          </p>
        </EmptyState>
      ) : (
        <div className={tableWrapClass}>
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr className={theadRowClass}>
                <th className={thClass}>{t('pamPamRequestsTab.table.requested', { defaultValue: 'Requested' })}</th>
                <th className={thClass}>{t('pamPamRequestsTab.table.device', { defaultValue: 'Device' })}</th>
                <th className={thClass}>{t('pamPamRequestsTab.table.user', { defaultValue: 'User' })}</th>
                <th className={thClass}>{t('pamPamRequestsTab.table.target', { defaultValue: 'Target' })}</th>
                <th className={thClass}>{t('pamPamRequestsTab.table.flow', { defaultValue: 'Flow' })}</th>
                <th className={thClass}>{t('pamPamRequestsTab.table.status', { defaultValue: 'Status' })}</th>
                <th className={thClass} />
              </tr>
            </thead>
            <tbody className={tbodyClass}>
              {requests.map((r) => {
                const canRespond = r.status === 'pending';
                const canRevoke = (ACTIVE_STATUSES as readonly string[]).includes(r.status);
                const attribution = decisionAttribution(r);
                // Policy/rule denials already name their source — the raw
                // "Blocked by…" string is then redundant.
                const showDenialReason =
                  r.decisionSource === 'human' || r.decisionSource == null;
                return (
                  <tr key={r.id} className={`${rowClass} align-top`} data-testid={`pam-request-row-${r.id}`}>
                    <td className={`${tdClass} whitespace-nowrap tabular-nums text-muted-foreground`}>
                      {formatDateTime(r.requestedAt)}
                    </td>
                    <td className={`${tdClass} font-medium`}>{r.deviceHostname ?? r.deviceId}</td>
                    <td className={tdClass}>{r.subjectUsername}</td>
                    <td className={`${tdClass} max-w-[260px]`}>
                      <div className="flex items-center gap-1.5">
                        <span className="truncate" title={requestTarget(r)}>
                          {requestTarget(r)}
                        </span>
                        {r.flowType === 'ai_tool_action' && r.riskTier != null && (
                          <RiskTierBadge
                            tier={r.riskTier}
                            testId={`pam-risk-tier-${r.id}`}
                            title={t('pamPamRequestsTab.table.riskTierTitle', {
                              defaultValue: 'Risk tier {{tier}}',
                              tier: r.riskTier,
                            })}
                          />
                        )}
                      </div>
                      {r.reason && (
                        <div className="mt-0.5 truncate text-xs text-muted-foreground" title={r.reason}>
                          {r.reason}
                        </div>
                      )}
                      {r.targetExecutableSigner && (
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          {t('pamPamRequestsTab.table.signer', {
                            defaultValue: 'Signer: {{signer}}',
                            signer: r.targetExecutableSigner,
                          })}
                        </div>
                      )}
                    </td>
                    <td className={`${tdClass} whitespace-nowrap`}>
                      <FlowCell flowType={r.flowType} />
                    </td>
                    <td className={tdClass}>
                      <StatusBadge status={r.status} />
                      {attribution && (
                        <div
                          className="mt-0.5 max-w-[180px] truncate text-xs text-muted-foreground"
                          data-testid={`pam-decided-by-${r.id}`}
                          title={attribution}
                        >
                          {attribution}
                        </div>
                      )}
                      {showDenialReason && r.denialReason && (
                        <div className="mt-0.5 max-w-[180px] truncate text-xs text-muted-foreground" title={r.denialReason}>
                          {r.denialReason}
                        </div>
                      )}
                    </td>
                    <td className={`${tdClass} whitespace-nowrap text-right`}>
                      <div className="inline-flex items-center gap-1.5">
                        {canRespond && (
                          <button
                            type="button"
                            onClick={() => setResponding(r)}
                            data-testid={`pam-respond-btn-${r.id}`}
                            className={btnOutlineClass}
                          >
                            {t('pamPamRequestsTab.actions.respond', { defaultValue: 'Respond' })}
                          </button>
                        )}
                        {canRevoke && (
                          <button
                            type="button"
                            onClick={() => setRevoking(r)}
                            data-testid={`pam-revoke-btn-${r.id}`}
                            className={btnOutlineDestructiveClass}
                          >
                            {t('pamPamRequestsTab.actions.revoke', { defaultValue: 'Revoke' })}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setRuleDraft(r)}
                          data-testid={`pam-create-rule-btn-${r.id}`}
                          title={t('pamPamRequestsTab.actions.ruleTitle', {
                            defaultValue: 'Create a PAM rule pre-filled from this request',
                          })}
                          className={btnOutlineClass}
                        >
                          {t('pamPamRequestsTab.actions.rule', { defaultValue: 'Rule…' })}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Pager
        page={page}
        totalPages={totalPages}
        onPrev={() => setPage((p) => p - 1)}
        onNext={() => setPage((p) => p + 1)}
        prevLabel={t('pamPamRequestsTab.pagination.previous', { defaultValue: 'Previous' })}
        nextLabel={t('common:actions.next', { defaultValue: 'Next' })}
        pageLabel={t('pamPamRequestsTab.pagination.pageOf', {
          defaultValue: 'Page {{page}} of {{totalPages}}',
          page: pagination.page,
          totalPages,
        })}
      />

      {responding && (
        <PamRespondModal
          request={responding}
          onClose={() => setResponding(null)}
          onActioned={() => {
            setResponding(null);
            void fetchRequests();
          }}
          onCreateRule={() => {
            setRuleDraft(responding);
            setResponding(null);
          }}
        />
      )}
      {ruleDraft && (
        <PamRuleModal
          rule={null}
          initial={requestToRuleDraft(ruleDraft)}
          onClose={() => setRuleDraft(null)}
          onSaved={() => {
            setRuleDraft(null);
            void fetchRequests();
          }}
        />
      )}
      {revoking && (
        <PamRevokeModal
          request={revoking}
          onClose={() => setRevoking(null)}
          onActioned={() => {
            setRevoking(null);
            void fetchRequests();
          }}
        />
      )}
    </div>
  );
}
