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
  instructions: null,
  checklistTemplateId: null,
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
    if (method === 'GET' && path.startsWith('/contracts')) {
      return jsonResp(200, { data: [{ id: 'ct-1', name: 'Acme MSA', status: 'active' }, { id: 'ct-2', name: 'Acme Onboarding', status: 'draft' }, { id: 'ct-x', name: 'Old', status: 'cancelled' }] });
    }
    if (method === 'DELETE') return jsonResp(204, {});
    if (method === 'PATCH') {
      // The API answers PATCH/POST with the full summary shape (`Deliverable`),
      // so `replaceRow(saved)` keeps contractName/status/nextDue intact.
      const body = JSON.parse(String(init?.body)) as Partial<Deliverable>;
      const saved: Deliverable = { ...rows[0], ...body, updatedAt: '2026-02-01T00:00:00Z' };
      return jsonResp(200, { data: saved });
    }
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

  it('toggles portal visibility with a PATCH through runAction and keeps the row summary intact', async () => {
    const fetcher = makeFetcher([base, standalone]);
    render(<DeliverableTable fetcher={fetcher} orgId="org-1" groupByContract />);
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
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));

    // The row was replaced with the PATCH response, which must be the full
    // summary: status pill, contract group and dates all survive the toggle.
    const row1 = screen.getByTestId('deliverable-row-d-1');
    expect(within(row1).getByTestId('deliverable-status-d-1').textContent).toBe('On track');
    expect(within(row1).getByText('Late')).toBeInTheDocument();
    expect(within(screen.getByTestId('deliverable-group-ct-1')).getByText('Acme MSA')).toBeInTheDocument();
    const rows = screen.getAllByTestId(/^deliverable-row-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['deliverable-row-d-1', 'deliverable-row-d-2']);
    // No reload was needed: still exactly one GET.
    expect(fetcher.mock.calls.filter(([p, i]) => (i?.method ?? 'GET') === 'GET' && String(p).startsWith('/orgs/org-1/deliverables')).length).toBe(1);
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

  describe('bulk reschedule (#9314)', () => {
    const d3: Deliverable = { ...base, id: 'd-3', name: 'Third', contractId: null, contractName: null };
    const occ = (id: string, status: string, dueAt: string) => ({ id, status, dueAt });

    function bulkFetcher(opts: { bulk?: () => Response } = {}) {
      return vi.fn(async (path: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'POST' && path === '/orgs/org-1/deliverables/occurrences/reschedule') {
          return opts.bulk ? opts.bulk() : jsonResp(200, { data: { results: [] } });
        }
        const m = /^\/orgs\/org-1\/deliverables\/(d-\d)\/occurrences/.exec(path);
        if (method === 'GET' && m) {
          const id = m[1];
          // newest first, like the API; the oldest LIVE one (not the delivered one) must be picked
          return jsonResp(200, { data: [occ(`${id}-new`, 'scheduled', '2026-12-01'), occ(`${id}-old`, 'open', '2026-10-01'), occ(`${id}-done`, 'delivered', '2026-08-01')] });
        }
        if (method === 'GET' && path.startsWith('/orgs/org-1/deliverables')) return jsonResp(200, { data: [base, standalone, d3] });
        throw new Error(`unexpected ${method} ${path}`);
      });
    }

    async function selectThreeAndSubmit(fetcher: ReturnType<typeof bulkFetcher>) {
      render(<DeliverableTable fetcher={fetcher} orgId="org-1" selectable />);
      for (const id of ['d-1', 'd-2', 'd-3']) fireEvent.click(await screen.findByTestId(`deliverable-select-${id}`));
      fireEvent.change(screen.getByTestId('deliverables-bulk-date'), { target: { value: '2026-11-30' } });
      fireEvent.click(screen.getByTestId('deliverables-bulk-reschedule'));
    }
    const bulkCalls = (fetcher: ReturnType<typeof bulkFetcher>) =>
      fetcher.mock.calls.filter(([p, i]) => i?.method === 'POST' && p === '/orgs/org-1/deliverables/occurrences/reschedule');

    it('selecting three rows calls the bulk endpoint once with each oldest live occurrence', async () => {
      const results = ['d-1-old', 'd-2-old', 'd-3-old'].map((occurrenceId) => ({ occurrenceId, ok: true }));
      const fetcher = bulkFetcher({ bulk: () => jsonResp(200, { data: { results } }) });
      await selectThreeAndSubmit(fetcher);
      await waitFor(() => expect(bulkCalls(fetcher)).toHaveLength(1));
      expect(JSON.parse(String(bulkCalls(fetcher)[0][1]?.body))).toEqual({
        occurrenceIds: ['d-1-old', 'd-2-old', 'd-3-old'], dueAt: '2026-11-30',
      });
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: '3 occurrences rescheduled' })));
    });

    it('reports rows the API refused instead of claiming full success', async () => {
      const results = [
        { occurrenceId: 'd-1-old', ok: true },
        { occurrenceId: 'd-2-old', ok: false, status: 409, code: 'INVALID_OCCURRENCE_TRANSITION', error: 'x' },
        { occurrenceId: 'd-3-old', ok: true },
      ];
      const fetcher = bulkFetcher({ bulk: () => jsonResp(200, { data: { results } }) });
      await selectThreeAndSubmit(fetcher);
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning', message: '2 rescheduled, 1 could not be moved' })));
    });

    it('a failed request is toasted through runAction', async () => {
      const fetcher = bulkFetcher({ bulk: () => jsonResp(500, { error: 'boom' }) });
      await selectThreeAndSubmit(fetcher);
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
      expect(bulkCalls(fetcher)).toHaveLength(1);
    });

    it('warns and sends nothing when no selected deliverable has a live occurrence', async () => {
      const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET' && /\/d-1\/occurrences/.test(path)) return jsonResp(200, { data: [{ id: 'x', status: 'delivered', dueAt: '2026-08-01' }] });
        if (method === 'GET') return jsonResp(200, { data: [base] });
        throw new Error(`unexpected ${method} ${path}`);
      });
      render(<DeliverableTable fetcher={fetcher} orgId="org-1" selectable />);
      fireEvent.click(await screen.findByTestId('deliverable-select-d-1'));
      fireEvent.change(screen.getByTestId('deliverables-bulk-date'), { target: { value: '2026-11-30' } });
      fireEvent.click(screen.getByTestId('deliverables-bulk-reschedule'));
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' })));
      expect(fetcher.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(false);
    });

    it('counts a selected deliverable with nothing live as not moved', async () => {
      const results = [{ occurrenceId: 'd-1-old', ok: true }, { occurrenceId: 'd-2-old', ok: true }];
      const base2 = bulkFetcher({ bulk: () => jsonResp(200, { data: { results } }) });
      const fetcher = vi.fn(async (path: string, init?: RequestInit) =>
        /\/d-3\/occurrences/.test(path) ? jsonResp(200, { data: [occ('z', 'waived', '2026-08-01')] }) : base2(path, init));
      await selectThreeAndSubmit(fetcher as unknown as ReturnType<typeof bulkFetcher>);
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning', message: '2 rescheduled, 1 could not be moved' })));
    });

    it('the action stays disabled until a date is chosen', async () => {
      render(<DeliverableTable fetcher={bulkFetcher()} orgId="org-1" selectable />);
      fireEvent.click(await screen.findByTestId('deliverable-select-d-1'));
      expect(screen.getByTestId('deliverables-bulk-reschedule')).toBeDisabled();
    });
  });
});
