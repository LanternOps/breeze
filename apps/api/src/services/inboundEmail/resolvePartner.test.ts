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
  partners: { __t: 'partners', slug: 'slug', inboundLocalPart: 'inboundLocalPart', id: 'id' }
}));

import { resolvePartnerByRecipient } from './resolvePartner';

beforeEach(() => { dbMocks.domainRows = []; dbMocks.partnerRows = []; });

describe('resolvePartnerByRecipient', () => {
  it('resolves via the platform slug address', async () => {
    dbMocks.partnerRows = [{ id: 'p-1' }];
    expect(await resolvePartnerByRecipient('acme@tickets.example.com')).toBe('p-1');
  });
  it('resolves the partner for an alias address on the platform domain', async () => {
    dbMocks.partnerRows = [{ id: 'p-2' }];
    expect(await resolvePartnerByRecipient('support@tickets.example.com')).toBe('p-2');
  });

  it('returns null when no partner matches the local-part', async () => {
    dbMocks.partnerRows = [];
    expect(await resolvePartnerByRecipient('nobody@tickets.example.com')).toBeNull();
  });
  it('returns null for an unknown recipient domain', async () => {
    expect(await resolvePartnerByRecipient('x@notours.com')).toBeNull();
  });
  it('prefers a custom domain match (Model-B seam)', async () => {
    dbMocks.domainRows = [{ partnerId: 'p-9' }];
    expect(await resolvePartnerByRecipient('support@tickets.theirmsp.com')).toBe('p-9');
  });
});
