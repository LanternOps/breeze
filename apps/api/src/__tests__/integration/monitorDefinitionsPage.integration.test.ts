/**
 * listMonitorDefinitionsPage against real Postgres (#6735): the page is cut in
 * SQL and its total is a same-statement window count, so the envelope can only
 * describe the rows actually returned. The unit tests mock the query builder;
 * this proves the SQL itself (window before LIMIT/OFFSET, RLS-bounded total,
 * deterministic (name, id) order over an unchanged set, the empty-page
 * fallback). Offset paging under concurrent inserts/deletes is not stable and
 * is not claimed here.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { monitorDefinitions } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { listMonitorDefinitionsPage } from '../../services/monitors/monitorService';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

function orgAuth(orgId: string, partnerId: string): AuthContext {
  return {
    scope: 'organization',
    orgId,
    partnerId,
    accessibleOrgIds: [orgId],
    orgCondition: (column: Parameters<AuthContext['orgCondition']>[0]) => eq(column, orgId),
    canAccessOrg: (id: string) => id === orgId,
    user: { id: '00000000-0000-0000-0000-000000000000' },
  } as unknown as AuthContext;
}

const createdOrgIds: string[] = [];
const createdPartnerIds: string[] = [];
afterEach(async () => {
  const orgIds = [...createdOrgIds];
  const partnerIds = [...createdPartnerIds];
  createdOrgIds.length = 0;
  createdPartnerIds.length = 0;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (orgIds.length > 0) await db.delete(monitorDefinitions).where(inArray(monitorDefinitions.orgId, orgIds));
    if (partnerIds.length > 0) {
      await db.delete(monitorDefinitions).where(inArray(monitorDefinitions.partnerId, partnerIds));
    }
  });
});

async function seedOrg(count: number, name: (i: number) => string) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  createdOrgIds.push(org.id);
  if (count > 0) {
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(monitorDefinitions).values(
        Array.from({ length: count }, (_, i) => ({
          orgId: org.id,
          partnerId: null,
          name: name(i),
          kind: 'cpu' as const,
          condition: { operator: 'gt', value: 90 },
          severity: 'high' as const,
        })),
      ),
    );
  }
  return { orgId: org.id, partnerId: partner.id };
}

describe('listMonitorDefinitionsPage (real Postgres, #6735)', () => {
  it('returns the page and the whole visible total from one statement, bounded to the caller', async () => {
    const a = await seedOrg(7, (i) => `a-${String(i).padStart(2, '0')}`);
    await seedOrg(5, (i) => `b-${i}`); // another tenant: must not count

    const page = await withDbAccessContext(orgContext(a.orgId, a.partnerId), () =>
      listMonitorDefinitionsPage(orgAuth(a.orgId, a.partnerId), undefined, { limit: 3, offset: 2 }),
    );

    expect(page.total).toBe(7);
    expect(page.rows.map((r) => r.name)).toEqual(['a-02', 'a-03', 'a-04']);
  });

  it('over an unchanged set, walks every row exactly once, including an org and a partner-wide row that share a name', async () => {
    // Names are unique per owner (monitor_definitions_owner_name_uidx), so the
    // only tie one caller can see is an org monitor and a partner-wide one.
    const a = await seedOrg(9, (i) => `e-${i}`);
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(monitorDefinitions).values({
        orgId: null,
        partnerId: a.partnerId,
        name: 'e-4',
        kind: 'cpu' as const,
        condition: { operator: 'gt', value: 90 },
        severity: 'high' as const,
      }),
    );
    createdPartnerIds.push(a.partnerId);

    const seen: string[] = [];
    for (let offset = 0; offset < 30; offset += 3) {
      const page = await withDbAccessContext(orgContext(a.orgId, a.partnerId), () =>
        listMonitorDefinitionsPage(orgAuth(a.orgId, a.partnerId), undefined, { limit: 3, offset }),
      );
      expect(page.total).toBe(10);
      seen.push(...page.rows.map((r) => r.id));
      if (page.rows.length < 3) break;
    }
    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
  });

  it('an offset past the end is an empty page that still reports the real total', async () => {
    const a = await seedOrg(3, (i) => `c-${i}`);
    const page = await withDbAccessContext(orgContext(a.orgId, a.partnerId), () =>
      listMonitorDefinitionsPage(orgAuth(a.orgId, a.partnerId), undefined, { limit: 10, offset: 50 }),
    );
    expect(page).toEqual({ rows: [], total: 3 });
  });

  it('applies the filters to both the page and the total', async () => {
    const a = await seedOrg(4, (i) => `d-${i}`);
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.update(monitorDefinitions).set({ enabled: false }).where(and(eq(monitorDefinitions.name, 'd-0'), eq(monitorDefinitions.orgId, a.orgId))),
    );
    const page = await withDbAccessContext(orgContext(a.orgId, a.partnerId), () =>
      listMonitorDefinitionsPage(orgAuth(a.orgId, a.partnerId), { enabled: true }, { limit: 10, offset: 0 }),
    );
    expect(page.total).toBe(3);
    expect(page.rows.map((r) => r.name)).toEqual(['d-1', 'd-2', 'd-3']);
  });
});
