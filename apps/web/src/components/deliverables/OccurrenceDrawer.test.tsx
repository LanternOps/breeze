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
    { id: 'ev-1', kind: 'report_run', documentId: null, reportId: 'r-1', reportRunId: 'run-1', createdAt: '2026-09-02T00:00:00Z' },
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
              { id: 'ev-2', kind: 'document', documentId: 'doc-1', reportId: null, reportRunId: null, createdAt: '2026-09-03T00:00:00Z' },
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
    expect(screen.queryByTestId('occurrence-list')).toBeNull();
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
});
