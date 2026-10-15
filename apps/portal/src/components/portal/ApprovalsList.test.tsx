// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';

const getApprovals = vi.fn();
vi.mock('@/lib/api', () => ({
  portalApi: {
    getApprovals: (...a: unknown[]) => getApprovals(...a),
    approveApproval: vi.fn(),
    denyApproval: vi.fn(),
  },
}));

import { ApprovalsList } from './ApprovalsList';
import type { PortalApproval } from '@/lib/api';

const make = (over: Partial<PortalApproval> = {}): PortalApproval => ({
  id: 'r1',
  ticketId: 't1',
  ticketNumber: 'T-1',
  ticketSubject: 'Subject one',
  trigger: 'budget',
  status: 'pending',
  revision: 1,
  requestedAt: '2026-10-10T10:00:00.000Z',
  expiresAt: '2026-10-20T10:00:00.000Z',
  decidedAt: null,
  decisionOrigin: null,
  message: null,
  ask: { minutes: 60, amount: null, currencyCode: null, coverageStartsAt: null, coverageEndsAt: null },
  snapshot: { budgetMinutes: null, consumedMinutes: null, budgetAmount: null, consumedAmount: null },
  role: 'approver',
  canDecide: true,
  ...over,
});

beforeEach(() => {
  getApprovals.mockReset();
  window.location.hash = '';
});
afterEach(cleanup);

describe('ApprovalsList', () => {
  it('lists pending requests before decided ones', () => {
    render(
      <ApprovalsList
        approvals={[
          make({ id: 'd', ticketNumber: 'T-D', status: 'approved', canDecide: false, decidedAt: '2026-10-11T10:00:00.000Z' }),
          make({ id: 'p', ticketNumber: 'T-P' }),
        ]}
      />
    );
    const rows = screen.getAllByTestId('approval-row');
    expect(rows[0].textContent).toContain('T-P');
    expect(rows[1].textContent).toContain('T-D');
  });

  it('shows ticket number, subject, ask sentence and a status chip per row', () => {
    render(<ApprovalsList approvals={[make()]} />);
    const row = screen.getByTestId('approval-row');
    expect(row.textContent).toContain('T-1');
    expect(row.textContent).toContain('Subject one');
    expect(row.textContent).toContain('Approve up to 1 h more on ticket #T-1');
    expect(screen.getByTestId('approval-status-r1').textContent).toMatch(/awaiting/i);
  });

  it('selecting a row writes the id to the hash and shows the panel', () => {
    render(<ApprovalsList approvals={[make()]} />);
    expect(screen.queryByTestId('approval-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('approval-row'));
    expect(window.location.hash).toBe('#r1');
    expect(screen.getByTestId('approval-panel')).toBeTruthy();
    expect(window.location.search).toBe('');
  });

  it('opens the request named by the hash on mount (email deep link)', () => {
    window.location.hash = '#r2';
    render(<ApprovalsList approvals={[make(), make({ id: 'r2', ticketNumber: 'T-2', ticketSubject: 'Second' })]} />);
    const panel = screen.getByTestId('approval-panel');
    expect(panel.textContent).toContain('ticket #T-2');
  });

  it('follows hashchange', () => {
    render(<ApprovalsList approvals={[make(), make({ id: 'r2', ticketNumber: 'T-2' })]} />);
    expect(screen.queryByTestId('approval-panel')).toBeNull();
    act(() => {
      window.location.hash = '#r2';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByTestId('approval-panel').textContent).toContain('ticket #T-2');
  });

  it('ignores a hash that matches no request', () => {
    window.location.hash = '#nope';
    render(<ApprovalsList approvals={[make()]} />);
    expect(screen.queryByTestId('approval-panel')).toBeNull();
  });

  it('refetches the full list when the panel asks to reload', async () => {
    getApprovals.mockResolvedValue({
      statusCode: 200,
      data: { data: [make({ status: 'approved', canDecide: false, decidedAt: '2026-10-12T10:00:00.000Z' })] },
    });
    window.location.hash = '#r1';
    render(<ApprovalsList approvals={[make()]} />);
    // A decision elsewhere makes the panel call onChanged; simulate via a stale-revision refusal.
    const { portalApi } = await import('@/lib/api');
    (portalApi.approveApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
      statusCode: 409, code: 'REQUEST_CHANGED', error: 'x',
    });
    fireEvent.change(screen.getByLabelText('Type your full name'), { target: { value: 'Pat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(getApprovals).toHaveBeenCalledTimes(1));
    expect(getApprovals.mock.calls[0][1]).toBeUndefined();
    await waitFor(() => expect(screen.getByTestId('approval-status-r1').textContent).toMatch(/approved/i));
  });

  it('shows an empty state and an error', () => {
    const { unmount } = render(<ApprovalsList approvals={[]} />);
    expect(screen.getByText(/no approval requests/i)).toBeTruthy();
    unmount();
    render(<ApprovalsList approvals={[]} error="Boom" />);
    expect(screen.getByRole('alert').textContent).toContain('Boom');
  });
});
