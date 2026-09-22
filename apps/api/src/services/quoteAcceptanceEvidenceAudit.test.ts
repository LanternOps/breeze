import { describe, it, expect } from 'vitest';
import { acceptanceEvidenceAttachedAuditEvent } from './quoteAcceptanceEvidenceAudit';

describe('acceptanceEvidenceAttachedAuditEvent (#6633)', () => {
  const args = {
    quoteId: 'q1', orgId: 'org1', acceptanceId: 'a1',
    filename: 'PO-4471.pdf', contentType: 'application/pdf', sizeBytes: 2048,
    sha256: 'ab'.repeat(32), replaced: false,
  };

  it('records the attachment against the quote, naming the acceptance and the file', () => {
    expect(acceptanceEvidenceAttachedAuditEvent(args)).toEqual({
      orgId: 'org1',
      action: 'quote.acceptance_evidence_attached',
      resourceType: 'quote',
      resourceId: 'q1',
      result: 'success',
      details: {
        acceptanceId: 'a1',
        filename: 'PO-4471.pdf', contentType: 'application/pdf', sizeBytes: 2048,
        sha256: 'ab'.repeat(32), replaced: false,
      },
    });
  });

  // A replacement destroys the previous file; the audit row is the only trace
  // that one existed, so `replaced` must be explicit either way.
  it('keeps replaced: true on a replacement', () => {
    expect(acceptanceEvidenceAttachedAuditEvent({ ...args, replaced: true }).details).toMatchObject({ replaced: true });
  });
});
