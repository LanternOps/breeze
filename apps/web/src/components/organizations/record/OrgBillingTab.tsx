import { useTranslation } from 'react-i18next';
import { usePermissions } from '@/lib/permissions';
import ContractsList from '../../contracts/ContractsList';
import InvoicesPage from '../../billing/InvoicesPage';
import QuotesPage from '../../billing/quotes/QuotesPage';
import SignedAgreementsPage from '../../agreements/SignedAgreementsPage';

export interface OrgBillingTabProps {
  orgId: string;
}

/**
 * The record's Contracts & Billing tab (#5075 W03).
 *
 * Stacks the four existing full-page components, each locked to the
 * record's org via `lockedOrgId` (Task 3.2) — no bespoke fetching here, so the
 * embed inherits every one of those pages' behaviors (bulk actions, currency
 * handling, access-denied states, …) instead of a second, thinner
 * implementation to keep in sync.
 *
 * All four stay mounted regardless of collapse state (a native
 * `<details>`/`<summary>` only toggles visibility), so opening this tab always
 * loads all four lists — matching the cost of opening the equivalent
 * standalone pages, just combined into one screen.
 *
 * Each section is gated on its OWN read grant. `orgRecordTabs.ts`'s
 * `TAB_PERMISSION.billing` is deliberately an ANY-of (contracts:read OR
 * invoices:read OR quotes:read OR agreements:read) so a user with only one of those still sees
 * the tab — which means a user with exactly one grant would otherwise see
 * that one working section flanked by `AccessDenied` panels from the
 * embedded pages' own gating. Checking `can(...)` here before mounting a
 * section avoids ever rendering that combination.
 */
export default function OrgBillingTab({ orgId }: OrgBillingTabProps) {
  const { t } = useTranslation('organizations');
  const { can } = usePermissions();

  const showContracts = can('contracts', 'read');
  const showInvoices = can('invoices', 'read');
  const showQuotes = can('quotes', 'read');
  const showAgreements = can('agreements', 'read');

  return (
    <div data-testid="org-billing-tab" className="space-y-4">
      {showContracts && (
        <details open className="rounded-lg border bg-card" data-testid="org-billing-section-contracts">
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold">
            {t('orgRecord.billing.sections.contracts')}
          </summary>
          <div className="border-t px-4 py-4">
            <ContractsList lockedOrgId={orgId} />
          </div>
        </details>
      )}
      {showInvoices && (
        <details open className="rounded-lg border bg-card" data-testid="org-billing-section-invoices">
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold">
            {t('orgRecord.billing.sections.invoices')}
          </summary>
          <div className="border-t px-4 py-4">
            <InvoicesPage lockedOrgId={orgId} />
          </div>
        </details>
      )}
      {showQuotes && (
        <details open className="rounded-lg border bg-card" data-testid="org-billing-section-quotes">
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold">
            {t('orgRecord.billing.sections.quotes')}
          </summary>
          <div className="border-t px-4 py-4">
            <QuotesPage lockedOrgId={orgId} />
          </div>
        </details>
      )}
      {showAgreements && (
        <details open className="rounded-lg border bg-card" data-testid="org-billing-section-agreements">
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold">
            {t('orgRecord.billing.sections.agreements')}
          </summary>
          <div className="border-t px-4 py-4">
            {/* Everything this org has signed — NOT just the unlinked ones. The
                "Unlinked only" chip is a triage tool for the standalone page
                (spec §6 + W03 scope decision 2); on a customer record the
                question is "what has this customer agreed to". */}
            <SignedAgreementsPage lockedOrgId={orgId} />
          </div>
        </details>
      )}
    </div>
  );
}
