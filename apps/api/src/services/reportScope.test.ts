import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const { systemCtxSpy, outsideSpy, ambient } = vi.hoisted(() => ({
  systemCtxSpy: vi.fn(),
  outsideSpy: vi.fn(),
  ambient: { current: undefined as unknown },
}));

vi.mock('../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: <T,>(fn: () => T): T => { outsideSpy(); return fn(); },
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>): Promise<T> => { systemCtxSpy(); return fn(); },
  getCurrentDbAccessContext: () => ambient.current,
  hasDbAccessContext: () => ambient.current !== undefined,
}));

import { db } from '../db';
import {
  ReportScopeMismatchError,
  organizationScope,
  reportOwnerOfScope,
  reportScopeFromAuthority,
  resolvePartnerReportOrgIds,
  runInReportScope,
  type ReportScope,
} from './reportScope';
import { UnexecutableReportScopeError } from './reportErrors';
import { UnexecutableReportScopeError as ReExportedUnexecutable } from './reportGenerationService';
import type { ReportGenerationAuthority } from './siteScope';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const PARTNER = '44444444-4444-4444-8444-444444444444';
const OTHER_PARTNER = '55555555-5555-4555-8555-555555555555';
const USER = '33333333-3333-4333-8333-333333333333';

let capturedWhere: SQL | undefined;

