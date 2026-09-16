import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeliverableForm from './DeliverableForm';
import type { Deliverable } from '../../lib/api/serviceDeliverables';
import type { ChecklistTemplate } from '../../lib/api/ticketChecklistTemplates';
import { showToast } from '../shared/Toast';

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
  lastDelivered: null,
  openCount: 0,
  status: 'on_track',
};

const OPTIONS = [{ id: 'ct-1', name: 'Acme MSA' }];

const jsonResp = (status: number, payload: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const isTemplatesGet = (path: string, init?: RequestInit) =>
  path.startsWith('/ticket-checklist-templates') && (init?.method ?? 'GET') === 'GET';

// The form loads the checklist-template picker on mount regardless of which
// test is exercising the contract picker, so every fetcher used below answers
// that GET with an empty list unless a test overrides it.
function makeFetcher() {
  return vi.fn(async (path: string, init?: RequestInit) => {
    if (isTemplatesGet(path, init)) return jsonResp(200, { data: [] });
    return jsonResp(201, { data: saved });
  });
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
    expect(fetcher.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });

  it('POSTs the chosen contract id once the options are loaded', async () => {
    const fetcher = makeFetcher();
    const onSaved = vi.fn();
    render(<DeliverableForm fetcher={fetcher} orgId="org-1" contractOptions={OPTIONS} onSaved={onSaved} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Monthly report' } });
    fireEvent.change(screen.getByTestId('deliverable-form-contract'), { target: { value: 'ct-1' } });
    expect(screen.getByTestId('deliverable-form-save')).toBeEnabled();
    fireEvent.click(screen.getByTestId('deliverable-form-save'));

    await waitFor(() => {
      const postCalls = fetcher.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
      expect(postCalls).toHaveLength(1);
    });
    const [path, init] = fetcher.mock.calls.find(
      ([, i]) => (i as RequestInit | undefined)?.method === 'POST',
    ) as unknown as [string, RequestInit];
    expect(path).toBe('/orgs/org-1/deliverables');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({ name: 'Monthly report', contractId: 'ct-1' });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
  });
});

describe('DeliverableForm auto-evidence report picker', () => {
  it('renders the evidence report picker bound to empty when None', () => {
    render(<DeliverableForm fetcher={makeFetcher()} orgId="org-1" contractOptions={[]} onSaved={vi.fn()} onCancel={vi.fn()} />);
    const picker = screen.getByTestId('deliverable-auto-evidence-report') as HTMLSelectElement;
    expect(picker.value).toBe('');
  });

  it('shows the empty state while no managed evidence type has shipped', () => {
    render(<DeliverableForm fetcher={makeFetcher()} orgId="org-1" contractOptions={[]} onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('deliverable-auto-evidence-empty')).toBeInTheDocument();
  });
});

