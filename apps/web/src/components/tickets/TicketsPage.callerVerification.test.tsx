import '@/lib/i18n';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import TicketsPage from './TicketsPage';
import { fetchWithAuth } from '../../stores/auth';
import type { TicketDetail, TicketSummary } from './ticketConfig';

// #8576 sweep: in the /tickets split view the queue owns the URL hash
// (`#<ticket>&sort=..&type=..`). "Verify caller" in the embedded workbench
// must open its modal without rewriting that hash — otherwise the queue reads
// `caller-verification` as a ticket key, falls back to the first row and the
// modal never shows. Real TicketsPage + TicketWorkbench + CallerVerificationEntry;
// only the modal body, flag and unrelated workbench cards are stubbed.

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector?: (s: { user: { id: string; name: string; permissions: unknown[] } }) => unknown) => {
      const s = { user: { id: 'user-1', name: 'Test Agent', permissions: [] } };
      return selector ? selector(s) : s;
    },
    { getState: () => ({ user: { id: 'user-1', name: 'Test Agent', permissions: [] } }) },
  ),
}));
vi.mock('../../lib/authScope', () => ({
  getJwtClaims: () => ({ scope: 'partner', orgId: null, partnerId: 'p-1' }),
  loginPathWithNext: () => '/login?next=%2F',
}));
vi.mock('../../lib/ticketConfigApi', async (orig) => ({
  ...(await orig<typeof import('../../lib/ticketConfigApi')>()), fetchTicketConfig: vi.fn().mockResolvedValue(null),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('./TicketPartsCard', () => ({ default: () => null }));
vi.mock('./TicketChecklistCard', () => ({ default: () => null }));
vi.mock('@/lib/useCallerVerificationEnabled', () => ({ useCallerVerificationEnabled: () => true }));
vi.mock('../callerVerification/TicketVerificationBadge', () => ({ TicketVerificationBadge: () => null }));
vi.mock('../callerVerification/VerifyCallerModal', () => ({
  VerifyCallerModal: (p: { ticketId?: string; onClose: () => void }) => (
    <div data-testid="cv-modal" data-ticket={p.ticketId}><button type="button" onClick={p.onClose}>close-cv</button></div>
  ),
}));

const summary = (id: string, internalNumber: string): TicketSummary => ({
  id, internalNumber, subject: `Subject ${internalNumber}`, status: 'open', priority: 'normal', source: 'portal',
  orgId: 'org-1', orgName: 'Acme', deviceId: null, deviceHostname: null, assignedTo: null, assigneeName: null,
  categoryId: null, dueDate: null, slaBreachedAt: null, firstResponseAt: null,
  createdAt: '2026-06-01T10:00:00.000Z', updatedAt: '2026-06-01T10:00:00.000Z',
});
const first = summary('tk-1', 'T-2026-0001');
const second = summary('tk-2', 'T-2026-0002');

const detail = (s: TicketSummary): TicketDetail => ({
  ...s, tags: [], description: null, submittedBy: null, submitterName: 'Pat', submitterEmail: null,
  pendingReason: null, resolutionNote: null, resolvedAt: null, comments: [], alertLinks: [],
  requesterContactId: 'contact-1',
});

const json = (body: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 404, json: async () => body }) as unknown as Response;

beforeEach(() => {
  vi.clearAllMocks();
  history.replaceState(null, '', window.location.pathname);
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
  vi.mocked(fetchWithAuth).mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith('/tickets?')) return json({ data: [first, second] });
    if (url === '/tickets/stats') return json({ data: { open: 2, unassigned: 0, mine: 0, breached: 0 } });
    if (url === '/tickets/tk-1') return json({ data: detail(first) });
    if (url === '/tickets/tk-2') return json({ data: detail(second) });
    return json({ error: 'unexpected' }, false);
  });
});

it('opens Verify caller in the split view without changing the selected ticket or the queue hash', async () => {
  window.location.hash = '#T-2026-0002&sort=newest';
  render(<TicketsPage />);

  await waitFor(() => expect(screen.getByTestId('ticket-row-tk-2')).toHaveAttribute('aria-selected', 'true'));
  const launcher = await screen.findByTestId('cv-entry');

  await act(async () => { fireEvent.click(launcher); });

  expect(await screen.findByTestId('cv-modal')).toHaveAttribute('data-ticket', 'tk-2');
  expect(window.location.hash).toBe('#T-2026-0002&sort=newest');
  expect(screen.getByTestId('ticket-row-tk-2')).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByTestId('ticket-row-tk-1')).toHaveAttribute('aria-selected', 'false');

  await act(async () => { fireEvent.click(screen.getByText('close-cv')); });

  expect(screen.queryByTestId('cv-modal')).toBeNull();
  expect(window.location.hash).toBe('#T-2026-0002&sort=newest');
  expect(screen.getByTestId('ticket-row-tk-2')).toHaveAttribute('aria-selected', 'true');
});
