import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw, ShieldAlert, UserX } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { formatAbsolute, formatRelative } from '../account/relativeTime';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';

interface AdminDeletionRequest {
  requestId: string;
  status: 'pending' | 'processing' | 'completed' | 'cancelled';
  requestedAt: string;
  processBy: string;
  processedAt: string | null;
  processedBy: string | null;
  reason: string | null;
  adminNote: string | null;
  orgId: string | null;
  user: {
    id: string;
    email: string;
    name: string;
    joinedAt: string | null;
  } | null;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'unauthorized' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; requests: AdminDeletionRequest[]; limit: number; offset: number };

const PAGE_SIZE = 50;

export default function AccountDeletionRequestsList() {
  const { t } = useTranslation('admin');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [offset, setOffset] = useState(0);
  const [statusFilter, setStatusFilter] = useState<'pending' | 'processing' | 'cancelled' | 'completed'>('pending');
  const statusLabels: Record<typeof statusFilter, string> = {
    pending: t('admin.accountDeletionRequestsList.status.pending'),
    processing: t('admin.accountDeletionRequestsList.status.processing'),
    cancelled: t('admin.accountDeletionRequestsList.status.cancelled'),
    completed: t('admin.accountDeletionRequestsList.status.completed'),
  };

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const url = `/admin/account-deletion-requests?status=${statusFilter}&limit=${PAGE_SIZE}&offset=${offset}`;
      const res = await fetchWithAuth(url);
      if (res.status === 403) {
        setState({ kind: 'unauthorized' });
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setState({ kind: 'error', message: body.error ?? t('admin.accountDeletionRequestsList.errors.requestFailed', { status: res.status }) });
        return;
      }
      const body = (await res.json()) as { requests: AdminDeletionRequest[]; limit: number; offset: number };
      setState({ kind: 'ready', requests: body.requests ?? [], limit: body.limit, offset: body.offset });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : t('admin.accountDeletionRequestsList.errors.network') });
    }
  }, [statusFilter, offset, t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('admin.accountDeletionRequestsList.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('admin.accountDeletionRequestsList.description')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => {
              setOffset(0);
              setStatusFilter(e.target.value as typeof statusFilter);
            }}
            className="h-10 rounded-md border bg-background px-3 text-sm"
            aria-label={t('admin.accountDeletionRequestsList.filterLabel')}
          >
            <option value="pending">{statusLabels.pending}</option>
            <option value="processing">{statusLabels.processing}</option>
            <option value="cancelled">{statusLabels.cancelled}</option>
            <option value="completed">{statusLabels.completed}</option>
          </select>
          <button
            type="button"
            onClick={() => void load()}
            disabled={state.kind === 'loading'}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${state.kind === 'loading' ? 'animate-spin' : ''}`} />
            {t('admin.accountDeletionRequestsList.refresh')}
          </button>
        </div>
      </div>

      {state.kind === 'loading' && (
        <div className="flex min-h-[40vh] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
        </div>
      )}

      {state.kind === 'unauthorized' && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6">
          <h2 className="font-semibold text-destructive">{t('admin.accountDeletionRequestsList.unauthorized.title')}</h2>
          <p className="mt-1 text-sm text-destructive">
            {t('admin.accountDeletionRequestsList.unauthorized.prefix')} <code>users:write</code>{' '}
            {t('admin.accountDeletionRequestsList.unauthorized.suffix')}
          </p>
        </div>
      )}

      {state.kind === 'error' && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
          <div className="flex-1 space-y-2">
            <p>{state.message}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-md border border-destructive/40 px-3 py-1 text-xs font-medium hover:bg-destructive/5"
            >
              {t('admin.accountDeletionRequestsList.retry')}
            </button>
          </div>
        </div>
      )}

      {state.kind === 'ready' && state.requests.length === 0 && (
        <div className="rounded-lg border border-dashed bg-muted/30 p-8 text-center">
          <UserX className="mx-auto h-10 w-10 text-muted-foreground/40" aria-hidden />
          <h2 className="mt-4 text-base font-semibold">
            {t('admin.accountDeletionRequestsList.empty.title', {
              status: statusLabels[statusFilter],
            })}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('admin.accountDeletionRequestsList.empty.description')}
          </p>
        </div>
      )}

      {state.kind === 'ready' && state.requests.length > 0 && (
        <>
          <div className="overflow-hidden rounded-lg border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/40">
                <tr className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">{t('admin.accountDeletionRequestsList.table.user')}</th>
                  <th className="px-4 py-3">{t('admin.accountDeletionRequestsList.table.requested')}</th>
                  <th className="px-4 py-3">{t('admin.accountDeletionRequestsList.table.processBy')}</th>
                  <th className="px-4 py-3">{t('admin.accountDeletionRequestsList.table.reason')}</th>
                  <th className="px-4 py-3">{t('admin.accountDeletionRequestsList.table.status')}</th>
                  <th className="px-4 py-3 text-right">{t('admin.accountDeletionRequestsList.table.action')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {state.requests.map((req) => (
                  <tr key={req.requestId}>
                    <td className="px-4 py-3">
                      <div className="font-medium">{req.user?.name ?? '—'}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{req.user?.email ?? '—'}</div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground" title={formatAbsolute(req.requestedAt)}>
                      {formatRelative(req.requestedAt)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground" title={formatAbsolute(req.processBy)}>
                      {formatRelative(req.processBy)}
                    </td>
                    <td className="px-4 py-3 max-w-xs">
                      <div className="line-clamp-2 text-muted-foreground">
                        {req.reason || <span className="italic">{t('admin.accountDeletionRequestsList.noReasonGiven')}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={req.status} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <a
                        href={`/admin/account-deletion-requests/${req.requestId}`}
                        className="inline-flex h-9 items-center gap-1 rounded-md border px-3 text-sm font-medium transition hover:bg-muted"
                      >
                        {t('admin.accountDeletionRequestsList.review')}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            offset={state.offset}
            limit={state.limit}
            count={state.requests.length}
            onPrev={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            onNext={() => setOffset(offset + PAGE_SIZE)}
          />
        </>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: AdminDeletionRequest['status'] }) {
  const { t } = useTranslation('admin');
  const labels: Record<AdminDeletionRequest['status'], string> = {
    pending: t('admin.accountDeletionRequestsList.status.pending'),
    processing: t('admin.accountDeletionRequestsList.status.processing'),
    completed: t('admin.accountDeletionRequestsList.status.completed'),
    cancelled: t('admin.accountDeletionRequestsList.status.cancelled'),
  };
  const styles: Record<AdminDeletionRequest['status'], string> = {
    pending: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
    processing: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
    completed: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    cancelled: 'bg-muted text-muted-foreground',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

function Pagination({
  offset,
  limit,
  count,
  onPrev,
  onNext,
}: {
  offset: number;
  limit: number;
  count: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { t } = useTranslation('admin');
  const showingFrom = count === 0 ? 0 : offset + 1;
  const showingTo = offset + count;
  const atStart = offset === 0;
  const atEnd = count < limit;
  if (atStart && atEnd) return null;
  return (
    <div className="flex items-center justify-between text-sm text-muted-foreground">
      <span>{t('admin.accountDeletionRequestsList.pagination.showing', { from: showingFrom, to: showingTo })}</span>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onPrev}
          disabled={atStart}
          className="h-9 rounded-md border px-3 font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('admin.accountDeletionRequestsList.pagination.previous')}
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={atEnd}
          className="h-9 rounded-md border px-3 font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('admin.accountDeletionRequestsList.pagination.next')}
        </button>
      </div>
    </div>
  );
}
