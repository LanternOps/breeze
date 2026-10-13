import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

let perms: Record<string, boolean> = {};
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ can: (_r: string, a: string) => perms[a] ?? false }),
}));
const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import TicketApprovalsPanel from './TicketApprovalsPanel';
import type { ApprovalRequest, ApprovalSummary } from '../../lib/ticketApproval';

const eff = <T,>(value: T) => ({ value, source: 'org' as const });
function req(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'req-1', ticketId: 'tk-1', orgId: 'o-1', trigger: 'budget', origin: 'auto', status: 'pending',
    revision: 2, enforcement: 'soft', requestedAt: '2026-10-10T10:00:00Z', expiresAt: '2026-10-13T10:00:00Z',
    message: null, requestedExtensionMinutes: 60, requestedExtensionAmount: '150.00', currencyCode: 'EUR',
    coverageStartsAt: null, coverageEndsAt: null,
    approverEmails: ['boss@cust.example'], notifyEmails: ['fyi@cust.example'],
    decidedAt: null, decisionOrigin: null, signerName: null, signerEmail: null, decisionMethod: null,
    decisionReference: null, decisionNote: null, decidedRevision: null, approvedExtensionMinutes: null,
    approvedExtensionAmount: null, heldEntryCount: 2, requestedByUserName: 'Todd', decidedByUserName: null,
    ...over,
  };
}
function summaryWith(requests: ApprovalRequest[]): ApprovalSummary {
  return {
    policy: { enabled: eff(true), budgetTrigger: eff(true), afterHoursTrigger: eff(true), enforcement: eff<'soft' | 'hard'>('soft'), requestTtlHours: eff(72) },
    budget: { minutes: 120, amount: null, currency: null },
    consumed: { minutes: 0, amount: null },
    held: { minutes: 0, amount: null, entryCount: 0, unpricedEntryCount: 0 },
    approvedExtensions: { minutes: 0, amount: null },
    ceiling: { minutes: 120, amount: null },
    requests,
  };
}
const ok = (body: unknown = { data: {} }) => ({ ok: true, status: 200, json: async () => body }) as Response;

beforeEach(() => {
  perms = { write: true, record_approval: true };
  fetchWithAuth.mockReset();
  showToast.mockReset();
  fetchWithAuth.mockResolvedValue(ok());
});

describe('TicketApprovalsPanel', () => {
  it('splits approvers from notified recipients', () => {
    render(<TicketApprovalsPanel summary={summaryWith([req()])} onChanged={vi.fn()} />);
    expect(screen.getByTestId('approval-approvers-req-1').textContent).toContain('boss@cust.example');
    expect(screen.getByTestId('approval-approvers-req-1').textContent).not.toContain('fyi@cust.example');
    expect(screen.getByTestId('approval-notified-req-1').textContent).toContain('fyi@cust.example');
  });

  it('warns when a pending request has no approver', () => {
    render(<TicketApprovalsPanel summary={summaryWith([req({ approverEmails: [] })])} onChanged={vi.fn()} />);
    expect(screen.getByTestId('approval-no-approver-req-1').textContent).toMatch(/No approver on file/);
  });

  it('shows who recorded an on-behalf decision', () => {
    const r = req({
      status: 'approved', decisionOrigin: 'on_behalf', decidedByUserName: 'Todd', signerName: 'Pat Customer',
      decisionMethod: 'verbal', decisionReference: 'call 10/12',
    });
    render(<TicketApprovalsPanel summary={summaryWith([r])} onChanged={vi.fn()} />);
    const text = screen.getByTestId('approval-decision-req-1').textContent ?? '';
    expect(text).toContain('Recorded by Todd on behalf of Pat Customer');
    expect(text).toContain('call 10/12');
  });

  it('offers Cancel and Record decision on a pending request, Re-ask only on resolved requests with held time', () => {
    render(<TicketApprovalsPanel summary={summaryWith([
      req(),
      req({ id: 'req-2', status: 'expired' }),
      req({ id: 'req-3', status: 'denied', heldEntryCount: 0 }),
    ])} onChanged={vi.fn()} />);
    expect(screen.getByTestId('approval-cancel-req-1')).toBeTruthy();
    expect(screen.getByTestId('approval-record-req-1')).toBeTruthy();
    expect(screen.queryByTestId('approval-reask-req-1')).toBeNull();
    expect(screen.getByTestId('approval-reask-req-2')).toBeTruthy();
    expect(screen.queryByTestId('approval-cancel-req-2')).toBeNull();
    expect(screen.queryByTestId('approval-reask-req-3')).toBeNull();
  });

  it('hides Record decision without tickets:record_approval and every action without tickets:write', () => {
    perms = { write: true };
    const { unmount } = render(<TicketApprovalsPanel summary={summaryWith([req()])} onChanged={vi.fn()} />);
    expect(screen.queryByTestId('approval-record-req-1')).toBeNull();
    expect(screen.getByTestId('approval-cancel-req-1')).toBeTruthy();
    unmount();
    perms = {};
    render(<TicketApprovalsPanel summary={summaryWith([req()])} onChanged={vi.fn()} />);
    expect(screen.queryByTestId('approval-cancel-req-1')).toBeNull();
  });

  it('cancels after a confirm step', async () => {
    const onChanged = vi.fn();
    render(<TicketApprovalsPanel summary={summaryWith([req()])} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('approval-cancel-req-1'));
    expect(fetchWithAuth).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('approval-cancel-confirm'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = fetchWithAuth.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/ticket-approval-requests/req-1/cancel');
    expect(init.method).toBe('POST');
  });

  it('re-asks through the reask endpoint', async () => {
    const onChanged = vi.fn();
    render(<TicketApprovalsPanel summary={summaryWith([req({ status: 'expired' })])} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('approval-reask-req-1'));
    fireEvent.click(screen.getByTestId('approval-reask-submit-req-1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetchWithAuth.mock.calls[0][0]).toBe('/ticket-approval-requests/req-1/reask');
  });

  it('renders nothing when there are no requests', () => {
    const { container } = render(<TicketApprovalsPanel summary={summaryWith([])} onChanged={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});
