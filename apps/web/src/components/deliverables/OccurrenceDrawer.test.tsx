import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OccurrenceDrawer from './OccurrenceDrawer';
import type { Deliverable, Occurrence } from '../../lib/api/serviceDeliverables';
import { showToast } from '../shared/Toast';
// TicketChecklistCard (mounted lazily by OccurrenceDrawer's checklist expansion,
// #5808 W03) reaches the ambient `fetchWithAuth` directly rather than through
// the `fetcher` prop the drawer itself uses, so it needs its own mock here.
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const checklistFetchMock = vi.mocked(fetchWithAuth);

const jsonResp = (status: number, payload: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const deliverable: Deliverable = {
  id: 'd-1',
  orgId: 'org-1',
  contractId: null,
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
  contractName: null,
  nextDue: '2026-10-05',
  lastDelivered: null,
  openCount: 1,
  status: 'on_track',
};

const occurrence: Occurrence = {
  id: 'oc-1',
  orgId: 'org-1',
  deliverableId: 'd-1',
  nameSnapshot: 'Monthly executive report',
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  dueAt: '2026-10-12',
  originalDueAt: '2026-10-05',
  status: 'open',
  ticketId: null,
  deliveredAt: null,
  deliveredByUserId: null,
  deliveredVia: null,
  deliveryNote: null,
  waivedAt: null,
  waivedByUserId: null,
  waivedReason: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  late: false,
  evidence: [
    { id: 'ev-1', kind: 'report_run', documentId: null, reportId: 'r-1', reportRunId: 'run-1', contractDocumentId: null, createdAt: '2026-09-02T00:00:00Z' },
  ],
  checklist: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OccurrenceDrawer evidence upload (#5573 W03)', () => {
  const pdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'findings.pdf', { type: 'application/pdf' });

  const uploadFile = async (testId: string) => {
    const input = (await screen.findByTestId(testId)) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pdf()] } });
  };

  it('uploads a file as evidence through the multipart route and refreshes the occurrence', async () => {
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return jsonResp(200, { data: [occurrence] });
      if (path.endsWith('/evidence/upload')) {
        return jsonResp(200, {
          data: {
            ...occurrence,
            evidence: [
              ...occurrence.evidence,
              { id: 'ev-2', kind: 'document', documentId: 'doc-1', reportId: null, reportRunId: null, contractDocumentId: null, createdAt: '2026-09-03T00:00:00Z' },
            ],
          },
        });
      }
      throw new Error(`unexpected ${init?.method} ${path}`);
    });
    const onChanged = vi.fn();
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} onChanged={onChanged} />);
    await uploadFile('occurrence-evidence-file-oc-1');
    fireEvent.click(screen.getByTestId('occurrence-evidence-upload-oc-1'));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      '/orgs/org-1/deliverables/occurrences/oc-1/evidence/upload',
      expect.objectContaining({ method: 'POST', body: expect.any(FormData) }),
    ));
    const uploadCall = (fetcher.mock.calls as unknown as Array<[string, RequestInit | undefined]>)
      .find((c) => String(c[0]).endsWith('/evidence/upload'));
    const init = uploadCall![1] as RequestInit;
    // The browser supplies the multipart boundary; a Content-Type here breaks it.
    expect(init.headers).toBeUndefined();
    expect(await screen.findByTestId('evidence-chip-ev-2')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it('does nothing until a file is chosen', async () => {
    const fetcher = vi.fn(async (_path: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'GET') throw new Error('no request should be sent without a file');
      return jsonResp(200, { data: [occurrence] });
    });
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    const button = await screen.findByTestId('occurrence-evidence-upload-oc-1');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(fetcher.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('surfaces a 415 from the upload as the translated unsupported-type message, not a generic error', async () => {
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return jsonResp(200, { data: [occurrence] });
      if (path.endsWith('/evidence/upload')) {
        return jsonResp(415, { error: 'Only JPEG, PNG, WebP images and PDFs can be stored', code: 'UNSUPPORTED_DOCUMENT_TYPE' });
      }
      throw new Error(`unexpected ${init?.method} ${path}`);
    });
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    await uploadFile('occurrence-evidence-file-oc-1');
    fireEvent.click(screen.getByTestId('occurrence-evidence-upload-oc-1'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: 'Only PDF, JPEG, PNG and WebP files can be attached.',
    })));
  });
});

