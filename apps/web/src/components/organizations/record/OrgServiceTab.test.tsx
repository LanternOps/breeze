import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@/lib/i18n';
import OrgServiceTab from './OrgServiceTab';
import type { OrgFetch } from './orgRecordFetch';
import type { Deliverable } from '@/lib/api/serviceDeliverables';

// The ambient fetch must never be reached from inside the record: every request
// carries the org pin through the `orgFetch` prop (orgRecordFetch.ts).
const ambientFetch = vi.fn();
vi.mock('@/stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/auth')>();
  return { ...actual, fetchWithAuth: (...args: unknown[]) => ambientFetch(...args) };
});

// The deliverables components are owned by another task; stub them so this
// suite pins only the tab's own wiring (props handed down, drawer on select).
const tableProps = vi.fn();
vi.mock('@/components/deliverables/DeliverableTable', () => ({
  default: (props: Record<string, unknown>) => {
    tableProps(props);
    const onSelect = props.onSelect as ((d: Deliverable) => void) | undefined;
    return (
      <div data-testid="deliverables-table">
        <button type="button" data-testid="stub-select" onClick={() => onSelect?.(deliverable({ id: 'd-sel', name: 'Picked' }))}>
          select
        </button>
      </div>
    );
  },
}));
const formProps = vi.fn();
vi.mock('@/components/deliverables/DeliverableForm', () => ({
  default: (props: Record<string, unknown>) => {
    formProps(props);
    return <div data-testid="deliverable-form" />;
  },
}));
vi.mock('@/components/deliverables/OccurrenceDrawer', () => ({
  default: (props: { deliverable: Deliverable }) => (
    <div data-testid="occurrence-drawer">{props.deliverable.name}</div>
  ),
}));

const ORG_ID = 'org-record-1';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function isoDaysFromToday(days: number): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function deliverable(overrides: Partial<Deliverable> = {}): Deliverable {
  return {
    id: 'd-1',
    orgId: ORG_ID,
    contractId: null,
    name: 'Monthly report',
    description: null,
    cadence: 'monthly',
    anchorDueDate: '2026-01-31',
    effectiveFrom: '2026-01-01',
    effectiveUntil: null,
    leadDays: 7,
    graceDays: 3,
    artifactRequired: false,
    completionMode: 'explicit',
    autoEvidenceReportId: null,
    ownerUserId: null,
    ticketCategoryId: null,
    portalVisible: false,
    active: true,
    sortOrder: 0,
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    contractName: null,
    nextDue: null,
    lastDelivered: null,
    openCount: 0,
    status: 'on_track',
    ...overrides,
  };
}

function fetchFor(
  deliverables: Deliverable[],
  contracts: Array<{ id: string; name: string }> | Response = [],
): OrgFetch {
  return vi.fn(async (path: string) => {
    if (path.startsWith(`/orgs/${ORG_ID}/deliverables`)) return json({ data: deliverables });
    if (path.startsWith('/contracts')) return contracts instanceof Response ? contracts : json({ data: contracts });
    return json({ error: 'unexpected' }, 500);
  }) as unknown as OrgFetch;
}

afterEach(() => {
  ambientFetch.mockClear();
  tableProps.mockClear();
  formProps.mockClear();
});

