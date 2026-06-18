import { describe, it, expect } from 'vitest';
import { canWriteTemplate } from './templates';

// #1425: partner-wide alert templates. canWriteTemplate is the write boundary
// for PATCH/DELETE — the DB's dual-axis RLS is the real enforcement, but this
// returns the correct 403/404 UX and stops org-scope users editing shared rows.

type Row = { orgId: string | null; partnerId: string | null; isBuiltIn: boolean };
const orgRow: Row = { orgId: 'org-1', partnerId: 'p-1', isBuiltIn: false };
const partnerWide: Row = { orgId: null, partnerId: 'p-1', isBuiltIn: false };
const builtIn: Row = { orgId: null, partnerId: null, isBuiltIn: true };

const orgUser = { scope: 'organization' as const, partnerId: 'p-1', canAccessOrg: (id: string) => id === 'org-1' };
const partnerUser = { scope: 'partner' as const, partnerId: 'p-1', canAccessOrg: (id: string) => id === 'org-1' };
const otherPartnerUser = { scope: 'partner' as const, partnerId: 'p-2', canAccessOrg: () => false };
const systemUser = { scope: 'system' as const, partnerId: null, canAccessOrg: () => true };

describe('canWriteTemplate', () => {
  it('blocks editing built-in templates for every scope', () => {
    for (const u of [orgUser, partnerUser, systemUser]) {
      const r = canWriteTemplate(u, builtIn);
      expect(r).toMatchObject({ ok: false, status: 403 });
    }
  });

  it('lets an org user edit their own org template', () => {
    expect(canWriteTemplate(orgUser, orgRow)).toEqual({ ok: true });
  });

  it('makes partner-wide templates read-only (403) for org-scope users', () => {
    const r = canWriteTemplate(orgUser, partnerWide);
    expect(r).toMatchObject({ ok: false, status: 403 });
    if (!r.ok) expect(r.error).toMatch(/read-only/i);
  });

  it('lets the owning partner edit a partner-wide template', () => {
    expect(canWriteTemplate(partnerUser, partnerWide)).toEqual({ ok: true });
  });

  it('hides another partner’s partner-wide template (404)', () => {
    expect(canWriteTemplate(otherPartnerUser, partnerWide)).toMatchObject({ ok: false, status: 404 });
  });

  it('404s an org-specific template the caller cannot access', () => {
    const r = canWriteTemplate(partnerUser, { orgId: 'org-99', partnerId: 'p-1', isBuiltIn: false });
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it('lets system scope edit any non-built-in template', () => {
    expect(canWriteTemplate(systemUser, partnerWide)).toEqual({ ok: true });
    expect(canWriteTemplate(systemUser, orgRow)).toEqual({ ok: true });
  });
});
