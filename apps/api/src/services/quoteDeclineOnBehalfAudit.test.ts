import { describe, it, expect } from 'vitest';
import { declinedOnBehalfAuditEvent } from './quoteDeclineOnBehalfAudit';

describe('declinedOnBehalfAuditEvent', () => {
  const args = {
    quoteId: 'q1', orgId: 'org1',
    method: 'email', reference: 'Email from J. Doe 2026-09-20',
    reason: 'Went with another vendor',
  };

  it('records the act against the declined quote, with the evidence', () => {
    expect(declinedOnBehalfAuditEvent(args)).toEqual({
      orgId: 'org1',
      action: 'quote.declined_on_behalf',
      resourceType: 'quote',
      resourceId: 'q1',
      result: 'success',
      details: {
        method: 'email', reference: 'Email from J. Doe 2026-09-20',
        reason: 'Went with another vendor',
      },
    });
  });

  it('normalises an absent reason to null rather than dropping the key', () => {
    expect(declinedOnBehalfAuditEvent({ ...args, reason: undefined }).details).toEqual({
      method: 'email', reference: 'Email from J. Doe 2026-09-20', reason: null,
    });
  });
});
