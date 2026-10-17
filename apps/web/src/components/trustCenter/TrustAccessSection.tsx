// Owner: W02d (NDA text, ticket-per-request setting, access-request inbox; plan W02d Task 6).
// The NDA text and the ticket switch are page settings saved with this section's Save (settings rule 7) through
// PUT /trust-page; the NDA reaches the public page only when the page is next published (frozen config).
// Mutations go through runAction (listed in no-silent-mutations TARGET_GLOBS).
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TRUST_NDA_MAX_CHARS, type TrustAccessRequestStatus } from '@breeze/shared';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { updateTrustPage, type TrustSectionProps } from '@/lib/api/trustPage';
import {
  approveTrustAccessRequest, denyTrustAccessRequest, listTrustAccessRequests, resendTrustAccessGrant, revokeTrustAccessGrant,
  type TrustAccessRequestItem,
} from '@/lib/api/trustPageAccess';
import { formatDate } from '@/lib/dateTimeFormat';
import { handleActionError, runAction } from '@/lib/runAction';

const STATUSES: TrustAccessRequestStatus[] = ['pending_approval', 'pending_verification', 'approved', 'denied', 'revoked'];
const ERROR_KEYS: Record<string, string> = {
  MFA_REQUIRED: 'access.errors.mfaRequired',
  INVALID_STATE: 'access.errors.invalidState',
  NO_GATED_DOCUMENTS: 'access.errors.noGatedDocuments',
  PAGE_NOT_PUBLISHED: 'access.errors.pageNotPublished',
  GRANT_EXPIRED: 'access.errors.grantExpired',
  REVISION_MISMATCH: 'errors.revisionMismatch',
};

type Load = { requests: TrustAccessRequestItem[] } | { failed: true } | null;
type Confirming = { kind: 'deny' | 'revoke'; request: TrustAccessRequestItem } | null;

