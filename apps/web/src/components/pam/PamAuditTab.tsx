import { useCallback, useEffect, useState } from 'react';
import { Download, ScrollText } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import {
  type ElevationFlowType,
  type ElevationRequest,
  type ElevationStatus,
  FLOW_LABELS,
  type Pagination,
  STATUS_LABELS,
  requestTarget,
  statusBadgeClass,
} from './types';

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

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
    'approvedAt',
    'expiresAt',
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
        r.approvedAt ?? '',
        r.expiresAt ?? '',
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return lines.join('\n');
}

export default function PamAuditTab() {
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
    async (signal?: AbortSignal) => {
      setLoading(true);
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
          throw new Error(`Failed to load audit history (HTTP ${res.status})`);
        }
        const body = await res.json();
        setRows((body.requests ?? []) as ElevationRequest[]);
        setPagination((body.pagination ?? { page: 1, limit: 50, total: 0 }) as Pagination);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Failed to load audit history');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [buildParams, page],
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetchAudit(controller.signal);
    return () => controller.abort();
  }, [fetchAudit]);

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
        if (!res.ok) throw new Error(`Export failed (HTTP ${res.status})`);
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
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.limit));
  const inputClass = 'rounded-md border bg-background px-2 py-1.5 text-sm';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Status</span>
          <select
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value as ElevationStatus | '');
            }}
            data-testid="pam-audit-filter-status"
            className={inputClass}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s || 'all'} value={s}>
                {s ? STATUS_LABELS[s] : 'All statuses'}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Flow</span>
          <select
            value={flowType}
            onChange={(e) => {
              setPage(1);
              setFlowType(e.target.value as ElevationFlowType | '');
            }}
            data-testid="pam-audit-filter-flow"
            className={inputClass}
          >
            {FLOW_OPTIONS.map((f) => (
              <option key={f || 'all'} value={f}>
                {f ? FLOW_LABELS[f] : 'All flows'}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">From</span>
          <input
            type="date"
            value={from}
            onChange={(e) => {
              setPage(1);
              setFrom(e.target.value);
            }}
            data-testid="pam-audit-filter-from"
            className={inputClass}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">To</span>
          <input
            type="date"
            value={to}
            onChange={(e) => {
              setPage(1);
              setTo(e.target.value);
            }}
            data-testid="pam-audit-filter-to"
            className={inputClass}
          />
        </label>
        <button
          type="button"
          onClick={() => void exportCsv()}
          disabled={exporting || pagination.total === 0}
          data-testid="pam-audit-export-btn"
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          <Download className="h-4 w-4" />
          {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 rounded-md border bg-card px-4 py-6 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Loading audit history…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-dashed bg-card px-4 py-8 text-center">
          <ScrollText className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">No matching history</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Adjust the filters to see elevation request history.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Requested</th>
                <th className="px-3 py-2 font-medium">Device</th>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">Flow</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0" data-testid={`pam-audit-row-${r.id}`}>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {new Date(r.requestedAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">{r.deviceHostname ?? r.deviceId}</td>
                  <td className="px-3 py-2">{r.subjectUsername}</td>
                  <td className="max-w-[280px] px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate" title={requestTarget(r)}>
                        {requestTarget(r)}
                      </span>
                      {r.flowType === 'ai_tool_action' && r.riskTier != null && (
                        <span
                          data-testid={`pam-audit-risk-tier-${r.id}`}
                          title={`Risk tier ${r.riskTier}`}
                          className={`inline-flex shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold ${
                            r.riskTier >= 3
                              ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                              : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                          }`}
                        >
                          T{r.riskTier}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{FLOW_LABELS[r.flowType]}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(r.status)}`}
                    >
                      {STATUS_LABELS[r.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="rounded-md border px-2.5 py-1 text-xs disabled:opacity-50"
          >
            Previous
          </button>
          <span className="text-xs text-muted-foreground">
            Page {pagination.page} of {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-md border px-2.5 py-1 text-xs disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
