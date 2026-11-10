import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../../stores/auth';
import { fetchAllOrganizationsFrom } from '../../../lib/fetchAllOrganizations';
import { navigateTo } from '@/lib/navigation';
import { ActionError, runAction } from '@/lib/runAction';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { showToast } from '../../shared/Toast';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { AddDomainForm } from './AddDomainForm';
import { DomainVerificationPanel } from './DomainVerificationPanel';
import { UNKNOWN_AVAILABILITY, loadDomainMethodAvailability, type DomainMethodAvailability } from './methodAvailability';
import { clearedLabel, stateBadgeClass, stateLabel } from './labels';
import { customerDomainUrl, customerDomainsUrl, normalizeCustomerDomainList, type CustomerDomainView } from './types';

type Props = { orgId: string };

type LoadState = { status: 'loading' } | { status: 'forbidden' } | { status: 'error' } | { status: 'ready' };
type OrgOption = { id: string; name: string };

const toLogin = () => void navigateTo('/login', { replace: true });

/**
 * Organization › Domains (portal registration W5, spec §5.4): the one home for
 * an org's customer email domains. A declared row routes mail; a verified row is
 * proof of ownership that self-registration (W6) and Google sign-in (W7) trust.
 * Governance is the ticket-config gate (plan D9, OD7); the tab is shown only to
 * partner / system callers, and a 403 here means the caller lacks the admin role.
 */
