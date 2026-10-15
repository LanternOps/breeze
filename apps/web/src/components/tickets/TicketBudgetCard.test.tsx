import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

let canWrite = true;
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ can: (_r: string, a: string) => (a === 'write' ? canWrite : false) }),
}));
const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import TicketBudgetCard from './TicketBudgetCard';
import type { ApprovalSummary } from '../../lib/ticketApproval';

const eff = <T,>(value: T) => ({ value, source: 'org' as const });
function makeSummary(over: Partial<ApprovalSummary> = {}): ApprovalSummary {
  return {
    policy: {
      enabled: eff(true), budgetTrigger: eff(true), afterHoursTrigger: eff(true),
      enforcement: eff<'soft' | 'hard'>('soft'), requestTtlHours: eff(72),
    },
    budget: { minutes: 120, amount: null, currency: null },
    consumed: { minutes: 90, amount: null },
    held: { minutes: 30, amount: null, entryCount: 1, unpricedEntryCount: 0 },
    approvedExtensions: { minutes: 60, amount: null },
    ceiling: { minutes: 180, amount: null },
    requests: [],
    ...over,
  };
}
const ok = (body: unknown = { data: {} }) => ({ ok: true, status: 200, json: async () => body }) as Response;

beforeEach(() => {
  canWrite = true;
  fetchWithAuth.mockReset();
  showToast.mockReset();
  fetchWithAuth.mockResolvedValue(ok());
});

describe('TicketBudgetCard', () => {
  it('shows the ceiling including approved extensions (budget 120 + 60 approved = 3h)', () => {
    render(<TicketBudgetCard ticketId="tk-1" summary={makeSummary()} onChanged={vi.fn()} />);
    const ceiling = screen.getByTestId('ticket-budget-ceiling').textContent ?? '';
    expect(ceiling).toContain('3h');
    expect(ceiling).toContain('2h');
    expect(ceiling).toContain('1h');
  });

  it('renders held time as its own segment next to the consumed segment', () => {
    render(<TicketBudgetCard ticketId="tk-1" summary={makeSummary()} onChanged={vi.fn()} />);
    const consumed = screen.getByTestId('ticket-budget-bar-consumed');
    const held = screen.getByTestId('ticket-budget-bar-held');
    expect(consumed).not.toBe(held);
    // 90 / 180 and 30 / 180 of the ceiling.
    expect(parseFloat(consumed.style.width)).toBeCloseTo(50, 5);
    expect(parseFloat(held.style.width)).toBeCloseTo(16.6667, 3);
  });

  it('renders nothing when approvals are off, no budget and no requests', () => {
    const s = makeSummary({
      policy: { ...makeSummary().policy, enabled: eff(false) },
      budget: { minutes: null, amount: null, currency: null },
      ceiling: { minutes: null, amount: null },
      held: { minutes: 0, amount: null, entryCount: 0, unpricedEntryCount: 0 },
      approvedExtensions: { minutes: 0, amount: null },
    });
    const { container } = render(<TicketBudgetCard ticketId="tk-1" summary={s} onChanged={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('saves a changed hours value as minutes through PATCH and clears an emptied axis with null', async () => {
    const onChanged = vi.fn();
    render(<TicketBudgetCard ticketId="tk-1" summary={makeSummary()} onChanged={onChanged} />);
    fireEvent.change(screen.getByTestId('ticket-budget-hours'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByTestId('ticket-budget-save'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = fetchWithAuth.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/tickets/tk-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ budgetMinutes: 150 });

    fetchWithAuth.mockClear();
    fireEvent.change(screen.getByTestId('ticket-budget-hours'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('ticket-budget-save'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(JSON.parse((fetchWithAuth.mock.calls[0][1] as RequestInit).body as string)).toEqual({ budgetMinutes: null });
  });

  it('rejects an amount with more than two decimals without calling the API', () => {
    render(<TicketBudgetCard ticketId="tk-1" summary={makeSummary()} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ticket-budget-amount'), { target: { value: '10.123' } });
    fireEvent.click(screen.getByTestId('ticket-budget-save'));
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(screen.getByTestId('ticket-budget-error')).toBeTruthy();
  });

  it('is read-only without tickets:write', () => {
    canWrite = false;
    render(<TicketBudgetCard ticketId="tk-1" summary={makeSummary()} onChanged={vi.fn()} />);
    expect(screen.queryByTestId('ticket-budget-save')).toBeNull();
    expect(screen.queryByTestId('ticket-budget-request-toggle')).toBeNull();
    expect((screen.getByTestId('ticket-budget-hours') as HTMLInputElement).readOnly).toBe(true);
  });

  it('posts an approval request with the extension and trigger', async () => {
    const onChanged = vi.fn();
    render(<TicketBudgetCard ticketId="tk-1" summary={makeSummary()} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('ticket-budget-request-toggle'));
    fireEvent.change(screen.getByTestId('ticket-budget-request-extension-minutes'), { target: { value: '60' } });
    fireEvent.change(screen.getByTestId('ticket-budget-request-message'), { target: { value: 'More diag' } });
    fireEvent.click(screen.getByTestId('ticket-budget-request-submit'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = fetchWithAuth.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/tickets/tk-1/approval-requests');
    expect(JSON.parse(init.body as string)).toEqual({ trigger: 'budget', extensionMinutes: 60, message: 'More diag' });
  });

  it('requires a positive extension for a budget request', () => {
    render(<TicketBudgetCard ticketId="tk-1" summary={makeSummary()} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ticket-budget-request-toggle'));
    fireEvent.click(screen.getByTestId('ticket-budget-request-submit'));
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(screen.getByTestId('ticket-budget-request-error')).toBeTruthy();
  });
});