describe('OccurrenceDrawer', () => {
  it('lists occurrences with status, rescheduled-from note and evidence chips', async () => {
    const fetcher = vi.fn(async () => jsonResp(200, { data: [occurrence] }));
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('occurrence-drawer')).toBeInTheDocument());
    expect(fetcher).toHaveBeenCalledWith('/orgs/org-1/deliverables/d-1/occurrences?limit=24');
    const row = await screen.findByTestId('occurrence-row-oc-1');
    expect(row).toHaveTextContent('Open');
    expect(row).toHaveTextContent(/Rescheduled from/);
    expect(screen.getByTestId('evidence-remove-ev-1')).toBeInTheDocument();
  });

  it('shows an empty state with the lead days and next due date when no occurrence exists yet (#6219)', async () => {
    const fetcher = vi.fn(async () => jsonResp(200, { data: [] }));
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    const empty = await screen.findByTestId('occurrence-empty');
    expect(empty).toHaveTextContent(/No occurrences yet/);
    expect(empty).toHaveTextContent('7 days');
    expect(empty).toHaveTextContent('(');
    expect(screen.queryByTestId('occurrence-list')).toBeNull();
  });

  it('uses the singular plural form when leadDays is 1 (#6219)', async () => {
    const fetcher = vi.fn(async () => jsonResp(200, { data: [] }));
    render(
      <OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={{ ...deliverable, leadDays: 1 }} onClose={vi.fn()} />,
    );
    const empty = await screen.findByTestId('occurrence-empty');
    expect(empty).toHaveTextContent('1 day');
    expect(empty).not.toHaveTextContent('1 days');
  });

  it('omits the date clause when the next due date is unknown (#6219)', async () => {
    const fetcher = vi.fn(async () => jsonResp(200, { data: [] }));
    render(
      <OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={{ ...deliverable, nextDue: null, anchorDueDate: '2000-01-01' }} onClose={vi.fn()} />,
    );
    const empty = await screen.findByTestId('occurrence-empty');
    expect(empty).toHaveTextContent(/No occurrences yet/);
    expect(empty).not.toHaveTextContent(/\(/);
  });

  it('falls back to the anchor due date when nextDue is unknown but the anchor is still upcoming (#6219)', async () => {
    const fetcher = vi.fn(async () => jsonResp(200, { data: [] }));
    render(
      <OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={{ ...deliverable, nextDue: null, anchorDueDate: '2099-01-05' }} onClose={vi.fn()} />,
    );
    const empty = await screen.findByTestId('occurrence-empty');
    expect(empty).toHaveTextContent(/No occurrences yet/);
    expect(empty).toHaveTextContent('(');
  });

  it('surfaces the EVIDENCE_REQUIRED message inline when Deliver is rejected with a 400', async () => {
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return jsonResp(200, { data: [{ ...occurrence, evidence: [] }] });
      if (path.endsWith('/deliver')) {
        return jsonResp(400, {
          error: 'This deliverable requires evidence before it can be marked delivered',
          code: 'EVIDENCE_REQUIRED',
        });
      }
      throw new Error(`unexpected ${init?.method} ${path}`);
    });
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('occurrence-deliver-oc-1'));
    fireEvent.click(screen.getByTestId('occurrence-action-save'));

    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        '/orgs/org-1/deliverables/occurrences/oc-1/deliver',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ note: undefined }) }),
      ),
    );
    expect(await screen.findByText('Attach evidence before marking this occurrence delivered.')).toBeInTheDocument();
    // the generic toast still fires; the inline message is in addition to it
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('sends report-run evidence with Deliver only when an id was entered', async () => {
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return jsonResp(200, { data: [occurrence] });
      if (path.endsWith('/deliver')) return jsonResp(200, { data: { ...occurrence, status: 'delivered' } });
      throw new Error(`unexpected ${init?.method} ${path}`);
    });
    const onChanged = vi.fn();
    render(
      <OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} onChanged={onChanged} />,
    );
    fireEvent.click(await screen.findByTestId('occurrence-deliver-oc-1'));
    fireEvent.change(screen.getByLabelText('Delivery note'), { target: { value: 'Sent by email' } });
    fireEvent.change(screen.getByLabelText('Report run ID'), { target: { value: 'run-9' } });
    fireEvent.click(screen.getByTestId('occurrence-action-save'));

    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        '/orgs/org-1/deliverables/occurrences/oc-1/deliver',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ note: 'Sent by email', evidence: [{ kind: 'report_run', reportRunId: 'run-9' }] }),
        }),
      ),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Marked as delivered' }));
  });

  it('keeps Waive Save disabled until a reason is typed, then POSTs the reason', async () => {
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return jsonResp(200, { data: [occurrence] });
      if (path.endsWith('/waive')) return jsonResp(200, { data: { ...occurrence, status: 'waived' } });
      throw new Error(`unexpected ${init?.method} ${path}`);
    });
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('occurrence-waive-oc-1'));

    const save = screen.getByTestId('occurrence-action-save');
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason for waiving'), { target: { value: '   ' } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason for waiving'), { target: { value: 'Customer paused service' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        '/orgs/org-1/deliverables/occurrences/oc-1/waive',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ reason: 'Customer paused service' }) }),
      ),
    );
  });

  it('removes evidence through runAction', async () => {
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return jsonResp(200, { data: [occurrence] });
      if (init?.method === 'DELETE') return jsonResp(200, { data: { ...occurrence, evidence: [] } });
      throw new Error(`unexpected ${init?.method} ${path}`);
    });
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('evidence-remove-ev-1'));
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        '/orgs/org-1/deliverables/occurrences/oc-1/evidence/ev-1',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
    await waitFor(() => expect(screen.queryByTestId('evidence-remove-ev-1')).not.toBeInTheDocument());
  });
});

