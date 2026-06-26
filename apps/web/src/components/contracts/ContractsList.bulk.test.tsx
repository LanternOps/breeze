import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock fetchWithAuth — called directly for loadOrgs and bulk action POSTs.
const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

// Mock showToast to suppress UI side-effects.
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

// Mock navigateTo to prevent navigation side-effects.
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

// Grant all permissions so both bulk actions appear.
vi.mock('../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));

// Mock listContracts (used by loadContracts inside ContractsList).
const listContracts = vi.fn();
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/api/contracts')>();
  return { ...orig, listContracts: (...a: unknown[]) => listContracts(...a) };
});

import { ContractsList } from './ContractsList';

const json = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const C1 = '11111111-1111-1111-1111-111111111111';
const C2 = '22222222-2222-2222-2222-222222222222';

const CONTRACTS = [
  {
    id: C1,
    orgId: 'o1',
    partnerId: 'p1',
    name: 'Contract A',
    status: 'draft',
    intervalMonths: 1,
    currencyCode: 'USD',
    nextBillingAt: null,
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
    createdBy: null,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  },
  {
    id: C2,
    orgId: 'o1',
    partnerId: 'p1',
    name: 'Contract B',
    status: 'draft',
    intervalMonths: 1,
    currencyCode: 'USD',
    nextBillingAt: null,
    estimatedPeriodValue: '200.00',
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
  },
];

describe('ContractsList bulk actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // loadOrgs calls fetchWithAuth directly.
    fetchWithAuth.mockResolvedValue(json({ data: [] }));
    // loadContracts calls listContracts.
    listContracts.mockResolvedValueOnce(json({ data: CONTRACTS }));
  });

  it('selects rows and posts ids to /contracts/bulk-delete', async () => {
    render(<ContractsList />);
    await screen.findByTestId(`contract-row-${C1}`);

    fireEvent.click(screen.getByTestId(`contract-select-${C1}`));
    fireEvent.click(screen.getByTestId(`contract-select-${C2}`));

    // Wire bulk-delete response and subsequent refetch.
    fetchWithAuth.mockResolvedValueOnce(
      json({ data: { total: 2, succeeded: 2, skipped: 0, failed: 0, skippedReasons: {} } }),
    );
    listContracts.mockResolvedValueOnce(json({ data: [] }));

    fireEvent.click(screen.getByTestId('contracts-bulk-action-delete'));

    // Confirm dialog must appear before the request is sent.
    const confirmBtn = await screen.findByTestId('contracts-bulk-delete-confirm');
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find((c) => String(c[0]).includes('/contracts/bulk-delete'));
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string).ids).toEqual([C1, C2]);
    });
  });

  it('opens cancel confirm dialog and posts ids to /contracts/bulk-cancel', async () => {
    render(<ContractsList />);
    await screen.findByTestId(`contract-row-${C1}`);

    fireEvent.click(screen.getByTestId(`contract-select-${C1}`));

    // Click the Cancel bulk action to open the ConfirmDialog.
    fireEvent.click(screen.getByTestId('contracts-bulk-action-cancel'));

    // The confirm button should appear in the dialog.
    const confirmBtn = await screen.findByTestId('contracts-bulk-cancel-confirm');
    expect(confirmBtn).toBeInTheDocument();

    // Wire bulk-cancel response and subsequent refetch.
    fetchWithAuth.mockResolvedValueOnce(
      json({ data: { total: 1, succeeded: 1, skipped: 0, failed: 0, skippedReasons: {} } }),
    );
    listContracts.mockResolvedValueOnce(json({ data: [] }));

    fireEvent.click(confirmBtn);

    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find((c) => String(c[0]).includes('/contracts/bulk-cancel'));
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string).ids).toEqual([C1]);
    });
  });
});
