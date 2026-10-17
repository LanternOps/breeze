import '@/lib/i18n';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { freshForTicket } from '@/lib/api/callerVerification';
import { TicketVerificationBadge } from './TicketVerificationBadge';
import { ORG, TICKET, row } from './testFixtures';

const enabled = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/api/callerVerification', () => ({ freshForTicket: vi.fn() }));
vi.mock('@/lib/useCallerVerificationEnabled', () => ({ useCallerVerificationEnabled: () => enabled.value }));
afterEach(() => { vi.clearAllMocks(); enabled.value = true; });

const verified = { ...row, status: 'verified' as const, decidedAt: new Date(Date.now() - 60000).toISOString(), usableUntil: new Date(Date.now() + 900000).toISOString() };

it('makes no request while the feature is off', () => {
  enabled.value = false;
  render(<TicketVerificationBadge orgId={ORG} ticketId={TICKET} />);
  expect(freshForTicket).not.toHaveBeenCalled();
  expect(screen.queryByTestId('cv-badge')).toBeNull();
});

it('shows fresh, consumed, expired, pending and none from the server projection', async () => {
  vi.mocked(freshForTicket).mockResolvedValue({ row: verified, isFresh: true, isConsumed: false });
  const view = render(<TicketVerificationBadge orgId={ORG} ticketId={TICKET} />);
  expect(await screen.findByTestId('cv-badge')).toHaveTextContent('Verified · Tier 2');
  expect(screen.getByTestId('cv-badge')).toHaveAttribute('data-state', 'fresh');

  vi.mocked(freshForTicket).mockResolvedValue({ row: { ...verified, consumedAt: row.createdAt, consumedAction: 'reset_password' }, isFresh: true, isConsumed: true });
  view.rerender(<TicketVerificationBadge orgId={ORG} ticketId={TICKET} revision={1} />);
  await waitFor(() => expect(screen.getByTestId('cv-badge')).toHaveTextContent('Verification used'));

  vi.mocked(freshForTicket).mockResolvedValue({ row: verified, isFresh: false, isConsumed: false });
  view.rerender(<TicketVerificationBadge orgId={ORG} ticketId={TICKET} revision={2} />);
  await waitFor(() => expect(screen.getByTestId('cv-badge')).toHaveTextContent('Verification expired'));

  vi.mocked(freshForTicket).mockResolvedValue({ row, isFresh: false, isConsumed: false });
  view.rerender(<TicketVerificationBadge orgId={ORG} ticketId={TICKET} revision={3} />);
  await waitFor(() => expect(screen.getByTestId('cv-badge')).toHaveTextContent('Verification pending'));

  vi.mocked(freshForTicket).mockResolvedValue({ row: { ...row, status: 'rejected_by_user' }, isFresh: false, isConsumed: false });
  view.rerender(<TicketVerificationBadge orgId={ORG} ticketId={TICKET} revision={4} />);
  await waitFor(() => expect(screen.getByTestId('cv-badge')).toHaveTextContent('Verification failed'));

  vi.mocked(freshForTicket).mockResolvedValue({ row: null, isFresh: false, isConsumed: false });
  view.rerender(<TicketVerificationBadge orgId={ORG} ticketId={TICKET} revision={5} />);
  await waitFor(() => expect(screen.getByTestId('cv-badge')).toHaveTextContent('Not verified'));
  expect(freshForTicket).toHaveBeenLastCalledWith(ORG, TICKET, expect.any(AbortSignal));
});

it('does not claim fresh when the server says not fresh even if usableUntil is in the future', async () => {
  vi.mocked(freshForTicket).mockResolvedValue({ row: verified, isFresh: false, isConsumed: false });
  render(<TicketVerificationBadge orgId={ORG} ticketId={TICKET} />);
  expect(await screen.findByTestId('cv-badge')).not.toHaveAttribute('data-state', 'fresh');
});

it('stops claiming fresh once usableUntil passes, without a reload', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    vi.mocked(freshForTicket).mockResolvedValue({ row: { ...verified, usableUntil: new Date(Date.now() + 45000).toISOString() }, isFresh: true, isConsumed: false });
    render(<TicketVerificationBadge orgId={ORG} ticketId={TICKET} />);
    expect(await screen.findByTestId('cv-badge')).toHaveAttribute('data-state', 'fresh');
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(screen.getByTestId('cv-badge')).toHaveAttribute('data-state', 'stale');
  } finally { vi.useRealTimers(); }
});

it('shows an unavailable state on a failed read rather than a stale verified claim', async () => {
  vi.mocked(freshForTicket).mockRejectedValue(new Error('offline'));
  render(<TicketVerificationBadge orgId={ORG} ticketId={TICKET} />);
  expect(await screen.findByTestId('cv-badge')).toHaveTextContent('Status unavailable');
});
