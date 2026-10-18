import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  orgRows: [] as Array<{ partnerId: string | null }>,
  partnerRows: [] as Array<{ name: string | null; settings: unknown }>,
  partnerAxisRead: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const node: Record<string, unknown> = {};
      for (const m of ['from', 'where']) node[m] = vi.fn(() => node);
      // First select = organizations lookup, second = partners lookup.
      node.limit = vi.fn(async () => (h.partnerAxisRead.mock.calls.length === 0 ? h.orgRows : h.partnerRows));
      return node;
    }),
  },
}));
vi.mock('../../db/partnerAxisRead', () => ({
  readWithPartnerAxisVisibility: async (fn: () => Promise<unknown>) => {
    h.partnerAxisRead();
    return fn();
  },
}));
vi.mock('../../db/schema', () => ({
  organizations: { id: 'o.id', partnerId: 'o.partnerId' },
  partners: { id: 'p.id', name: 'p.name', settings: 'p.settings' },
}));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => ({})) }));

import { resolveMessageBranding } from './brandingSnapshot';

describe('resolveMessageBranding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.orgRows = [{ partnerId: 'partner-1' }];
    h.partnerRows = [{ name: '  Acme IT  ', settings: { branding: { primaryColor: '#12ab34' } } }];
  });

  it('uses the partner name as company and display name and the partner primary colour as accent', async () => {
    await expect(resolveMessageBranding('org-1')).resolves.toEqual({
      partnerId: 'partner-1',
      branding: { companyName: 'Acme IT', displayName: 'Acme IT', accent: '#12ab34' },
    });
  });

  it('reads the partner under partner-axis visibility, with only the partner id the org resolved to', async () => {
    await resolveMessageBranding('org-1');
    expect(h.partnerAxisRead).toHaveBeenCalledTimes(1);
  });

  it('accent is null when the partner has no valid primary colour', async () => {
    h.partnerRows = [{ name: 'Acme IT', settings: { branding: { primaryColor: 'url(javascript:1)' } } }];
    const r = await resolveMessageBranding('org-1');
    expect(r?.branding.accent).toBeNull();
  });

  it('caps the name at 120 characters', async () => {
    h.partnerRows = [{ name: 'x'.repeat(300), settings: {} }];
    const r = await resolveMessageBranding('org-1');
    expect(r?.branding.companyName).toHaveLength(120);
  });

  it('returns null (fail closed) when the org has no partner or the partner has no name', async () => {
    h.orgRows = [{ partnerId: null }];
    await expect(resolveMessageBranding('org-1')).resolves.toBeNull();
    h.orgRows = [{ partnerId: 'partner-1' }];
    h.partnerRows = [{ name: '   ', settings: {} }];
    h.partnerAxisRead.mockClear();
    await expect(resolveMessageBranding('org-1')).resolves.toBeNull();
  });
});
