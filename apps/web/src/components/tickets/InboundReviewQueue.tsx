import { useCallback, useEffect, useMemo, useState } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { showToast } from '../shared/Toast';
import { formatDateTime } from '@/lib/dateTimeFormat';

// Inbound review queue: quarantined (unknown sender) and failed inbound emails.
// Convert to a ticket or dismiss. Admin-only surface — the backing routes carry
// writePerm + adminMiddleware, so a non-admin gets a 403 and the graceful
// "admins only" message (the parent tab also hides itself for non-admins).
//
// Extracted out of settings/InboundEmailCard so it can live under the Tickets
// area (the dismiss/convert workflow is a ticketing task, not a settings task).

interface QueueRow {
  id: string;
  fromAddress: string | null;
  toAddress: string | null;
  subject: string | null;
  // The list endpoint only ever returns review-queue rows, so the union is the
  // two review statuses. convert/dismiss responses carry the resolved status
  // ('created'/'ignored') but this component discards those bodies and reloads
  // the queue, so they never widen this type.
  parseStatus: 'quarantined' | 'failed';
  error: string | null;
  ticketId: string | null;
  createdAt: string;
}

interface OrgOption {
  id: string;
  name: string;
}

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

const PAGE_SIZE = 50;

interface InboundReviewQueueProps {
  /** Notified with the authoritative pending total after every (re)load, so the
   *  parent's tab badge stays in sync as rows are converted/dismissed. */
  onTotalChange?: (total: number) => void;
}

