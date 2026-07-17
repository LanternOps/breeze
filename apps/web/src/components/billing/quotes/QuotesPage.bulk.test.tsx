import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock fetchWithAuth for loadOrgs (called directly) and bulk action calls.
const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a), registerOrgIdProvider: vi.fn() }));

// Mock showToast to suppress UI side-effects.
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

// Mock navigateTo to prevent navigation side-effects.
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

// Grant all permissions so both bulk actions appear.
vi.mock('../../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));

// Mock listQuotes (used by loadQuotes inside QuotesPage) and createQuote.
const listQuotes = vi.fn();
vi.mock('../../../lib/api/quotes', () => ({
  listQuotes: (...a: unknown[]) => listQuotes(...a),
  createQuote: vi.fn(),
}));

import { QuotesPage } from './QuotesPage';

const json = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const Q1 = '11111111-1111-1111-1111-111111111111';
const Q2 = '22222222-2222-2222-2222-222222222222';

describe('QuotesPage bulk delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // loadOrgs calls fetchWithAuth directly.
    fetchWithAuth.mockResolvedValueOnce(json({ data: [] }));
    // loadQuotes calls listQuotes which wraps fetchWithAuth.
    listQuotes.mockResolvedValueOnce(
      json({
        data: [
          { id: Q1, orgId: 'o1', status: 'draft', total: '10', currencyCode: 'USD', createdAt: '2026-06-01' },
          { id: Q2, orgId: 'o1', status: 'draft', total: '20', currencyCode: 'USD', createdAt: '2026-06-02' },
        ],
      }),
    );
  });

  it('selects rows and posts ids to /quotes/bulk-delete', async () => {
    render(<QuotesPage />);
    await screen.findByTestId(`quotes-row-${Q1}`);

    fireEvent.click(screen.getByTestId(`quotes-select-${Q1}`));
    fireEvent.click(screen.getByTestId(`quotes-select-${Q2}`));

    // bulk-delete response + refetch response
    fetchWithAuth.mockResolvedValueOnce(
      json({ data: { total: 2, succeeded: 2, skipped: 0, failed: 0, skippedReasons: {} } }),
    );
    listQuotes.mockResolvedValueOnce(json({ data: [] }));

    fireEvent.click(screen.getByTestId('quotes-bulk-action-delete'));

    // Confirm dialog must appear before the request is sent.
    const confirmBtn = await screen.findByTestId('quotes-bulk-delete-confirm');
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find((c) => String(c[0]).includes('/quotes/bulk-delete'));
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string).ids).toEqual([Q1, Q2]);
    });
  });
});
