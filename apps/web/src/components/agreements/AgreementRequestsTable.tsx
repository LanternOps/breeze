import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react';
import '@/lib/i18n';
import { navigateTo } from '@/lib/navigation';
import { useStableT } from '@/lib/i18n/useStableT';
import { runAction, ActionError } from '../../lib/runAction';
import {
  listAgreementRequests,
  getAgreementRequestLink,
  voidAgreementRequest,
  deleteAgreementRequest,
  remindAgreementRequest,
  AGREEMENT_EMAIL_REASONS,
  type AgreementEmailReason,
  type RemindAgreementRequestResult,
  type AgreementRequestRow,
  type AgreementRequestStatus,
} from '../../lib/api/agreementRequests';
import { usePermissions } from '../../lib/permissions';
import { formatDate } from '../billing/invoiceTypes';
import { showToast } from '../shared/Toast';
import { Dialog } from '../shared/Dialog';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });
const MAX_INLINE_RECIPIENTS = 2;

const STATUS_CLASS: Record<AgreementRequestStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  sent: 'bg-primary/10 text-primary',
  viewed: 'bg-primary/10 text-primary',
  signed: 'bg-success/10 text-success',
  declined: 'bg-destructive/10 text-destructive',
  voided: 'bg-muted text-muted-foreground',
  expired: 'bg-warning/10 text-warning',
};

export interface AgreementRequestsTableProps {
  /** `pending` = draft|sent|viewed; `closed` = declined|voided|expired. */
  bucket: 'pending' | 'closed';
  lockedOrgId?: string;
  lockedContractId?: string;
  /** org id -> name, from the parent's org lookup (cosmetic). */
  orgNames: Record<string, string>;
  /** Bump to force a reload (after a send from the dialog). */
  reloadKey?: number;
}

/** Agreement requests sent (or drafted) for signature — the Awaiting signature
 *  and Declined / voided / expired views of the signed-agreements page. */
