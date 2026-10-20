import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { RelatedContract } from '@breeze/shared';
import '@/lib/i18n';
import { navigateTo } from '@/lib/navigation';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { formatMoney } from '../billing/invoiceTypes';
import { adoptDraftContract } from '../../lib/api/contracts';
import { ActionError, handleActionError, runAction } from '../../lib/runAction';

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

/**
 * #9346: what the viewed contract needs to fold a sibling DRAFT into itself.
 * The parent passes it only when the viewer has contracts:write and the viewed
 * contract is draft or active (the states the API accepts as a target);
 * otherwise no draft row offers the action.
 */
export interface AdoptDraftProps {
  contractId: string;
  /** Called after a successful adopt — or when the draft turned out to be gone
   *  or no longer a draft — so the parent re-reads the contract and anything
   *  listing its deliverables or agreements. */
  onAdopted: () => void;
}

export default function RelatedContractsNotice({
  related, adopt,
}: { related: RelatedContract[] | undefined; adopt?: AdoptDraftProps }) {
  const { t } = useTranslation('billing');
  const [adopting, setAdopting] = useState<RelatedContract | null>(null);
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
            {adopt && r.status === 'draft' && (
              <button
                type="button"
                onClick={() => setAdopting(r)}
                data-testid={`contract-related-adopt-${r.id}`}
                className="mt-1 text-xs font-medium text-primary hover:underline"
              >
                {t('contracts.relatedNotice.adopt.action')}
              </button>
            )}
          </li>
        ))}
      </ul>
      {adopt && adopting && (
        <AdoptDraftConfirm
          source={adopting}
          contractId={adopt.contractId}
          onClose={() => setAdopting(null)}
          onAdopted={() => { setAdopting(null); adopt.onAdopted(); }}
        />
      )}
    </section>
  );
}

/** 409 DUPLICATE_NAME carries `details.names`: the deliverable names the draft
 *  shares with this contract. */
function collisionNames(err: unknown): string[] | null {
  if (!(err instanceof ActionError) || err.code !== 'DUPLICATE_NAME') return null;
  const names = (err.body as { details?: { names?: unknown } } | undefined)?.details?.names;
  const list = Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : [];
  return list.length > 0 ? list : null;
}

/** The draft is gone or no longer a draft (another tab adopted, deleted or
 *  activated it): the notice is stale, so close and re-read instead of letting
 *  Confirm fail again. */
function draftIsStale(err: unknown): boolean {
  return err instanceof ActionError && (err.code === 'CONTRACT_NOT_FOUND' || err.code === 'ADOPT_SOURCE_NOT_DRAFT');
}

/** Confirm for folding `source` (a draft) into contract `contractId`: says what
 *  moves, that lines are not copied, and that the draft is deleted. A name
 *  collision keeps the dialog open and names the deliverables to rename. */
function AdoptDraftConfirm({
  source, contractId, onClose, onAdopted,
}: {
  source: RelatedContract;
  contractId: string;
  onClose: () => void;
  onAdopted: () => void;
}) {
  const { t } = useTranslation('billing');
  const [busy, setBusy] = useState(false);
  const [collision, setCollision] = useState<string[] | null>(null);
  const errorFallback = t('contracts.relatedNotice.adopt.error');

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setCollision(null);
    let refresh = false;
    try {
      await runAction({
        request: () => adoptDraftContract(contractId, source.id),
        errorFallback,
        successMessage: t('contracts.relatedNotice.adopt.success', { name: source.name }),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      refresh = true;
    } catch (err) {
      const names = collisionNames(err);
      if (names) setCollision(names);
      refresh = draftIsStale(err);
      handleActionError(err, errorFallback);
    } finally {
      setBusy(false);
    }
    // Outside the try: a throw from the parent's refresh must not toast
    // "could not fold" for an adopt that already succeeded.
    if (refresh) onAdopted();
  };

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      onConfirm={() => void confirm()}
      isLoading={busy}
      variant="destructive"
      title={t('contracts.relatedNotice.adopt.title', { name: source.name })}
      message={t('contracts.relatedNotice.adopt.message', { name: source.name })}
      confirmLabel={t('contracts.relatedNotice.adopt.confirm')}
      confirmTestId="contract-adopt-draft-confirm-btn"
      dialogTestId="contract-adopt-draft-confirm"
    >
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {source.deliverableCount > 0 && (
          <li>{t('contracts.relatedNotice.adopt.deliverables', { count: source.deliverableCount })}</li>
        )}
        {source.signedAgreementCount > 0 && (
          <li>{t('contracts.relatedNotice.adopt.agreements', { count: source.signedAgreementCount })}</li>
        )}
        <li>{t('contracts.relatedNotice.adopt.noLines')}</li>
        <li className="font-medium">{t('contracts.relatedNotice.adopt.deleted', { name: source.name })}</li>
      </ul>
      {collision && (
        <p className="mt-3 text-sm text-destructive" role="alert" data-testid="contract-adopt-draft-collision">
          {t('contracts.relatedNotice.adopt.collision', { names: collision.join(', ') })}
        </p>
      )}
    </ConfirmDialog>
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
