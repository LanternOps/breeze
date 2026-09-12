import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeliverableForm from './DeliverableForm';
import type { Deliverable } from '../../lib/api/serviceDeliverables';

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const saved: Deliverable = {
  id: 'd-new',
  orgId: 'org-1',
  contractId: 'ct-1',
  name: 'Monthly report',
  description: null,
  cadence: 'monthly',
  anchorDueDate: '2026-01-05',
  effectiveFrom: '2026-01-01',
  effectiveUntil: null,
  leadDays: 7,
  graceDays: 14,
  artifactRequired: true,
  completionMode: 'on_ticket_resolve',
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
  lastDelivered: null,
  openCount: 0,
  status: 'on_track',
};

const OPTIONS = [{ id: 'ct-1', name: 'Acme MSA' }];

function makeFetcher() {
  return vi.fn(async () =>
    ({
      ok: true,
      status: 201,
      statusText: 'Created',
      json: vi.fn().mockResolvedValue({ data: saved }),
    }) as unknown as Response,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('DeliverableForm contract picker', () => {
  it('always offers the picker (with the no-contract option) when no contract is pinned, even with no options', () => {
    render(<DeliverableForm fetcher={makeFetcher()} orgId="org-1" contractOptions={[]} onSaved={vi.fn()} onCancel={vi.fn()} />);
    const picker = screen.getByTestId('deliverable-form-contract') as HTMLSelectElement;
    expect(picker).toBeEnabled();
    expect(Array.from(picker.options).map((o) => o.textContent)).toEqual(['Not tied to a contract']);
  });

  it('hides the picker when the contract is pinned', () => {
    render(<DeliverableForm fetcher={makeFetcher()} orgId="org-1" contractId="ct-1" onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByTestId('deliverable-form-contract')).toBeNull();
  });

  it('disables the picker while contracts are loading', () => {
    render(
      <DeliverableForm fetcher={makeFetcher()} orgId="org-1" contractOptions={[]} contractsState="loading" onSaved={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByTestId('deliverable-form-contract')).toBeDisabled();
    expect(screen.queryByTestId('deliverable-form-contracts-error')).toBeNull();
  });

  it('shows the inline error and refuses to save when the contracts load failed', () => {
    const fetcher = makeFetcher();
    render(
      <DeliverableForm fetcher={fetcher} orgId="org-1" contractOptions={[]} contractsState="failed" onSaved={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByTestId('deliverable-form-contracts-error').textContent).toContain('Could not load');
    expect(screen.getByTestId('deliverable-form-contract')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Monthly report' } });
    expect(screen.getByTestId('deliverable-form-save')).toBeDisabled();
    fireEvent.submit(screen.getByTestId('deliverable-form'));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('POSTs the chosen contract id once the options are loaded', async () => {
    const fetcher = makeFetcher();
    const onSaved = vi.fn();
    render(<DeliverableForm fetcher={fetcher} orgId="org-1" contractOptions={OPTIONS} onSaved={onSaved} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Monthly report' } });
    fireEvent.change(screen.getByTestId('deliverable-form-contract'), { target: { value: 'ct-1' } });
    expect(screen.getByTestId('deliverable-form-save')).toBeEnabled();
    fireEvent.click(screen.getByTestId('deliverable-form-save'));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/orgs/org-1/deliverables');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({ name: 'Monthly report', contractId: 'ct-1' });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
  });
});