export default function AgreementRequestsTable({
  bucket, lockedOrgId, lockedContractId, orgNames, reloadKey = 0,
}: AgreementRequestsTableProps) {
  const { t } = useTranslation('billing');
  const stableT = useStableT(t);
  const { can } = usePermissions();
  const canSend = can('agreements', 'send');
  const canWrite = can('agreements', 'write');

  const [rows, setRows] = useState<AgreementRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [voiding, setVoiding] = useState<AgreementRequestRow | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voidBusy, setVoidBusy] = useState(false);
  // Ids with a reminder in flight: a second click must not mail the recipients twice.
  const [reminding, setReminding] = useState<ReadonlySet<string>>(new Set());
  const remindingRef = useRef<Set<string>>(new Set());
  const [tick, setTick] = useState(0);

  // Latest-wins: a slow earlier response (chip switch, reloadKey bump) must not
  // overwrite the rows of the bucket now on screen.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const stale = () => seq !== loadSeq.current;
    try {
      setLoading(true);
      setError(undefined);
      const res = await listAgreementRequests({ status: bucket, orgId: lockedOrgId, contractId: lockedContractId });
      if (stale()) return;
      if (res.status === 401) return UNAUTHORIZED();
      if (!res.ok) throw new Error(stableT('agreements.requests.loadError'));
      const body = (await res.json().catch(() => null)) as { data?: AgreementRequestRow[] } | null;
      if (stale()) return;
      if (!body) throw new Error(stableT('agreements.requests.loadError'));
      setRows(body.data ?? []);
    } catch (err) {
      if (stale()) return;
      setError(err instanceof Error ? err.message : stableT('agreements.requests.loadError'));
    } finally {
      if (!stale()) setLoading(false);
    }
  }, [bucket, lockedOrgId, lockedContractId, stableT]);

  useEffect(() => { void load(); }, [load, reloadKey, tick]);

  const reload = () => setTick((n) => n + 1);

  const copyLink = async (row: AgreementRequestRow) => {
    try {
      const res = await getAgreementRequestLink(row.id);
      if (res.status === 401) return UNAUTHORIZED();
      const body = (await res.json().catch(() => null)) as { data?: { link?: string }; error?: string } | null;
      const link = body?.data?.link;
      if (!res.ok || !link) {
        showToast({ type: 'error', message: (!res.ok && body?.error) || t('agreements.requests.copyLink.error') });
        return;
      }
      try {
        await navigator.clipboard.writeText(link);
      } catch {
        // Clipboard unavailable/denied: hand the link over so it can be copied by hand.
        showToast({ type: 'error', message: t('agreements.requests.copyLink.clipboardError', { link }) });
        return;
      }
      showToast({ type: 'success', message: t('agreements.requests.copyLink.success') });
    } catch {
      showToast({ type: 'error', message: t('agreements.requests.copyLink.error') });
    }
  };

  const remind = async (row: AgreementRequestRow) => {
    if (remindingRef.current.has(row.id)) return;
    remindingRef.current.add(row.id);
    setReminding(new Set(remindingRef.current));
    try {
      const result = await runAction<RemindAgreementRequestResult>({
        request: () => remindAgreementRequest(row.id),
        errorFallback: t('agreements.requests.remind.error'),
        parseSuccess: (data) => (data as { data: RemindAgreementRequestResult }).data,
        onUnauthorized: UNAUTHORIZED,
      });
      if (result.emailed) {
        showToast({ type: 'success', message: t('agreements.requests.remind.success', { count: result.recipients.length }) });
      } else {
        // The API's enum can grow ahead of this bundle; never build a missing key.
        const reason: AgreementEmailReason =
          result.emailReason && AGREEMENT_EMAIL_REASONS.includes(result.emailReason) ? result.emailReason : 'send_failed';
        showToast({
          type: 'warning',
          // i18n-dynamic: key built from the API's emailReason enum.
          message: t(/* i18n-dynamic */ `agreements.requests.remind.notEmailed.${reason}`),
        });
      }
      reload();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('agreements.requests.remind.error') });
    } finally {
      remindingRef.current.delete(row.id);
      setReminding(new Set(remindingRef.current));
    }
  };

  const confirmVoid = async () => {
    if (!voiding) return;
    setVoidBusy(true);
    try {
      await runAction({
        request: () => voidAgreementRequest(voiding.id, voidReason),
        errorFallback: t('agreements.requests.void.error'),
        successMessage: t('agreements.requests.void.success'),
        onUnauthorized: UNAUTHORIZED,
      });
      setVoiding(null);
      setVoidReason('');
      reload();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('agreements.requests.void.error') });
    } finally {
      setVoidBusy(false);
    }
  };

  const deleteDraft = async (row: AgreementRequestRow) => {
    try {
      await runAction({
        request: () => deleteAgreementRequest(row.id),
        errorFallback: t('agreements.requests.deleteDraft.error'),
        successMessage: t('agreements.requests.deleteDraft.success'),
        onUnauthorized: UNAUTHORIZED,
      });
      reload();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('agreements.requests.deleteDraft.error') });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16" data-testid="agreement-requests-loading">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }
  if (error) {
    return (
      <div
        className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center text-sm text-destructive"
        data-testid="agreement-requests-error"
      >
        {error}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center" data-testid="agreement-requests-empty">
        <FileText className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">
          {bucket === 'pending' ? t('agreements.requests.empty.pending.title') : t('agreements.requests.empty.closed.title')}
        </p>
        <p className="text-sm text-muted-foreground">
          {bucket === 'pending'
            ? t('agreements.requests.empty.pending.description')
            : t('agreements.requests.empty.closed.description')}
        </p>
      </div>
    );
  }

  const closedReason = (row: AgreementRequestRow): string | null => {
    if (row.status === 'declined' && row.declineReason) return t('agreements.requests.declinedReason', { reason: row.declineReason });
    if (row.status === 'voided' && row.voidReason) return t('agreements.requests.voidedReason', { reason: row.voidReason });
    return null;
  };

  return (
    <>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">{t('agreements.requests.columns.template')}</th>
              {!lockedOrgId && <th className="px-3 py-2 font-medium">{t('agreements.requests.columns.organization')}</th>}
              <th className="px-3 py-2 font-medium">{t('agreements.requests.columns.recipients')}</th>
              <th className="px-3 py-2 font-medium">{t('agreements.requests.columns.sent')}</th>
              <th className="px-3 py-2 font-medium">{t('agreements.requests.columns.expires')}</th>
              <th className="px-3 py-2 font-medium">{t('agreements.requests.columns.status')}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const reason = closedReason(row);
              const shown = row.recipients.slice(0, MAX_INLINE_RECIPIENTS);
              const more = row.recipients.length - shown.length;
              const live = row.status === 'sent' || row.status === 'viewed';
              return (
                <tr key={row.id} data-testid="agreement-request-row" data-request-id={row.id} className="border-t hover:bg-muted/20">
                  <td className="px-3 py-2">
                    {t('contracts.contractDetail.documents.templateVersion', {
                      name: row.templateName, number: row.templateVersionNumber,
                    })}
                    {row.label && <div className="text-xs text-muted-foreground">{row.label}</div>}
                    {reason && <div className="text-xs text-muted-foreground" data-testid="agreement-request-reason">{reason}</div>}
                  </td>
                  {!lockedOrgId && (
                    <td className="px-3 py-2 text-muted-foreground">{orgNames[row.orgId] ?? '—'}</td>
                  )}
                  <td className="px-3 py-2 text-muted-foreground">
                    {shown.join(', ') || '—'}
                    {more > 0 && <span className="ml-1">{t('agreements.requests.recipientsMore', { count: more })}</span>}
                  </td>
                  <td className="px-3 py-2">
                    {row.sentAt ? formatDate(row.sentAt) : t('agreements.requests.notSent')}
                    {live && row.reminderCount > 0 && (
                      <div className="text-xs text-muted-foreground" data-testid="agreement-request-reminded">
                        {t('agreements.requests.remindedCount', { count: row.reminderCount })}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">{row.expiresAt ? formatDate(row.expiresAt) : '—'}</td>
                  <td className="px-3 py-2">
                    <span
                      data-testid="agreement-request-status"
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[row.status]}`}
                    >
                      {/* i18n-dynamic: key built from the request status enum. */}
                      {t(/* i18n-dynamic */ `agreements.requests.status.${row.status}`)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {canSend && live && (
                        <>
                          <button
                            type="button"
                            onClick={() => void remind(row)}
                            disabled={reminding.has(row.id)}
                            data-testid={`agreement-request-remind-${row.id}`}
                            className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                          >
                            {t('agreements.requests.remind.label')}
                          </button>
                          <button
                            type="button"
                            onClick={() => void copyLink(row)}
                            data-testid={`agreement-request-copy-link-${row.id}`}
                            className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                          >
                            {t('agreements.requests.copyLink.label')}
                          </button>
                          <button
                            type="button"
                            onClick={() => { setVoiding(row); setVoidReason(''); }}
                            data-testid={`agreement-request-void-${row.id}`}
                            className="rounded-md border px-2 py-1 text-xs font-medium text-destructive hover:bg-muted"
                          >
                            {t('agreements.requests.void.label')}
                          </button>
                        </>
                      )}
                      {canWrite && row.status === 'draft' && (
                        <button
                          type="button"
                          onClick={() => void deleteDraft(row)}
                          data-testid={`agreement-request-delete-${row.id}`}
                          className="rounded-md border px-2 py-1 text-xs font-medium text-destructive hover:bg-muted"
                        >
                          {t('agreements.requests.deleteDraft.label')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Dialog
        open={voiding !== null}
        onClose={() => { if (!voidBusy) setVoiding(null); }}
        title={t('agreements.requests.void.title')}
        labelledBy="agreement-request-void-title"
        maxWidth="md"
        className="p-6"
      >
        <div data-testid="agreement-request-void-dialog">
          <h3 id="agreement-request-void-title" className="text-base font-semibold text-foreground">
            {t('agreements.requests.void.title')}
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">{t('agreements.requests.void.description')}</p>
          <label className="mt-4 block">
            <span className="mb-1 block text-sm font-medium text-foreground">{t('agreements.requests.void.reasonLabel')}</span>
            <textarea
              value={voidReason}
              maxLength={1000}
              rows={3}
              onChange={(e) => setVoidReason(e.target.value)}
              disabled={voidBusy}
              data-testid="agreement-request-void-reason"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </label>
          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setVoiding(null)}
              disabled={voidBusy}
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {t('common:actions.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void confirmVoid()}
              disabled={voidBusy}
              data-testid="agreement-request-void-confirm"
              className="rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              {voidBusy ? t('agreements.requests.void.confirming') : t('agreements.requests.void.confirm')}
            </button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
