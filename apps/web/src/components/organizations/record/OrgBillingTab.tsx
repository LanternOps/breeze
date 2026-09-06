import { useTranslation } from 'react-i18next';
import ContractsList from '../../contracts/ContractsList';
import InvoicesPage from '../../billing/InvoicesPage';
import QuotesPage from '../../billing/quotes/QuotesPage';

export interface OrgBillingTabProps {
  orgId: string;
}

/**
 * The record's Contracts & Billing tab (#5075 W03).
 *
 * Stacks the three existing full-page components, each locked to the
 * record's org via `lockedOrgId` (Task 3.2) — no bespoke fetching here, so the
 * embed inherits every one of those pages' behaviors (bulk actions, currency
 * handling, access-denied states, …) instead of a second, thinner
 * implementation to keep in sync.
 *
 * All three stay mounted regardless of collapse state (a native
 * `<details>`/`<summary>` only toggles visibility), so opening this tab always
 * loads all three lists — matching the cost of opening the equivalent
 * standalone pages, just combined into one screen.
 */
export default function OrgBillingTab({ orgId }: OrgBillingTabProps) {
  const { t } = useTranslation('organizations');

  return (
    <div data-testid="org-billing-tab" className="space-y-4">
      <details open className="rounded-lg border bg-card" data-testid="org-billing-section-contracts">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold">
          {t('orgRecord.billing.sections.contracts')}
        </summary>
        <div className="border-t px-4 py-4">
          <ContractsList lockedOrgId={orgId} />
        </div>
      </details>
      <details open className="rounded-lg border bg-card" data-testid="org-billing-section-invoices">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold">
          {t('orgRecord.billing.sections.invoices')}
        </summary>
        <div className="border-t px-4 py-4">
          <InvoicesPage lockedOrgId={orgId} />
        </div>
      </details>
      <details open className="rounded-lg border bg-card" data-testid="org-billing-section-quotes">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold">
          {t('orgRecord.billing.sections.quotes')}
        </summary>
        <div className="border-t px-4 py-4">
          <QuotesPage lockedOrgId={orgId} />
        </div>
      </details>
    </div>
  );
}
