import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { navigateTo } from '@/lib/navigation';
import { getDeviceRoleLabel } from '@/lib/deviceRoles';
import '@/lib/i18n';
import { runAction, handleActionError, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { Dialog } from '../shared/Dialog';
import { currencyLabel, currencyOptions } from '@/lib/currencies';
import {
  changeContractCurrency,
  contractTransition,
  deleteContract,
  generateContractInvoice,
  getContractEstimate,
  type ContractCurrencyBlockerDetails,
  type ContractDetail as ContractDetailData,
  type ContractEstimate,
  type ContractEstimateLine,
  type OverageSummary,
  type ContractStatus,
  type ContractTransition,
  type PriceBookGap,
  type UncoveredDevices,
} from '../../lib/api/contracts';
import { formatMoney, formatDate } from '../billing/invoiceTypes';
import { usePermissions } from '../../lib/permissions';
import ContractDocumentsSection from './ContractDocumentsSection';
import DeviceCoverageNotice, { formatUncoveredBreakdown } from './DeviceCoverageNotice';
import { LINE_TYPE_LABELS } from './lineTypes';
import AllowanceCell, { OverageNotice } from './AllowanceCell';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface Props {
  detail: ContractDetailData;
  onChanged: () => void;
}

// Which lifecycle transitions are offered for each status (mirrors the API's
// allowed state machine — the route rejects anything else with a 409).
const TRANSITIONS_FOR_STATUS: Record<ContractStatus, ContractTransition[]> = {
  draft: ['activate'],
  active: ['pause', 'cancel'],
  paused: ['resume', 'cancel'],
  cancelled: [],
  expired: [],
};

const TRANSITION_LABELS: Record<ContractTransition, string> = {
  activate: 'contracts.shared.transition.activate',
  pause: 'contracts.shared.transition.pause',
  resume: 'contracts.shared.transition.resume',
  cancel: 'contracts.shared.transition.cancel',
};


/**
 * Multi-currency wave 6 (#3778), Task 16 — the ACTIVE-contract currency restamp.
 *
 * The server is the authority: `POST /contracts/:id/currency` re-checks
 * `contracts:manage`, the explicit confirmation and eligibility under the
 * contract's row lock, so this dialog is a convenience, never a gate. What it
 * DOES owe the operator is the reason: each 409 names the exact rows that block
 * the restamp, keyed by the error code, and those ids are rendered as an
 * actionable list instead of being flattened into a generic toast.
 */
type CurrencyMode = 'clear' | 'reprice';

const BLOCKER_ID_KEYS: Record<string, keyof ContractCurrencyBlockerDetails> = {
  UNBILLED_MONETARY_ROWS: 'draftInvoiceIds',
  ORPHANED_BILLING_PERIOD: 'billingPeriodIds',
  ORPHANED_CONTRACT_SOURCE: 'lineIds',
  BROKEN_CONTRACT_LINEAGE: 'invoiceIds',
};

/** Codes whose blocking ids are invoices, so the row can link to one. */
const INVOICE_BLOCKER_CODES = new Set(['UNBILLED_MONETARY_ROWS', 'BROKEN_CONTRACT_LINEAGE']);

interface CurrencyBlockers { code: string; ids: string[] }

/** Reads the blocking row ids off a rejected change-currency call. Returns null
 *  for anything that is not a structured blocker (network error, 401, a 409 with
 *  no details) — those stay with runAction's toast. */
function blockersFrom(err: unknown): CurrencyBlockers | null {
  if (!(err instanceof ActionError) || err.status !== 409 || !err.code) return null;
  const key = BLOCKER_ID_KEYS[err.code];
  if (!key) return null;
  const body = err.body as { details?: ContractCurrencyBlockerDetails } | null | undefined;
  const ids = body?.details?.[key];
  if (!Array.isArray(ids) || ids.length === 0) return null;
  return { code: err.code, ids: ids.filter((id): id is string => typeof id === 'string') };
}

export default function ContractDetail({ detail, onChanged }: Props) {
  const { t, i18n } = useTranslation('billing');
  const { can } = usePermissions();
  const { contract, lines, periods } = detail;
  const currency = contract.currencyCode;

  const [busy, setBusy] = useState(false);
  const [delOpen, setDelOpen] = useState(false);
  // Cancel is terminal (no transition out of `cancelled`), so it routes through a
  // confirm step — matching the bulk-list Cancel. Pause/resume/activate are
  // reversible and fire immediately.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [estimate, setEstimate] = useState<ContractEstimate | null>(null);
  const [estimateFailed, setEstimateFailed] = useState(false);
  const estByLine = useMemo(() => {
    const m = new Map<string, ContractEstimateLine>();
    for (const e of estimate?.lines ?? []) m.set(e.lineId, e);
    return m;
  }, [estimate]);
  // Currency restamp (ACTIVE contracts only, manage-gated, #3778).
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [targetCurrency, setTargetCurrency] = useState(currency);
  const [currencyMode, setCurrencyMode] = useState<CurrencyMode | null>(null);
  const [currencyConfirmed, setCurrencyConfirmed] = useState(false);
  const [currencyBlockers, setCurrencyBlockers] = useState<CurrencyBlockers | null>(null);

  // Guards against a response landing after unmount (or after `loadEstimate`
  // itself changes, e.g. contract.id changing under us): toggled false in the
  // effect cleanup below and checked before every setState past an await.
  const mountedRef = useRef(true);

  const loadEstimate = useCallback(async () => {
    setEstimate(null);
    setEstimateFailed(false);
    let res: Response;
    try {
      res = await getContractEstimate(contract.id);
    } catch {
      if (mountedRef.current) setEstimateFailed(true);
      return;
    }
    if (!res.ok) {
      if (mountedRef.current) setEstimateFailed(true);
      return;
    }
    const body = (await res.json().catch(() => null)) as { data?: ContractEstimate } | null;
    if (mountedRef.current) setEstimate(body?.data ?? null);
  }, [contract.id]);

  useEffect(() => {
    mountedRef.current = true;
    void loadEstimate();
    return () => { mountedRef.current = false; };
  }, [loadEstimate]);

  const refresh = useCallback(() => { onChanged(); void loadEstimate(); }, [onChanged, loadEstimate]);

  const transition = useCallback(async (verb: ContractTransition) => {
    if (busy) return;
    setBusy(true);
    try {
      await runAction({
        request: () => contractTransition(contract.id, verb),
        errorFallback: t(/* i18n-dynamic */ `contracts.contractDetail.errors.transition.${verb}`),
        successMessage: t(/* i18n-dynamic */ `contracts.contractDetail.toast.transition.${verb}`),
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    } catch (err) {
      handleActionError(err, t(/* i18n-dynamic */ `contracts.contractDetail.errors.transition.${verb}`));
    } finally {
      setBusy(false);
    }
  }, [busy, contract.id, refresh, t]);

  const generateNow = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await runAction<{ data?: { invoiceId?: string; priceBookGaps?: PriceBookGap[]; uncoveredDevices?: UncoveredDevices | null; overages?: OverageSummary[] } }>({
        request: () => generateContractInvoice(contract.id),
        errorFallback: t('contracts.contractDetail.errors.generateInvoice'),
        successMessage: t('contracts.contractDetail.toast.invoiceGenerated'),
        onUnauthorized: UNAUTHORIZED,
      });
      const invoiceId = result?.data?.invoiceId;
      // Multi-currency wave 3 (#3775): a catalog line with no price in the
      // contract's currency was still billed — at the contract's stamped
      // snapshot. That fallback is permitted but never silent: name the lines
      // and the currency so the operator can fix the catalog (review #10).
      const gaps = result?.data?.priceBookGaps ?? [];
      if (gaps.length > 0) {
        showToast({
          type: 'warning',
          message: t('contracts.contractDetail.toast.priceBookGaps', {
            count: gaps.length,
            currency: gaps[0]!.currencyCode,
            lines: gaps.map((g) => g.itemName).join(', '),
          }),
        });
      }
      // #3205: a role-billed contract with devices no line covers still billed —
      // say so, with the breakdown, before navigating to the invoice.
      const uncovered = result?.data?.uncoveredDevices;
      if (uncovered && uncovered.total > 0) {
        showToast({
          type: 'warning',
          message: t('contracts.contractDetail.toast.uncoveredDevices', {
            count: uncovered.total, breakdown: formatUncoveredBreakdown(uncovered.byRole),
          }),
        });
      }
      // #3205 W04: flagged overage is money left on the table. It is NOT on the
      // invoice the user is about to be navigated to, so this toast is the only
      // place they see it. Billed overage raises nothing — it is a line on the
      // invoice they are about to open.
      const flagged = (result?.data?.overages ?? []).filter((o) => o.mode === 'flag');
      if (flagged.length > 0) {
        showToast({
          type: 'warning',
          message: t('contracts.contractDetail.toast.flaggedOverage', {
            count: flagged.length,
            names: flagged.map((o) => o.description).join(', '),
          }),
        });
      }
      if (invoiceId) {
        void navigateTo(`/billing/invoices/${invoiceId}`);
      } else {
        refresh();
      }
    } catch (err) {
      handleActionError(err, t('contracts.contractDetail.errors.generateInvoice'));
    } finally {
      setBusy(false);
    }
  }, [busy, contract.id, refresh, t]);

  const openCurrencyDialog = useCallback(() => {
    setTargetCurrency(currency);
    setCurrencyMode(null);
    setCurrencyConfirmed(false);
    setCurrencyBlockers(null);
    setCurrencyOpen(true);
  }, [currency]);

  const submitCurrency = useCallback(async () => {
    if (busy || !currencyMode || !currencyConfirmed || targetCurrency === currency) return;
    setBusy(true);
    // A retry starts from a clean slate — a stale blocker list would read as a
    // fresh rejection.
    setCurrencyBlockers(null);
    try {
      await runAction({
        request: () => changeContractCurrency(contract.id, {
          currencyCode: targetCurrency,
          ...(currencyMode === 'clear' ? { clearLines: true } : { reprice: true }),
          confirmActiveChange: true,
        }),
        errorFallback: t('contracts.currency.errors.change'),
        successMessage: t('contracts.currency.toast.changed', { currency: targetCurrency }),
        onUnauthorized: UNAUTHORIZED,
      });
      setCurrencyOpen(false);
      refresh();
    } catch (err) {
      // A structured 409 names the rows that block the restamp: keep the dialog
      // open and show them, so the operator can go issue or delete them.
      const blockers = blockersFrom(err);
      if (blockers) setCurrencyBlockers(blockers);
      else handleActionError(err, t('contracts.currency.errors.change'));
    } finally {
      setBusy(false);
    }
  }, [busy, contract.id, currency, currencyConfirmed, currencyMode, refresh, t, targetCurrency]);

  const remove = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await runAction({
        request: () => deleteContract(contract.id),
        errorFallback: t('contracts.contractDetail.errors.deleteDraft'),
        successMessage: t('contracts.contractDetail.toast.draftDeleted'),
        onUnauthorized: UNAUTHORIZED,
      });
      setDelOpen(false);
      void navigateTo('/contracts');
    } catch (err) {
      handleActionError(err, t('contracts.contractDetail.errors.deleteDraft'));
    } finally {
      setBusy(false);
    }
  }, [busy, contract.id, t]);

  const availableTransitions = TRANSITIONS_FOR_STATUS[contract.status] ?? [];
  const canGenerate = contract.status === 'active';
  // Draft contracts keep today's behaviour: their currency is changed through the
  // editor's draft path, which this action deliberately does not touch.
  const canChangeCurrency = can('contracts', 'manage') && contract.status === 'active';
  const currencySubmittable = !!currencyMode && currencyConfirmed && targetCurrency !== currency;

  return (
    <div className="space-y-6" data-testid="contract-detail">
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* ── header (read-only) + lines + period history ───────────────── */}
        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="contract-header">
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase text-muted-foreground">{t('contracts.contractDetail.fields.billingTiming')}</dt>
                <dd className="mt-1 font-medium capitalize">{t(/* i18n-dynamic */ `contracts.shared.billingTiming.${contract.billingTiming}`)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-muted-foreground">{t('contracts.contractDetail.fields.cadence')}</dt>
                <dd className="mt-1 font-medium">
                  {contract.intervalMonths === 1
                    ? t('contracts.shared.cadence.monthly')
                    : contract.intervalMonths === 3
                      ? t('contracts.shared.cadence.quarterly')
                      : contract.intervalMonths === 12
                        ? t('contracts.shared.cadence.annual')
                        : t('contracts.shared.cadence.custom', { count: contract.intervalMonths })}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-muted-foreground">{t('contracts.contractDetail.fields.startDate')}</dt>
                <dd className="mt-1 font-medium">{formatDate(contract.startDate)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-muted-foreground">{t('contracts.contractDetail.fields.endDate')}</dt>
                <dd className="mt-1 font-medium">{formatDate(contract.endDate)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-muted-foreground">{t('contracts.contractDetail.fields.nextBilling')}</dt>
                <dd className="mt-1 font-medium">{formatDate(contract.nextBillingAt)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-muted-foreground">{t('contracts.contractDetail.fields.autoIssue')}</dt>
                <dd className="mt-1 font-medium">{contract.autoIssue ? t('common:labels.yes') : t('contracts.contractDetail.values.noDrafts')}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-muted-foreground">{t('contracts.contractDetail.fields.renewal')}</dt>
                <dd className="mt-1 font-medium" data-testid="contract-renewal-status">
                  {contract.autoRenew ? (
                    <>
                      <span>{t('contracts.contractDetail.renewal.autoRenews')}</span>
                      {' '}{t('contracts.contractDetail.renewal.everyMonths', { count: contract.renewalTermMonths ?? '—' })}
                      {contract.endDate ? <> {t('contracts.contractDetail.renewal.currentTermEnds', { date: formatDate(contract.endDate) })}</> : null}
                      {contract.renewalNoticeDays != null ? <> {t('contracts.contractDetail.renewal.noticeDays', { count: contract.renewalNoticeDays })}</> : null}
                    </>
                  ) : (
                    <span>{t('contracts.contractDetail.renewal.doesNotAutoRenew')}</span>
                  )}
                </dd>
              </div>
              {/* Estimated value per billing period, from live device/seat counts. */}
              <div>
                <dt className="text-xs uppercase text-muted-foreground">{t('contracts.contractDetail.fields.estimatedPerPeriod')}</dt>
                <dd className="mt-1 font-medium tabular-nums" data-testid="contract-estimate-stat">
                  {estimate ? formatMoney(estimate.periodTotal, currency) : '—'}
                  <DeviceCoverageNotice uncovered={estimate?.uncoveredDevices} />
                  <OverageNotice overages={estimate?.overages} />
                  {estimateFailed && (
                    <p className="mt-1 text-xs text-amber-600 dark:text-amber-500" data-testid="contract-estimate-stale">
                      {t('contracts.contractEditor.estimate.loadLiveCountsFailed')}{' '}
                      <button type="button" onClick={() => void loadEstimate()} className="underline hover:text-foreground">
                        {t('common:actions.retry')}
                      </button>
                    </p>
                  )}
                </dd>
              </div>
            </dl>
            {contract.notes && (
              <div className="mt-4 border-t pt-3">
                <dt className="text-xs uppercase text-muted-foreground">{t('contracts.contractDetail.fields.notes')}</dt>
                <dd className="mt-1 whitespace-pre-wrap text-sm">{contract.notes}</dd>
              </div>
            )}
          </div>

          {/* Lines (read-only) */}
          <div className="rounded-lg border bg-card shadow-xs">
            <table className="w-full text-sm" data-testid="contract-detail-lines">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">{t('common:labels.type')}</th>
                  <th className="px-3 py-2 font-medium">{t('common:labels.description')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('contracts.contractDetail.table.unitPrice')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('contracts.contractDetail.table.qty')}</th>
                  <th className="px-3 py-2 text-center font-medium">{t('contracts.contractDetail.table.tax')}</th>
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-sm text-muted-foreground">
                      {t('contracts.contractDetail.table.empty')}
                    </td>
                  </tr>
                ) : (
                  lines.map((l) => (
                    <tr key={l.id} className="border-t" data-testid={`contract-detail-line-${l.id}`}>
                      <td className="px-3 py-2">
                        {t(/* i18n-dynamic */ LINE_TYPE_LABELS[l.lineType])}
                        {l.site
                          ? <span className="block text-xs text-muted-foreground" data-testid={`contract-detail-line-site-${l.id}`}>{t('contracts.shared.lineScope.site', { name: l.site.name })}</span>
                          : null}
                        {l.lineType === 'per_device_role' && l.deviceRoles
                          ? <span className="block text-xs text-muted-foreground">{l.deviceRoles.map(getDeviceRoleLabel).join(', ')}</span>
                          : null}
                        {l.lineType === 'per_device_group'
                          ? <span className="block text-xs text-muted-foreground" data-testid={`contract-detail-line-group-${l.id}`}>
                              {l.deviceGroup
                                ? `${l.deviceGroup.name}${l.deviceGroup.type === 'dynamic' ? ` · ${t('contracts.shared.dynamicGroup')}` : ''}`
                                : t('contracts.shared.deletedGroup', { name: l.deviceGroupName ?? '' })}
                            </span>
                          : null}
                      </td>
                      <td className="px-3 py-2">{l.description}</td>
                      <td className="px-3 py-2 text-right">{formatMoney(l.unitPrice, currency)}</td>
                      <td className="px-3 py-2 text-right" data-testid={`contract-detail-line-qty-${l.id}`}>
                        <AllowanceCell line={l} estimate={estByLine.get(l.id)} />
                      </td>
                      <td className="px-3 py-2 text-center">{l.taxable ? '✓' : '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Billing-period history */}
          <div className="rounded-lg border bg-card shadow-xs">
            <h3 className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('contracts.contractDetail.billingHistory.title')}
            </h3>
            <table className="w-full text-sm" data-testid="contract-periods">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">{t('contracts.contractDetail.billingHistory.period')}</th>
                  <th className="px-3 py-2 font-medium">{t('contracts.contractDetail.billingHistory.generated')}</th>
                  <th className="px-3 py-2 font-medium">{t('contracts.contractDetail.billingHistory.invoice')}</th>
                </tr>
              </thead>
              <tbody>
                {periods.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-8 text-center text-sm text-muted-foreground" data-testid="contract-periods-empty">
                      {t('contracts.contractDetail.billingHistory.empty')}
                    </td>
                  </tr>
                ) : (
                  periods.map((p) => (
                    <tr key={p.id} className="border-t" data-testid={`period-row-${p.id}`}>
                      <td className="px-3 py-2">{formatDate(p.periodStart)} – {formatDate(p.periodEnd)}</td>
                      <td className="px-3 py-2">{formatDate(p.generatedAt)}</td>
                      <td className="px-3 py-2">
                        {p.invoiceId ? (
                          <a
                            href={`/billing/invoices/${p.invoiceId}`}
                            data-testid={`period-invoice-link-${p.id}`}
                            className="text-primary hover:underline"
                          >
                            {t('contracts.contractDetail.billingHistory.viewInvoice')}
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Executed documents (Task 15's accept-time snapshots) */}
          <ContractDocumentsSection contractId={contract.id} />
        </div>

        {/* ── status + lifecycle + generate ─────────────────────────────── */}
        <div className="space-y-4">
          {/* The status badge already leads the page header (ContractWorkspace) and
              cadence sits in the details card above, so this card carries only what
              neither does: what the buttons below will do. The sr-only status node
              keeps the contract state announced to assistive tech now that the
              visible badge moved to the header. */}
          <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="contract-detail-summary">
            <span className="sr-only" data-testid="contract-detail-status">
              {t(/* i18n-dynamic */ `contracts.shared.status.${contract.status}`)}
            </span>
            <p className="text-sm text-muted-foreground">
              {canGenerate
                ? t('contracts.contractDetail.summary.active')
                : t('contracts.contractDetail.summary.inactive')}
            </p>
          </div>

          {/* Lifecycle */}
          {can('contracts', 'manage') && availableTransitions.length > 0 && (
            <div className="space-y-2" data-testid="contract-lifecycle">
              {availableTransitions.map((verb) => {
                const destructive = verb === 'cancel';
                return (
                  <button
                    key={verb}
                    type="button"
                    onClick={destructive ? () => setCancelOpen(true) : () => void transition(verb)}
                    disabled={busy}
                    data-testid={`contract-${verb}-btn`}
                    className={`inline-flex w-full items-center justify-center rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 ${
                      destructive
                        ? 'border border-destructive/40 text-destructive hover:bg-destructive/10'
                        : verb === 'activate' || verb === 'resume'
                          ? 'bg-primary text-primary-foreground hover:opacity-90'
                          : 'border hover:bg-muted'
                    }`}
                  >
                    {t(/* i18n-dynamic */ TRANSITION_LABELS[verb])}
                  </button>
                );
              })}
            </div>
          )}

          {/* Generate now */}
          {can('contracts', 'manage') && canGenerate && (
            <button
              type="button"
              onClick={() => void generateNow()}
              disabled={busy}
              data-testid="generate-now-btn"
              className="inline-flex w-full items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {t('contracts.contractDetail.actions.generateInvoiceNow')}
            </button>
          )}

          {/* Change stamped currency (ACTIVE only, #3778). The server re-checks
              permission, confirmation and eligibility under the row lock. */}
          {canChangeCurrency && (
            <button
              type="button"
              onClick={openCurrencyDialog}
              disabled={busy}
              data-testid="contract-currency-open"
              className="inline-flex w-full items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {t('contracts.currency.actions.change')}
            </button>
          )}

          {/* Delete draft (write-gated, draft-only) */}
          {can('contracts', 'write') && contract.status === 'draft' && (
            <button
              type="button"
              onClick={() => setDelOpen(true)}
              data-testid="contract-delete-open"
              className="inline-flex w-full items-center justify-center rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10"
            >
              {t('contracts.contractDetail.actions.deleteDraft')}
            </button>
          )}
        </div>
      </div>

      <Dialog
        open={currencyOpen}
        onClose={() => setCurrencyOpen(false)}
        title={t('contracts.currency.dialog.title')}
        maxWidth="lg"
        className="p-6"
      >
        <div className="space-y-4" data-testid="contract-currency-dialog">
          <div>
            <h3 className="text-base font-semibold">{t('contracts.currency.dialog.title')}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('contracts.currency.dialog.description', { currency })}
            </p>
          </div>

          <div>
            <label className="text-sm font-medium" htmlFor="ct-currency">
              {t('contracts.currency.dialog.currencyLabel')}
            </label>
            <select
              id="ct-currency"
              value={targetCurrency}
              onChange={(e) => setTargetCurrency(e.target.value)}
              data-testid="contract-currency-select"
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            >
              {currencyOptions(currency).map((code) => (
                <option key={code} value={code}>{currencyLabel(code, i18n.language)}</option>
              ))}
            </select>
          </div>

          {/* clearLines and reprice are mutually exclusive server-side, so the UI
              models them as one radio group rather than two checkboxes that could
              be sent together. */}
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t('contracts.currency.dialog.modeLegend')}</legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio" name="contract-currency-mode" value="clear"
                checked={currencyMode === 'clear'}
                onChange={() => setCurrencyMode('clear')}
                data-testid="contract-currency-mode-clear"
                className="mt-1"
              />
              <span>
                <span className="font-medium">{t('contracts.currency.dialog.modeClear')}</span>
                <span className="block text-muted-foreground">{t('contracts.currency.dialog.modeClearHint')}</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio" name="contract-currency-mode" value="reprice"
                checked={currencyMode === 'reprice'}
                onChange={() => setCurrencyMode('reprice')}
                data-testid="contract-currency-mode-reprice"
                className="mt-1"
              />
              <span>
                <span className="font-medium">{t('contracts.currency.dialog.modeReprice')}</span>
                <span className="block text-muted-foreground">{t('contracts.currency.dialog.modeRepriceHint')}</span>
              </span>
            </label>
          </fieldset>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={currencyConfirmed}
              onChange={(e) => setCurrencyConfirmed(e.target.checked)}
              data-testid="contract-currency-confirm-check"
              className="mt-1"
            />
            <span>{t('contracts.currency.dialog.confirm')}</span>
          </label>

          {currencyBlockers && (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
              data-testid="contract-currency-blockers"
            >
              <p className="font-medium text-destructive">
                {t(/* i18n-dynamic */ `contracts.currency.blockers.${currencyBlockers.code}`)}
              </p>
              <ul className="mt-2 space-y-1">
                {currencyBlockers.ids.map((id) => (
                  <li key={id} data-testid={`contract-currency-blocker-${id}`}>
                    {INVOICE_BLOCKER_CODES.has(currencyBlockers.code) ? (
                      <a href={`/billing/invoices/${id}`} className="text-primary hover:underline">{id}</a>
                    ) : (
                      <span className="font-mono text-xs">{id}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setCurrencyOpen(false)}
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              {t('common:actions.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void submitCurrency()}
              disabled={busy || !currencySubmittable}
              data-testid="contract-currency-submit"
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {t('contracts.currency.dialog.submit')}
            </button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={() => { setCancelOpen(false); void transition('cancel'); }}
        isLoading={busy}
        title={t('contracts.contractDetail.cancelConfirm.title')}
        message={t('contracts.contractDetail.cancelConfirm.message')}
        confirmLabel={t('contracts.contractDetail.cancelConfirm.confirm')}
        confirmTestId="contract-cancel-confirm"
      />

      <ConfirmDialog
        open={delOpen}
        onClose={() => setDelOpen(false)}
        onConfirm={() => void remove()}
        isLoading={busy}
        title={t('contracts.contractDetail.deleteConfirm.title')}
        message={t('contracts.contractDetail.deleteConfirm.message')}
        confirmLabel={t('contracts.contractDetail.deleteConfirm.confirm')}
        confirmTestId="contract-delete-confirm"
      />
    </div>
  );
}
