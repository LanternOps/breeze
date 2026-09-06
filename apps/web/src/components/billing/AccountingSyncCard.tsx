import { useCallback, useEffect, useRef, useState } from 'react';
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
  /**
   * When the invoice row was last written, used ONLY to decide whether a fresh
   * mount should arm the live sync watch (see `shouldWatchOnMount`).
   *
   * The detail payload carries no issue timestamp: `issueDate` is a DATE (day
   * precision) and `sentAt` is null for a plain Issue that sent no email, so
   * the caller passes the invoice row's `updatedAt`, which the issue write
   * bumps. It is a proxy, deliberately: any other write in the last 90s (an
   * inline due-date edit, say) also reads as "recent", which at worst costs a
   * pending-row invoice one poll window and never shows a wrong status.
   *
   * Optional because `updatedAt` is not declared on the web's InvoiceSummary
   * today — an older payload can omit it, and a missing timestamp means no
   * mount watch rather than a watch armed on a guess.
   */
  invoiceTouchedAt?: string | null;
  /** `can('invoices','write')` — the same permission the push route requires. */
  canPush: boolean;
  /**
   * Refetch the invoice so the card re-renders off the persisted mapping row.
   * May return a promise (InvoiceWorkspace's `reload` does); the watch awaits
   * it so a slow refetch never has a second one stacked behind it.
   */
  onChanged: () => void | Promise<void>;
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

/** The QuickBooks push is asynchronous: `/invoices/:id/issue` (auto push mode)
 *  and `/accounting/quickbooks/invoices/:id/push` both return as soon as the
 *  job is enqueued, and the worker lands a beat later. Anything below is a
 *  settled outcome — the watch stops the moment the refetched mapping row
 *  reads one of them. */
function isSettled(status: AccountingSyncSummary['syncStatus']): boolean {
  return status === 'synced' || status === 'synced_with_tax_variance' || status === 'error';
}

/** Poll cadence and ceiling for the post-issue / post-push watch. The ceiling
 *  matters more than the cadence: the watch is a courtesy, and on timeout the
 *  card must fall back to the honest "Not pushed yet" + manual button rather
 *  than spin forever. */
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 60000;
/** How recently the invoice must have been written for a FRESH MOUNT to arm
 *  the watch. Wider than the poll window so a mount a few seconds after the
 *  issue write still catches the tail of the push; anything older is a settled
 *  fact (manual push mode, or a push that never happened), not a push in
 *  flight, and must render the actionable view immediately. */
const MOUNT_WATCH_MAX_AGE_MS = 90000;

/** Whether a fresh mount should arm the watch. The prod flow needs this and
 *  the draft -> issued transition does NOT cover it: InvoiceWorkspace opens a
 *  draft on the Editor tab and only renders InvoiceDetail on the Detail tab,
 *  so a header Issue click flips the status, unmounts the editor and mounts
 *  this card FRESH — already issued, with no transition to observe. It also
 *  re-arms correctly after a tab switch (which likewise unmounts the card),
 *  so no watch state has to move up into InvoiceWorkspace. */
function shouldWatchOnMount(
  invoiceStatus: InvoiceStatus,
  sync: AccountingSyncSummary | null | undefined,
  touchedAt: string | null | undefined,
): boolean {
  if (invoiceStatus === 'draft' || invoiceStatus === 'void') return false;
  if (sync && sync.syncStatus !== 'pending') return false;
  if (!touchedAt) return false;
  const touched = Date.parse(touchedAt);
  if (Number.isNaN(touched)) return false;
  const age = Date.now() - touched;
  // A clock-skewed future timestamp reads as age < 0; treat it as recent
  // rather than as ancient — the failure mode is a spinner that times out,
  // not a stale button that invites a double push.
  return age < MOUNT_WATCH_MAX_AGE_MS;
}