describe('OccurrenceDrawer checklist progress (#5808 W03)', () => {
  const checklistSummary = (done: number, total: number) => ({
    items: Array.from({ length: total }, (_, i) => ({
      id: `ci-${i}`,
      ticketId: 'tk-1',
      label: `Step ${i}`,
      detail: null,
      position: i,
      done: i < done,
      doneAt: null,
      doneByUserId: null,
      source: 'manual',
      sourceTemplateItemId: null,
      createdAt: '2026-09-01T00:00:00Z',
    })),
    done,
    total,
  });

  beforeEach(() => {
    // Default: any TicketChecklistCard that mounts sees a small checklist. Tests
    // that need to observe failures or count calls override this per-call.
    checklistFetchMock.mockImplementation(async (path: string) => {
      if (String(path).endsWith('/checklist')) return jsonResp(200, { data: checklistSummary(1, 2) });
      return jsonResp(200, { data: [] });
    });
  });

  it('renders a progress chip for an occurrence with a checklist', async () => {
    const occ: Occurrence = { ...occurrence, ticketId: 'tk-1', checklist: { done: 2, total: 5 } };
    const fetcher = vi.fn(async () => jsonResp(200, { data: [occ] }));
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    const chip = await screen.findByTestId('occurrence-checklist-chip-oc-1');
    expect(chip).toHaveTextContent('2 / 5');
  });

  it('renders no chip for an occurrence whose checklist is null', async () => {
    const fetcher = vi.fn(async () => jsonResp(200, { data: [occurrence] }));
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    await screen.findByTestId('occurrence-row-oc-1');
    expect(screen.queryByTestId('occurrence-checklist-chip-oc-1')).toBeNull();
  });

  it('mounts no ticket-checklist-card until a row is expanded', async () => {
    const occ: Occurrence = { ...occurrence, ticketId: 'tk-1', checklist: { done: 1, total: 3 } };
    const fetcher = vi.fn(async () => jsonResp(200, { data: [occ] }));
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    await screen.findByTestId('occurrence-checklist-chip-oc-1');
    expect(screen.queryByTestId('ticket-checklist-card')).toBeNull();
    expect(checklistFetchMock).not.toHaveBeenCalled();
  });

  it('expanding one row mounts exactly one card and issues exactly one /checklist fetch', async () => {
    const occA: Occurrence = { ...occurrence, id: 'oc-1', ticketId: 'tk-1', checklist: { done: 1, total: 2 } };
    const occB: Occurrence = { ...occurrence, id: 'oc-2', ticketId: 'tk-2', checklist: { done: 0, total: 1 } };
    const fetcher = vi.fn(async () => jsonResp(200, { data: [occA, occB] }));
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('occurrence-checklist-expand-oc-1'));

    expect(await screen.findAllByTestId('ticket-checklist-card')).toHaveLength(1);
    await waitFor(() => {
      const checklistCalls = checklistFetchMock.mock.calls.filter(([path]) => String(path).endsWith('/checklist'));
      expect(checklistCalls).toHaveLength(1);
    });
  });

  it('expanding a second row unmounts the first', async () => {
    const occA: Occurrence = { ...occurrence, id: 'oc-1', ticketId: 'tk-1', checklist: { done: 1, total: 2 } };
    const occB: Occurrence = { ...occurrence, id: 'oc-2', ticketId: 'tk-2', checklist: { done: 0, total: 1 } };
    const fetcher = vi.fn(async () => jsonResp(200, { data: [occA, occB] }));
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByTestId('occurrence-checklist-expand-oc-1'));
    await waitFor(() => expect(screen.getAllByTestId('ticket-checklist-card')).toHaveLength(1));

    fireEvent.click(screen.getByTestId('occurrence-checklist-expand-oc-2'));
    await waitFor(() => expect(screen.getAllByTestId('ticket-checklist-card')).toHaveLength(1));
    // Still exactly one card mounted, and it now belongs to the second row —
    // verified indirectly by the second row's fetch having fired.
    await waitFor(() => {
      const checklistCalls = checklistFetchMock.mock.calls.filter(([path]) => String(path) === '/tickets/tk-2/checklist');
      expect(checklistCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('collapsing the expanded row unmounts its card', async () => {
    const occ: Occurrence = { ...occurrence, ticketId: 'tk-1', checklist: { done: 1, total: 2 } };
    const fetcher = vi.fn(async () => jsonResp(200, { data: [occ] }));
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByTestId('occurrence-checklist-expand-oc-1'));
    await waitFor(() => expect(screen.getByTestId('ticket-checklist-card')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('occurrence-checklist-expand-oc-1'));
    expect(screen.queryByTestId('ticket-checklist-card')).toBeNull();
  });

  it('does not toast when the lazily-loaded checklist fails to load (e.g. a 403 without tickets:read)', async () => {
    const occ: Occurrence = { ...occurrence, ticketId: 'tk-1', checklist: { done: 1, total: 2 } };
    const fetcher = vi.fn(async () => jsonResp(200, { data: [occ] }));
    checklistFetchMock.mockImplementation(async (path: string) =>
      String(path).endsWith('/checklist') ? jsonResp(403, { error: 'forbidden' }) : jsonResp(200, { data: [] }),
    );
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByTestId('occurrence-checklist-expand-oc-1'));
    await screen.findByTestId('ticket-checklist-error');
    expect(showToast).not.toHaveBeenCalled();
  });

  it('renders the Operator badge inside the compact card too (the second mount site)', async () => {
    // TicketWorkbench stubs TicketChecklistCard, so this drawer is the only
    // host suite that proves the badge actually reaches a mounted page.
    const occ: Occurrence = { ...occurrence, ticketId: 'tk-1', checklist: { done: 0, total: 1 } };
    const fetcher = vi.fn(async () => jsonResp(200, { data: [occ] }));
    checklistFetchMock.mockImplementation(async (path: string) => {
      if (String(path).endsWith('/checklist')) {
        return jsonResp(200, {
          data: {
            items: [
              {
                id: 'ci-op',
                ticketId: 'tk-1',
                label: 'Operator step',
                detail: null,
                position: 0,
                done: false,
                doneAt: null,
                doneByUserId: null,
                source: 'operator_task',
                operatorTaskId: 'task-9',
                sourceTemplateItemId: null,
                createdAt: '2026-09-01T00:00:00Z',
              },
            ],
            done: 0,
            total: 1,
          },
        });
      }
      return jsonResp(200, { data: [] });
    });
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('occurrence-checklist-expand-oc-1'));
    expect(await screen.findByTestId('ticket-checklist-operator-badge-ci-op')).toBeInTheDocument();
  });
});

describe('OccurrenceDrawer link signed agreement (#9312)', () => {
  const AGREEMENTS_PATH = '/contracts/contract-documents?orgId=org-1&linked=all';
  const agreements = [
    {
      id: 'cd-1', orgId: 'org-1', templateName: 'Master services agreement', templateVersionNumber: 3,
      signerName: 'Jane Doe', signedAt: '2026-09-15T12:00:00Z', createdAt: '2026-09-15T12:00:00Z', mime: 'application/pdf',
    },
  ];

  it('lists the org\'s signed agreements and links one by reference', async () => {
    const awaiting = { ...occurrence, status: 'awaiting_evidence' as const, evidence: [] };
    const linked = {
      ...awaiting,
      status: 'delivered' as const,
      evidence: [{
        id: 'ev-7', kind: 'contract_document' as const, documentId: null, reportId: null, reportRunId: null,
        contractDocumentId: 'cd-1', createdAt: '2026-09-16T00:00:00Z',
      }],
    };
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && path === AGREEMENTS_PATH) return jsonResp(200, { data: agreements });
      if (method === 'GET') return jsonResp(200, { data: [awaiting] });
      if (path.endsWith('/evidence')) return jsonResp(200, { data: linked });
      throw new Error(`unexpected ${method} ${path}`);
    });
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('occurrence-evidence-link-agreement-oc-1'));
    const select = await screen.findByTestId('occurrence-evidence-agreement-select-oc-1');
    await waitFor(() => expect(screen.getByRole('option', { name: /Master services agreement/ })).toBeTruthy());
    expect((screen.getByTestId('occurrence-evidence-agreement-save-oc-1') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: 'cd-1' } });
    fireEvent.click(screen.getByTestId('occurrence-evidence-agreement-save-oc-1'));

    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        '/orgs/org-1/deliverables/occurrences/oc-1/evidence',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ kind: 'contract_document', contractDocumentId: 'cd-1' }) }),
      ),
    );
    expect((await screen.findByTestId('evidence-chip-ev-7')).textContent).toContain('Signed agreement');
    expect(screen.getByTestId('occurrence-status-oc-1').textContent).toBe('Delivered');
    expect(screen.queryByTestId('occurrence-evidence-agreement-panel-oc-1')).toBeNull();
  });

  it('shows an alert with Retry when the agreements fail to load, and recovers on retry', async () => {
    let calls = 0;
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && path === AGREEMENTS_PATH) {
        calls += 1;
        return calls === 1 ? jsonResp(500, { error: 'boom' }) : jsonResp(200, { data: agreements });
      }
      return jsonResp(200, { data: [occurrence] });
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('occurrence-evidence-link-agreement-oc-1'));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load signed agreements.');
    fireEvent.click(screen.getByTestId('occurrence-evidence-agreement-retry-oc-1'));
    expect(await screen.findByRole('option', { name: /Master services agreement/ })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    errSpy.mockRestore();
  });

  it('shows the empty hint when the org has no signed agreements', async () => {
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && path === AGREEMENTS_PATH) return jsonResp(200, { data: [] });
      return jsonResp(200, { data: [occurrence] });
    });
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('occurrence-evidence-link-agreement-oc-1'));
    expect(await screen.findByText(/No signed agreements for this organization/)).toBeTruthy();
  });

  it('opening the agreement picker closes the document picker (one picker at a time)', async () => {
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && (path === AGREEMENTS_PATH || path.startsWith('/orgs/org-1/documents'))) {
        return jsonResp(200, { data: [] });
      }
      return jsonResp(200, { data: [occurrence] });
    });
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('occurrence-evidence-link-oc-1'));
    expect(await screen.findByTestId('occurrence-evidence-link-panel-oc-1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('occurrence-evidence-link-agreement-oc-1'));
    expect(await screen.findByTestId('occurrence-evidence-agreement-panel-oc-1')).toBeTruthy();
    expect(screen.queryByTestId('occurrence-evidence-link-panel-oc-1')).toBeNull();
  });
});