function queueOrgRows(rows: Array<{ id: string }>) {
  vi.mocked(db.select).mockImplementation((() => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = (cond: SQL) => { capturedWhere = cond; return chain; };
    chain.orderBy = () => chain;
    (chain as { then?: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(rows).then(r);
    return chain;
  }) as never);
}

const orgAuthority: ReportGenerationAuthority = {
  principalKind: 'user',
  scope: { version: 1, kind: 'unrestricted', orgId: ORG_A },
  principalUserId: USER,
  capturedAt: new Date('2026-09-21T00:00:00.000Z'),
  fingerprint: 'f'.repeat(64),
};

const partnerAuthority: ReportGenerationAuthority = {
  principalKind: 'user',
  scope: { version: 1, kind: 'partner_wide', partnerId: PARTNER },
  principalUserId: USER,
  capturedAt: new Date('2026-09-21T00:00:00.000Z'),
  fingerprint: 'a'.repeat(64),
};

beforeEach(() => {
  vi.clearAllMocks();
  ambient.current = undefined;
  capturedWhere = undefined;
});

describe('reportScopeFromAuthority', () => {
  it('an org owner with an org authority yields an organization scope and opens NO system context', async () => {
    const scope = await reportScopeFromAuthority({ orgId: ORG_A }, orgAuthority);
    expect(scope).toEqual({ kind: 'organization', orgId: ORG_A });
    expect(systemCtxSpy).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('a partner owner with no ambient context resolves the live org list under a system context', async () => {
    queueOrgRows([{ id: ORG_A }, { id: ORG_B }]);
    const scope = await reportScopeFromAuthority({ partnerId: PARTNER }, partnerAuthority);
    expect(scope).toEqual({ kind: 'partner', partnerId: PARTNER, orgIds: [ORG_A, ORG_B] });
    expect(systemCtxSpy).toHaveBeenCalledOnce();
    expect(outsideSpy).not.toHaveBeenCalled();
  });

  it('a partner owner on the request path (matching partner ambient context) opens NO second context', async () => {
    ambient.current = { scope: 'partner', orgId: null, accessibleOrgIds: [ORG_A], accessiblePartnerIds: [PARTNER] };
    queueOrgRows([{ id: ORG_A }]);
    await expect(reportScopeFromAuthority({ partnerId: PARTNER }, partnerAuthority))
      .resolves.toEqual({ kind: 'partner', partnerId: PARTNER, orgIds: [ORG_A] });
    expect(systemCtxSpy).not.toHaveBeenCalled();
    expect(outsideSpy).not.toHaveBeenCalled();
  });

  it('a partner with zero organizations yields an empty, NOT a null, org list', async () => {
    queueOrgRows([]);
    await expect(reportScopeFromAuthority({ partnerId: PARTNER }, partnerAuthority))
      .resolves.toEqual({ kind: 'partner', partnerId: PARTNER, orgIds: [] });
  });

  it('refuses an owner/authority axis mismatch rather than inventing a scope', async () => {
    await expect(reportScopeFromAuthority({ partnerId: PARTNER }, orgAuthority))
      .rejects.toBeInstanceOf(ReportScopeMismatchError);
    await expect(reportScopeFromAuthority({ orgId: ORG_A }, partnerAuthority))
      .rejects.toBeInstanceOf(ReportScopeMismatchError);
  });

  it('refuses an org authority whose orgId is not the owner org', async () => {
    await expect(reportScopeFromAuthority({ orgId: ORG_B }, orgAuthority))
      .rejects.toBeInstanceOf(ReportScopeMismatchError);
  });

  it('refuses a partner authority for another partner', async () => {
    await expect(reportScopeFromAuthority({ partnerId: ORG_A }, partnerAuthority))
      .rejects.toBeInstanceOf(ReportScopeMismatchError);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('round-trips owner -> scope -> owner', () => {
    expect(reportOwnerOfScope(organizationScope(ORG_A))).toEqual({ orgId: ORG_A });
    expect(reportOwnerOfScope({ kind: 'partner', partnerId: PARTNER, orgIds: [] }))
      .toEqual({ partnerId: PARTNER });
  });
});

describe('resolvePartnerReportOrgIds', () => {
  it('filters to active/trial, non-deleted, non-quick_support orgs of exactly this partner', async () => {
    queueOrgRows([{ id: ORG_A }]);
    await resolvePartnerReportOrgIds(PARTNER);
    expect(capturedWhere).toBeDefined();
    const compiled = new PgDialect().sqlToQuery(capturedWhere!);
    expect(compiled.sql).toContain('"organizations"."partner_id" = $1');
    expect(compiled.sql).toMatch(/"organizations"\."status" in \(\$\d+, \$\d+\)/);
    expect(compiled.sql).toContain('"organizations"."deleted_at" is null');
    expect(compiled.sql).toMatch(/"organizations"\."type" <> \$\d+/);
    expect(compiled.params).toEqual(expect.arrayContaining([PARTNER, 'active', 'trial', 'quick_support']));
    expect(compiled.params).not.toContain('suspended');
    expect(compiled.params).not.toContain('archived');
  });
});

describe('runInReportScope', () => {
  const partnerScope: ReportScope = { kind: 'partner', partnerId: PARTNER, orgIds: [ORG_A] };

  it('with no ambient context opens a system context', async () => {
    await expect(runInReportScope(partnerScope, async () => 'ok')).resolves.toBe('ok');
    expect(systemCtxSpy).toHaveBeenCalledOnce();
    expect(outsideSpy).not.toHaveBeenCalled();
  });

  it('with a matching partner ambient context runs in it without opening one', async () => {
    ambient.current = { scope: 'partner', orgId: null, accessibleOrgIds: [ORG_A], accessiblePartnerIds: [PARTNER] };
    await expect(runInReportScope(partnerScope, async () => 'ok')).resolves.toBe('ok');
    expect(systemCtxSpy).not.toHaveBeenCalled();
    expect(outsideSpy).not.toHaveBeenCalled();
  });

  it('with a system ambient context runs in it', async () => {
    ambient.current = { scope: 'system', orgId: null, accessibleOrgIds: null };
    const fn = vi.fn(async () => 1);
    await expect(runInReportScope(partnerScope, fn)).resolves.toBe(1);
    await expect(runInReportScope(organizationScope(ORG_B), fn)).resolves.toBe(1);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(systemCtxSpy).not.toHaveBeenCalled();
  });

  it('with an org-scope ambient context and a partner ReportScope throws instead of running', async () => {
    ambient.current = { scope: 'organization', orgId: ORG_A, accessibleOrgIds: [ORG_A], accessiblePartnerIds: [PARTNER] };
    const fn = vi.fn(async () => 'rows');
    await expect(runInReportScope(partnerScope, fn)).rejects.toBeInstanceOf(ReportScopeMismatchError);
    expect(fn).not.toHaveBeenCalled();
    expect(systemCtxSpy).not.toHaveBeenCalled();
  });

  it('with a partner ambient context for another partner throws', async () => {
    ambient.current = { scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [OTHER_PARTNER] };
    const fn = vi.fn(async () => 'rows');
    await expect(runInReportScope(partnerScope, fn)).rejects.toBeInstanceOf(ReportScopeMismatchError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('with a partner ambient context lacking accessiblePartnerIds throws', async () => {
    ambient.current = { scope: 'partner', orgId: null, accessibleOrgIds: [ORG_A] };
    await expect(runInReportScope(partnerScope, async () => 'rows')).rejects.toBeInstanceOf(ReportScopeMismatchError);
  });

  it('an organization scope runs in an ambient context that can see the org', async () => {
    ambient.current = { scope: 'partner', orgId: null, accessibleOrgIds: [ORG_A, ORG_B], accessiblePartnerIds: [PARTNER] };
    await expect(runInReportScope(organizationScope(ORG_B), async () => 'ok')).resolves.toBe('ok');
    expect(systemCtxSpy).not.toHaveBeenCalled();
  });

  it('an organization scope refuses an ambient context that cannot see the org', async () => {
    ambient.current = { scope: 'organization', orgId: ORG_A, accessibleOrgIds: [ORG_A] };
    const fn = vi.fn(async () => 'rows');
    await expect(runInReportScope(organizationScope(ORG_B), fn)).rejects.toBeInstanceOf(ReportScopeMismatchError);
    ambient.current = { scope: 'partner', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: [PARTNER] };
    await expect(runInReportScope(organizationScope(ORG_B), fn)).rejects.toBeInstanceOf(ReportScopeMismatchError);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('ReportScopeMismatchError', () => {
  it('is an UnexecutableReportScopeError so every existing 403 arm maps it', () => {
    const err = new ReportScopeMismatchError('x');
    expect(err).toBeInstanceOf(UnexecutableReportScopeError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ReportScopeMismatchError');
    expect(err.code).toBe('report_scope_mismatch');
    expect(err.message).toBe('x');
  });

  it('reportGenerationService re-exports the SAME error class, not a copy', () => {
    expect(ReExportedUnexecutable).toBe(UnexecutableReportScopeError);
  });
});
