import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Clock, Loader2 } from 'lucide-react';
import '../../lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../lib/runAction';
import { formatDateTime } from '@/lib/dateTimeFormat';
import type { AccountingSyncSummary, InvoiceStatus } from './invoiceTypes';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface Props {
  invoiceId: string;
  /**
   * The API's `accountingSync` field. `null`/`undefined` means "no QuickBooks
   * mapping row is visible" — no connection, never pushed under a manual
   * push-mode partner, or the caller's RLS context can't see the partner-axis
   * row. All three read the same way to this component: render nothing rather
   * than invent a status.
   */
  sync: AccountingSyncSummary | null | undefined;
  /**
   * The invoice's own lifecycle status (#4544). A void invoice is not
   * reflected in `sync` at all — the mapping row can still read 'synced' or
   * 'error' from before the void — so the card needs this independently to
   * hide the push affordance on a voided invoice.
   */
  invoiceStatus: InvoiceStatus;
  /** `can('invoices','write')` — the same permission the push route requires. */
  canPush: boolean;
  /** Refetch the invoice so the card re-renders off the persisted mapping row. */
  onChanged: () => void;
}

/** Pushing is a remedy only for a row that is not (successfully) in QuickBooks
 *  yet. `synced_with_tax_variance` IS synced — QuickBooks simply computed a
 *  different tax total — so re-pushing would just re-send identical content.
 *  Does NOT account for a voided invoice or a remote-deleted mapping (#4544)
 *  — those are independent blockers layered on top by the caller, so this
 *  stays a pure function of `syncStatus` alone. */
function isPushable(status: AccountingSyncSummary['syncStatus']): boolean {
  return status === 'pending' || status === 'error';
}

export default function AccountingSyncCard({ invoiceId, sync, invoiceStatus, canPush, onChanged }: Props) {
  const { t } = useTranslation('billing');
  const [pushing, setPushing] = useState(false);

  if (!sync) return null;

  const { syncStatus } = sync;
  // Explicit default (not just relying on `!undefined` reading truthy the
  // same as `!false`) — `remoteDeleted` is optional (absent on an older API
  // response, see invoiceTypes.ts); this keeps the type honest about that
  // instead of a TS `boolean` that can actually be `undefined` at runtime.
  const remoteDeleted = sync.remoteDeleted ?? false;
  // Void is checked independently of `sync` (see the Props doc above) —
  // the mapping row's own status doesn't change when the invoice is voided.
  const voided = invoiceStatus === 'void';
  const statusPushable = isPushable(syncStatus);
  const pushable = canPush && statusPushable && !voided && !remoteDeleted;
  const statusLabel = t(
    /* i18n-dynamic */ `invoiceDetail.accountingSync.status.${syncStatus}`,
  );
  const pillTone =
    syncStatus === 'synced'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : syncStatus === 'error'
        ? 'border-red-200 bg-red-50 text-red-700'
        : syncStatus === 'synced_with_tax_variance'
          ? 'border-amber-200 bg-amber-50 text-amber-800'
          : 'border-slate-200 bg-slate-50 text-slate-600';
  const PillIcon =
    syncStatus === 'synced'
      ? CheckCircle2
      : syncStatus === 'pending'
        ? Clock
        : AlertTriangle;

  async function push() {
    setPushing(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/accounting/quickbooks/invoices/${invoiceId}/push`, { method: 'POST' }),
        errorFallback: t('invoiceDetail.accountingSync.pushFailed'),
        successMessage: t('invoiceDetail.accountingSync.pushed'),
        onUnauthorized: UNAUTHORIZED,
      });
      onChanged();
    } catch (err) {
      // A typed 409 (currency_mismatch, customer_not_mapped, …) has already
      // been toasted by runAction with the route's own message; deliberately
      // no refetch, because nothing about the invoice changed.
      handleActionError(err, t('invoiceDetail.accountingSync.pushFailed'));
    } finally {
      setPushing(false);
    }
  }

  return (
    <div className="rounded-lg border bg-card p-4" data-testid="invoice-detail-accounting-sync">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('invoiceDetail.accountingSync.title')}
      </h3>
      <div className="space-y-2 text-sm">
        <span
          data-testid="invoice-accounting-sync-status"
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${pillTone}`}
        >
          <PillIcon className="h-3.5 w-3.5" /> {statusLabel}
        </span>

        {syncStatus === 'synced_with_tax_variance' && (
          <p className="text-xs text-amber-800" data-testid="invoice-accounting-sync-variance">
            {t('invoiceDetail.accountingSync.taxVarianceHint')}
          </p>
        )}

        {syncStatus === 'error' && sync.lastError && (
          <p className="text-xs text-red-700" data-testid="invoice-accounting-sync-error">
            {sync.lastError}
          </p>
        )}

        {/* Explanatory labels for why the push affordance is hidden even
            though the mapping row's own status would otherwise allow it
            (#4544). Void takes precedence in copy when both apply — a
            remote-deleted invoice that also got voided in Breeze doesn't
            need two explanations for one missing button. */}
        {statusPushable && voided && (
          <p className="text-xs text-muted-foreground" data-testid="invoice-accounting-sync-voided-hint">
            {t('invoiceDetail.accountingSync.voidedHint')}
          </p>
        )}
        {statusPushable && remoteDeleted && !voided && (
          <p className="text-xs text-muted-foreground" data-testid="invoice-accounting-sync-remote-deleted-hint">
            {t('invoiceDetail.accountingSync.remoteDeletedHint')}
          </p>
        )}

        {sync.remoteDocNumber && (
          <p className="text-muted-foreground" data-testid="invoice-accounting-sync-docnumber">
            {t('invoiceDetail.accountingSync.docNumber', { docNumber: sync.remoteDocNumber })}
          </p>
        )}

        {sync.lastSyncedAt && (
          <p className="text-xs text-muted-foreground" data-testid="invoice-accounting-sync-lastsynced">
            {t('invoiceDetail.accountingSync.lastSynced', { when: formatDateTime(sync.lastSyncedAt) })}
          </p>
        )}

        {pushable && (
          <button
            type="button"
            data-testid="invoice-accounting-sync-push"
            onClick={() => void push()}
            disabled={pushing}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {pushing && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('invoiceDetail.accountingSync.push')}
          </button>
        )}
      </div>
    </div>
  );
}
