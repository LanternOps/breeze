// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const approveApproval = vi.fn();
const denyApproval = vi.fn();
vi.mock('@/lib/api', () => ({
  portalApi: {
    approveApproval: (...a: unknown[]) => approveApproval(...a),
    denyApproval: (...a: unknown[]) => denyApproval(...a),
  },
}));

import { ApprovalDecisionPanel } from './ApprovalDecisionPanel';
import type { PortalApproval } from '@/lib/api';

const make = (over: Partial<PortalApproval> = {}): PortalApproval => ({
  id: 'r1',
  ticketId: 't1',
  ticketNumber: 'T-1042',
  ticketSubject: 'Server migration',
  trigger: 'budget',
  status: 'pending',
  revision: 4,
  requestedAt: '2026-10-10T10:00:00.000Z',
  expiresAt: '2026-10-20T10:00:00.000Z',
  decidedAt: null,
  decisionOrigin: null,
  message: 'We need more time to finish the cutover.',
  ask: { minutes: 150, amount: null, currencyCode: null, coverageStartsAt: null, coverageEndsAt: null },
  snapshot: { budgetMinutes: 600, consumedMinutes: 585, budgetAmount: null, consumedAmount: null },
  role: 'approver',
  canDecide: true,
  ...over,
});

const ok = (status: 'approved' | 'denied') => ({
  statusCode: 200,
  data: { data: { status, releasedEntryCount: 2, stillHeldEntryCount: 0 } },
});
const fail = (statusCode: number, code: string, error = 'nope') => ({ statusCode, code, error });

beforeEach(() => {
  approveApproval.mockReset();
  denyApproval.mockReset();
});
afterEach(cleanup);

const typeName = (value = 'Pat Doe') =>
  fireEvent.change(screen.getByLabelText('Type your full name'), { target: { value } });

describe('ApprovalDecisionPanel — content', () => {
  it('shows the ask, snapshot and staff message', () => {
    render(<ApprovalDecisionPanel approval={make()} onChanged={vi.fn()} />);
    expect(screen.getByText('Approve up to 2 h 30 m more on ticket #T-1042')).toBeTruthy();
    expect(screen.getByText('Budget 10 h, used 9 h 45 m')).toBeTruthy();
    expect(screen.getByText('We need more time to finish the cutover.')).toBeTruthy();
  });
});

describe('ApprovalDecisionPanel — deciding', () => {
  it('disables Approve and Deny until a name is typed', () => {
    render(<ApprovalDecisionPanel approval={make()} onChanged={vi.fn()} />);
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    const deny = screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(deny.disabled).toBe(true);
    typeName('   ');
    expect(approve.disabled).toBe(true);
    typeName();
    expect(approve.disabled).toBe(false);
    expect(deny.disabled).toBe(false);
  });

  it('approves with the rendered revision, trimmed name and optional note', async () => {
    approveApproval.mockResolvedValue(ok('approved'));
    const onChanged = vi.fn();
    render(<ApprovalDecisionPanel approval={make()} onChanged={onChanged} />);
    typeName('  Pat Doe ');
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'Go ahead' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approveApproval).toHaveBeenCalledTimes(1));
    expect(approveApproval).toHaveBeenCalledWith('r1', { revision: 4, signerName: 'Pat Doe', note: 'Go ahead' });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(denyApproval).not.toHaveBeenCalled();
  });

  it('omits note when blank', async () => {
    approveApproval.mockResolvedValue(ok('approved'));
    render(<ApprovalDecisionPanel approval={make()} onChanged={vi.fn()} />);
    typeName();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approveApproval).toHaveBeenCalled());
    expect(approveApproval.mock.calls[0][1]).toEqual({ revision: 4, signerName: 'Pat Doe' });
  });

  it('denies through denyApproval', async () => {
    denyApproval.mockResolvedValue(ok('denied'));
    render(<ApprovalDecisionPanel approval={make()} onChanged={vi.fn()} />);
    typeName();
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(denyApproval).toHaveBeenCalledWith('r1', { revision: 4, signerName: 'Pat Doe' }));
    expect(approveApproval).not.toHaveBeenCalled();
  });
});

describe('ApprovalDecisionPanel — errors', () => {
  it('REQUEST_CHANGED reloads the request and tells the customer to review again', async () => {
    approveApproval.mockResolvedValue(fail(409, 'REQUEST_CHANGED', 'Revision mismatch'));
    const onChanged = vi.fn();
    render(<ApprovalDecisionPanel approval={make()} onChanged={onChanged} />);
    typeName();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('This request was updated, please review again')).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });

  it('maps REQUEST_NOT_PENDING and REQUEST_EXPIRED', async () => {
    approveApproval.mockResolvedValueOnce(fail(409, 'REQUEST_NOT_PENDING'));
    render(<ApprovalDecisionPanel approval={make()} onChanged={vi.fn()} />);
    typeName();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('This request has already been decided, possibly by your earlier attempt. Check its status below.')).toBeTruthy();

    approveApproval.mockResolvedValueOnce(fail(409, 'REQUEST_EXPIRED'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('This request has expired. Contact your service provider.')).toBeTruthy();
  });

  it('falls back to the API error text for other failures', async () => {
    approveApproval.mockResolvedValue(fail(403, 'NOT_AN_APPROVER', 'You cannot decide this'));
    render(<ApprovalDecisionPanel approval={make()} onChanged={vi.fn()} />);
    typeName();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('You cannot decide this')).toBeTruthy();
  });
});

describe('ApprovalDecisionPanel — read-only viewers', () => {
  it('notify-only viewer of a pending request sees status text and no form', () => {
    render(<ApprovalDecisionPanel approval={make({ role: 'notify', canDecide: false })} onChanged={vi.fn()} />);
    expect(screen.getByText('Waiting for your billing contact to decide')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText('Type your full name')).toBeNull();
  });

  it.each([
    ['approved', /approved/i],
    ['denied', /declined|denied/i],
    ['expired', /expired/i],
    ['cancelled', /cancelled/i],
  ] as const)('a %s request has no buttons or form', (status, text) => {
    render(<ApprovalDecisionPanel approval={make({ status, canDecide: false })} onChanged={vi.fn()} />);
    expect(screen.getByTestId('approval-status-text').textContent).toMatch(text);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText('Type your full name')).toBeNull();
  });
});
