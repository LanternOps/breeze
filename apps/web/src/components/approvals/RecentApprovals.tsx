import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  HelpCircle,
  Loader2,
  XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatRelativeTime } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

/**
 * The "Recent" section of `/approvals` — terminal action intents (#6022).
 *
 * The inbox listed PENDING intents only, so an intent that failed had no UI
 * home at all. In the reported case the #5934 guardrail refused an
 * `autoInstall` arm after the operator approved it: the intent ended
 * `failed` / `tool_returned_error`, the chat said "Approved · running", and
 * `/approvals` showed nothing. The operator was told the platform had done
 * something it had in fact refused.
 *
 * Deliberately a SEPARATE, collapsed-by-default, READ-ONLY panel rather than a
 * status filter threaded through the pending list:
 *
 *  - the pending list owns polling, WS nudges, cursor paging, batch decisions
 *    and step-up ceremonies, none of which apply to a row that can never be
 *    decided again — folding terminal rows into it would mean auditing every
 *    one of those paths for "what if this row is already dead";
 *  - it keeps "pending-first" literally true: nothing about the default view
 *    changes, and this panel does not fetch at all until it is opened.
 */

export interface RecentApprovalRow {
  id: string;
  actionLabel: string;
  actionToolName: string;
  orgName: string | null;
  decidedAt: string | null;
  createdAt: string;
  intentOutcome: {
    status: string;
    errorCode: string | null;
    reason: string | null;
    executedAt: string | null;
  } | null;
}

const RECENT_LIMIT = 20;

/** Terminal statuses that mean the action did NOT take effect. */
const FAILURE_STATUSES = new Set(['failed', 'rejected', 'expired', 'cancelled', 'denied', 'reported']);
/** Terminal statuses that mean it DID. */
const SUCCESS_STATUSES = new Set(['completed', 'approved']);

/**
 * Three-way on purpose. An outcome the client does not recognise — a missing
 * projection, or a status added server-side later — must NOT fall into the
 * success branch: "we don't know" rendered as a green check is the exact
 * failure mode #6022 is about.
 */
export function outcomeKind(row: RecentApprovalRow): 'success' | 'failure' | 'unknown' {
  const status = row.intentOutcome?.status ?? '';
  if (FAILURE_STATUSES.has(status)) return 'failure';
  if (SUCCESS_STATUSES.has(status)) return 'success';
  return 'unknown';
}

export default function RecentApprovals() {
  const { t } = useTranslation('approvals');
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<RecentApprovalRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetchWithAuth(`/approvals/pending?view=recent&limit=${RECENT_LIMIT}`);
      if (!res.ok) throw new Error('Unable to load recent approvals');
      const body = (await res.json()) as { approvals?: RecentApprovalRow[] };
      setRows(Array.isArray(body.approvals) ? body.approvals : []);
    } catch {
      // Surfaced inline: a silent empty panel would repeat the very failure
      // mode this section exists to end.
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetches only once the panel is actually opened — the default view stays
  // exactly as cheap as it was.
  useEffect(() => {
    if (open && rows === null && !loading && !loadError) void load();
  }, [open, rows, loading, loadError, load]);

  return (
    <section className="rounded-lg border" data-testid="approvals-recent">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium"
        data-testid="approvals-recent-toggle"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        )}
        {t('recent.title')}
        <span className="text-xs font-normal text-muted-foreground">{t('recent.subtitle')}</span>
      </button>

      {open && (
        <div className="border-t px-4 py-3">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="approvals-recent-loading">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t('recent.loading')}
            </div>
          )}

          {!loading && loadError && (
            <div className="flex items-center gap-2 text-sm text-destructive" role="alert" data-testid="approvals-recent-error">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              {t('recent.error')}
              <button
                type="button"
                onClick={() => void load()}
                className="underline"
                data-testid="approvals-recent-retry"
              >
                {t('recent.retry')}
              </button>
            </div>
          )}

          {!loading && !loadError && rows !== null && rows.length === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="approvals-recent-empty">
              {t('recent.empty')}
            </p>
          )}

          {!loading && !loadError && rows !== null && rows.length > 0 && (
            <ul className="divide-y">
              {rows.map((row) => {
                const kind = outcomeKind(row);
                const status = row.intentOutcome?.status ?? 'unknown';
                return (
                  <li key={row.id} className="py-2" data-testid={`approvals-recent-row-${row.id}`}>
                    <div className="flex items-start gap-2" data-outcome={kind}>
                      {kind === 'failure' ? (
                        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                      ) : kind === 'success' ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" aria-hidden="true" />
                      ) : (
                        <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{row.actionLabel}</p>
                        <p className="text-xs text-muted-foreground">
                          <span data-testid={`approvals-recent-status-${row.id}`}>
                            {/* One key per terminal intent status, all eight
                                present in every locale; a status the locale
                                files do not know renders raw rather than
                                blank. */}
                            {t(/* i18n-dynamic */ `recent.status.${status}`, { defaultValue: status })}
                          </span>
                          {row.orgName ? ` · ${row.orgName}` : ''}
                          {row.decidedAt ? ` · ${formatRelativeTime(new Date(row.decidedAt))}` : ''}
                        </p>
                        {/* The reason the platform gave — the fact that was
                            invisible everywhere before this issue. */}
                        {row.intentOutcome?.reason && (
                          <p
                            className="mt-1 text-xs text-destructive"
                            data-testid={`approvals-recent-reason-${row.id}`}
                          >
                            {row.intentOutcome.reason}
                          </p>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
