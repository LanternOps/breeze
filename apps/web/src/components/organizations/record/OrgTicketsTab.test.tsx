import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@/lib/i18n';
import OrgTicketsTab from './OrgTicketsTab';
import type { OrgFetch } from './orgRecordFetch';
import type { TicketSummary } from '../../tickets/ticketConfig';

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

// Ticket config is fetched via the ambient module cache, not orgFetch (see
// OrgTicketsTab's docblock) — stub it so no real fetchWithAuth call happens.
vi.mock('@/lib/ticketConfigApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ticketConfigApi')>();
  return { ...actual, fetchTicketConfig: vi.fn().mockResolvedValue(null) };
});

const ORG_ID = 'org-record-1';
const OTHER_ORG_ID = 'org-record-2';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function ticket(overrides: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: 't-1',
    internalNumber: 'T-1',
    subject: 'Printer is down',
    status: 'open',
    priority: 'normal',
    source: 'manual',
    orgId: ORG_ID,
    orgName: 'Acme',
    deviceId: null,
    deviceHostname: null,
    assignedTo: null,
    assigneeName: null,
    categoryId: null,
    dueDate: null,
    slaBreachedAt: null,
    firstResponseAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('OrgTicketsTab', () => {
  it('requests the record org, not the ambient one — the URL orgFetch is called with', async () => {
    const orgFetch = vi.fn(async () => json({ data: [ticket()] })) as unknown as OrgFetch;
    render(<OrgTicketsTab orgId={ORG_ID} orgFetch={orgFetch} />);
    await waitFor(() => expect(screen.getByText('Printer is down')).toBeTruthy());
    // makeOrgFetch(orgId) is the production wiring; here we assert the tab
    // calls through the SAME orgFetch it was given (never a bare fetchWithAuth),
    // which is what carries the pin — see OrganizationRecordPage's orgFetch prop.
    const calls = (orgFetch as ReturnType<typeof vi.fn>).mock.calls as [string][];
    expect(calls.some(([path]) => path.startsWith('/tickets?'))).toBe(true);
    // Never silently reaches for a different org's id.
    expect(calls.every(([path]) => !path.includes(OTHER_ORG_ID))).toBe(true);
  });

  it('shows the empty state when the org has no tickets in the selected status group', async () => {
    const orgFetch = vi.fn(async () => json({ data: [] })) as unknown as OrgFetch;
    render(<OrgTicketsTab orgId={ORG_ID} orgFetch={orgFetch} />);
    await waitFor(() => expect(screen.getByTestId('tickets-queue-empty')).toBeTruthy());
  });

  it('shows a retryable error, not the empty state, when the load fails', async () => {
    const orgFetch = vi.fn(async () => json({}, 500)) as unknown as OrgFetch;
    render(<OrgTicketsTab orgId={ORG_ID} orgFetch={orgFetch} />);
    await waitFor(() => expect(screen.getByTestId('org-tickets-error')).toBeTruthy());
    expect(screen.queryByTestId('tickets-queue-empty')).toBeNull();
  });

  it('re-fetches the selected status group when the tab changes', async () => {
    const orgFetch = vi.fn(async () => json({ data: [] })) as unknown as OrgFetch;
    render(<OrgTicketsTab orgId={ORG_ID} orgFetch={orgFetch} />);
    await waitFor(() => expect(orgFetch).toHaveBeenCalled());
    await userEvent.click(screen.getByTestId('org-tickets-tab-closed'));
    await waitFor(() =>
      expect((orgFetch as ReturnType<typeof vi.fn>).mock.calls.some((call) => String(call[0]).includes('statusGroup=closed'))).toBe(true),
    );
  });

  it('links New ticket to the create form pre-scoped to this org via #orgId=', async () => {
    const orgFetch = vi.fn(async () => json({ data: [] })) as unknown as OrgFetch;
    render(<OrgTicketsTab orgId={ORG_ID} orgFetch={orgFetch} />);
    const link = await screen.findByTestId('org-tickets-new');
    expect(link.getAttribute('href')).toBe(`/tickets/new#orgId=${ORG_ID}`);
  });

  it('navigates to the full ticket page on select', async () => {
    const orgFetch = vi.fn(async () => json({ data: [ticket()] })) as unknown as OrgFetch;
    render(<OrgTicketsTab orgId={ORG_ID} orgFetch={orgFetch} />);
    const row = await screen.findByText('Printer is down');
    await userEvent.click(row);
    expect(navigateTo).toHaveBeenCalledWith('/tickets/t-1');
  });
});
