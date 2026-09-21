import { describe, it, expect } from 'vitest';
import { acceptedOnBehalfAuditEvent } from './quoteAcceptOnBehalfAudit';

describe('acceptedOnBehalfAuditEvent', () => {
  const args = {
    quoteId: 'q1', orgId: 'org1',
    method: 'purchase_order', reference: 'PO 4471',
    signerName: 'Dana Buyer', signerEmail: 'dana@customer.example',
    invoiceId: 'inv1', invoiceNumber: 'INV-2026-0042',
    contractIds: ['c1', 'c2'], wasDraft: true,
  };

  it('records the act against the quote whose status changed', () => {
    expect(acceptedOnBehalfAuditEvent(args)).toEqual({
      orgId: 'org1',
      action: 'quote.accepted_on_behalf',
      resourceType: 'quote',
      resourceId: 'q1',
      result: 'success',
      details: {
        method: 'purchase_order', reference: 'PO 4471',
        signerName: 'Dana Buyer', signerEmail: 'dana@customer.example',
        invoiceId: 'inv1', invoiceNumber: 'INV-2026-0042',
        contractIds: ['c1', 'c2'], wasDraft: true,
      },
    });
  });

  // wasDraft is the reviewer's flag for "the customer never saw this document
  // before the invoice" — it must be present even when false, not omitted.
  it('keeps wasDraft: false rather than dropping it', () => {
    expect(acceptedOnBehalfAuditEvent({ ...args, wasDraft: false }).details).toMatchObject({ wasDraft: false });
  });

  it('normalises an absent signer email and invoice number to null', () => {
    const e = acceptedOnBehalfAuditEvent({ ...args, signerEmail: undefined, invoiceNumber: null });
    expect(e.details).toMatchObject({ signerEmail: null, invoiceNumber: null });
  });
});
