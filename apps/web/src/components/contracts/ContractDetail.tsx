import { useCallback, useEffect, useState } from 'react';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../lib/runAction';
import {
  contractTransition,
  generateContractInvoice,
  getContractEstimate,
  formatCadence,
  CONTRACT_STATUS_COLORS,
  CONTRACT_STATUS_LABELS,
  type ContractDetail as ContractDetailData,
  type ContractEstimate,
  type ContractLineType,
  type ContractStatus,
  type ContractTransition,
} from '../../lib/api/contracts';
import { formatMoney } from '../billing/invoiceTypes';
import { usePermissions } from '../../lib/permissions';

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

interface Props {
  detail: ContractDetailData;
  onChanged: () => void;
}

const LINE_TYPE_LABELS: Record<ContractLineType, string> = {
  flat: 'Flat fee',
  per_device: 'Per device',
  per_seat: 'Per seat',
  manual: 'Manual quantity',
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
  activate: 'Activate',
  pause: 'Pause',
  resume: 'Resume',
  cancel: 'Cancel',
};

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}

export default function ContractDetail({ detail, onChanged }: Props) {
  const { can } = usePermissions();
  const { contract, lines, periods } = detail;
  const currency = contract.currencyCode;

  const [busy, setBusy] = useState(false);
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
        errorFallback: `Could not ${verb} the contract.`,
        successMessage: `Contract ${verb === 'activate' ? 'activated' : verb === 'pause' ? 'paused' : verb === 'resume' ? 'resumed' : 'cancelled'}`,
        onUnauthorized: UNAUTHORIZED,
      });
      refresh();
    } catch (err) {
      handleActionError(err, `Could not ${verb} the contract.`);
    } finally {
      setBusy(false);
    }
  }, [busy, contract.id, refresh]);

  const generateNow = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await runAction<{ data?: { invoiceId?: string } }>({
        request: () => generateContractInvoice(contract.id),
        errorFallback: 'Could not generate an invoice.',
        successMessage: 'Invoice generated',
        onUnauthorized: UNAUTHORIZED,
      });
      const invoiceId = result?.data?.invoiceId;
      if (invoiceId) {
        void navigateTo(`/billing/invoices/${invoiceId}`);
      } else {
        refresh();
      }
    } catch (err) {
      handleActionError(err, 'Could not generate an invoice.');
    } finally {
      setBusy(false);
    }
  }, [busy, contract.id, refresh]);

  const availableTransitions = TRANSITIONS_FOR_STATUS[contract.status] ?? [];
  const canGenerate = contract.status === 'active';

  return (
    <div className="space-y-6" data-testid="contract-detail">
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* ── header (read-only) + lines + period history ───────────────── */}
        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-4 shadow-sm" data-testid="contract-header">
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase text-muted-foreground">Billing timing</dt>
                <dd className="mt-1 font-medium capitalize">{contract.billingTiming === 'advance' ? 'In advance' : 'In arrears'}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-muted-foreground">Cadence</dt>
                <dd className="mt-1 font-medium">{formatCadence(contract.intervalMonths)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-muted-foreground">Start date</dt>
                <dd className="mt-1 font-medium">{formatDate(contract.startDate)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-muted-foreground">End date</dt>
                <dd className="mt-1 font-medium">{formatDate(contract.endDate)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-muted-foreground">Next billing</dt>
                <dd className="mt-1 font-medium">{formatDate(contract.nextBillingAt)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-muted-foreground">Auto-issue</dt>
                <dd className="mt-1 font-medium">{contract.autoIssue ? 'Yes' : 'No (drafts)'}</dd>
              </div>
              {/* Estimated value per billing period, from live device/seat counts. */}
              <div>
                <dt className="text-xs uppercase text-muted-foreground">Est. / period</dt>
                <dd className="mt-1 font-medium tabular-nums" data-testid="contract-estimate-stat">
                  {estimate ? formatMoney(estimate.periodTotal, currency) : '—'}
                </dd>
              </div>
            </dl>
            {contract.notes && (
              <div className="mt-4 border-t pt-3">
                <dt className="text-xs uppercase text-muted-foreground">Notes</dt>
                <dd className="mt-1 whitespace-pre-wrap text-sm">{contract.notes}</dd>
              </div>
            )}
          </div>

          {/* Lines (read-only) */}
          <div className="rounded-lg border bg-card shadow-sm">
            <table className="w-full text-sm" data-testid="contract-detail-lines">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 text-right font-medium">Unit price</th>
                  <th className="px-3 py-2 text-right font-medium">Qty</th>
                  <th className="px-3 py-2 text-center font-medium">Tax</th>
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-sm text-muted-foreground">
                      This contract has no lines.
                    </td>
                  </tr>
                ) : (
                  lines.map((l) => (
                    <tr key={l.id} className="border-t" data-testid={`contract-detail-line-${l.id}`}>
                      <td className="px-3 py-2">{LINE_TYPE_LABELS[l.lineType]}</td>
                      <td className="px-3 py-2">{l.description}</td>
                      <td className="px-3 py-2 text-right">{formatMoney(l.unitPrice, currency)}</td>
                      <td className="px-3 py-2 text-right">
                        {l.lineType === 'per_device' || l.lineType === 'per_seat'
                          ? <span className="text-muted-foreground">auto</span>
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
          <div className="rounded-lg border bg-card shadow-sm">
            <h3 className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Billing history
            </h3>
            <table className="w-full text-sm" data-testid="contract-periods">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Period</th>
                  <th className="px-3 py-2 font-medium">Generated</th>
                  <th className="px-3 py-2 font-medium">Invoice</th>
                </tr>
              </thead>
              <tbody>
                {periods.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-8 text-center text-sm text-muted-foreground" data-testid="contract-periods-empty">
                      No invoices have been generated yet.
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
                            View invoice
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
        </div>

        {/* ── status + lifecycle + generate ─────────────────────────────── */}
        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4 shadow-sm" data-testid="contract-detail-summary">
            <div className="mb-3 flex items-center justify-between">
              <span
                className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${CONTRACT_STATUS_COLORS[contract.status]}`}
                data-testid="contract-detail-status"
              >
                {CONTRACT_STATUS_LABELS[contract.status]}
              </span>
              <span className="text-xs text-muted-foreground">{formatCadence(contract.intervalMonths)}</span>
            </div>
            <p className="text-sm text-muted-foreground">
              {canGenerate
                ? 'This contract is active and will generate invoices on its cadence.'
                : 'Invoices generate while the contract is active.'}
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
                    onClick={() => void transition(verb)}
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
                    {TRANSITION_LABELS[verb]}
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
              Generate invoice now
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
