import { describe, it, expect, vi } from 'vitest';

const { resolveSpy } = vi.hoisted(() => ({
  resolveSpy: vi.fn(async () => 'should-not-be-called')
}));

vi.mock('./resolvePartner', () => ({ resolvePartnerByRecipient: resolveSpy }));

// Make the partner look active so processing proceeds past the status gate,
// then stop at the first unmocked dependency -- we only assert resolve is skipped.
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ status: 'active' }] }) }) }) },
  runOutsideDbContext: (fn: any) => fn(),
  withSystemDbAccessContext: (fn: any) => fn(),
}));

import { processInboundEmail } from './inboundEmailService';
import type { NormalizedInboundEmail } from './types';

const base: NormalizedInboundEmail = {
  provider: 'm365', providerMessageId: 'g1', to: 'support@a.com', from: 'cust@x.com',
  subject: 'hi', text: 'body', attachments: [], raw: {}, resolvedPartnerId: 'partner-123',
};

describe('processInboundEmail resolvedPartnerId seam', () => {
  it('does not call resolvePartnerByRecipient when resolvedPartnerId is present', async () => {
    try { await processInboundEmail(base); } catch { /* later deps unmocked -- fine */ }
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});
