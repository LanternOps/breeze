import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { RelatedContract } from '@breeze/shared';
import '@/lib/i18n';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { formatMoney } from '../billing/invoiceTypes';

/**
 * #9303: a quote accept creates its own draft contract and never looks at the
 * org's existing ones, so a hand-built draft for the same services can sit next
 * to it unseen. This notice names the org's other draft/active/paused contracts
 * on the contract page, and turns prominent when one bills on the same cadence
 * over an overlapping term. Warn-and-confirm only: several live contracts per
 * org are legitimate (per-site, per-service), so nothing here blocks anything.
 *
 * Mounted inside ContractDetail and ContractEditor (not the workspace shell) so
 * it sits next to the Activate button whichever of the two renders.
 */

/** Siblings that would double-bill alongside this contract. */
export function overlappingSiblings(related: RelatedContract[] | undefined): RelatedContract[] {
  return (related ?? []).filter((r) => r.overlapsCadence);
}

function cadenceLabel(t: TFunction, intervalMonths: number): string {
  if (intervalMonths === 1) return t('contracts.shared.cadence.monthly');
  if (intervalMonths === 3) return t('contracts.shared.cadence.quarterly');
  if (intervalMonths === 12) return t('contracts.shared.cadence.annual');
  return t('contracts.shared.cadence.custom', { count: intervalMonths });
}

export default function RelatedContractsNotice({ related }: { related: RelatedContract[] | undefined }) {
  const { t } = useTranslation('billing');
  if (!related || related.length === 0) return null;
  const overlap = related.some((r) => r.overlapsCadence);
  const tone = overlap
    ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200'
    : 'bg-card';
  return (
    <section
      className={`rounded-lg border p-4 text-sm shadow-xs ${tone}`}
      data-testid="contract-related-notice"
      role={overlap ? 'alert' : undefined}
    >
      <h3 className="font-semibold">{t('contracts.relatedNotice.title', { count: related.length })}</h3>
      {overlap && (
        <p className="mt-1" data-testid="contract-related-overlap-warning">
          {t('contracts.relatedNotice.overlapWarning')}
        </p>
      )}
      <ul className="mt-3 space-y-2">
        {related.map((r) => (
          <li key={r.id} data-testid={`contract-related-item-${r.id}`}>
            <a
              href={`/contracts/${r.id}`}
              data-testid={`contract-related-link-${r.id}`}
              className="font-medium text-primary hover:underline"
            >
              {r.name}
            </a>
            {r.overlapsCadence && (
              <span className="ml-2 rounded-full bg-amber-200 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900/60 dark:text-amber-100">
                {t('contracts.relatedNotice.sameCadence')}
              </span>
            )}
            <span className="block text-xs text-muted-foreground">
              {[
                t(/* i18n-dynamic */ `contracts.shared.status.${r.status}`),
                cadenceLabel(t, r.intervalMonths),
                // null = not computable (a device group that failed to
                // evaluate or was deleted) — say so instead of omitting it.
                r.recurringTotal !== null
                  ? t('contracts.relatedNotice.perPeriod', { amount: formatMoney(r.recurringTotal, r.currencyCode) })
                  : t('contracts.relatedNotice.estimateUnavailable'),
                t('contracts.relatedNotice.deliverables', { count: r.deliverableCount }),
                t('contracts.relatedNotice.signedAgreements', { count: r.signedAgreementCount }),
              ].join(' · ')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The Activate confirm shown when `siblings` (the overlapping ones) is
 *  non-empty. The caller owns open state and the transition itself. */
export function ActivateOverlapConfirm({
  open, siblings, busy, onClose, onConfirm,
}: {
  open: boolean;
  siblings: RelatedContract[];
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('billing');
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      isLoading={busy}
      variant="warning"
      title={t('contracts.relatedNotice.activateConfirm.title')}
      message={t('contracts.relatedNotice.activateConfirm.message')}
      confirmLabel={t('contracts.relatedNotice.activateConfirm.confirm')}
      confirmTestId="contract-activate-overlap-confirm-btn"
      dialogTestId="contract-activate-overlap-confirm"
    >
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {siblings.map((s) => (
          <li key={s.id}>
            <a href={`/contracts/${s.id}`} className="text-primary hover:underline">{s.name}</a>
            {' '}
            <span className="text-muted-foreground">({t(/* i18n-dynamic */ `contracts.shared.status.${s.status}`)})</span>
          </li>
        ))}
      </ul>
    </ConfirmDialog>
  );
}
