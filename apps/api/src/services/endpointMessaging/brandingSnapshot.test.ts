import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableRows } from '../../__tests__/helpers/tableKeyedDb';

// Table-keyed DB (real schema) so the pins below survive the resolver refactor
// (#10190 OD-2 (a)): the snapshot now comes from resolvePromptIdentity.
const h = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  partnerAxisRead: vi.fn(),
  resolverCalls: [] as string[],
}));

vi.mock('../../db', async () => {
  const { createTableKeyedDb } = await import('../../__tests__/helpers/tableKeyedDb');
  return { db: createTableKeyedDb(() => h.rows as Record<string, TableRows>).db };
});
vi.mock('../../db/partnerAxisRead', () => ({
  readWithPartnerAxisVisibility: async (fn: () => Promise<unknown>) => {
    h.partnerAxisRead();
    return fn();
  },
}));
vi.mock('../promptIdentity', async (importOriginal) => {
  const real = await importOriginal<typeof import('../promptIdentity')>();
  return {
    ...real,
    resolvePromptIdentity: async (orgId: string) => {
      h.resolverCalls.push(orgId);
      return real.resolvePromptIdentity(orgId);
    },
  };
});

import { resolveMessageBranding } from './brandingSnapshot';

function setRows(over: { org?: unknown[]; partner?: unknown[]; portal?: unknown[] } = {}) {
  h.rows = {
    organizations: over.org ?? [{ partnerId: 'partner-1' }],
    partners: over.partner ?? [{ name: '  Acme IT  ', settings: { branding: { primaryColor: '#12ab34' } } }],
    portal_branding: over.portal ?? [],
  };
}

describe('resolveMessageBranding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.resolverCalls = [];
    setRows();
  });

  it('uses the partner name as company and display name and the partner primary colour as accent', async () => {
    await expect(resolveMessageBranding('org-1')).resolves.toEqual({
      partnerId: 'partner-1',
      branding: { companyName: 'Acme IT', displayName: 'Acme IT', accent: '#12ab34' },
    });
  });

  it('comes from the shared prompt identity resolver', async () => {
    await resolveMessageBranding('org-1');
    expect(h.resolverCalls).toEqual(['org-1']);
  });

  it('snapshot unchanged for a partner with no portal override (the pre-#10190 shape, byte for byte)', async () => {
    setRows({ partner: [{ name: 'Example IT Services', settings: { branding: { primaryColor: '#1F5FAD', logoUrl: 'https://logos.example.com/p.png' } } }] });
    const snapshot = await resolveMessageBranding('org-1');
    expect(JSON.stringify(snapshot)).toBe(JSON.stringify({
      partnerId: 'partner-1',
      branding: { companyName: 'Example IT Services', displayName: 'Example IT Services', accent: '#1F5FAD' },
    }));
  });

  it('reads the partner under partner-axis visibility, with only the partner id the org resolved to', async () => {
    await resolveMessageBranding('org-1');
    expect(h.partnerAxisRead).toHaveBeenCalledTimes(1);
  });

  it('accent is null when the partner has no valid primary colour', async () => {
    setRows({ partner: [{ name: 'Acme IT', settings: { branding: { primaryColor: 'url(javascript:1)' } } }] });
    const r = await resolveMessageBranding('org-1');
    expect(r?.branding.accent).toBeNull();
  });

  it("an org portal colour override now sets the accent; the name stays the partner's", async () => {
    setRows({ portal: [{ logoUrl: null, primaryColor: '#aa0000', companyName: 'Spoofed Corp' }] });
    const r = await resolveMessageBranding('org-1');
    expect(r?.branding).toEqual({ companyName: 'Acme IT', displayName: 'Acme IT', accent: '#aa0000' });
  });

  it('caps the name at 120 characters', async () => {
    setRows({ partner: [{ name: 'x'.repeat(300), settings: {} }] });
    const r = await resolveMessageBranding('org-1');
    expect(r?.branding.companyName).toHaveLength(120);
  });

  it('returns null (fail closed) when the org has no partner or the partner has no name', async () => {
    setRows({ org: [{ partnerId: null }] });
    await expect(resolveMessageBranding('org-1')).resolves.toBeNull();
    setRows({ partner: [{ name: '   ', settings: {} }] });
    await expect(resolveMessageBranding('org-1')).resolves.toBeNull();
  });
});
