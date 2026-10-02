import { describe, it, expect, vi, beforeEach } from 'vitest';

const { ambientContext } = vi.hoisted(() => ({ ambientContext: vi.fn() }));
vi.mock('../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  getCurrentDbAccessContext: ambientContext,
}));
import { inArray, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { auditLogReadCondition, auditPartnerScopeId, type AuditReadAuth } from './auditReadScope';
import { derivePartnerAttribution, type RequestLike } from './auditEvents';

const dialect = new PgDialect();
const PARTNER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';

function auth(scope: AuditReadAuth['scope'], partnerId: string | null, orgIds: string[] | null): AuditReadAuth {
  return {
    scope,
    partnerId,
    orgCondition: (col: PgColumn) => (orgIds === null ? undefined : orgIds.length === 0 ? sql`false` : inArray(col, orgIds)),
  };
}

function render(cond: SQL | undefined) {
  return cond ? dialect.sqlToQuery(cond) : undefined;
}

describe('auditLogReadCondition (#7696)', () => {
  it('partner scope: accessible orgs OR the caller partner-scoped rows', () => {
    const q = render(auditLogReadCondition(auth('partner', PARTNER, [ORG])))!;
    expect(q.sql).toContain('"audit_logs"."org_id" is null');
    expect(q.sql).toContain('"audit_logs"."partner_id" = $');
    expect(q.sql).toMatch(/ or /);
    expect(q.params).toEqual([ORG, PARTNER]);
  });

  it('partner scope with zero accessible orgs still reaches its partner-scoped rows', () => {
    const q = render(auditLogReadCondition(auth('partner', PARTNER, [])))!;
    expect(q.sql).toContain('"audit_logs"."partner_id" = $');
    expect(q.params).toEqual([PARTNER]);
  });

  it('organization scope never gets the partner branch, even though the token carries a partnerId', () => {
    const q = render(auditLogReadCondition(auth('organization', PARTNER, [ORG])))!;
    expect(q.sql).not.toContain('partner_id');
    expect(q.params).toEqual([ORG]);
  });

  it('system scope stays unfiltered', () => {
    expect(auditLogReadCondition(auth('system', null, null))).toBeUndefined();
  });

  it('auditPartnerScopeId is gated on partner scope', () => {
    expect(auditPartnerScopeId({ scope: 'partner', partnerId: PARTNER })).toBe(PARTNER);
    expect(auditPartnerScopeId({ scope: 'organization', partnerId: PARTNER })).toBeNull();
    expect(auditPartnerScopeId({ scope: 'system', partnerId: null })).toBeNull();
    expect(auditPartnerScopeId({ scope: 'partner', partnerId: null })).toBeNull();
  });
});

describe('derivePartnerAttribution (#7696)', () => {
  beforeEach(() => {
    ambientContext.mockReset();
    ambientContext.mockReturnValue(undefined);
  });

  const ctx = (a: unknown): RequestLike =>
    ({ req: { header: () => undefined }, get: (k: string) => (k === 'auth' ? a : undefined) }) as unknown as RequestLike;
  const shim: RequestLike = { req: { header: () => undefined } };

  it('derives the partner for a NULL-org event from a partner-scope request', () => {
    expect(derivePartnerAttribution(ctx({ scope: 'partner', partnerId: PARTNER }), { orgId: null })).toBe(PARTNER);
    expect(derivePartnerAttribution(ctx({ scope: 'partner', partnerId: PARTNER }), { orgId: undefined })).toBe(PARTNER);
  });

  it('never attributes an org row', () => {
    expect(derivePartnerAttribution(ctx({ scope: 'partner', partnerId: PARTNER }), { orgId: ORG })).toBeNull();
    expect(derivePartnerAttribution(shim, { orgId: ORG, partnerId: PARTNER })).toBeNull();
  });

  it('never derives from an organization- or system-scope request', () => {
    expect(derivePartnerAttribution(ctx({ scope: 'organization', partnerId: PARTNER }), { orgId: null })).toBeNull();
    expect(derivePartnerAttribution(ctx({ scope: 'system', partnerId: null }), { orgId: null })).toBeNull();
  });

  it('honours an explicit partnerId, including an explicit null opt-out', () => {
    expect(derivePartnerAttribution(shim, { orgId: null, partnerId: PARTNER })).toBe(PARTNER);
    expect(derivePartnerAttribution(ctx({ scope: 'partner', partnerId: PARTNER }), { orgId: null, partnerId: null })).toBeNull();
  });

  it('tolerates a RequestLike shim without auth and rejects a non-uuid', () => {
    expect(derivePartnerAttribution(shim, { orgId: null })).toBeNull();
    expect(derivePartnerAttribution(ctx({ scope: 'partner', partnerId: 'not-a-uuid' }), { orgId: null })).toBeNull();
    expect(derivePartnerAttribution(shim, { orgId: null, partnerId: 'not-a-uuid' })).toBeNull();
  });

  // AI tools and services audit through requestLikeFromSnapshot (no auth), but
  // run inside withDbAccessContext(dbAccessContextFromAuth(auth)). The RLS
  // context is the fallback attribution source.
  it('falls back to the ambient partner-scope DB context for an auth-less shim', () => {
    ambientContext.mockReturnValue({ scope: 'partner', orgId: null, accessibleOrgIds: [ORG], accessiblePartnerIds: [PARTNER], currentPartnerId: PARTNER });
    expect(derivePartnerAttribution(shim, { orgId: null })).toBe(PARTNER);
    expect(derivePartnerAttribution(shim, { orgId: ORG })).toBeNull();
    expect(derivePartnerAttribution(shim, { orgId: null, partnerId: null })).toBeNull();
  });

  it('never falls back to an organization- or system-scope DB context', () => {
    ambientContext.mockReturnValue({ scope: 'organization', orgId: ORG, accessibleOrgIds: [ORG], accessiblePartnerIds: [], currentPartnerId: PARTNER });
    expect(derivePartnerAttribution(shim, { orgId: null })).toBeNull();
    ambientContext.mockReturnValue({ scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null });
    expect(derivePartnerAttribution(shim, { orgId: null })).toBeNull();
  });

  it('request auth wins over the ambient context', () => {
    ambientContext.mockReturnValue({ scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [PARTNER] });
    expect(derivePartnerAttribution(ctx({ scope: 'organization', partnerId: PARTNER }), { orgId: null })).toBeNull();
  });
});
