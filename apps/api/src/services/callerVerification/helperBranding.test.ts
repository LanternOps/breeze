import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableRows } from '../../__tests__/helpers/tableKeyedDb';

const m = vi.hoisted(() => ({ rows: {} as Record<string, unknown>, partnerAxis: vi.fn(), resolverCalls: [] as string[] }));
vi.mock('../../db', async () => {
  const { createTableKeyedDb } = await import('../../__tests__/helpers/tableKeyedDb');
  return { db: createTableKeyedDb(() => m.rows as Record<string, TableRows>).db };
});
vi.mock('../../db/partnerAxisRead', () => ({ readWithPartnerAxisVisibility: (fn: () => unknown) => { m.partnerAxis(); return fn(); } }));
vi.mock('../promptIdentity', async (importOriginal) => {
  const real = await importOriginal<typeof import('../promptIdentity')>();
  return {
    ...real,
    resolvePromptIdentity: async (orgId: string) => {
      m.resolverCalls.push(orgId);
      return real.resolvePromptIdentity(orgId);
    },
  };
});

import { callerHelperBranding, safeLogo } from './helperBranding';

describe('safeLogo', () => {
  it.each(['javascript:alert(1)', 'http://example.com/logo.png', 'data:image/svg+xml,x', '', null, 'https://user:pw@example.com/x.png', 'not a url'])(
    'rejects %s', (value) => expect(safeLogo(value)).toBeNull(),
  );
  it('permits an HTTPS logo', () => expect(safeLogo('https://example.com/logo.png')).toBe('https://example.com/logo.png'));
});

describe('callerHelperBranding', () => {
  function setRows(over: { org?: unknown[]; partner?: unknown[]; portal?: unknown[] } = {}) {
    m.rows = {
      organizations: over.org ?? [{ partnerId: 'p1' }],
      partners: over.partner ?? [{ name: '  Northwind IT  ', settings: { branding: { logoUrl: 'https://cdn.example.com/brand.png' } } }],
      portal_branding: over.portal ?? [],
      // The pre-#10190 source. Present on purpose: it must no longer be used.
      partner_login_branding: [{ logoUrl: 'https://cdn.example.com/login-page.png' }],
    };
  }
  beforeEach(() => {
    vi.clearAllMocks();
    m.resolverCalls = [];
    setRows();
  });

  it('comes from the prompt identity resolver for the authenticated device org (OD-2 (a))', async () => {
    expect(await callerHelperBranding('org-1')).toEqual({ partnerName: 'Northwind IT', logoUrl: 'https://cdn.example.com/brand.png' });
    expect(m.resolverCalls).toEqual(['org-1']);
    expect(m.partnerAxis).toHaveBeenCalledTimes(1);
  });

  it('the logo is Partner → Branding, never the partner login-page logo', async () => {
    setRows({ partner: [{ name: 'Northwind IT', settings: {} }] });
    expect(await callerHelperBranding('org-1')).toEqual({ partnerName: 'Northwind IT', logoUrl: null });
  });

  it("the org portal override wins for the logo; the name stays the partner's", async () => {
    setRows({ portal: [{ logoUrl: 'https://cdn.example.com/org.png', primaryColor: null, companyName: 'Spoofed' }] });
    expect(await callerHelperBranding('org-1')).toEqual({ partnerName: 'Northwind IT', logoUrl: 'https://cdn.example.com/org.png' });
  });

  it('passes only an https logo (a data: upload is not sent to the card)', async () => {
    setRows({ partner: [{ name: 'Northwind', settings: { branding: { logoUrl: 'data:image/png;base64,AAAA' } } }] });
    expect(await callerHelperBranding('org-1')).toEqual({ partnerName: 'Northwind', logoUrl: null });
  });

  it('returns null without an org/partner or a usable name', async () => {
    setRows({ org: [] });
    expect(await callerHelperBranding('org-1')).toBeNull();
    setRows({ org: [{ partnerId: null }] });
    expect(await callerHelperBranding('org-1')).toBeNull();
    setRows({ partner: [{ name: '   ', settings: {} }] });
    expect(await callerHelperBranding('org-1')).toBeNull();
  });
});
