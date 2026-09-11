import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OccurrenceDrawer from './OccurrenceDrawer';
import type { Deliverable, Occurrence } from '../../lib/api/serviceDeliverables';
import { showToast } from '../shared/Toast';

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

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
