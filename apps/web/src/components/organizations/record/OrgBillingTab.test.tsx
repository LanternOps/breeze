import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@/lib/i18n';
import OrgBillingTab from './OrgBillingTab';
import type { InvoicesPageProps } from '../../billing/InvoicesPage';
import type { QuotesPageProps } from '../../billing/quotes/QuotesPage';

// The three embedded pages are exercised by their own test suites (including
// their `lockedOrgId` behavior) — stub them here so this test proves only what
// OrgBillingTab itself is responsible for: mounting all three, locked to the
// record's org, gated on each one's own read grant.
vi.mock('../../contracts/ContractsList', () => ({
  default: ({ lockedOrgId }: { lockedOrgId?: string }) => (
    <div data-testid="stub-contracts-list">contracts:{lockedOrgId}</div>
  ),
}));
vi.mock('../../billing/InvoicesPage', () => ({
  default: ({ lockedOrgId }: InvoicesPageProps) => (
    <div data-testid="stub-invoices-page">invoices:{lockedOrgId}</div>
  ),
}));
vi.mock('../../billing/quotes/QuotesPage', () => ({
  default: ({ lockedOrgId }: QuotesPageProps) => (
    <div data-testid="stub-quotes-page">quotes:{lockedOrgId}</div>
  ),
}));

type Perm = { resource: string; action: string };
const grantedPermissions = vi.hoisted(() => ({ current: [{ resource: '*', action: '*' }] as Perm[] }));
vi.mock('@/lib/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/permissions')>();
  return {
    ...actual,
    usePermissions: () => ({
      permissions: grantedPermissions.current,
      can: (resource: string, action: string) =>
        actual.hasPermission(grantedPermissions.current as never, resource as never, action as never),
    }),
  };
});

const ORG_ID = 'org-record-1';

describe('OrgBillingTab', () => {
  it('renders Contracts, Invoices and Quotes, each locked to the record org, for a user with every grant', () => {
    grantedPermissions.current = [{ resource: '*', action: '*' }];
    render(<OrgBillingTab orgId={ORG_ID} />);
    expect(screen.getByTestId('stub-contracts-list')).toHaveTextContent(`contracts:${ORG_ID}`);
    expect(screen.getByTestId('stub-invoices-page')).toHaveTextContent(`invoices:${ORG_ID}`);
    expect(screen.getByTestId('stub-quotes-page')).toHaveTextContent(`quotes:${ORG_ID}`);
  });

  it('renders Contracts first, then Invoices, then Quotes', () => {
    grantedPermissions.current = [{ resource: '*', action: '*' }];
    render(<OrgBillingTab orgId={ORG_ID} />);
    const sections = screen.getByTestId('org-billing-tab').querySelectorAll('details');
    expect(sections).toHaveLength(3);
    expect(sections[0]).toHaveAttribute('data-testid', 'org-billing-section-contracts');
    expect(sections[1]).toHaveAttribute('data-testid', 'org-billing-section-invoices');
    expect(sections[2]).toHaveAttribute('data-testid', 'org-billing-section-quotes');
  });

  it('opens all three sections by default', () => {
    grantedPermissions.current = [{ resource: '*', action: '*' }];
    render(<OrgBillingTab orgId={ORG_ID} />);
    for (const testId of ['org-billing-section-contracts', 'org-billing-section-invoices', 'org-billing-section-quotes']) {
      expect((screen.getByTestId(testId) as HTMLDetailsElement).open).toBe(true);
    }
  });

  // A user holding only ONE of the tab's ANY-of grants (orgRecordTabs.ts's
  // TAB_PERMISSION.billing) must see exactly that one section — never the
  // other two rendered as AccessDenied panels beside it (#5110 review).
  it('shows only the Invoices section for a user with invoices:read alone', () => {
    grantedPermissions.current = [{ resource: 'invoices', action: 'read' }];
    render(<OrgBillingTab orgId={ORG_ID} />);
    expect(screen.queryByTestId('stub-contracts-list')).not.toBeInTheDocument();
    expect(screen.getByTestId('stub-invoices-page')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-quotes-page')).not.toBeInTheDocument();
  });

  it('shows only the Quotes section for a user with quotes:read alone', () => {
    grantedPermissions.current = [{ resource: 'quotes', action: 'read' }];
    render(<OrgBillingTab orgId={ORG_ID} />);
    expect(screen.queryByTestId('stub-contracts-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stub-invoices-page')).not.toBeInTheDocument();
    expect(screen.getByTestId('stub-quotes-page')).toBeInTheDocument();
  });

  // The docblock's stated contract: collapsing a section only hides it, it
  // never unmounts the embedded page — so its fetch and list state survive a
  // collapse/re-expand instead of re-loading from scratch.
  it('keeps a collapsed section mounted rather than unmounting it', () => {
    grantedPermissions.current = [{ resource: '*', action: '*' }];
    render(<OrgBillingTab orgId={ORG_ID} />);
    const invoicesSection = screen.getByTestId('org-billing-section-invoices') as HTMLDetailsElement;
    expect(invoicesSection.open).toBe(true);
    fireEvent.click(invoicesSection.querySelector('summary')!);
    expect(invoicesSection.open).toBe(false);
    // Still in the DOM — collapsing toggles `open`, not React unmount.
    expect(screen.getByTestId('stub-invoices-page')).toBeInTheDocument();
  });
});
