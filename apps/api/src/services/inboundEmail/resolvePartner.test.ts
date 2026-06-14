import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMocks } = vi.hoisted(() => ({ dbMocks: { domainRows: [] as unknown[], partnerRows: [] as unknown[] } }));
vi.mock('../../config/validate', () => ({ getConfig: () => ({ TICKETS_INBOUND_DOMAIN: 'tickets.example.com' }) }));
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((tbl: { _name?: string }) => ({
        where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve(
          // first call = domains, second = partners; switch on a marker set in the schema mock
          (tbl as any).__t === 'domains' ? dbMocks.domainRows : dbMocks.partnerRows
        )) }))
      }))
    }))
  }
}));
vi.mock('../../db/schema', () => ({
  partnerInboundDomains: { __t: 'domains', domain: 'domain', partnerId: 'partnerId' },
  partners: { __t: 'partners', slug: 'slug', id: 'id' }
}));

import { resolvePartnerByRecipient } from './resolvePartner';

beforeEach(() => { dbMocks.domainRows = []; dbMocks.partnerRows = []; });

describe('resolvePartnerByRecipient', () => {
  it('resolves via the platform slug address', async () => {
    dbMocks.partnerRows = [{ id: 'p-1' }];
    expect(await resolvePartnerByRecipient('acme@tickets.example.com')).toBe('p-1');
  });
  it('returns null for an unknown recipient domain', async () => {
    expect(await resolvePartnerByRecipient('x@notours.com')).toBeNull();
  });
  it('prefers a custom domain match (Model-B seam)', async () => {
    dbMocks.domainRows = [{ partnerId: 'p-9' }];
    expect(await resolvePartnerByRecipient('support@tickets.theirmsp.com')).toBe('p-9');
  });
});
