import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Mock fetchWithAuth — called directly for loadOrgs.
const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));

const listContracts = vi.fn();
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/api/contracts')>();
  return { ...orig, listContracts: (...a: unknown[]) => listContracts(...a) };
});

import { ContractsList } from './ContractsList';

const json = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const ACTIVE_CONTRACT = {
  id: '11111111-1111-1111-1111-111111111111',
  orgId: 'o1',
  partnerId: 'p1',
  name: 'Contract A',
  status: 'active',
  intervalMonths: 1,
  currencyCode: 'USD',
  nextBillingAt: '2026-02-01',
  estimatedPeriodValue: '100.00',
  billingTiming: 'advance',
  startDate: '2026-01-01',
  endDate: null,
  autoIssue: false,
  autoRenew: false,
  renewalTermMonths: null,
  renewalNoticeDays: null,
  notes: null,
  terms: null,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

describe('ContractsList — empty states & locked org', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    fetchWithAuth.mockResolvedValue(json({ data: [] }));
  });

  it('shows the first-run CTA (not "clear filters") when there are no contracts and no filters', async () => {
    listContracts.mockResolvedValue(json({ data: [] }));
    render(<ContractsList />);

    await screen.findByTestId('contracts-empty');
    expect(screen.getByTestId('contracts-empty-cta')).toBeInTheDocument();
    expect(screen.queryByTestId('contracts-clear-filters')).not.toBeInTheDocument();
  });

  it('shows "Clear filters" (not the first-run CTA) when an active filter returns nothing', async () => {
    // The list seeds its filter from the URL hash on mount.
    window.location.hash = '#status=draft';
    listContracts.mockResolvedValue(json({ data: [] }));
    render(<ContractsList />);

    await screen.findByTestId('contracts-empty');
    expect(screen.getByTestId('contracts-clear-filters')).toBeInTheDocument();
    expect(screen.queryByTestId('contracts-empty-cta')).not.toBeInTheDocument();
  });

  it('hides the Organization column when locked to an org (embedded view)', async () => {
    listContracts.mockResolvedValue(json({ data: [ACTIVE_CONTRACT] }));
    render(<ContractsList lockedOrgId="o1" />);

    await screen.findByTestId('contracts-list');
    expect(screen.queryByRole('columnheader', { name: 'Organization' })).not.toBeInTheDocument();
    // The org filter dropdown is also suppressed in the locked embed.
    expect(screen.queryByTestId('contracts-filter-org')).not.toBeInTheDocument();
  });
});
