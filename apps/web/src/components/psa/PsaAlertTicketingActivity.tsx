import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, handleActionError, runAction } from '../../lib/runAction';

type FailureState = 'failed' | 'skipped_no_company' | 'needs_attention';
type Mapping = {
  id: string;
  alertId: string | null;
  createState: FailureState;
  lastError: string | null;
  createAnywayUsed?: boolean;
};
type Activity = {
  data: Mapping[];
  counts: Record<string, number>;
  pagination: { total: number; page: number; limit: number };
};
const PREFIX = 'longTail.psa.PsaAlertTicketingActivity';
const buttonClass = 'rounded-md border px-3 py-2 text-sm hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

export default function PsaAlertTicketingActivity({ connectionId, canManage }: { connectionId: string; canManage: boolean }) {
  const { t } = useTranslation('common');
  const [activity, setActivity] = useState<Activity | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmCreate, setConfirmCreate] = useState<string | null>(null);
  const generation = useRef(0);
  const mutationPending = useRef(false);

  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setLoadFailed(false);
    try {
      const query = new URLSearchParams({ connectionId, createState: 'failed,skipped_no_company,needs_attention', includeCounts: 'true', page: String(page), limit: '20' });
      const response = await fetchWithAuth(`/psa/tickets?${query}`);
      if (!response.ok) throw new Error('Activity unavailable');
      const result = await response.json() as Activity;
      if (!Array.isArray(result.data) || !result.counts || !result.pagination) throw new Error('Invalid activity');
      if (request === generation.current) {
        const lastPage = Math.max(1, Math.ceil(result.pagination.total / 20));
        // A human action can remove the last row on this page. Refetch the
        // nearest available page before hiding pagination or showing empty.
        if (page > lastPage) { setPage(lastPage); return; }
        setActivity(result);
      }
    } catch {
      if (request === generation.current) { setActivity(null); setLoadFailed(true); }
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [connectionId, page]);

  useEffect(() => {
    setActivity(null);
    setConfirmCreate(null);
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  const act = async (url: string, body?: object) => {
    if (!canManage || mutationPending.current) return;
    mutationPending.current = true;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(url, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) }),
        errorFallback: t(/* i18n-dynamic */ `${PREFIX}.actionFailed`),
        successMessage: t(/* i18n-dynamic */ `${PREFIX}.actionSucceeded`),
      });
      setConfirmCreate(null);
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      handleActionError(err, t(/* i18n-dynamic */ `${PREFIX}.actionFailed`));
      if (err instanceof ActionError && err.status === 409) { setConfirmCreate(null); await load(); }
    } finally {
      mutationPending.current = false;
      setBusy(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil((activity?.pagination.total ?? 0) / 20));
  return (
    <div className="mt-6 border-t pt-5" data-testid="psa-ticketing-activity" aria-busy={loading || busy}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{t(/* i18n-dynamic */ `${PREFIX}.title`)}</h3>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} disabled={loading || busy} onClick={() => void load()} data-testid="psa-ticketing-refresh">{t(/* i18n-dynamic */ `${PREFIX}.refresh`)}</button>
          {canManage && <button type="button" className={buttonClass} disabled={loading || busy || !((activity?.counts.failed ?? 0) + (activity?.counts.skipped_no_company ?? 0))} onClick={() => void act(`/psa/connections/${connectionId}/alert-ticketing/redrive`, { states: ['failed', 'skipped_no_company'] })} data-testid="psa-ticketing-redrive">{t(/* i18n-dynamic */ `${PREFIX}.redrive`)}</button>}
        </div>
      </div>
      {loading && <p role="status" className="mt-3 text-sm text-muted-foreground">{t(/* i18n-dynamic */ `${PREFIX}.loading`)}</p>}
      {loadFailed && <p role="alert" className="mt-3 text-sm text-destructive">{t(/* i18n-dynamic */ `${PREFIX}.loadFailed`)}</p>}
      {activity && <>
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {Object.entries(activity.counts).map(([state, count]) => <div key={state} className="flex gap-2" data-testid={`psa-ticketing-count-${state}`}>
            <dt className="text-muted-foreground">{t(/* i18n-dynamic */ `${PREFIX}.states.${state}`, { defaultValue: state })}</dt>
            <dd className="font-medium tabular-nums">{count}</dd>
          </div>)}
        </dl>
        <p className="mt-4 text-sm text-muted-foreground">{t(/* i18n-dynamic */ `${PREFIX}.help`)}</p>
        {activity.data.length === 0 ? <p className="mt-3 text-sm" data-testid="psa-ticketing-empty">{t(/* i18n-dynamic */ `${PREFIX}.empty`)}</p> :
          <ul className="mt-3 divide-y">
            {activity.data.map(row => <li key={row.id} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{t(/* i18n-dynamic */ `${PREFIX}.states.${row.createState}`)}</p>
                  {row.lastError && <p className="mt-1 break-words text-sm text-muted-foreground">{row.lastError}</p>}
                  {row.alertId && <a href={`/alerts/${row.alertId}`} className="mt-1 inline-block text-sm text-primary underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring" data-testid={`psa-ticketing-alert-${row.id}`}>{t(/* i18n-dynamic */ `${PREFIX}.viewAlert`)}</a>}
                </div>
                {canManage && <div className="flex flex-wrap gap-2">
                  {row.createState === 'needs_attention' && !row.createAnywayUsed && <button type="button" className={buttonClass} disabled={busy || loading} onClick={() => setConfirmCreate(row.id)} data-testid={`psa-ticketing-create-anyway-${row.id}`}>{t(/* i18n-dynamic */ `${PREFIX}.createAnyway`)}</button>}
                  <button type="button" className={buttonClass} disabled={busy || loading} onClick={() => void act(`/psa/ticket-mappings/${row.id}/mark-handled`, { expectedState: row.createState })} data-testid={`psa-ticketing-mark-handled-${row.id}`}>{t(/* i18n-dynamic */ `${PREFIX}.markHandled`)}</button>
                </div>}
              </div>
              {canManage && confirmCreate === row.id && <div className="mt-3 space-y-2 rounded-md border p-3">
                <p role="alert" className="text-sm">{t(/* i18n-dynamic */ `${PREFIX}.duplicateWarning`)}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={buttonClass} disabled={busy || loading} onClick={() => void act(`/psa/ticket-mappings/${row.id}/create-anyway`)} data-testid={`psa-ticketing-confirm-create-${row.id}`}>{t(/* i18n-dynamic */ `${PREFIX}.confirmCreate`)}</button>
                  <button type="button" className={buttonClass} disabled={busy} onClick={() => setConfirmCreate(null)} data-testid={`psa-ticketing-cancel-create-${row.id}`}>{t(/* i18n-dynamic */ `${PREFIX}.cancel`)}</button>
                </div>
              </div>}
            </li>)}
          </ul>}
        {totalPages > 1 && <div className="mt-3 flex flex-wrap items-center justify-end gap-3 text-sm">
          <button type="button" className={buttonClass} disabled={page <= 1 || loading || busy} onClick={() => setPage(value => value - 1)} data-testid="psa-ticketing-previous">{t(/* i18n-dynamic */ `${PREFIX}.previous`)}</button>
          <span>{t(/* i18n-dynamic */ `${PREFIX}.page`, { page, total: totalPages })}</span>
          <button type="button" className={buttonClass} disabled={page >= totalPages || loading || busy} onClick={() => setPage(value => value + 1)} data-testid="psa-ticketing-next">{t(/* i18n-dynamic */ `${PREFIX}.next`)}</button>
        </div>}
      </>}
    </div>
  );
}