export default function TrustAccessSection({ orgId, orgFetch, state, canWrite, onReload }: TrustSectionProps) {
  const { t } = useTranslation('organizations');
  const tr = useCallback(
    (key: string, vars?: Record<string, unknown>) => t(/* i18n-dynamic */ `orgRecord.trust.${key}`, vars ?? {}),
    [t],
  );
  const friendly = useCallback((code: string) => (ERROR_KEYS[code] ? tr(ERROR_KEYS[code]) : undefined), [tr]);
  const page = state.page;
  // Seeded once from the server page: other sections bump the revision and reload, which must not clobber edits here.
  const [nda, setNda] = useState(page.ndaText ?? '');
  const [ticket, setTicket] = useState(page.accessRequestCreatesTicket);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<TrustAccessRequestStatus | 'all'>('all');
  const [load, setLoad] = useState<Load>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [note, setNote] = useState('');

  const hasGated = state.documents.some((d) => d.visibility === 'gated');

  const loadRequests = useCallback(async () => {
    try {
      setLoad({ requests: await listTrustAccessRequests(orgFetch, orgId, filter === 'all' ? undefined : filter) });
    } catch (err) {
      console.error('[TrustAccessSection] failed to load access requests', err);
      setLoad({ failed: true });
    }
  }, [orgFetch, orgId, filter]);
  useEffect(() => { void loadRequests(); }, [loadRequests]);

  const saveSettings = async () => {
    if (!canWrite) return;
    setSaving(true);
    try {
      await runAction({
        request: () => updateTrustPage(orgFetch, orgId, {
          ndaText: nda.trim() === '' ? null : nda.trim(),
          accessRequestCreatesTicket: ticket,
          expectedRevision: page.publicationRevision,
        }),
        successMessage: tr('access.saved'),
        errorFallback: tr('access.saveFailed'),
        friendly,
      });
      await onReload();
    } catch (err) {
      handleActionError(err, tr('access.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const act = async (id: string, request: () => Promise<Response>, successKey: string, failKey: string) => {
    setActing(id);
    try {
      await runAction({ request, successMessage: tr(successKey), errorFallback: tr(failKey), friendly });
      await loadRequests();
    } catch (err) {
      handleActionError(err, tr(failKey));
    } finally {
      setActing(null);
    }
  };
  const approve = (r: TrustAccessRequestItem) =>
    act(r.id, () => approveTrustAccessRequest(orgFetch, orgId, r.id), 'access.approved', 'access.approveFailed');
  const resend = (r: TrustAccessRequestItem) =>
    act(r.id, () => resendTrustAccessGrant(orgFetch, orgId, r.id), 'access.resent', 'access.resendFailed');
  const openConfirm = (kind: 'deny' | 'revoke', request: TrustAccessRequestItem) => { setNote(''); setConfirming({ kind, request }); };
  const confirm = () => {
    if (!confirming) return;
    const { kind, request } = confirming;
    setConfirming(null);
    if (kind === 'deny') {
      const trimmed = note.trim();
      void act(request.id, () => denyTrustAccessRequest(orgFetch, orgId, request.id, trimmed === '' ? undefined : trimmed), 'access.denied', 'access.denyFailed');
    } else {
      void act(request.id, () => revokeTrustAccessGrant(orgFetch, orgId, request.id), 'access.revoked', 'access.revokeFailed');
    }
  };

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4" data-testid="trust-access-section">
      <div>
        <h3 className="text-base font-semibold">{t('orgRecord.trust.access.title')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{tr('access.description')}</p>
      </div>

      {hasGated && !page.publishedAt && (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm" role="status" data-testid="trust-access-unpublished">
          {tr('access.unpublishedBanner')}
        </p>
      )}
      {!hasGated && (
        <p className="text-sm text-muted-foreground" data-testid="trust-access-no-gated">{tr('access.noGatedHint')}</p>
      )}

      <div className="space-y-3">
        <label className="block text-sm">
          <span className="font-medium">{tr('access.ndaLabel')}</span>
          <textarea
            value={nda}
            onChange={(e) => setNda(e.target.value)}
            maxLength={TRUST_NDA_MAX_CHARS}
            rows={5}
            disabled={!canWrite}
            className="mt-1 block w-full rounded-md border bg-background p-2 text-sm disabled:opacity-60"
            data-testid="trust-access-nda"
          />
          <span className="mt-1 flex justify-between gap-2 text-xs text-muted-foreground">
            <span>{tr('access.ndaHelp')}</span>
            <span className="shrink-0">{tr('access.ndaCount', { count: nda.length, max: TRUST_NDA_MAX_CHARS })}</span>
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={ticket} disabled={!canWrite} onChange={(e) => setTicket(e.target.checked)} data-testid="trust-access-ticket" />
          <span>{tr('access.ticketLabel')}</span>
        </label>
        <button
          type="button"
          disabled={!canWrite || saving}
          onClick={() => void saveSettings()}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="trust-access-save"
        >
          {tr('access.save')}
        </button>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold">{tr('access.requestsHeading')}</h4>
          <label className="flex items-center gap-2 text-sm">
            <span>{tr('access.filterLabel')}</span>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as TrustAccessRequestStatus | 'all')}
              className="rounded-md border bg-background px-2 py-1 text-sm"
              data-testid="trust-access-filter"
            >
              <option value="all">{tr('access.filterAll')}</option>
              {STATUSES.map((s) => <option key={s} value={s}>{tr(`access.status.${s}`)}</option>)}
            </select>
          </label>
        </div>
        {load === null ? (
          <p className="text-sm text-muted-foreground">{tr('loading')}</p>
        ) : 'failed' in load ? (
          <div className="text-sm" role="alert" data-testid="trust-access-load-error">
            <p>{tr('access.loadFailed')}</p>
            <button type="button" onClick={() => void loadRequests()} className="mt-2 rounded-md border px-3 py-1.5 hover:bg-muted" data-testid="trust-access-retry">
              {tr('retry')}
            </button>
          </div>
        ) : load.requests.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="trust-access-empty">{tr('access.empty')}</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">{tr('access.columns.status')}</th>
                  <th className="px-3 py-2">{tr('access.columns.requester')}</th>
                  <th className="px-3 py-2">{tr('access.columns.company')}</th>
                  <th className="px-3 py-2">{tr('access.columns.purpose')}</th>
                  <th className="px-3 py-2">{tr('access.columns.requested')}</th>
                  <th className="px-3 py-2">{tr('access.columns.expires')}</th>
                  {canWrite && <th className="px-3 py-2">{tr('access.columns.actions')}</th>}
                </tr>
              </thead>
              <tbody className="divide-y">
                {load.requests.map((r) => {
                  const busy = acting === r.id;
                  return (
                    <tr key={r.id} className="align-top" data-testid={`trust-access-row-${r.id}`}>
                      <td className="px-3 py-2">
                        <div>{tr(`access.status.${r.status}`)}</div>
                        {r.expired && <div className="text-xs text-warning" data-testid={`trust-access-expired-${r.id}`}>{tr('access.expired')}</div>}
                        {r.status === 'approved' && <div className="text-xs text-muted-foreground">{tr('access.downloads', { count: r.downloadCount })}</div>}
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{r.requesterName}</div>
                        <div className="text-xs text-muted-foreground">{r.requesterEmail}</div>
                        {r.ndaAccepted && <div className="text-xs text-muted-foreground">{tr('access.ndaAccepted')}</div>}
                      </td>
                      <td className="px-3 py-2">{r.requesterCompany}</td>
                      <td className="max-w-xs px-3 py-2"><p className="line-clamp-3 break-words" title={r.purpose}>{r.purpose}</p></td>
                      <td className="whitespace-nowrap px-3 py-2">{formatDate(r.createdAt)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{r.expiresAt ? formatDate(r.expiresAt) : ''}</td>
                      {canWrite && (
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {r.status === 'pending_approval' && (
                              <button type="button" disabled={busy} onClick={() => void approve(r)}
                                className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50" data-testid={`trust-access-approve-${r.id}`}>
                                {tr('access.approve')}
                              </button>
                            )}
                            {(r.status === 'pending_approval' || r.status === 'pending_verification') && (
                              <button type="button" disabled={busy} onClick={() => openConfirm('deny', r)}
                                className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50" data-testid={`trust-access-deny-${r.id}`}>
                                {tr('access.deny')}
                              </button>
                            )}
                            {r.status === 'approved' && !r.expired && (
                              <>
                                <button type="button" disabled={busy} onClick={() => void resend(r)}
                                  className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50" data-testid={`trust-access-resend-${r.id}`}>
                                  {tr('access.resend')}
                                </button>
                                <button type="button" disabled={busy} onClick={() => openConfirm('revoke', r)}
                                  className="rounded-md border border-destructive/50 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50" data-testid={`trust-access-revoke-${r.id}`}>
                                  {tr('access.revoke')}
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={confirm}
        title={tr(confirming?.kind === 'revoke' ? 'access.revokeTitle' : 'access.denyTitle')}
        message={confirming?.kind === 'revoke'
          ? tr('access.revokeMessage', { name: confirming.request.requesterName })
          : tr('access.denyMessage', { name: confirming?.request.requesterName ?? '', company: confirming?.request.requesterCompany ?? '' })}
        confirmLabel={tr(confirming?.kind === 'revoke' ? 'access.revokeConfirm' : 'access.denyConfirm')}
        variant="destructive"
        confirmTestId={confirming?.kind === 'revoke' ? 'trust-access-revoke-confirm' : 'trust-access-deny-confirm'}
      >
        {confirming?.kind === 'deny' && (
          <label className="mt-3 block text-sm">
            <span>{tr('access.denyNoteLabel')}</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={3}
              className="mt-1 block w-full rounded-md border bg-background p-2 text-sm"
              data-testid="trust-access-deny-note"
            />
          </label>
        )}
      </ConfirmDialog>
    </section>
  );
}
