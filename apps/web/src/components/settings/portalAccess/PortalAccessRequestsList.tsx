import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, ActionError } from '@/lib/runAction';
import { showToast } from '../../shared/Toast';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import type {
  PortalAccessRequestDecideResult,
  PortalAccessRequestListItem,
  PortalAccessRequestSource,
} from './types';

/**
 * Pending portal access requests for one organization (portal registration W3,
 * #11380). Partner/system scope only: renders nothing while loading, when the
 * API refuses the caller (403/404), or when nothing is pending. Any other load
 * failure shows an error with Retry, so waiting requests are never hidden.
 */

// Static maps (no template keys) so keyUsage.test.ts can see every key.
const SOURCE_LABEL_KEYS: Record<PortalAccessRequestSource, string> = {
  self: 'portalAccessRequests.sources.self',
  entra: 'portalAccessRequests.sources.entra',
  google: 'portalAccessRequests.sources.google',
  addin_user: 'portalAccessRequests.sources.addin_user',
};

const RESULT_LABEL_KEYS: Record<string, string> = {
  PORTAL_ACCESS_REQUEST_NOT_FOUND: 'portalAccessRequests.results.notFound',
  PORTAL_ACCESS_REQUEST_NOT_PENDING: 'portalAccessRequests.results.notPending',
  PORTAL_ACCESS_REQUEST_ACCOUNT_EXISTS: 'portalAccessRequests.results.accountExists',
  PORTAL_ACCESS_REQUEST_IDENTITY_LINKED: 'portalAccessRequests.results.identityLinked',
  PORTAL_ACCESS_REQUEST_ENTRA_TENANT_NOT_PROVEN: 'portalAccessRequests.results.entraTenantNotProven',
};
const RESULT_FAILED_KEY = 'portalAccessRequests.results.failed';

type DenyTarget = { kind: 'one'; request: PortalAccessRequestListItem } | { kind: 'bulk' };

/** `POST …/decide` accepts at most this many ids; a larger selection is sent in batches. */
const DECIDE_BATCH = 100;

const base = (orgId: string) => `/orgs/organizations/${orgId}/portal-access-requests`;
const unauthorized = () => void navigateTo('/login', { replace: true });