export default function AccountingSyncCard({ invoiceId, sync, invoiceStatus, invoiceTouchedAt, canPush, onChanged }: Props) {
  const { t } = useTranslation('billing');
  const [pushing, setPushing] = useState(false);
  // The push is in flight somewhere server-side; poll the invoice until the
  // mapping row settles. Armed on a fresh mount of a just-issued invoice and
  // on the draft -> issued transition. NOT armed by the manual push button:
  // that route awaits the QuickBooks call and returns the settled status, so
  // the refetch behind it already reads the outcome.
  const [watching, setWatching] = useState(() => shouldWatchOnMount(invoiceStatus, sync, invoiceTouchedAt));
  const deadlineRef = useRef(Date.now() + POLL_TIMEOUT_MS);
  // True from the moment a poll's refetch is dispatched until it resolves, so
  // a slow response cannot have a second refetch stacked behind it and land
  // out of order.
  const refetchInFlightRef = useRef(false);
  // Keep the latest `onChanged` reachable from the interval without making the
  // interval's identity depend on it — the parent re-creates the callback on
  // every render, which would otherwise tear down and restart the timer (and
  // reset the cadence) on each poll's own refetch.
  const onChangedRef = useRef(onChanged);
  useEffect(() => { onChangedRef.current = onChanged; });

  const startWatch = useCallback(() => {
    deadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
    setWatching(true);
  }, []);

  // Second trigger: the invoice's own lifecycle, for the case where the card
  // is already mounted when Issue lands (the Detail tab's own rail copy of
  // InvoiceActions). Keyed off the status prop rather than an Issue callback
  // so it covers both copies of the actions without new plumbing.
  const prevStatusRef = useRef(invoiceStatus);
  useEffect(() => {
    const previous = prevStatusRef.current;
    prevStatusRef.current = invoiceStatus;
    if (previous === 'draft' && invoiceStatus !== 'draft' && invoiceStatus !== 'void') startWatch();
  }, [invoiceStatus, startWatch]);

  // Stop on a settled row, and on a void: a spinning "Syncing…" over the
  // "nothing to push" hint is a contradiction, and the void already tells the
  // operator everything the watch was going to.
  const done = invoiceStatus === 'void' || (!!sync && isSettled(sync.syncStatus));
  useEffect(() => {
    if (done) setWatching(false);
  }, [done]);

  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => {
      // Clear the interval imperatively as well as flipping state: the state
      // update only tears the timer down on the NEXT commit, and a stop
      // decided from inside the callback must not get one more tick in.
      if (Date.now() >= deadlineRef.current) { clearInterval(timer); setWatching(false); return; }
      if (refetchInFlightRef.current) return;
      refetchInFlightRef.current = true;
      void Promise.resolve(onChangedRef.current()).finally(() => { refetchInFlightRef.current = false; });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [watching]);

  // A watch with no mapping row to show yet renders nothing — a partner with
  // no QuickBooks connection must not see a QuickBooks card appear just
  // because they issued an invoice.
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
  // While the watch is live the push is already in flight server-side: the
  // affordance has to go, or the operator double-submits the very push they
  // are waiting on.
  const pushable = canPush && statusPushable && !voided && !remoteDeleted && !watching;
  const statusLabel = watching
    ? t('invoiceDetail.accountingSync.syncing')
    : t(/* i18n-dynamic */ `invoiceDetail.accountingSync.status.${syncStatus}`);
  const pillTone = watching
    ? 'border-sky-200 bg-sky-50 text-sky-700'
    : syncStatus === 'synced'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : syncStatus === 'error'
        ? 'border-red-200 bg-red-50 text-red-700'
        : syncStatus === 'synced_with_tax_variance'
          ? 'border-amber-200 bg-amber-50 text-amber-800'
          : 'border-slate-200 bg-slate-50 text-slate-600';
  const PillIcon = watching
    ? Loader2
    : syncStatus === 'synced'
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
      // No watch here: unlike the auto-push path, this route AWAITS the
      // QuickBooks call and returns the settled syncStatus, so the refetch
      // already reads the outcome. Arming the watch would strand a retry from
      // an `error` row on a 60s spinner — the row's status would never change
      // again to end it.
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
          <PillIcon className={`h-3.5 w-3.5 ${watching ? 'animate-spin' : ''}`} /> {statusLabel}
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
