import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ can: () => true }),
}));
const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import TicketApprovalRail from './TicketApprovalRail';
import { notifyApprovalChanged, type ApprovalSummary } from '../../lib/ticketApproval';

const eff = <T,>(value: T) => ({ value, source: 'org' as const });
const summary: ApprovalSummary = {
  policy: {
    enabled: eff(true), budgetTrigger: eff(true), afterHoursTrigger: eff(true),
    enforcement: eff<'soft' | 'hard'>('soft'), requestTtlHours: eff(72),
  },
  budget: { minutes: 120, amount: null, currency: null },
  consumed: { minutes: 90, amount: null },
  held: { minutes: 0, amount: null, entryCount: 0, unpricedEntryCount: 0 },
  approvedExtensions: { minutes: 0, amount: null },
  ceiling: { minutes: 120, amount: null },
  requests: [],
};
const okRes = () => ({ ok: true, status: 200, json: async () => ({ data: summary }) }) as Response;
const failRes = (status: number) => ({ ok: false, status, json: async () => ({}) }) as Response;

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchWithAuth.mockReset();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('TicketApprovalRail load states', () => {
  it('shows the error row with Retry on a 500, even with no previous summary', async () => {
    fetchWithAuth.mockResolvedValue(failRes(500));
    render(<TicketApprovalRail ticketId="tk-1" />);
    expect(await screen.findByTestId('ticket-approval-load-error')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-approval-retry')).toBeInTheDocument();
    expect(warn).toHaveBeenCalled();
  });

  it('Retry reloads and replaces the error row with the cards', async () => {
    fetchWithAuth.mockResolvedValueOnce(failRes(500)).mockResolvedValue(okRes());
    render(<TicketApprovalRail ticketId="tk-1" />);
    fireEvent.click(await screen.findByTestId('ticket-approval-retry'));
    await waitFor(() => expect(screen.queryByTestId('ticket-approval-load-error')).toBeNull());
    expect(screen.getByTestId('ticket-budget-ceiling')).toBeInTheDocument();
  });

  it.each([403, 404])('renders nothing on a %i (approvals not applicable)', async (status) => {
    fetchWithAuth.mockResolvedValue(failRes(status));
    const { container } = render(<TicketApprovalRail ticketId="tk-1" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('ticket-approval-load-error')).toBeNull();
  });

  it('keeps the cards on screen when a background reload fails', async () => {
    fetchWithAuth.mockResolvedValueOnce(okRes()).mockResolvedValue(failRes(500));
    render(<TicketApprovalRail ticketId="tk-1" />);
    await screen.findByTestId('ticket-budget-ceiling');
    act(() => notifyApprovalChanged());
    expect(await screen.findByTestId('ticket-approval-load-error')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-budget-ceiling')).toBeInTheDocument();
  });
});