export function PortalAccessRequestsList({ orgId, onChanged }: { orgId: string; onChanged?: () => void }) {
  const { t } = useTranslation('settings');
  const [requests, setRequests] = useState<PortalAccessRequestListItem[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [denyTarget, setDenyTarget] = useState<DenyTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`${base(orgId)}?status=pending`);
      if (res.status === 401) { unauthorized(); return; }
      if (res.status === 403 || res.status === 404) { setRequests(null); setLoadError(false); return; }
      if (!res.ok) throw new Error(`access requests load failed: ${res.status}`);
      const body = (await res.json()) as { data?: PortalAccessRequestListItem[]; hasMore?: boolean };
      const rows = body.data ?? [];
      setRequests(rows);
      setHasMore(body.hasMore === true);
      setLoadError(false);
      const ids = new Set(rows.map((r) => r.id));
      setSelected((prev) => new Set([...prev].filter((id) => ids.has(id))));
      setRowErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => ids.has(id))));
    } catch (err) {
      console.warn('[PortalAccessRequestsList] load failed', err);
      setLoadError(true);
    }
  }, [orgId]);

  useEffect(() => {
    setRequests(null);
    setSelected(new Set());
    setRowErrors({});
    setLoadError(false);
    void load();
  }, [load]);

  const friendly = (code: string): string | undefined => {
    const key = RESULT_LABEL_KEYS[code];
    return key ? t(/* i18n-dynamic */ key) : undefined;
  };

  const decideOne = async (request: PortalAccessRequestListItem, action: 'approve' | 'deny') => {
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`${base(orgId)}/${request.id}/${action}`, { method: 'POST' }),
        errorFallback: t('portalAccessRequests.errors.action'),
        successMessage: action === 'approve'
          ? t('portalAccessRequests.toasts.approved', { email: request.email })
          : t('portalAccessRequests.toasts.denied', { email: request.email }),
        friendly,
        onUnauthorized: unauthorized,
      });
      await load();
      if (action === 'approve') onChanged?.();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('portalAccessRequests.errors.action') });
      } else if (err.status === 404 || err.status === 409) {
        await load(); // the row is stale; refresh it
      }
    } finally {
      setBusy(false);
    }
  };

  const decideSelected = async (decision: 'approve' | 'deny') => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBusy(true);
    try {
      // Batches run one after another; a failed batch stops the rest (runAction
      // has toasted it) and its ids, like any id without a result, read as failed.
      const results = new Map<string, string>();
      for (let i = 0; i < ids.length; i += DECIDE_BATCH) {
        const batch = ids.slice(i, i + DECIDE_BATCH);
        try {
          const body = await runAction<{ data?: PortalAccessRequestDecideResult[] }>({
            request: () => fetchWithAuth(`${base(orgId)}/decide`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ requestIds: batch, decision }),
            }),
            errorFallback: t('portalAccessRequests.errors.bulk'),
            onUnauthorized: unauthorized,
          });
          for (const r of body?.data ?? []) results.set(r.requestId, r.result);
        } catch (err) {
          // Nothing decided yet: keep the selection for another try. A 401 hands
          // off to the login redirect, so no partial-result summary either.
          if (results.size === 0 || (err instanceof ActionError && err.status === 401)) throw err;
          if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('portalAccessRequests.errors.bulk') });
          break;
        }
      }
      const done = decision === 'approve' ? 'approved' : 'denied';
      const errors: Record<string, string> = {};
      let succeeded = 0;
      for (const id of ids) {
        const result = results.get(id);
        if (result === done) succeeded += 1;
        else errors[id] = RESULT_LABEL_KEYS[result ?? ''] ?? RESULT_FAILED_KEY;
      }
      setRowErrors(errors);
      setSelected(new Set());
      if (succeeded === ids.length) {
        showToast({ type: 'success', message: t('portalAccessRequests.toasts.bulkDone', { count: succeeded }) });
      } else {
        showToast({
          type: 'warning',
          message: t('portalAccessRequests.toasts.bulkPartial', { succeeded, total: ids.length }),
        });
      }
      await load();
      if (decision === 'approve' && succeeded > 0) onChanged?.();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('portalAccessRequests.errors.bulk') });
      }
    } finally {
      setBusy(false);
    }
  };

  if (loadError && !requests) {
    return (
      <p data-testid="portal-access-requests-load-error" className="text-sm text-muted-foreground">
        {t('portalAccessRequests.errors.load')}{' '}
        <button type="button" onClick={() => void load()} className="underline hover:text-foreground">
          {t('common:actions.retry')}
        </button>
      </p>
    );
  }

  if (!requests || requests.length === 0) return null;

  const allSelected = requests.every((r) => selected.has(r.id));
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <section id="portal-access-requests" data-testid="portal-access-requests" className="space-y-3 rounded-md border bg-muted/20 p-4">
      <div>
        <h3 className="text-base font-semibold">{t('portalAccessRequests.title')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('portalAccessRequests.description')}</p>
      </div>

      {loadError && (
        <p role="alert" data-testid="portal-access-requests-refresh-error" className="text-sm text-destructive">
          {t('portalAccessRequests.refreshFailed')}{' '}
          <button type="button" onClick={() => void load()} className="underline hover:text-foreground">
            {t('common:actions.retry')}
          </button>
        </p>
      )}
      {hasMore && (
        <p data-testid="portal-access-requests-more" className="text-xs text-muted-foreground">
          {t('portalAccessRequests.more', { count: requests.length })}
        </p>
      )}

      {selected.size > 0 && (
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="portal-access-requests-bulk-approve"
            disabled={busy}
            onClick={() => void decideSelected('approve')}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {t('portalAccessRequests.actions.approveSelected', { count: selected.size })}
          </button>
          <button
            type="button"
            data-testid="portal-access-requests-bulk-deny"
            disabled={busy}
            onClick={() => setDenyTarget({ kind: 'bulk' })}
            className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted/50 disabled:opacity-50"
          >
            {t('portalAccessRequests.actions.denySelected', { count: selected.size })}
          </button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="w-8 py-2">
                <input
                  type="checkbox"
                  aria-label={t('portalAccessRequests.selectAll')}
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(requests.map((r) => r.id)))}
                />
              </th>
              <th className="py-2 font-medium">{t('portalAccessRequests.columns.person')}</th>
              <th className="py-2 font-medium">{t('portalAccessRequests.columns.source')}</th>
              <th className="py-2 font-medium">{t('portalAccessRequests.columns.requested')}</th>
              <th className="py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id} data-testid={`portal-access-request-row-${r.id}`} className="border-b last:border-0 align-top">
                <td className="py-2">
                  <input
                    type="checkbox"
                    aria-label={t('portalAccessRequests.selectOne', { email: r.email })}
                    checked={selected.has(r.id)}
                    onChange={() => toggle(r.id)}
                  />
                </td>
                <td className="py-2">
                  <div>{r.email}</div>
                  {r.name && <div className="text-xs text-muted-foreground">{r.name}</div>}
                  {r.accountExists && (
                    <div className="text-xs text-amber-600">{t('portalAccessRequests.accountExists')}</div>
                  )}
                  {rowErrors[r.id] && (
                    <span
                      role="status"
                      data-testid={`portal-access-request-error-${r.id}`}
                      className="mt-1 inline-flex rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive"
                    >
                      {t(/* i18n-dynamic */ rowErrors[r.id])}
                    </span>
                  )}
                </td>
                <td className="py-2">{t(/* i18n-dynamic */ SOURCE_LABEL_KEYS[r.source])}</td>
                <td className="py-2">{new Date(r.lastRequestedAt).toLocaleDateString()}</td>
                <td className="py-2">
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      data-testid={`portal-access-request-approve-${r.id}`}
                      disabled={busy || r.accountExists}
                      onClick={() => void decideOne(r, 'approve')}
                      className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted/50 disabled:opacity-50"
                    >
                      {t('portalAccessRequests.actions.approve')}
                    </button>
                    <button
                      type="button"
                      data-testid={`portal-access-request-deny-${r.id}`}
                      disabled={busy}
                      onClick={() => setDenyTarget({ kind: 'one', request: r })}
                      className="rounded-md border px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      {t('portalAccessRequests.actions.deny')}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={denyTarget !== null}
        onClose={() => setDenyTarget(null)}
        onConfirm={() => {
          const target = denyTarget;
          if (!target) return;
          setDenyTarget(null);
          if (target.kind === 'one') void decideOne(target.request, 'deny');
          else void decideSelected('deny');
        }}
        title={t('portalAccessRequests.denyDialog.title')}
        message={denyTarget?.kind === 'one'
          ? t('portalAccessRequests.denyDialog.message', { email: denyTarget.request.email })
          : denyTarget?.kind === 'bulk'
            ? t('portalAccessRequests.denyDialog.bulkMessage', { count: selected.size })
            : ''}
        confirmLabel={t('portalAccessRequests.actions.deny')}
        variant="destructive"
        isLoading={busy}
        confirmTestId="portal-access-request-deny-confirm"
      />
    </section>
  );
}

export default PortalAccessRequestsList;
