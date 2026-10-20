import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeliverableTable from './DeliverableTable';
import { MoveHereDialog } from './MoveDeliverablesDialogs';
import type { Deliverable } from '../../lib/api/serviceDeliverables';

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const jsonResp = (status: number, payload: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, statusText: 'x', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const row = (over: Partial<Deliverable>): Deliverable => ({
  id: 'd-1', orgId: 'org-1', contractId: 'ct-1', name: 'Backups', description: null, cadence: 'monthly',
  anchorDueDate: '2026-01-05', effectiveFrom: '2026-01-01', effectiveUntil: null, leadDays: 7, graceDays: 14,
  artifactRequired: true, completionMode: 'explicit', autoEvidenceReportId: null, ownerUserId: null,
  ticketCategoryId: null, instructions: null, checklistTemplateId: null, portalVisible: true, active: true,
  sortOrder: 0, createdBy: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  contractName: 'Draft A', nextDue: '2026-10-05', lastDelivered: null, openCount: 0, status: 'on_track', ...over,
});

const ROWS = [row({ id: 'd-1', name: 'Backups' }), row({ id: 'd-2', name: 'Patching' })];
const CONTRACTS = [
  { id: 'ct-1', name: 'Draft A', status: 'draft' },
  { id: 'ct-2', name: 'Signed MSA', status: 'active' },
  { id: 'ct-x', name: 'Dead', status: 'cancelled' },
];

function makeFetcher(moveResponse: () => Response = () => jsonResp(200, { data: { moved: 2 } })) {
  return vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path.startsWith('/contracts')) return jsonResp(200, { data: CONTRACTS });
    if (method === 'GET' && path.startsWith('/orgs/org-1/deliverables')) return jsonResp(200, { data: ROWS });
    if (method === 'POST' && path === '/orgs/org-1/deliverables/move') return moveResponse();
    throw new Error(`unexpected ${method} ${path}`);
  });
}

const moveCalls = (f: ReturnType<typeof makeFetcher>) =>
  f.mock.calls.filter(([p, i]) => p === '/orgs/org-1/deliverables/move' && i?.method === 'POST');

beforeEach(() => vi.clearAllMocks());

describe('bulk move from the table (#9302)', () => {
  it('multi-selects rows, picks a non-cancelled target and POSTs one batch', async () => {
    const fetcher = makeFetcher();
    render(<DeliverableTable fetcher={fetcher} orgId="org-1" groupByContract selectable />);
    fireEvent.click(await screen.findByTestId('deliverable-select-d-1'));
    fireEvent.click(screen.getByTestId('deliverable-select-d-2'));
    fireEvent.click(screen.getByTestId('deliverables-move-open'));
    const target = (await screen.findByTestId('move-to-target')) as HTMLSelectElement;
    await waitFor(() => expect(target).not.toBeDisabled());
    expect(Array.from(target.options).map((o) => o.value)).toEqual(['', 'ct-1', 'ct-2']); // cancelled excluded
    fireEvent.change(target, { target: { value: 'ct-2' } });
    fireEvent.click(screen.getByTestId('move-to-confirm'));
    await waitFor(() => expect(moveCalls(fetcher)).toHaveLength(1));
    expect(JSON.parse(String(moveCalls(fetcher)[0][1]?.body))).toEqual({ deliverableIds: ['d-1', 'd-2'], contractId: 'ct-2' });
  });

  it('names the colliding deliverables when the batch is refused with 409', async () => {
    const fetcher = makeFetcher(() =>
      jsonResp(409, { error: 'dup', code: 'DUPLICATE_NAME', details: { names: ['Patching'] } }));
    render(<DeliverableTable fetcher={fetcher} orgId="org-1" selectable />);
    fireEvent.click(await screen.findByTestId('deliverable-select-d-1'));
    fireEvent.click(screen.getByTestId('deliverables-move-open'));
    await waitFor(() => expect(screen.getByTestId('move-to-target')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('move-to-confirm'));
    expect((await screen.findByTestId('move-error')).textContent).toContain('Patching');
  });

  it('does not render checkboxes unless selectable', async () => {
    render(<DeliverableTable fetcher={makeFetcher()} orgId="org-1" />);
    await screen.findByTestId('deliverable-row-d-1');
    expect(screen.queryByTestId('deliverable-select-d-1')).toBeNull();
  });
});

describe('MoveHereDialog (#9302)', () => {
  it('lists only deliverables of OTHER contracts and moves the picked ones here', async () => {
    const fetcher = makeFetcher();
    const onMoved = vi.fn();
    render(<MoveHereDialog fetcher={fetcher} orgId="org-1" targetContractId="ct-2" onClose={vi.fn()} onMoved={onMoved} />);
    fireEvent.click(await screen.findByTestId('move-here-pick-d-1'));
    fireEvent.click(screen.getByTestId('move-here-confirm'));
    await waitFor(() => expect(moveCalls(fetcher)).toHaveLength(1));
    expect(JSON.parse(String(moveCalls(fetcher)[0][1]?.body))).toEqual({ deliverableIds: ['d-1'], contractId: 'ct-2' });
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
  });

  it('shows the empty state when everything already lives on this contract', async () => {
    render(<MoveHereDialog fetcher={makeFetcher()} orgId="org-1" targetContractId="ct-1" onClose={vi.fn()} onMoved={vi.fn()} />);
    expect(await screen.findByTestId('move-here-empty')).toBeTruthy();
    expect(screen.getByTestId('move-here-confirm')).toBeDisabled();
  });
});