export default function InboundReviewQueue({ onTotalChange }: InboundReviewQueueProps) {
  const { t } = useTranslation('tickets');
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [convertOpenId, setConvertOpenId] = useState<string | null>(null);
  const [convertOrgId, setConvertOrgId] = useState('');

  const friendlyCode = useCallback((code: string): string | undefined => {
    const friendlyCodes: Record<string, string> = {
      ORG_NOT_ACCESSIBLE: t('inboundReviewQueue.friendly.orgNotAccessible'),
      INBOUND_ROW_NOT_FOUND: t('inboundReviewQueue.friendly.rowNotFound'),
      INBOUND_ROW_ALREADY_RESOLVED: t('inboundReviewQueue.friendly.rowAlreadyResolved'),
      INBOUND_ROW_NO_SENDER: t('inboundReviewQueue.friendly.noSender'),
    };
    return friendlyCodes[code];
  }, [t]);

  const loadQueue = useCallback(
    async (p: number) => {
      const res = await fetchWithAuth(`/ticket-config/email-inbound?page=${p}&limit=${PAGE_SIZE}`);
      // The queue is an admin-only surface; a 403 must not break the page.
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) {
        setError(true);
        return;
      }
      setForbidden(false);
      const body = (await res.json()) as { data: QueueRow[]; pagination: { total: number } };
      setRows(body.data);
      setTotal(body.pagination.total);
      onTotalChange?.(body.pagination.total);
    },
    [onTotalChange],
  );

  const loadOrgs = useCallback(async () => {
    const res = await fetchWithAuth('/orgs/organizations?limit=100');
    if (res.ok) {
      const body = (await res.json()) as { data?: OrgOption[] };
      if (body.data) setOrgs(body.data);
    }
  }, []);

  const loadAll = useCallback(
    async (p: number) => {
      setLoading(true);
      setError(false);
      try {
        await Promise.all([loadQueue(p), loadOrgs()]);
      } catch {
        setError(true);
      }
      setLoading(false);
    },
    [loadQueue, loadOrgs],
  );

  useEffect(() => {
    void loadAll(1);
  }, [loadAll]);

  const convert = useCallback(
    async (id: string) => {
      if (!convertOrgId) {
        showToast({ type: 'error', message: t('inboundReviewQueue.pickOrgFirst') });
        return;
      }
      try {
        await runAction({
          request: () =>
            fetchWithAuth(`/ticket-config/email-inbound/${id}/convert`, {
              method: 'POST',
              body: JSON.stringify({ orgId: convertOrgId }),
            }),
          errorFallback: t('inboundReviewQueue.convertFailed'),
          successMessage: t('inboundReviewQueue.ticketCreated'),
          friendly: friendlyCode,
          onUnauthorized: UNAUTHORIZED,
        });
        setConvertOpenId(null);
        await loadQueue(page);
      } catch (err) {
        handleActionError(err, t('inboundReviewQueue.convertFailed'));
        // An already-resolved row (409) means the list is stale — refresh so it clears.
        await loadQueue(page);
      }
    },
    [convertOrgId, friendlyCode, page, loadQueue, t],
  );

  const dismiss = useCallback(
    async (id: string) => {
      try {
        await runAction({
          request: () =>
            fetchWithAuth(`/ticket-config/email-inbound/${id}/dismiss`, { method: 'PATCH' }),
          errorFallback: t('inboundReviewQueue.dismissFailed'),
          successMessage: t('inboundReviewQueue.dismissed'),
          friendly: friendlyCode,
          onUnauthorized: UNAUTHORIZED,
        });
        await loadQueue(page);
      } catch (err) {
        handleActionError(err, t('inboundReviewQueue.dismissFailed'));
        await loadQueue(page);
      }
    },
    [friendlyCode, page, loadQueue, t],
  );

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total]);
  const goPage = useCallback(
    (p: number) => {
      setPage(p);
      void loadQueue(p);
    },
    [loadQueue],
  );

  if (loading)
    return (
      <p className="mt-6 text-center text-sm text-muted-foreground" data-testid="inbound-review-loading">
        {t('inboundReviewQueue.loading')}
      </p>
    );
  if (error)
    return (
      <p className="mt-6 text-center text-sm text-muted-foreground" data-testid="inbound-review-error">
        {t('inboundReviewQueue.loadFailed')}{' '}
        <button
          type="button"
          onClick={() => void loadAll(1)}
          className="underline hover:text-foreground"
          data-testid="inbound-review-retry"
        >
          {t('common:actions.retry')}
        </button>
      </p>
    );

  return (
    <section className="rounded-lg border p-4" data-testid="inbound-review-queue">
      <h2 className="mb-1 text-sm font-semibold">{t('inboundReviewQueue.title')}</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        {t('inboundReviewQueue.description')}
      </p>
      {forbidden ? (
        <p className="text-sm text-muted-foreground" data-testid="inbound-review-forbidden">
          {t('inboundReviewQueue.adminsOnly')}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="inbound-review-empty">
          {t('inboundReviewQueue.empty')}
        </p>
      ) : (
        <table className="min-w-full divide-y text-sm">
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={r.id} data-testid={`inbound-row-${r.id}`}>
                <td className="px-2 py-2 align-top">
                  <div className="font-medium">{r.fromAddress ?? t('inboundReviewQueue.unknownSender')}</div>
                  <div className="text-muted-foreground">{r.subject ?? t('inboundReviewQueue.noSubject')}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    <span className="rounded border px-1 py-0.5">{t(`inboundReviewQueue.parseStatus.${r.parseStatus}`)}</span>{' '}
                    {formatDateTime(r.createdAt)}
                    {r.parseStatus === 'failed' && r.error && (
                      <span className="ml-2 text-red-600">{r.error}</span>
                    )}
                  </div>
                  {convertOpenId === r.id && (
                    <div
                      className="mt-2 flex items-center gap-2"
                      data-testid={`inbound-convert-form-${r.id}`}
                    >
                      <select
                        value={convertOrgId}
                        onChange={(e) => setConvertOrgId(e.target.value)}
                        className="rounded-md border bg-background px-2 py-1 text-sm"
                        data-testid={`inbound-convert-org-${r.id}`}
                      >
                        <option value="">{t('inboundReviewQueue.selectOrganization')}</option>
                        {orgs.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => void convert(r.id)}
                        disabled={!convertOrgId}
                        className="rounded-md bg-primary px-2.5 py-1 text-sm text-white disabled:opacity-50"
                        data-testid={`inbound-convert-submit-${r.id}`}
                      >
                        {t('inboundReviewQueue.createTicket')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConvertOpenId(null)}
                        className="rounded-md border px-2.5 py-1 text-sm"
                      >
                        {t('common:actions.cancel')}
                      </button>
                    </div>
                  )}
                </td>
                <td className="px-2 py-2 text-right align-top space-x-2 whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => {
                      setConvertOpenId(r.id);
                      setConvertOrgId('');
                    }}
                    className="text-muted-foreground hover:text-foreground"
                    data-testid={`inbound-convert-${r.id}`}
                  >
                    {t('inboundReviewQueue.convertToTicket')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void dismiss(r.id)}
                    className="text-muted-foreground hover:text-foreground"
                    data-testid={`inbound-dismiss-${r.id}`}
                  >
                    {t('inboundReviewQueue.dismiss')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!forbidden && totalPages > 1 && (
        <div
          className="mt-3 flex items-center justify-between text-sm"
          data-testid="inbound-pagination"
        >
          <button
            type="button"
            onClick={() => goPage(page - 1)}
            disabled={page <= 1}
            className="rounded-md border px-2.5 py-1 disabled:opacity-40"
            data-testid="inbound-page-prev"
          >
            {t('inboundReviewQueue.prev')}
          </button>
          <span className="text-muted-foreground">
            {t('inboundReviewQueue.pageOf', { page, totalPages })}
          </span>
          <button
            type="button"
            onClick={() => goPage(page + 1)}
            disabled={page >= totalPages}
            className="rounded-md border px-2.5 py-1 disabled:opacity-40"
            data-testid="inbound-page-next"
          >
            {t('common:actions.next')}
          </button>
        </div>
      )}
    </section>
  );
}