export default function OrgDomainsTab({ orgId }: Props) {
  const { t } = useTranslation('settings');
  const [rows, setRows] = useState<CustomerDomainView[]>([]);
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [availability, setAvailability] = useState<DomainMethodAvailability>(UNKNOWN_AVAILABILITY);
  const [openPanel, setOpenPanel] = useState<string | null>(null);
  const [savingRow, setSavingRow] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<CustomerDomainView | null>(null);
  const [moving, setMoving] = useState<CustomerDomainView | null>(null);
  const [moveTarget, setMoveTarget] = useState('');
  const [moveOrgs, setMoveOrgs] = useState<OrgOption[] | null>(null);
  const [moveOrgsFailed, setMoveOrgsFailed] = useState(false);
  /** A refresh after a successful change failed: the table may not show it yet. */
  const [stale, setStale] = useState(false);
  const seq = useRef(0);

  const loadRows = useCallback(async (opts: { silent?: boolean } = {}) => {
    const mine = (seq.current += 1);
    if (!opts.silent) setLoad({ status: 'loading' });
    try {
      const res = await fetchWithAuth(customerDomainsUrl(orgId));
      if (mine !== seq.current) return;
      if (res.status === 401) { toLogin(); return; }
      if (res.status === 403) { setLoad({ status: 'forbidden' }); return; }
      if (!res.ok) throw new Error(`customer domains load failed: ${res.status}`);
      const body = (await res.json()) as { data?: unknown };
      if (mine !== seq.current) return;
      setRows(normalizeCustomerDomainList(body.data, 'OrgDomainsTab'));
      setLoad({ status: 'ready' });
      setStale(false);
    } catch (err) {
      if (mine !== seq.current) return;
      console.error('[OrgDomainsTab] load failed', err);
      // A silent refresh after a mutation keeps the table on screen and says it may be out of date.
      if (opts.silent) setStale(true);
      else setLoad({ status: 'error' });
    }
  }, [orgId]);

  useEffect(() => {
    void loadRows();
    return () => { seq.current += 1; };
  }, [loadRows]);

  useEffect(() => {
    let cancelled = false;
    void loadDomainMethodAvailability(orgId).then((a) => { if (!cancelled) setAvailability(a); });
    return () => { cancelled = true; };
  }, [orgId]);

  const refresh = useCallback(() => void loadRows({ silent: true }), [loadRows]);

  const patchRow = async (row: CustomerDomainView, patch: Record<string, unknown>, successMessage: string): Promise<boolean> => {
    setSavingRow(row.id);
    try {
      await runAction({
        request: () => fetchWithAuth(customerDomainUrl(orgId, row.id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        }),
        errorFallback: t('orgDomains.errors.save'),
        successMessage,
        onUnauthorized: toLogin,
      });
      refresh();
      return true;
    } catch (err) {
      if (!(err instanceof ActionError)) {
        console.error('[OrgDomainsTab] update failed', err);
        showToast({ type: 'error', message: t('orgDomains.errors.save') });
      }
      return false;
    } finally {
      setSavingRow(null);
    }
  };

  const deleteRow = async () => {
    if (!deleting) return;
    const row = deleting;
    setSavingRow(row.id);
    try {
      await runAction({
        request: () => fetchWithAuth(customerDomainUrl(orgId, row.id), { method: 'DELETE' }),
        errorFallback: t('orgDomains.errors.delete'),
        successMessage: t('orgDomains.toasts.deleted', { domain: row.domain }),
        onUnauthorized: toLogin,
      });
      setDeleting(null);
      if (openPanel === row.id) setOpenPanel(null);
      refresh();
    } catch (err) {
      if (!(err instanceof ActionError)) {
        console.error('[OrgDomainsTab] delete failed', err);
        showToast({ type: 'error', message: t('orgDomains.errors.delete') });
      }
    } finally {
      setSavingRow(null);
    }
  };

  const openMove = (row: CustomerDomainView) => {
    setMoving(row);
    setMoveTarget('');
    if (moveOrgs !== null) return;
    setMoveOrgsFailed(false);
    fetchAllOrganizationsFrom<OrgOption>('/orgs/organizations')
      .then((orgs) => setMoveOrgs(orgs))
      .catch((err) => {
        console.warn('[OrgDomainsTab] organizations failed to load', err);
        setMoveOrgsFailed(true);
      });
  };

  const confirmMove = async () => {
    if (!moving || !moveTarget) return;
    const targetName = moveOrgs?.find((o) => o.id === moveTarget)?.name ?? '';
    const ok = await patchRow(moving, { orgId: moveTarget }, t('orgDomains.toasts.moved', { domain: moving.domain, org: targetName }));
    if (ok) {
      if (openPanel === moving.id) setOpenPanel(null);
      setMoving(null);
    }
  };

  if (load.status === 'loading') {
    return <p className="text-sm text-muted-foreground" data-testid="org-domains-loading">{t('common:states.loading')}</p>;
  }

  if (load.status === 'forbidden') {
    return (
      <section className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="org-domains-forbidden">
        {t('orgDomains.forbidden')}
      </section>
    );
  }

  if (load.status === 'error') {
    return (
      <section className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="org-domains-load-error">
        {t('orgDomains.errors.load')}{' '}
        <button type="button" data-testid="org-domains-retry" onClick={() => void loadRows()} className="underline hover:text-foreground">
          {t('common:actions.retry')}
        </button>
      </section>
    );
  }

  const movingVerified = moving?.state === 'verified';

  return (
    <section className="space-y-4 rounded-lg border bg-card p-6 shadow-xs" data-testid="org-domains-tab">
      <div>
        <h2 className="text-lg font-semibold">{t('orgDomains.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('orgDomains.description')}</p>
      </div>

      {stale && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200" data-testid="org-domains-stale">
          {t('orgDomains.stale')}{' '}
          <button type="button" onClick={() => void loadRows({ silent: true })} className="underline" data-testid="org-domains-stale-retry">
            {t('common:actions.retry')}
          </button>
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-2 py-2 font-medium">{t('orgDomains.columns.domain')}</th>
              <th className="px-2 py-2 font-medium">{t('orgDomains.columns.status')}</th>
              <th className="px-2 py-2 font-medium">{t('orgDomains.columns.lastChecked')}</th>
              <th className="px-2 py-2 font-medium">{t('common:states.active')}</th>
              <th className="px-2 py-2 font-medium">{t('orgDomains.columns.autoCreateContact')}</th>
              <th className="px-2 py-2 font-medium"><span className="sr-only">{t('common:labels.actions')}</span></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => {
              const cleared = row.state !== 'verified' && row.clearedReason ? clearedLabel(t, row.clearedReason) : null;
              const busy = savingRow === row.id;
              return (
                <Fragment key={row.id}>
                  <tr data-testid={`org-domains-row-${row.id}`}>
                    <td className="px-2 py-2 font-medium">{row.domain}</td>
                    <td className="px-2 py-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${stateBadgeClass(row.state)}`}
                        data-testid={`org-domains-state-${row.id}`}
                      >
                        {stateLabel(t, row)}
                      </span>
                      {row.state === 'verified' && !row.usableForSignIn && (
                        <p className="mt-1 text-xs text-amber-700" data-testid={`org-domains-not-current-${row.id}`}>
                          {row.isActive ? t('orgDomains.notCurrent') : t('orgDomains.inactiveSuspended')}
                        </p>
                      )}
                      {cleared && (
                        <p className="mt-1 text-xs text-muted-foreground" data-testid={`org-domains-cleared-${row.id}`}>{cleared}</p>
                      )}
                    </td>
                    <td className="px-2 py-2 text-muted-foreground">
                      {row.lastCheckedAt ? formatDateTime(row.lastCheckedAt) : t('orgDomains.neverChecked')}
                    </td>
                    <td className="px-2 py-2">
                      <input
                        type="checkbox"
                        aria-label={t('orgDomains.aria.active', { domain: row.domain })}
                        checked={row.isActive}
                        disabled={busy}
                        onChange={(e) => void patchRow(row, { isActive: e.target.checked }, t('orgDomains.toasts.saved', { domain: row.domain }))}
                        data-testid={`org-domains-active-${row.id}`}
                      />
                    </td>
                    <td className="px-2 py-2">
                      <input
                        type="checkbox"
                        aria-label={t('orgDomains.aria.autoCreateContact', { domain: row.domain })}
                        checked={row.autoCreateContact}
                        disabled={busy}
                        onChange={(e) => void patchRow(row, { autoCreateContact: e.target.checked }, t('orgDomains.toasts.saved', { domain: row.domain }))}
                        data-testid={`org-domains-auto-create-${row.id}`}
                      />
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right">
                      <div className="inline-flex gap-3">
                        <button
                          type="button"
                          aria-expanded={openPanel === row.id}
                          aria-controls={`org-domains-panel-${row.id}`}
                          aria-label={t('orgDomains.aria.verify', { domain: row.domain })}
                          onClick={() => setOpenPanel((cur) => (cur === row.id ? null : row.id))}
                          className="text-primary hover:underline"
                          data-testid={`org-domains-verify-${row.id}`}
                        >
                          {row.state === 'verified' ? t('orgDomains.actions.manageVerification') : t('orgDomains.actions.verify')}
                        </button>
                        <button
                          type="button"
                          onClick={() => openMove(row)}
                          disabled={busy}
                          aria-label={t('orgDomains.aria.move', { domain: row.domain })}
                          className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                          data-testid={`org-domains-move-${row.id}`}
                        >
                          {t('orgDomains.actions.move')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleting(row)}
                          disabled={busy}
                          aria-label={t('orgDomains.aria.delete', { domain: row.domain })}
                          className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                          data-testid={`org-domains-delete-${row.id}`}
                        >
                          {t('common:actions.delete')}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {openPanel === row.id && (
                    <tr id={`org-domains-panel-${row.id}`} data-testid={`org-domains-panel-row-${row.id}`}>
                      <td colSpan={6} className="px-2 pb-4">
                        <DomainVerificationPanel key={row.id} orgId={orgId} domain={row} availability={availability} onChanged={refresh} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td className="px-2 py-3 text-muted-foreground" colSpan={6} data-testid="org-domains-empty">{t('orgDomains.empty')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <AddDomainForm orgId={orgId} onAdded={refresh} />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => { if (savingRow === null) setDeleting(null); }}
        onConfirm={() => void deleteRow()}
        title={t('orgDomains.delete.title', { domain: deleting?.domain ?? '' })}
        message={deleting?.state === 'verified' ? t('orgDomains.delete.messageVerified') : t('orgDomains.delete.message')}
        confirmLabel={t('common:actions.delete')}
        variant="destructive"
        isLoading={deleting !== null && savingRow === deleting.id}
        confirmTestId="org-domains-delete-confirm"
      />

      <ConfirmDialog
        open={moving !== null}
        onClose={() => { if (savingRow === null) setMoving(null); }}
        onConfirm={() => void confirmMove()}
        title={t('orgDomains.move.title', { domain: moving?.domain ?? '' })}
        message={movingVerified ? t('orgDomains.move.messageVerified') : t('orgDomains.move.message')}
        confirmLabel={t('orgDomains.actions.move')}
        variant="warning"
        isLoading={moving !== null && savingRow === moving.id}
        confirmDisabled={!moveTarget}
        confirmTestId="org-domains-move-confirm"
        dialogTestId="org-domains-move-dialog"
      >
        <div className="mt-3 space-y-1">
          <label htmlFor="org-domains-move-target" className="text-xs font-medium">{t('orgDomains.move.targetLabel')}</label>
          {moveOrgsFailed ? (
            <p className="text-xs text-destructive" data-testid="org-domains-move-orgs-error">{t('orgDomains.move.orgsFailed')}</p>
          ) : (
            <select
              id="org-domains-move-target"
              value={moveTarget}
              onChange={(e) => setMoveTarget(e.target.value)}
              disabled={moveOrgs === null}
              className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              data-testid="org-domains-move-target"
            >
              <option value="">{moveOrgs === null ? t('common:states.loading') : t('orgDomains.move.targetPlaceholder')}</option>
              {(moveOrgs ?? []).filter((o) => o.id !== orgId).map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          )}
        </div>
      </ConfirmDialog>
    </section>
  );
}
