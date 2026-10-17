import { act, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import TicketWorkbench from './TicketWorkbench';
import { fetchWithAuth } from '../../stores/auth';
import type { TicketDetail } from './ticketConfig';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (selector: (s: { user: { name: string; permissions: unknown[] } }) => unknown) =>
    selector({ user: { name: 'Test Agent', permissions: [] } }),
}));
vi.mock('./TicketPartsCard', () => ({ default: () => null }));
vi.mock('./TicketChecklistCard', () => ({ default: () => null }));
vi.mock('../../lib/ticketConfigApi', async (orig) => ({
  ...(await orig<typeof import('../../lib/ticketConfigApi')>()), fetchTicketConfig: vi.fn().mockResolvedValue(null),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const entry = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock('../callerVerification/CallerVerificationEntry', () => ({
  CallerVerificationEntry: (p: Record<string, unknown>) => { entry.props = p; return <div data-testid="cv-entry-stub" />; },
}));
vi.mock('../callerVerification/TicketVerificationBadge', () => ({
  TicketVerificationBadge: (p: { orgId: string; ticketId: string; revision?: number }) =>
    <div data-testid="cv-badge-stub" data-org={p.orgId} data-ticket={p.ticketId} data-revision={p.revision} />,
}));

const ticket = (overrides: Partial<TicketDetail> = {}): TicketDetail => ({
  id: 'tk-1', internalNumber: 'T-1', subject: 'Reset my password', status: 'open', priority: 'normal', source: 'portal',
  orgId: 'org-1', orgName: 'Acme', deviceId: null, deviceHostname: null, assignedTo: null, assigneeName: null,
  categoryId: null, dueDate: null, tags: [], slaBreachedAt: null, firstResponseAt: null,
  createdAt: '2026-06-01T10:00:00.000Z', updatedAt: '2026-06-01T10:00:00.000Z', description: null, submittedBy: null,
  submitterName: 'Pat', submitterEmail: null, pendingReason: null, resolutionNote: null, resolvedAt: null,
  comments: [], alertLinks: [], ...overrides,
});

function mockTicket(t: TicketDetail) {
  vi.mocked(fetchWithAuth).mockImplementation(async (input) => {
    const url = String(input);
    const body = /^\/tickets\/[^/]+$/.test(url) ? { data: t } : { success: true };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
}

beforeEach(() => { vi.clearAllMocks(); entry.props = null; });

it('mounts the launcher and badge for a ticket with a requester contact', async () => {
  mockTicket(ticket({ requesterContactId: 'contact-1' }));
  render(<TicketWorkbench ticketId="tk-1" expanded />);
  const badge = await screen.findByTestId('cv-badge-stub');
  expect(badge).toHaveAttribute('data-org', 'org-1');
  expect(badge).toHaveAttribute('data-ticket', 'tk-1');
  expect(entry.props).toMatchObject({ orgId: 'org-1', initialContactId: 'contact-1', lockContact: true, ticketId: 'tk-1', hash: 'caller-verification' });
});

it('gives the launcher no hash in the /tickets split pane, where the queue owns the hash (#8576 sweep)', async () => {
  mockTicket(ticket({ requesterContactId: 'contact-1' }));
  render(<TicketWorkbench ticketId="tk-1" />);
  await screen.findByTestId('cv-entry-stub');
  expect(entry.props).toMatchObject({ orgId: 'org-1', ticketId: 'tk-1' });
  expect(entry.props!.hash).toBeUndefined();
});

it('re-reads the badge after the modal reports a change', async () => {
  mockTicket(ticket({ requesterContactId: 'contact-1' }));
  render(<TicketWorkbench ticketId="tk-1" />);
  const before = (await screen.findByTestId('cv-badge-stub')).getAttribute('data-revision');
  await act(async () => { (entry.props!.onChanged as (r: unknown) => void)({ status: 'verified' }); });
  expect(screen.getByTestId('cv-badge-stub').getAttribute('data-revision')).not.toBe(before);
});

it('mounts nothing without a requester contact', async () => {
  mockTicket(ticket({ requesterContactId: null }));
  render(<TicketWorkbench ticketId="tk-1" />);
  await screen.findByTestId('ticket-workbench');
  expect(screen.queryByTestId('cv-badge-stub')).toBeNull();
  expect(screen.queryByTestId('cv-entry-stub')).toBeNull();
});
