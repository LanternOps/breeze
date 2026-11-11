import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// #10361: a draft contract created by a quote accept must be distinguishable
// from a hand-started draft in the contracts list.
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
import { navigateTo } from '@/lib/navigation';

const json = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const base = {
  partnerId: 'p1', orgId: 'o1', billingTiming: 'advance' as const, currencyCode: 'USD', endDate: null,
  autoIssue: false, autoRenew: false, renewalTermMonths: null, renewalNoticeDays: null, createdBy: null,
  notes: null, terms: null, createdAt: '2026-01-01', updatedAt: '2026-01-01', autopayExcluded: false,
  intervalMonths: 1, nextBillingAt: null, startDate: '2026-11-01', estimatedPeriodValue: '150.00',
};
const QUOTE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const FROM_QUOTE_DRAFT = {
  ...base, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Managed services — Acme (Monthly)', status: 'draft' as const,
  sourceQuoteId: QUOTE_ID, sourceQuote: { id: QUOTE_ID, quoteNumber: 'Q-2026-0042' },
};
const HAND_DRAFT = {
  ...base, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Hand-built draft', status: 'draft' as const,
  sourceQuoteId: null, sourceQuote: null,
};
const FROM_QUOTE_ACTIVE = {
  ...base, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Live from quote', status: 'active' as const,
  sourceQuoteId: QUOTE_ID, sourceQuote: { id: QUOTE_ID, quoteNumber: 'Q-2026-0042' },
};
const UNNUMBERED_DRAFT = {
  ...base, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Unnumbered', status: 'draft' as const,
  sourceQuoteId: QUOTE_ID, sourceQuote: { id: QUOTE_ID, quoteNumber: null },
};

describe('ContractsList — quote-sourced drafts (#10361)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    fetchWithAuth.mockResolvedValue(json({ data: [{ id: 'o1', name: 'Acme Corp' }] }));
  });

  it('marks a draft created by a quote accept, links its quote, and leaves other rows unmarked', async () => {
    listContracts.mockResolvedValue(json({ data: [FROM_QUOTE_DRAFT, HAND_DRAFT, FROM_QUOTE_ACTIVE, UNNUMBERED_DRAFT] }));
    render(<ContractsList />);
    await screen.findByTestId('contracts-list');

    const chip = screen.getByTestId(`contract-from-quote-${FROM_QUOTE_DRAFT.id}`);
    expect(chip).toHaveTextContent('From Q-2026-0042 · ready to activate');
    expect(chip).toHaveAttribute('href', `/billing/quotes/${QUOTE_ID}`);

    // The chip is a link of its own: clicking it must not also open the contract row.
    fireEvent.click(chip);
    expect(navigateTo).not.toHaveBeenCalled();

    expect(screen.getByTestId(`contract-from-quote-${UNNUMBERED_DRAFT.id}`)).toHaveTextContent('From a quote · ready to activate');
    expect(screen.queryByTestId(`contract-from-quote-${HAND_DRAFT.id}`)).not.toBeInTheDocument();
    // Activated: no longer pending, so no "ready to activate" marker.
    expect(screen.queryByTestId(`contract-from-quote-${FROM_QUOTE_ACTIVE.id}`)).not.toBeInTheDocument();
  });

  it('tolerates an older payload with no sourceQuote field', async () => {
    const { sourceQuote: _sq, sourceQuoteId: _id, ...legacy } = FROM_QUOTE_DRAFT;
    listContracts.mockResolvedValue(json({ data: [legacy] }));
    render(<ContractsList />);
    await screen.findByTestId('contracts-list');
    expect(screen.getByTestId(`contract-row-${legacy.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`contract-from-quote-${legacy.id}`)).not.toBeInTheDocument();
  });
});
