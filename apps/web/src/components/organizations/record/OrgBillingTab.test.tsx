import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@/lib/i18n';
import OrgBillingTab from './OrgBillingTab';

// The three embedded pages are exercised by their own test suites (including
// their `lockedOrgId` behavior) — stub them here so this test proves only what
// OrgBillingTab itself is responsible for: mounting all three, locked to the
// record's org.
vi.mock('../../contracts/ContractsList', () => ({
  default: ({ lockedOrgId }: { lockedOrgId?: string }) => (
    <div data-testid="stub-contracts-list">contracts:{lockedOrgId}</div>
  ),
}));
vi.mock('../../billing/InvoicesPage', () => ({
  default: ({ lockedOrgId }: { lockedOrgId?: string }) => (
    <div data-testid="stub-invoices-page">invoices:{lockedOrgId}</div>
  ),
}));
vi.mock('../../billing/quotes/QuotesPage', () => ({
  default: ({ lockedOrgId }: { lockedOrgId?: string }) => (
    <div data-testid="stub-quotes-page">quotes:{lockedOrgId}</div>
  ),
}));

const ORG_ID = 'org-record-1';

describe('OrgBillingTab', () => {
  it('renders Contracts, Invoices and Quotes, each locked to the record org', () => {
    render(<OrgBillingTab orgId={ORG_ID} />);
    expect(screen.getByTestId('stub-contracts-list')).toHaveTextContent(`contracts:${ORG_ID}`);
    expect(screen.getByTestId('stub-invoices-page')).toHaveTextContent(`invoices:${ORG_ID}`);
    expect(screen.getByTestId('stub-quotes-page')).toHaveTextContent(`quotes:${ORG_ID}`);
  });

  it('renders Contracts first, then Invoices, then Quotes', () => {
    render(<OrgBillingTab orgId={ORG_ID} />);
    const sections = screen.getByTestId('org-billing-tab').querySelectorAll('details');
    expect(sections).toHaveLength(3);
    expect(sections[0]).toHaveAttribute('data-testid', 'org-billing-section-contracts');
    expect(sections[1]).toHaveAttribute('data-testid', 'org-billing-section-invoices');
    expect(sections[2]).toHaveAttribute('data-testid', 'org-billing-section-quotes');
  });

  it('opens all three sections by default', () => {
    render(<OrgBillingTab orgId={ORG_ID} />);
    for (const testId of ['org-billing-section-contracts', 'org-billing-section-invoices', 'org-billing-section-quotes']) {
      expect((screen.getByTestId(testId) as HTMLDetailsElement).open).toBe(true);
    }
  });
});
