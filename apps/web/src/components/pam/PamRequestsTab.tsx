import { useCallback, useEffect, useState } from 'react';
import { Inbox } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import PamRespondModal from './PamRespondModal';
import PamRevokeModal from './PamRevokeModal';
import {
  ACTIVE_STATUSES,
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

export default function PamRequestsTab({ liveTick }: { liveTick: number }) {
  const [requests, setRequests] = useState<ElevationRequest[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0 });
  const [status, setStatus] = useState<ElevationStatus | ''>('pending');
  const [flowType, setFlowType] = useState<ElevationFlowType | ''>('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [responding, setResponding] = useState<ElevationRequest | null>(null);
  const [revoking, setRevoking] = useState<ElevationRequest | null>(null);

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
          throw new Error(`Failed to load requests (HTTP ${res.status})`);
        }
        const body = await res.json();
        setRequests((body.requests ?? []) as ElevationRequest[]);
        setPagination((body.pagination ?? { page: 1, limit: 50, total: 0 }) as Pagination);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Failed to load requests');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [status, flowType, page],
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
          <span className="text-muted-foreground">Status</span>
          <select
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value as ElevationStatus | '');
            }}
            data-testid="pam-filter-status"
            className="rounded-md border bg-background px-2 py-1.5 text-sm"
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
            data-testid="pam-filter-flow"
            className="rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            {FLOW_OPTIONS.map((f) => (
              <option key={f || 'all'} value={f}>
                {f ? FLOW_LABELS[f] : 'All flows'}
              </option>
            ))}
          </select>
        </label>
        <span className="ml-auto text-xs text-muted-foreground">
          {pagination.total} request{pagination.total === 1 ? '' : 's'}
        </span>
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
          Loading requests…
        </div>
      ) : requests.length === 0 ? (
        <div className="rounded-md border border-dashed bg-card px-4 py-8 text-center">
          <Inbox className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">No elevation requests</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Requests matching the current filters will appear here.
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
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => {
                const canRespond = r.status === 'pending';
                const canRevoke = (ACTIVE_STATUSES as readonly string[]).includes(r.status);
                return (
                  <tr key={r.id} className="border-b align-top last:border-0" data-testid={`pam-request-row-${r.id}`}>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {new Date(r.requestedAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">{r.deviceHostname ?? r.deviceId}</td>
                    <td className="px-3 py-2">{r.subjectUsername}</td>
                    <td className="max-w-[260px] px-3 py-2">
                      <div className="truncate" title={requestTarget(r)}>
                        {requestTarget(r)}
                      </div>
                      {r.reason && (
                        <div className="mt-0.5 truncate text-xs text-muted-foreground" title={r.reason}>
                          {r.reason}
                        </div>
                      )}
                      {r.targetExecutableSigner && (
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          Signer: {r.targetExecutableSigner}
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{FLOW_LABELS[r.flowType]}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(r.status)}`}
                      >
                        {STATUS_LABELS[r.status]}
                      </span>
                      {r.denialReason && (
                        <div className="mt-0.5 max-w-[180px] truncate text-xs text-muted-foreground" title={r.denialReason}>
                          {r.denialReason}
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {canRespond && (
                        <button
                          type="button"
                          onClick={() => setResponding(r)}
                          data-testid={`pam-respond-btn-${r.id}`}
                          className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent"
                        >
                          Respond
                        </button>
                      )}
                      {canRevoke && (
                        <button
                          type="button"
                          onClick={() => setRevoking(r)}
                          data-testid={`pam-revoke-btn-${r.id}`}
                          className="rounded-md border border-destructive/40 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
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

      {responding && (
        <PamRespondModal
          request={responding}
          onClose={() => setResponding(null)}
          onActioned={() => {
            setResponding(null);
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