describe('OrgServiceTab', () => {
  it('builds the upcoming-90-days list from nextDue through orgFetch, sorted ascending, never via ambient fetchWithAuth', async () => {
    const orgFetch = fetchFor([
      deliverable({ id: 'far', name: 'Far away', nextDue: isoDaysFromToday(120) }),
      deliverable({ id: 'late', name: 'Later this quarter', nextDue: isoDaysFromToday(60) }),
      deliverable({ id: 'soon', name: 'Soon', nextDue: isoDaysFromToday(5) }),
      deliverable({ id: 'past', name: 'Overdue', nextDue: isoDaysFromToday(-3) }),
      deliverable({ id: 'none', name: 'Unscheduled', nextDue: null }),
    ]);
    render(<OrgServiceTab orgId={ORG_ID} orgFetch={orgFetch} />);

    const upcoming = await screen.findByTestId('org-service-upcoming');
    await waitFor(() => expect(upcoming.textContent).toContain('Soon'));
    const items = Array.from(upcoming.querySelectorAll('li')).map((li) => li.textContent ?? '');
    expect(items.length).toBe(2);
    expect(items[0]).toContain('Soon');
    expect(items[1]).toContain('Later this quarter');
    expect(upcoming.textContent).not.toContain('Far away');
    expect(upcoming.textContent).not.toContain('Overdue');
    expect(upcoming.textContent).not.toContain('Unscheduled');

    const calls = (orgFetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [string][];
    expect(calls.some(([path]) => path === `/orgs/${ORG_ID}/deliverables`)).toBe(true);
    expect(ambientFetch).not.toHaveBeenCalled();
  });

  it('shows the empty copy when nothing is due within 90 days', async () => {
    render(<OrgServiceTab orgId={ORG_ID} orgFetch={fetchFor([deliverable({ nextDue: isoDaysFromToday(200) })])} />);
    await waitFor(() => expect(screen.getByTestId('org-service-upcoming').textContent).toContain('Nothing due in the next 90 days.'));
  });

  it('renders the table grouped by contract with the record orgFetch, and opens the drawer on select', async () => {
    const orgFetch = fetchFor([]);
    render(<OrgServiceTab orgId={ORG_ID} orgFetch={orgFetch} />);
    await screen.findByTestId('deliverables-table');
    const props = tableProps.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(props.groupByContract).toBe(true);
    expect(props.orgId).toBe(ORG_ID);
    expect(props.fetcher).toBe(orgFetch);
    expect(props.contractId).toBeUndefined();

    await userEvent.click(screen.getByTestId('stub-select'));
    expect((await screen.findByTestId('occurrence-drawer')).textContent).toContain('Picked');
  });

  it('opens the add form with the org contracts loaded through orgFetch as picker options', async () => {
    const orgFetch = fetchFor([], [{ id: 'c-1', name: 'Gold support' }]);
    render(<OrgServiceTab orgId={ORG_ID} orgFetch={orgFetch} />);
    await screen.findByTestId('deliverables-table');
    expect(screen.queryByTestId('deliverable-form')).toBeNull();

    await userEvent.click(screen.getByTestId('org-service-add'));
    await screen.findByTestId('deliverable-form');
    await waitFor(() => {
      const props = formProps.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(props.contractOptions).toEqual([{ id: 'c-1', name: 'Gold support' }]);
      expect(props.contractsState).toBeUndefined();
    });
    const calls = (orgFetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [string][];
    // `listContractsQuerySchema` caps limit at 100; the org pin is orgFetch's job.
    expect(calls.some(([path]) => path === '/contracts?limit=100')).toBe(true);
    expect(ambientFetch).not.toHaveBeenCalled();
  });

  it('hands the form contractsState=failed (not an empty list) when the contracts request fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const orgFetch = fetchFor([], json({ error: 'contracts unavailable' }, 503));
      render(<OrgServiceTab orgId={ORG_ID} orgFetch={orgFetch} />);
      await screen.findByTestId('deliverables-table');
      await userEvent.click(screen.getByTestId('org-service-add'));
      await screen.findByTestId('deliverable-form');
      await waitFor(() => {
        const props = formProps.mock.calls.at(-1)?.[0] as Record<string, unknown>;
        expect(props.contractsState).toBe('failed');
        expect(props.contractOptions).toEqual([]);
      });
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('renders the server message, not the empty copy, when the deliverables request fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const orgFetch = vi.fn(async (path: string) => {
        if (path.startsWith('/contracts')) return json({ data: [] });
        return json({ error: 'deliverables are on fire' }, 500);
      }) as unknown as OrgFetch;
      render(<OrgServiceTab orgId={ORG_ID} orgFetch={orgFetch} />);
      const error = await screen.findByTestId('org-service-error');
      expect(error.textContent).toBe('deliverables are on fire');
      expect(screen.getByTestId('org-service-upcoming').textContent).not.toContain('Nothing due in the next 90 days.');
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('falls back to the generic copy when the failure carries no message', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const orgFetch = vi.fn(async (path: string) => {
        if (path.startsWith('/contracts')) return json({ data: [] });
        return new Response('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
      }) as unknown as OrgFetch;
      render(<OrgServiceTab orgId={ORG_ID} orgFetch={orgFetch} />);
      const error = await screen.findByTestId('org-service-error');
      // unwrapData's own fallback for a body-less failure; still the real status.
      expect(error.textContent).toBe('Request failed (502)');
    } finally {
      errSpy.mockRestore();
    }
  });
});
