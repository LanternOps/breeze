import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import { showToast } from '../shared/Toast';
import { ApplyTemplateModal } from './ApplyTemplateModal';
import type { TemplateSet } from '../../lib/api/deliverableTemplates';
import type { Fetcher } from '../../lib/api/serviceDeliverables';

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const ORG_ID = 'org-1';

const SETS: TemplateSet[] = [
  {
    id: 'set-org',
    orgId: ORG_ID,
    partnerId: null,
    ownerScope: 'organization',
    name: 'Good plan',
    description: null,
    items: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'set-partner',
    orgId: null,
    partnerId: 'partner-1',
    ownerScope: 'partner',
    name: 'Best plan',
    description: null,
    items: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

const CONTRACTS = [{ id: 'contract-1', name: 'Support agreement' }];

function fetcherFor(opts: {
  setsResponse?: Response;
  contractsResponse?: Response;
  applyResponse?: Response;
}): Fetcher {
  return vi.fn(async (path: string, init?: RequestInit) => {
    if (path.startsWith('/deliverable-templates') && (!init || (init.method ?? 'GET') === 'GET')) {
      return opts.setsResponse ?? jsonResponse({ data: SETS });
    }
    if (path.startsWith('/contracts')) {
      return opts.contractsResponse ?? jsonResponse({ data: CONTRACTS });
    }
    if (path.includes('/deliverables/apply-template')) {
      return (
        opts.applyResponse ??
        jsonResponse({
          data: {
            setId: 'set-org',
            setName: 'Good plan',
            orgId: ORG_ID,
            contractId: null,
            effectiveFrom: '2026-01-01',
            created: [{ id: 'd-1', name: 'Monthly report', cadence: 'monthly', anchorDueDate: '2026-02-01' }],
            skipped: [],
          },
        })
      );
    }
    return jsonResponse({ error: 'unexpected' }, 500);
  }) as unknown as Fetcher;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ApplyTemplateModal', () => {
  it('lists template sets and badges the partner-wide ones', async () => {
    const fetcher = fetcherFor({});
    render(<ApplyTemplateModal fetcher={fetcher} orgId={ORG_ID} onApplied={vi.fn()} onClose={vi.fn()} />);

    const select = await screen.findByTestId('apply-template-set');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toContain('Good plan');
    expect(options.some((o) => o?.includes('Best plan') && o.includes('All orgs'))).toBe(true);
  });

  it('locks the contract field when opened from the contract section', async () => {
    const fetcher = fetcherFor({});
    render(
      <ApplyTemplateModal fetcher={fetcher} orgId={ORG_ID} contractId="contract-fixed" onApplied={vi.fn()} onClose={vi.fn()} />,
    );
    await screen.findByTestId('apply-template-set');
    const contractField = screen.getByTestId('apply-template-contract');
    expect(contractField.tagName).toBe('INPUT');
    expect((contractField as HTMLInputElement).value).toBe('contract-fixed');
    // No contracts fetch is made when the contract is already fixed.
    const calls = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls as [string][];
    expect(calls.some(([p]) => p.startsWith('/contracts'))).toBe(false);
  });

  it('POSTs apply-template with the chosen set, contract and effective date', async () => {
    const fetcher = fetcherFor({});
    const onApplied = vi.fn();
    render(<ApplyTemplateModal fetcher={fetcher} orgId={ORG_ID} onApplied={onApplied} onClose={vi.fn()} />);

    await screen.findByTestId('apply-template-set');
    fireEvent.change(screen.getByTestId('apply-template-set'), { target: { value: 'set-org' } });
    await screen.findByText('Support agreement');
    fireEvent.change(screen.getByTestId('apply-template-contract'), { target: { value: 'contract-1' } });
    fireEvent.change(screen.getByTestId('apply-template-effective-from'), { target: { value: '2026-03-01' } });
    fireEvent.click(screen.getByTestId('apply-template-submit'));

    await waitFor(() => {
      const calls = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit | undefined][];
      const call = calls.find(([p, init]) => p.includes('/deliverables/apply-template') && init?.method === 'POST');
      expect(call).toBeTruthy();
      const body = JSON.parse(String((call![1] as RequestInit).body));
      expect(body).toEqual({ setId: 'set-org', contractId: 'contract-1', effectiveFrom: '2026-03-01' });
    });
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
  });

  it('renders the colliding names inline on 409 and keeps the modal open', async () => {
    const onApplied = vi.fn();
    const onClose = vi.fn();
    const fetcher = fetcherFor({
      applyResponse: jsonResponse(
        { error: 'names collide', code: 'TEMPLATE_NAME_COLLISION', details: { collisions: ['Monthly report', 'Quarterly review'] } },
        409,
      ),
    });
    render(<ApplyTemplateModal fetcher={fetcher} orgId={ORG_ID} onApplied={onApplied} onClose={onClose} />);

    await screen.findByTestId('apply-template-set');
    fireEvent.change(screen.getByTestId('apply-template-set'), { target: { value: 'set-org' } });
    fireEvent.click(screen.getByTestId('apply-template-submit'));

    const collision = await screen.findByTestId('apply-template-collision');
    expect(collision.textContent).toContain('Monthly report');
    expect(collision.textContent).toContain('Quarterly review');
    expect(onApplied).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('apply-template-modal')).toBeInTheDocument();
  });

  it('reports skipped names on success and calls onApplied', async () => {
    const onApplied = vi.fn();
    const fetcher = fetcherFor({
      applyResponse: jsonResponse({
        data: {
          setId: 'set-org',
          setName: 'Good plan',
          orgId: ORG_ID,
          contractId: null,
          effectiveFrom: '2026-01-01',
          created: [{ id: 'd-1', name: 'Monthly report', cadence: 'monthly', anchorDueDate: '2026-02-01' }],
          skipped: ['Quarterly review'],
        },
      }),
    });
    render(<ApplyTemplateModal fetcher={fetcher} orgId={ORG_ID} onApplied={onApplied} onClose={vi.fn()} />);

    await screen.findByTestId('apply-template-set');
    fireEvent.change(screen.getByTestId('apply-template-set'), { target: { value: 'set-org' } });
    fireEvent.click(screen.getByTestId('apply-template-submit'));

    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(expect.objectContaining({ skipped: ['Quarterly review'] })));
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'success',
          message: expect.stringContaining('Quarterly review'),
        }),
      );
    });
  });
});
