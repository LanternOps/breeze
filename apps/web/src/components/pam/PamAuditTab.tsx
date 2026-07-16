import '@/lib/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, ScrollText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { escapeCsvCell } from '@/lib/csvExport';
import {
  type ElevationFlowType,
  type ElevationRequest,
  type ElevationStatus,
  FLOW_LABELS,
  type Pagination,
  STATUS_LABELS,
  decisionAttribution,
  requestTarget,
} from './types';
import {
  EmptyState,
  ErrorAlert,
  FlowCell,
  Pager,
  RiskTierBadge,
  StatusBadge,
  TableSkeleton,
  btnGhostClass,
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

/** Hard cap on rows fetched for CSV export (10 pages of 100). */
const EXPORT_MAX_ROWS = 1000;

/** Neutralize spreadsheet-formula injection then RFC-4180-quote an audit cell. */
function csvEscape(value: unknown): string {
  return escapeCsvCell(value === null || value === undefined ? '' : String(value));
}

export function buildAuditCsv(rows: ElevationRequest[]): string {
  const header = [
    'id',
    'requestedAt',
    'status',
    'flowType',
    'device',
    'site',
    'user',
    'target',
    'signer',
    'hash',
    'toolName',
    'riskTier',
    'reason',
    'denialReason',
    'revokedReason',
    'approvedBy',
    'deniedBy',
    'revokedBy',
    'approvedAt',
    'expiresAt',
    'decisionSource',
    'matchedPolicyName',
    'pamRuleName',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.requestedAt,
        r.status,
        r.flowType,
        r.deviceHostname ?? r.deviceId,
        r.siteName ?? '',
        r.subjectUsername,
        requestTarget(r),
        r.targetExecutableSigner ?? '',
        r.targetExecutableHash ?? '',
        r.toolName ?? '',
        r.riskTier ?? '',
        r.reason ?? '',
        r.denialReason ?? '',
        r.revokedReason ?? '',
        // Prefer the joined display name; fall back to the full user id
        // (audit-grade — no truncation in exports).
        r.approvedByName ?? r.approvedByUserId ?? '',
        r.deniedByName ?? r.deniedByUserId ?? '',
        r.revokedByName ?? r.revokedByUserId ?? '',
        r.approvedAt ?? '',
        r.expiresAt ?? '',
        r.decisionSource ?? '',
        r.matchedPolicyName ?? '',
        r.pamRuleName ?? '',
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return lines.join('\n');
}

export default function PamAuditTab({ liveTick }: { liveTick: number }) {
  const { t } = useTranslation('security');
  const [rows, setRows] = useState<ElevationRequest[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0 });
  const [status, setStatus] = useState<ElevationStatus | ''>('');
  const [flowType, setFlowType] = useState<ElevationFlowType | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildParams = useCallback(
    (pageNum: number, limit: number) => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (flowType) params.set('flowType', flowType);
      if (from) params.set('from', new Date(from).toISOString());
      if (to) params.set('to', new Date(to).toISOString());
      params.set('page', String(pageNum));
      params.set('limit', String(limit));
      return params;
    },
    [status, flowType, from, to],
  );

  const fetchAudit = useCallback(
    async (signal?: AbortSignal, opts: { silent?: boolean } = {}) => {
      if (!opts.silent) setLoading(true);
      setError(null);
      try {
        const res = await fetchWithAuth(`/pam/elevation-requests?${buildParams(page, 50).toString()}`, {
          signal,
        });
        if (!res.ok) {
          if (res.status === 401) {
            void navigateTo('/login', { replace: true });
            return;
          }
          throw new Error(
            t('pamPamAuditTab.errors.loadWithStatus', {
              defaultValue: 'Failed to load audit history (HTTP {{status}})',
              status: res.status,
            }),
          );
        }
        const body = await res.json();
        setRows((body.requests ?? []) as ElevationRequest[]);
        setPagination((body.pagination ?? { page: 1, limit: 50, total: 0 }) as Pagination);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(
          err instanceof Error
            ? err.message
            : t('pamPamAuditTab.errors.load', { defaultValue: 'Failed to load audit history' }),
        );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [buildParams, page, t],
  );

  // liveTick-driven refreshes are silent (rows stay rendered, same contract as
  // the other tabs); filter/page changes (a new fetchAudit identity) show the
  // loading state as before.
  const lastTickRef = useRef(liveTick);
  useEffect(() => {
    const silent = liveTick !== lastTickRef.current;
    lastTickRef.current = liveTick;
    const controller = new AbortController();
    void fetchAudit(controller.signal, { silent });
    return () => controller.abort();
  }, [fetchAudit, liveTick]);

  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    setError(null);
    try {
      const all: ElevationRequest[] = [];
      let exportPage = 1;
      for (;;) {
        const res = await fetchWithAuth(
          `/pam/elevation-requests?${buildParams(exportPage, 100).toString()}`,
        );
        if (!res.ok) {
          throw new Error(
            t('pamPamAuditTab.errors.exportWithStatus', {
              defaultValue: 'Export failed (HTTP {{status}})',
              status: res.status,
            }),
          );
        }
        const body = await res.json();
        const batch = (body.requests ?? []) as ElevationRequest[];
        all.push(...batch);
        const total = Number(body.pagination?.total ?? all.length);
        if (batch.length === 0 || all.length >= Math.min(total, EXPORT_MAX_ROWS)) break;
        exportPage += 1;
      }
      const csv = buildAuditCsv(all.slice(0, EXPORT_MAX_ROWS));
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `pam-audit-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('pamPamAuditTab.errors.export', { defaultValue: 'Export failed' }),
      );
    } finally {
      setExporting(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.limit));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="font-medium text-muted-foreground">
            {t('pamPamAuditTab.filters.status', { defaultValue: 'Status' })}
          </span>
          <select
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value as ElevationStatus | '');
            }}
            data-testid="pam-audit-filter-status"
            className={selectClass}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s || 'all'} value={s}>
                {s ? STATUS_LABELS[s] : t('pamPamAuditTab.filters.allStatuses', { defaultValue: 'All statuses' })}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="font-medium text-muted-foreground">
            {t('pamPamAuditTab.filters.flow', { defaultValue: 'Flow' })}
          </span>
          <select
            value={flowType}
            onChange={(e) => {
              setPage(1);
              setFlowType(e.target.value as ElevationFlowType | '');
            }}
            data-testid="pam-audit-filter-flow"
            className={selectClass}
          >
            {FLOW_OPTIONS.map((f) => (
              <option key={f || 'all'} value={f}>
                {f ? FLOW_LABELS[f] : t('pamPamAuditTab.filters.allFlows', { defaultValue: 'All flows' })}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="font-medium text-muted-foreground">
            {t('pamPamAuditTab.filters.from', { defaultValue: 'From' })}
          </span>
          <input
            type="date"
            value={from}
            onChange={(e) => {
              setPage(1);
              setFrom(e.target.value);
            }}
            data-testid="pam-audit-filter-from"
            className={selectClass}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="font-medium text-muted-foreground">
            {t('pamPamAuditTab.filters.to', { defaultValue: 'To' })}
          </span>
          <input
            type="date"
            value={to}
            onChange={(e) => {
              setPage(1);
              setTo(e.target.value);
            }}
            data-testid="pam-audit-filter-to"
            className={selectClass}
          />
        </label>
        <button
          type="button"
          onClick={() => void exportCsv()}
          disabled={exporting || pagination.total === 0}
          data-testid="pam-audit-export-btn"
          className={`ml-auto ${btnGhostClass}`}
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          {exporting
            ? t('pamPamAuditTab.actions.exporting', { defaultValue: 'Exporting…' })
            : t('pamPamAuditTab.actions.exportCsv', { defaultValue: 'Export CSV' })}
        </button>
      </div>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      {loading ? (
        <TableSkeleton label={t('pamPamAuditTab.loading', { defaultValue: 'Loading audit history…' })} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title={t('pamPamAuditTab.empty.title', { defaultValue: 'No matching history' })}
          description={t('pamPamAuditTab.empty.description', {
            defaultValue: 'Adjust the filters to see elevation request history.',
          })}
        />
      ) : (
        <div className={tableWrapClass}>
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr className={theadRowClass}>
                <th className={thClass}>{t('pamPamAuditTab.table.requested', { defaultValue: 'Requested' })}</th>
                <th className={thClass}>{t('pamPamAuditTab.table.device', { defaultValue: 'Device' })}</th>
                <th className={thClass}>{t('pamPamAuditTab.table.user', { defaultValue: 'User' })}</th>
                <th className={thClass}>{t('pamPamAuditTab.table.target', { defaultValue: 'Target' })}</th>
                <th className={thClass}>{t('pamPamAuditTab.table.flow', { defaultValue: 'Flow' })}</th>
                <th className={thClass}>{t('pamPamAuditTab.table.status', { defaultValue: 'Status' })}</th>
              </tr>
            </thead>
            <tbody className={tbodyClass}>
              {rows.map((r) => {
                const attribution = decisionAttribution(r);
                return (
                <tr key={r.id} className={rowClass} data-testid={`pam-audit-row-${r.id}`}>
                  <td className={`${tdClass} whitespace-nowrap tabular-nums text-muted-foreground`}>
                    {formatDateTime(r.requestedAt)}
                  </td>
                  <td className={`${tdClass} font-medium`}>{r.deviceHostname ?? r.deviceId}</td>
                  <td className={tdClass}>{r.subjectUsername}</td>
                  <td className={`${tdClass} max-w-[280px]`}>
                    <div className="flex items-center gap-1.5">
                      <span className="truncate" title={requestTarget(r)}>
                        {requestTarget(r)}
                      </span>
                      {r.flowType === 'ai_tool_action' && r.riskTier != null && (
                        <RiskTierBadge
                          tier={r.riskTier}
                          testId={`pam-audit-risk-tier-${r.id}`}
                          title={t('pamPamAuditTab.table.riskTierTitle', {
                            defaultValue: 'Risk tier {{tier}}',
                            tier: r.riskTier,
                          })}
                        />
                      )}
                    </div>
                  </td>
                  <td className={`${tdClass} whitespace-nowrap`}>
                    <FlowCell flowType={r.flowType} />
                  </td>
                  <td className={tdClass}>
                    <StatusBadge status={r.status} />
                    {attribution && (
                      <div
                        className="mt-0.5 max-w-[180px] truncate text-xs text-muted-foreground"
                        data-testid={`pam-audit-decided-by-${r.id}`}
                        title={attribution}
                      >
                        {attribution}
                      </div>
                    )}
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
        prevLabel={t('pamPamAuditTab.pagination.previous', { defaultValue: 'Previous' })}
        nextLabel={t('common:actions.next', { defaultValue: 'Next' })}
        pageLabel={t('pamPamAuditTab.pagination.pageOf', {
          defaultValue: 'Page {{page}} of {{totalPages}}',
          page: pagination.page,
          totalPages,
        })}
      />
    </div>
  );
}
