import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeliverableTable from './DeliverableTable';
import type { Deliverable } from '../../lib/api/serviceDeliverables';
import { showToast } from '../shared/Toast';

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const jsonResp = (status: number, payload: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const base: Deliverable = {
  id: 'd-1',
  orgId: 'org-1',
  contractId: 'ct-1',
  name: 'Monthly executive report',
  description: null,
  cadence: 'monthly',
  anchorDueDate: '2026-01-05',
  effectiveFrom: '2026-01-01',
  effectiveUntil: null,
  leadDays: 7,
  graceDays: 14,
  artifactRequired: true,
  completionMode: 'explicit',
  autoEvidenceReportId: null,
  ownerUserId: null,
  ticketCategoryId: null,
  portalVisible: true,
  active: true,
  sortOrder: 0,
  createdBy: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  contractName: 'Acme MSA',
  nextDue: '2026-10-05',
  lastDelivered: { at: '2026-09-07', late: true, note: null },
  openCount: 1,
  status: 'on_track',
};

const standalone: Deliverable = {
  ...base,
  id: 'd-2',
  contractId: null,
  contractName: null,
  name: 'Quarterly business review',
  cadence: 'quarterly',
  lastDelivered: null,
  status: 'late',
};

function makeFetcher(rows: Deliverable[]) {
  return vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path.startsWith('/orgs/org-1/deliverables')) return jsonResp(200, { data: rows });
    if (method === 'DELETE') return jsonResp(204, {});
    if (method === 'PATCH') return jsonResp(200, { data: { ...rows[0], portalVisible: false } });
    throw new Error(`unexpected ${method} ${path}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DeliverableTable', () => {
  it('renders one row per deliverable with cadence, dates, late pill and status pill', async () => {
    const fetcher = makeFetcher([base, standalone]);
    render(<DeliverableTable fetcher={fetcher} orgId="org-1" contractId="ct-1" />);

    await waitFor(() => expect(screen.getByTestId('deliverables-table')).toBeInTheDocument());
    expect(fetcher).toHaveBeenCalledWith('/orgs/org-1/deliverables?contractId=ct-1');

    const row1 = screen.getByTestId('deliverable-row-d-1');
    expect(within(row1).getByText('Monthly executive report')).toBeInTheDocument();
    expect(within(row1).getByText('Monthly')).toBeInTheDocument();
    expect(within(row1).getByText('On track')).toBeInTheDocument();
    // lastDelivered.late renders a "Late" pill next to the delivered date
    expect(within(row1).getByText('Late')).toBeInTheDocument();

    const row2 = screen.getByTestId('deliverable-row-d-2');
    expect(within(row2).getByText('Quarterly')).toBeInTheDocument();
    expect(within(row2).getByText('Late')).toBeInTheDocument();
  });

  it('calls onSelect with the deliverable when its name is clicked', async () => {
    const onSelect = vi.fn();
    render(<DeliverableTable fetcher={makeFetcher([base])} orgId="org-1" onSelect={onSelect} />);
    fireEvent.click(await screen.findByText('Monthly executive report'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'd-1' }));
  });

  it('deactivates through a two-step inline confirm, DELETEs via runAction and toasts', async () => {
    const fetcher = makeFetcher([base]);
    render(<DeliverableTable fetcher={fetcher} orgId="org-1" />);
    const btn = await screen.findByTestId('deliverable-deactivate-d-1');

    // first click arms the confirm, nothing is sent yet
    fireEvent.click(btn);
    expect(fetcher).not.toHaveBeenCalledWith('/orgs/org-1/deliverables/d-1', expect.objectContaining({ method: 'DELETE' }));

    fireEvent.click(screen.getByTestId('deliverable-deactivate-d-1'));
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith('/orgs/org-1/deliverables/d-1', expect.objectContaining({ method: 'DELETE' })),
    );
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Deliverable deactivated' })),
    );
    // list reloads after the deactivate
    await waitFor(() => expect(fetcher.mock.calls.filter(([p, i]) => (i?.method ?? 'GET') === 'GET' && String(p).startsWith('/orgs/org-1/deliverables')).length).toBe(2));
  });

  it('toggles portal visibility with a PATCH through runAction', async () => {
    const fetcher = makeFetcher([base]);
    render(<DeliverableTable fetcher={fetcher} orgId="org-1" />);
    const toggle = await screen.findByTestId('deliverable-portal-toggle-d-1');
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        '/orgs/org-1/deliverables/d-1',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ portalVisible: false }) }),
      ),
    );
    await waitFor(() => expect(screen.getByTestId('deliverable-portal-toggle-d-1')).not.toBeChecked());
  });

  it('groups rows by contract name with standalone rows under "No contract"', async () => {
    render(<DeliverableTable fetcher={makeFetcher([base, standalone])} orgId="org-1" groupByContract />);
    await screen.findByTestId('deliverable-row-d-1');
    const acme = screen.getByTestId('deliverable-group-ct-1');
    expect(within(acme).getByText('Acme MSA')).toBeInTheDocument();
    const none = screen.getByTestId('deliverable-group-none');
    expect(within(none).getByText('No contract')).toBeInTheDocument();
    // the row order follows the groups: contract group first, then standalone
    const rows = screen.getAllByTestId(/^deliverable-row-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['deliverable-row-d-1', 'deliverable-row-d-2']);
  });

  it('renders the empty state when there are no deliverables', async () => {
    render(<DeliverableTable fetcher={makeFetcher([])} orgId="org-1" />);
    expect(await screen.findByText(/No deliverables yet/)).toBeInTheDocument();
  });
});
