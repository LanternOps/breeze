import { describe, it, expect } from 'vitest';
import { recordedOnBehalfAuditEvent } from './agreementRecordedOnBehalfAudit';

const base = {
  requestId: 'req-1',
  orgId: 'org-1',
  signedAgreementId: 'sa-1',
  method: 'signed_document',
  reference: 'DocuSign envelope 4F2…  (wet-ink copy in client folder)',
  signerName: 'Jane Doe',
  signerEmail: 'jane@example.com',
  templateVersionId: 'ver-1',
  contractId: null,
  contentSha256: 'abc',
};

describe('recordedOnBehalfAuditEvent', () => {
  it('names the action, the request resource and the org', () => {
    const ev = recordedOnBehalfAuditEvent({ ...base, external: false });
    expect(ev).toMatchObject({
      orgId: 'org-1',
      action: 'billing.agreement.recorded_on_behalf',
      resourceType: 'agreement_request',
      resourceId: 'req-1',
      result: 'success',
    });
  });

  it('carries the reference verbatim and the evidence fields', () => {
    const ev = recordedOnBehalfAuditEvent({ ...base, external: false });
    expect(ev.details).toEqual({
      signedAgreementId: 'sa-1',
      method: 'signed_document',
      reference: 'DocuSign envelope 4F2…  (wet-ink copy in client folder)',
      signerName: 'Jane Doe',
      signerEmail: 'jane@example.com',
      templateVersionId: 'ver-1',
      contractId: null,
      contentSha256: 'abc',
      external: false,
    });
  });

  it('flags an externally signed copy and nulls an absent email', () => {
    const ev = recordedOnBehalfAuditEvent({ ...base, signerEmail: undefined, external: true });
    expect(ev.details).toMatchObject({ external: true, signerEmail: null });
  });
});
