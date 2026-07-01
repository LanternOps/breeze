import { useCallback, useEffect, useMemo, useState } from 'react';
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

const FRIENDLY_CODES: Record<string, string> = {
  ORG_NOT_ACCESSIBLE: 'That organization is not available under your partner.',
  INBOUND_ROW_NOT_FOUND: 'That inbound email is no longer available.',
  INBOUND_ROW_ALREADY_RESOLVED: 'That inbound email was already handled. Refreshing the list.',
  INBOUND_ROW_NO_SENDER:
    'This email has no usable sender address, so it cannot become a ticket. Dismiss it or follow up out-of-band.',
};
const friendlyCode = (code: string): string | undefined => FRIENDLY_CODES[code];
const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

const PAGE_SIZE = 50;

interface InboundReviewQueueProps {
  /** Notified with the authoritative pending total after every (re)load, so the
   *  parent's tab badge stays in sync as rows are converted/dismissed. */
  onTotalChange?: (total: number) => void;
}

export default function InboundReviewQueue({ onTotalChange }: InboundReviewQueueProps) {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [convertOpenId, setConvertOpenId] = useState<string | null>(null);
  const [convertOrgId, setConvertOrgId] = useState('');

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
        showToast({ type: 'error', message: 'Pick an organization first.' });
        return;
      }
      try {
        await runAction({
          request: () =>
            fetchWithAuth(`/ticket-config/email-inbound/${id}/convert`, {
              method: 'POST',
              body: JSON.stringify({ orgId: convertOrgId }),
            }),
          errorFallback: 'Convert to ticket failed. Retry.',
          successMessage: 'Ticket created from email',
          friendly: friendlyCode,
          onUnauthorized: UNAUTHORIZED,
        });
        setConvertOpenId(null);
        await loadQueue(page);
      } catch (err) {
        handleActionError(err, 'Convert to ticket failed. Retry.');
        // An already-resolved row (409) means the list is stale — refresh so it clears.
        await loadQueue(page);
      }
    },
    [convertOrgId, page, loadQueue],
  );

  const dismiss = useCallback(
    async (id: string) => {
      try {
        await runAction({
          request: () =>
            fetchWithAuth(`/ticket-config/email-inbound/${id}/dismiss`, { method: 'PATCH' }),
          errorFallback: 'Dismiss failed. Retry.',
          successMessage: 'Inbound email dismissed',
          friendly: friendlyCode,
          onUnauthorized: UNAUTHORIZED,
        });
        await loadQueue(page);
      } catch (err) {
        handleActionError(err, 'Dismiss failed. Retry.');
        await loadQueue(page);
      }
    },
    [page, loadQueue],
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
        Loading.
      </p>
    );
  if (error)
    return (
      <p className="mt-6 text-center text-sm text-muted-foreground" data-testid="inbound-review-error">
        Review queue failed to load.{' '}
        <button
          type="button"
          onClick={() => void loadAll(1)}
          className="underline hover:text-foreground"
          data-testid="inbound-review-retry"
        >
          Retry
        </button>
      </p>
    );

  return (
    <section className="rounded-lg border p-4" data-testid="inbound-review-queue">
      <h2 className="mb-1 text-sm font-semibold">Review queue</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Quarantined (unknown sender) and failed inbound emails. Convert to a ticket or dismiss.
      </p>
      {forbidden ? (
        <p className="text-sm text-muted-foreground" data-testid="inbound-review-forbidden">
          The review queue is available to admins only.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="inbound-review-empty">
          Nothing to review.
        </p>
      ) : (
        <table className="min-w-full divide-y text-sm">
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={r.id} data-testid={`inbound-row-${r.id}`}>
                <td className="px-2 py-2 align-top">
                  <div className="font-medium">{r.fromAddress ?? '(unknown sender)'}</div>
                  <div className="text-muted-foreground">{r.subject ?? '(no subject)'}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    <span className="rounded border px-1 py-0.5">{r.parseStatus}</span>{' '}
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
                        <option value="">Select organization…</option>
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
                        Create ticket
                      </button>
                      <button
                        type="button"
                        onClick={() => setConvertOpenId(null)}
                        className="rounded-md border px-2.5 py-1 text-sm"
                      >
                        Cancel
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
                    Convert to ticket
                  </button>
                  <button
                    type="button"
                    onClick={() => void dismiss(r.id)}
                    className="text-muted-foreground hover:text-foreground"
                    data-testid={`inbound-dismiss-${r.id}`}
                  >
                    Dismiss
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
            Prev
          </button>
          <span className="text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            onClick={() => goPage(page + 1)}
            disabled={page >= totalPages}
            className="rounded-md border px-2.5 py-1 disabled:opacity-40"
            data-testid="inbound-page-next"
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}
