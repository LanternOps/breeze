import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { navigateTo } from '@/lib/navigation';
import '@/lib/i18n';
import { runAction, handleActionError } from '../../lib/runAction';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import {
  contractTransition,
  deleteContract,
  generateContractInvoice,
  getContractEstimate,
  type ContractDetail as ContractDetailData,
  type ContractEstimate,
  type ContractLineType,
  type ContractStatus,
  type ContractTransition,
} from '../../lib/api/contracts';
import { formatMoney, formatDate } from '../billing/invoiceTypes';
import { usePermissions } from '../../lib/permissions';
import ContractDocumentsSection from './ContractDocumentsSection';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface Props {
  detail: ContractDetailData;
  onChanged: () => void;
}

const LINE_TYPE_LABELS: Record<ContractLineType, string> = {
  flat: 'contracts.shared.lineType.flat',
  per_device: 'contracts.shared.lineType.perDevice',
  per_seat: 'contracts.shared.lineType.perSeat',
  manual: 'contracts.shared.lineType.manual',
};

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

export default function ContractDetail({ detail, onChanged }: Props) {
  const { t } = useTranslation('billing');
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

  useEffect(() => {
    let cancelled = false;
    void getContractEstimate(contract.id).then(async (res) => {
      if (cancelled || !res.ok) return;
      const body = (await res.json().catch(() => null)) as { data?: ContractEstimate } | null;
      if (!cancelled) setEstimate(body?.data ?? null);
    });
    return () => { cancelled = true; };
  }, [contract.id]);

  const refresh = useCallback(() => onChanged(), [onChanged]);

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
      const result = await runAction<{ data?: { invoiceId?: string } }>({
        request: () => generateContractInvoice(contract.id),
        errorFallback: t('contracts.contractDetail.errors.generateInvoice'),
        successMessage: t('contracts.contractDetail.toast.invoiceGenerated'),
        onUnauthorized: UNAUTHORIZED,
      });
      const invoiceId = result?.data?.invoiceId;
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
                      <td className="px-3 py-2">{t(/* i18n-dynamic */ LINE_TYPE_LABELS[l.lineType])}</td>
                      <td className="px-3 py-2">{l.description}</td>
                      <td className="px-3 py-2 text-right">{formatMoney(l.unitPrice, currency)}</td>
                      <td className="px-3 py-2 text-right">
                        {l.lineType === 'per_device' || l.lineType === 'per_seat'
                          ? <span className="text-muted-foreground">{t('contracts.shared.values.auto')}</span>
                          : (l.lineType === 'manual' ? (l.manualQuantity ?? '0') : '1')}
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
