import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetDesignReportSummary } from '@breeze/shared';

const loadFleetDesignReportMock = vi.fn();
const uploadDocumentMock = vi.fn();
const addEvidenceMock = vi.fn();
const buildReportPdfMock = vi.fn();
const selectQueue: Array<Array<Record<string, unknown>>> = [];

vi.mock('../aiAgents/fleetDesignReport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../aiAgents/fleetDesignReport')>();
  return { ...actual, loadFleetDesignReport: (...args: unknown[]) => loadFleetDesignReportMock(...args) };
});
vi.mock('../orgDocumentService', () => ({ uploadDocument: (...args: unknown[]) => uploadDocumentMock(...args) }));
vi.mock('../serviceDeliverableService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../serviceDeliverableService')>();
  return { DeliverableServiceError: actual.DeliverableServiceError, addEvidence: (...args: unknown[]) => addEvidenceMock(...args) };
});
vi.mock('@breeze/shared/reportPdf', () => ({ buildReportPdf: (...args: unknown[]) => buildReportPdfMock(...args) }));
vi.mock('../../db', () => {
  function thenable(rows: Array<Record<string, unknown>>) {
    const p = Promise.resolve(rows) as Promise<Array<Record<string, unknown>>> & Record<string, unknown>;
    p.limit = () => thenable(rows);
    p.orderBy = () => thenable(rows);
    return p;
  }
  const chain = () => ({
    from: () => {
      const rows = selectQueue.shift() ?? [];
      const c = { where: () => thenable(rows), innerJoin: () => c };
      return c;
    },
  });
  return {
    db: { select: chain },
    getCurrentDbAccessContext: () => ({ scope: 'system' }),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import { fileFleetDesignDocument, fleetDesignDocumentFilename, fleetDesignDocumentTitle } from './documents';

const ORG = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const REPORT = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const DELIVERABLE = '55555555-5555-4555-8555-555555555555';
const OCCURRENCE = '66666666-6666-4666-8666-666666666666';
const actor = { userId: USER, partnerId: null, accessibleOrgIds: [ORG] };

const summary: FleetDesignReportSummary = {
  fleetDesign: { orgName: 'Acme Dental', generatedAt: '2026-09-12T09:00:00.000Z', outcome: undefined },
};

describe('fileFleetDesignDocument', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
    loadFleetDesignReportMock.mockResolvedValue({ reportRunId: RUN, reportId: REPORT, orgId: ORG, summary, generatedAt: '2026-09-12T09:00:00.000Z' });
    buildReportPdfMock.mockReturnValue({ output: () => new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer });
    uploadDocumentMock.mockResolvedValue({ id: 'doc-1', title: 'x' });
    addEvidenceMock.mockResolvedValue({ id: OCCURRENCE });
  });

  it('renders the PDF server-side and files it under category baseline with a stable filename', async () => {
    selectQueue.push([]); // no existing filed document
    selectQueue.push([]); // no deliverable
    const result = await fileFleetDesignDocument({ orgId: ORG, reportRunId: RUN, actor });

    expect(buildReportPdfMock).toHaveBeenCalledWith([], expect.objectContaining({ reportType: 'ai_fleet_design', summary }));
    expect(uploadDocumentMock).toHaveBeenCalledTimes(1);
    const [orgArg, input, actorArg] = uploadDocumentMock.mock.calls[0]!;
    expect(orgArg).toBe(ORG);
    expect(actorArg).toBe(actor);
    expect(input.category).toBe('baseline');
    expect(input.title).toBe(fleetDesignDocumentTitle('Acme Dental', '2026-09-12T09:00:00.000Z'));
    expect(input.title).toBe('Fleet Design — Acme Dental — 2026-09-12');
    expect(input.file.filename).toBe(fleetDesignDocumentFilename(RUN));
    expect(input.file.contentType).toBe('application/pdf');
    expect(Buffer.isBuffer(input.file.buffer)).toBe(true);
    expect(result).toEqual({ documentId: 'doc-1', alreadyFiled: false, evidence: null });
    expect(addEvidenceMock).not.toHaveBeenCalled();
  });

  it('is idempotent per report run: a second call returns the existing document and uploads nothing', async () => {
    selectQueue.push([{ id: 'doc-existing' }]); // already filed
    selectQueue.push([]); // no deliverable
    const result = await fileFleetDesignDocument({ orgId: ORG, reportRunId: RUN, actor });
    expect(uploadDocumentMock).not.toHaveBeenCalled();
    expect(result).toEqual({ documentId: 'doc-existing', alreadyFiled: true, evidence: null });
  });

  it('re-attempts the evidence link when the document exists but was never linked (a failure between the two writes)', async () => {
    selectQueue.push([{ id: 'doc-existing' }]); // already filed
    selectQueue.push([{ id: DELIVERABLE, autoEvidenceReportId: REPORT, name: 'Quarterly configuration audit' }]);
    selectQueue.push([{ id: OCCURRENCE }]); // open occurrence
    selectQueue.push([]); // no evidence row yet
    const result = await fileFleetDesignDocument({ orgId: ORG, reportRunId: RUN, actor });
    expect(uploadDocumentMock).not.toHaveBeenCalled();
    expect(addEvidenceMock).toHaveBeenCalledWith(ORG, OCCURRENCE, { kind: 'document', documentId: 'doc-existing' }, actor);
    expect(result).toEqual({ documentId: 'doc-existing', alreadyFiled: true, evidence: { deliverableId: DELIVERABLE, occurrenceId: OCCURRENCE } });
  });

  it('never attaches a twin when the document is already evidence on that occurrence', async () => {
    selectQueue.push([{ id: 'doc-existing' }]);
    selectQueue.push([{ id: DELIVERABLE, autoEvidenceReportId: REPORT, name: 'Quarterly configuration audit' }]);
    selectQueue.push([{ id: OCCURRENCE }]);
    selectQueue.push([{ id: 'evidence-1' }]); // already linked
    const result = await fileFleetDesignDocument({ orgId: ORG, reportRunId: RUN, actor });
    expect(addEvidenceMock).not.toHaveBeenCalled();
    expect(result.evidence).toEqual({ deliverableId: DELIVERABLE, occurrenceId: OCCURRENCE });
  });

  it('skips the deliverable linkage entirely when the caller lacks contracts:write', async () => {
    selectQueue.push([]); // not filed yet
    const result = await fileFleetDesignDocument({ orgId: ORG, reportRunId: RUN, actor, linkDeliverableEvidence: false });
    expect(uploadDocumentMock).toHaveBeenCalledTimes(1);
    expect(addEvidenceMock).not.toHaveBeenCalled();
    expect(result).toEqual({ documentId: 'doc-1', alreadyFiled: false, evidence: null });
  });

  it('prefers the explicitly linked deliverable over a name-matched one that sorts first', async () => {
    selectQueue.push([]); // not filed yet
    selectQueue.push([
      { id: 'deliverable-name-match', autoEvidenceReportId: null, name: 'Annual configuration audit' },
      { id: DELIVERABLE, autoEvidenceReportId: REPORT, name: 'Quarterly review' },
    ]);
    selectQueue.push([{ id: OCCURRENCE }]);
    selectQueue.push([]); // no evidence row yet
    const result = await fileFleetDesignDocument({ orgId: ORG, reportRunId: RUN, actor });
    expect(result.evidence).toEqual({ deliverableId: DELIVERABLE, occurrenceId: OCCURRENCE });
  });

  it('attaches the document as evidence on the open occurrence of a linked deliverable', async () => {
    selectQueue.push([]); // no existing document
    selectQueue.push([{ id: DELIVERABLE, autoEvidenceReportId: REPORT, name: 'Quarterly configuration audit' }]);
    selectQueue.push([{ id: OCCURRENCE }]); // open occurrence
    selectQueue.push([]); // no evidence row yet
    const result = await fileFleetDesignDocument({ orgId: ORG, reportRunId: RUN, actor });
    expect(addEvidenceMock).toHaveBeenCalledWith(ORG, OCCURRENCE, { kind: 'document', documentId: 'doc-1' }, actor);
    expect(result.evidence).toEqual({ deliverableId: DELIVERABLE, occurrenceId: OCCURRENCE });
  });

  it('files the document even when the deliverable has no open occurrence', async () => {
    selectQueue.push([]);
    selectQueue.push([{ id: DELIVERABLE, autoEvidenceReportId: null, name: 'Quarterly Configuration Audit' }]);
    selectQueue.push([]); // no open occurrence
    const result = await fileFleetDesignDocument({ orgId: ORG, reportRunId: RUN, actor });
    expect(uploadDocumentMock).toHaveBeenCalledTimes(1);
    expect(addEvidenceMock).not.toHaveBeenCalled();
    expect(result.evidence).toBeNull();
  });

  it('throws not_found when the report run is not a Fleet Design of this org', async () => {
    loadFleetDesignReportMock.mockResolvedValue(null);
    await expect(fileFleetDesignDocument({ orgId: ORG, reportRunId: RUN, actor })).rejects.toMatchObject({ code: 'not_found' });
    expect(uploadDocumentMock).not.toHaveBeenCalled();
  });
});