describe('OccurrenceDrawer link existing document + badges (#9311)', () => {
  const docs = [
    { id: 'doc-1', title: 'Q3 findings', originalFilename: 'q3.pdf', category: 'report' },
    { id: 'doc-2', title: 'Pen test', originalFilename: 'pt.pdf', category: 'evidence' },
  ];

  it('links a library document as evidence and moves awaiting_evidence to delivered', async () => {
    const awaiting = { ...occurrence, status: 'awaiting_evidence' as const, evidence: [] };
    const linked = {
      ...awaiting,
      status: 'delivered' as const,
      evidence: [{ id: 'ev-9', kind: 'document' as const, documentId: 'doc-2', reportId: null, reportRunId: null, contractDocumentId: null, createdAt: '2026-09-02T00:00:00Z' }],
    };
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && path.startsWith('/orgs/org-1/documents')) return jsonResp(200, { data: docs });
      if (method === 'GET') return jsonResp(200, { data: [awaiting] });
      if (path.endsWith('/evidence')) return jsonResp(200, { data: linked });
      throw new Error(`unexpected ${method} ${path}`);
    });
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('occurrence-evidence-link-oc-1'));
    const select = await screen.findByTestId('occurrence-evidence-doc-select-oc-1');
    await waitFor(() => expect(screen.getByRole('option', { name: /Pen test/ })).toBeTruthy());
    fireEvent.change(select, { target: { value: 'doc-2' } });
    fireEvent.click(screen.getByTestId('occurrence-evidence-link-save-oc-1'));

    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        '/orgs/org-1/deliverables/occurrences/oc-1/evidence',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ kind: 'document', documentId: 'doc-2' }) }),
      ),
    );
    expect(await screen.findByTestId('evidence-chip-ev-9')).toBeTruthy();
    expect(screen.getByTestId('occurrence-status-oc-1').textContent).toBe('Delivered');
  });

  it('keeps Link disabled until a document is chosen', async () => {
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && path.startsWith('/orgs/org-1/documents')) return jsonResp(200, { data: docs });
      return jsonResp(200, { data: [occurrence] });
    });
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('occurrence-evidence-link-oc-1'));
    await screen.findByTestId('occurrence-evidence-doc-select-oc-1');
    expect((screen.getByTestId('occurrence-evidence-link-save-oc-1') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows an alert with Retry when the library fails to load, and recovers on retry', async () => {
    let docCalls = 0;
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && path.startsWith('/orgs/org-1/documents')) {
        docCalls += 1;
        return docCalls === 1 ? jsonResp(500, { error: 'boom' }) : jsonResp(200, { data: docs });
      }
      return jsonResp(200, { data: [occurrence] });
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('occurrence-evidence-link-oc-1'));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load the document library.');
    expect((screen.getByTestId('occurrence-evidence-link-save-oc-1') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('occurrence-evidence-library-retry-oc-1'));
    expect(await screen.findByRole('option', { name: /Pen test/ })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    errSpy.mockRestore();
  });

  it('shows the empty-library hint and refetches each time the picker opens', async () => {
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && path.startsWith('/orgs/org-1/documents')) return jsonResp(200, { data: [] });
      return jsonResp(200, { data: [occurrence] });
    });
    const docGets = () => fetcher.mock.calls.filter(([p]) => String(p).startsWith('/orgs/org-1/documents')).length;
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    const toggle = await screen.findByTestId('occurrence-evidence-link-oc-1');
    expect(docGets()).toBe(0);
    fireEvent.click(toggle);
    expect(await screen.findByText(/No documents in this organization/)).toBeTruthy();
    expect((screen.getByTestId('occurrence-evidence-link-save-oc-1') as HTMLButtonElement).disabled).toBe(true);
    expect(docGets()).toBe(1);
    fireEvent.click(toggle); // close
    fireEvent.click(toggle); // reopen
    await waitFor(() => expect(docGets()).toBe(2));
  });

  it('keeps the picker and selection open when linking fails', async () => {
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && path.startsWith('/orgs/org-1/documents')) return jsonResp(200, { data: docs });
      if (method === 'GET') return jsonResp(200, { data: [occurrence] });
      return jsonResp(500, { error: 'boom' });
    });
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('occurrence-evidence-link-oc-1'));
    const select = (await screen.findByTestId('occurrence-evidence-doc-select-oc-1')) as HTMLSelectElement;
    await screen.findByRole('option', { name: /Pen test/ });
    fireEvent.change(select, { target: { value: 'doc-2' } });
    const save = screen.getByTestId('occurrence-evidence-link-save-oc-1') as HTMLButtonElement;
    fireEvent.click(save);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    await waitFor(() => expect(save.disabled).toBe(false));
    expect(select.value).toBe('doc-2');
    expect(screen.queryByTestId('evidence-chip-ev-9')).toBeNull();
  });

  it('shows no Late pill on a missed row; the status badge says Missed', async () => {
    const fetcher = vi.fn(async () => jsonResp(200, { data: [{ ...occurrence, status: 'missed', late: true }] }));
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    await screen.findByTestId('occurrence-status-oc-1');
    expect(screen.queryByText('Late')).toBeNull();
    expect(screen.getByTestId('occurrence-status-oc-1').textContent).toBe('Missed');
  });

  it('still shows Late on an open past-due row', async () => {
    const fetcher = vi.fn(async () => jsonResp(200, { data: [{ ...occurrence, status: 'open', late: true }] }));
    render(<OccurrenceDrawer fetcher={fetcher} orgId="org-1" deliverable={deliverable} onClose={vi.fn()} />);
    await screen.findByTestId('occurrence-status-oc-1');
    expect(screen.getByText('Late')).toBeTruthy();
  });
});