describe('DeliverableForm checklist fields (#5808 W03)', () => {
  const templates: ChecklistTemplate[] = [
    {
      id: 'tpl-org',
      orgId: 'org-1',
      partnerId: 'partner-1',
      ownerScope: 'organization',
      name: 'Standard onboarding',
      description: null,
      instructions: null,
      isActive: true,
      items: [],
      createdAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'tpl-partner',
      orgId: null,
      partnerId: 'partner-1',
      ownerScope: 'partner',
      name: 'Gold tier',
      description: null,
      instructions: null,
      isActive: true,
      items: [],
      createdAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'tpl-inactive',
      orgId: 'org-1',
      partnerId: 'partner-1',
      ownerScope: 'organization',
      name: 'Retired procedure',
      description: null,
      instructions: null,
      isActive: false,
      items: [],
      createdAt: '2026-01-01T00:00:00Z',
    },
  ];

  function makeFetcherWithTemplates(response: 'ok' | 'fail' = 'ok') {
    return vi.fn(async (path: string, init?: RequestInit) => {
      if (isTemplatesGet(path, init)) {
        return response === 'fail' ? jsonResp(500, { error: 'boom' }) : jsonResp(200, { data: templates });
      }
      return jsonResp(201, { data: saved });
    });
  }

  it('renders the internal-only hint for the instructions field', async () => {
    render(<DeliverableForm fetcher={makeFetcherWithTemplates()} orgId="org-1" contractId="ct-1" onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(await screen.findByTestId('deliverable-instructions-hint')).toHaveTextContent(/never shown to the customer/i);
  });

  it('lists only ACTIVE templates, marking partner-wide ones as All orgs', async () => {
    render(<DeliverableForm fetcher={makeFetcherWithTemplates()} orgId="org-1" contractId="ct-1" onSaved={vi.fn()} onCancel={vi.fn()} />);
    const select = (await screen.findByTestId('deliverable-checklist-template')) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3)); // None + 2 active templates
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toContain('Standard onboarding');
    expect(labels.some((l) => l?.includes('Gold tier') && l?.includes('All orgs'))).toBe(true);
    expect(labels.some((l) => l?.includes('Retired procedure'))).toBe(false);
  });

  it('submits both instructions and the chosen checklist template', async () => {
    const fetcher = makeFetcherWithTemplates();
    const onSaved = vi.fn();
    render(<DeliverableForm fetcher={fetcher} orgId="org-1" contractId="ct-1" onSaved={onSaved} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Monthly report' } });
    fireEvent.change(screen.getByLabelText('Internal instructions'), { target: { value: 'Check the backup logs first' } });
    const select = (await screen.findByTestId('deliverable-checklist-template')) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    fireEvent.change(select, { target: { value: 'tpl-org' } });
    fireEvent.click(screen.getByTestId('deliverable-form-save'));

    await waitFor(() => {
      const postCall = fetcher.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
      expect(postCall).toBeTruthy();
      const body = JSON.parse(String((postCall![1] as RequestInit).body));
      expect(body.instructions).toBe('Check the backup logs first');
      expect(body.checklistTemplateId).toBe('tpl-org');
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('sends checklistTemplateId null when None is selected', async () => {
    const fetcher = makeFetcherWithTemplates();
    render(<DeliverableForm fetcher={fetcher} orgId="org-1" contractId="ct-1" onSaved={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Monthly report' } });
    fireEvent.click(screen.getByTestId('deliverable-form-save'));

    await waitFor(() => {
      const postCall = fetcher.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
      expect(postCall).toBeTruthy();
      const body = JSON.parse(String((postCall![1] as RequestInit).body));
      expect(body.checklistTemplateId).toBeNull();
    });
  });

  it('keeps working with only the None option when the template list fetch fails, without toasting', async () => {
    render(
      <DeliverableForm fetcher={makeFetcherWithTemplates('fail')} orgId="org-1" contractId="ct-1" onSaved={vi.fn()} onCancel={vi.fn()} />,
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const select = (await screen.findByTestId('deliverable-checklist-template')) as HTMLSelectElement;
      await waitFor(() => expect(select.options.length).toBe(1));
      expect(select.options[0]!.textContent).toBe('None');
      expect(showToast).not.toHaveBeenCalled();
      // ...but it must not be SILENT either. A failed fetch is not "this MSP
      // has no templates", and console.error is the only trace available (the
      // web app has no client-side Sentry). Same precedent as
      // TicketChecklistCard.tsx.
      await waitFor(() => expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to load checklist templates'),
        expect.anything(),
      ));
    } finally { errSpy.mockRestore(); }
  });

  it('surfaces a 404 on submit through the existing runClientAction error path', async () => {
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if (isTemplatesGet(path, init)) return jsonResp(200, { data: [] });
      return jsonResp(404, { error: 'Deliverable not found' });
    });
    render(<DeliverableForm fetcher={fetcher} orgId="org-1" contractId="ct-1" onSaved={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Monthly report' } });
    fireEvent.click(screen.getByTestId('deliverable-form-save'));

    expect(await screen.findByTestId('deliverable-form-error')).toHaveTextContent('Deliverable not found');
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  });
});
