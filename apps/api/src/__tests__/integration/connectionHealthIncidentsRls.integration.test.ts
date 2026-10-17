/**
 * connection_health_incidents RLS — tenancy shape 4 (dual-axis), spec
 * 2026-10-15 connection health §2.1.
 *
 * Migration under test: 2026-12-29-100100-connection-health-incidents.sql.
 *
 * `partner_id` is always set; `org_id` is NULL only for a partner-owned
 * connection. One FOR ALL policy admits org rows by breeze_has_org_access and
 * partner-wide rows by breeze_has_partner_access. There is deliberately NO
 * breeze_current_partner_id() read branch: an org-scope token must never see
 * a partner-owned connection's incident. The composite FK
 * (org_id, partner_id) → organizations(id, partner_id) keeps an org row from
 * naming another partner.
 *
 * Runs through the REAL postgres.js driver as `breeze_app`, which is the only
 * guard that a caller cannot forge another tenant's partner_id/org_id — the
 * rls-coverage contract only checks that the helpers appear in the policy.
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { connectionHealthIncidents, organizations } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
  };
}

// The real shape of an org token: currentPartnerId is set from the token's
// partner (middleware/auth.ts), accessiblePartnerIds is empty. Setting
// currentPartnerId here proves no partner-wide read branch leaks through it.
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

const asSystem = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);
const asPartner = <T>(partnerId: string, orgIds: string[], fn: () => Promise<T>) =>
  withDbAccessContext(partnerContext(partnerId, orgIds), fn);
const asOrg = <T>(orgId: string, partnerId: string, fn: () => Promise<T>) =>
  withDbAccessContext(orgContext(orgId, partnerId), fn);

let seq = 0;

async function insertIncident(owner: {
  partnerId: string;
  orgId: string | null;
  sourceKind?: string;
  sourceId?: string;
  fixHref?: string;
  resolvedAt?: Date | null;
  resolution?: string | null;
}): Promise<string> {
  const now = new Date();
  const rows = await db
    .insert(connectionHealthIncidents)
    .values({
      partnerId: owner.partnerId,
      orgId: owner.orgId,
      sourceKind: owner.sourceKind ?? 'oauth_grant',
      sourceId: owner.sourceId ?? `grant-${Date.now()}-${seq++}`,
      condition: 'reauth_required',
      severity: 'permanent',
      displayName: 'Test connected app',
      fixHref: owner.fixHref ?? '/settings/connected-apps',
      viewPermission: 'connected_apps:read',
      repairPermission: 'connected_apps:manage',
      firstFailedAt: now,
      openedAt: now,
      lastObservedAt: now,
      resolvedAt: owner.resolvedAt ?? null,
      resolution: owner.resolution ?? null,
    })
    .returning({ id: connectionHealthIncidents.id });
  return rows[0]!.id;
}

async function selectIncidentIds(): Promise<string[]> {
  const rows = await db.select({ id: connectionHealthIncidents.id }).from(connectionHealthIncidents);
  return rows.map((r) => r.id);
}

describe('connection_health_incidents RLS', () => {
  // Partner P with orgs A and B; partner Q with org C.
  let P: string;
  let Q: string;
  let A: string;
  let B: string;
  let C: string;
  // Incidents, inserted in system scope (the reconciler's only write path).
  let iA: string;
  let iB: string;
  let iP: string;
  let iC: string;
  let iQ: string;

  // setup.ts TRUNCATEs partners/organizations (CASCADE) before every test,
  // so the fixture is rebuilt per test.
  beforeEach(async () => {
    P = (await createPartner()).id;
    Q = (await createPartner()).id;
    A = (await createOrganization({ partnerId: P })).id;
    B = (await createOrganization({ partnerId: P })).id;
    C = (await createOrganization({ partnerId: Q })).id;
    await asSystem(async () => {
      iA = await insertIncident({ partnerId: P, orgId: A });
      iB = await insertIncident({ partnerId: P, orgId: B });
      iP = await insertIncident({ partnerId: P, orgId: null });
      iC = await insertIncident({ partnerId: Q, orgId: C });
      iQ = await insertIncident({ partnerId: Q, orgId: null });
    });
  });

  it('partner-scope full access sees its org and partner-wide incidents only', async () => {
    const ids = await asPartner(P, [A, B], () => selectIncidentIds());
    expect(ids.sort()).toEqual([iA, iB, iP].sort());
  });

  it('partner user with selected access to A does not see B', async () => {
    const ids = await asPartner(P, [A], () => selectIncidentIds());
    expect(ids).toContain(iA);
    expect(ids).not.toContain(iB);
    expect(ids).not.toContain(iC);
    expect(ids).not.toContain(iQ);
  });

  it('org-scope token never sees partner-wide rows, even with currentPartnerId set', async () => {
    const ids = await asOrg(A, P, () => selectIncidentIds());
    expect(ids).toEqual([iA]);
  });

  it('a forged cross-tenant org insert fails RLS', async () => {
    await expect(
      asPartner(P, [A, B], () => insertIncident({ partnerId: Q, orgId: C })),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('a forged partner-wide insert for another partner fails RLS', async () => {
    await expect(
      asPartner(P, [A, B], () => insertIncident({ partnerId: Q, orgId: null })),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('an org-scope token cannot write a partner-wide row', async () => {
    await expect(
      asOrg(A, P, () => insertIncident({ partnerId: P, orgId: null })),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('another partner cannot update or delete partner-wide rows it does not own', async () => {
    const updated = await asPartner(Q, [C], () =>
      db
        .update(connectionHealthIncidents)
        .set({ condition: 'HIJACKED' })
        .where(eq(connectionHealthIncidents.id, iP))
        .returning({ id: connectionHealthIncidents.id }),
    );
    expect(updated).toEqual([]);
    const deleted = await asPartner(Q, [C], () =>
      db
        .delete(connectionHealthIncidents)
        .where(eq(connectionHealthIncidents.id, iP))
        .returning({ id: connectionHealthIncidents.id }),
    );
    expect(deleted).toEqual([]);
    const ids = await asSystem(() => selectIncidentIds());
    expect(ids).toContain(iP);
  });

  it('an org whose partner does not match is rejected by the composite FK', async () => {
    await expect(asSystem(() => insertIncident({ partnerId: P, orgId: C }))).rejects.toMatchObject({
      cause: { code: '23503', constraint_name: 'connection_health_incidents_org_partner_fk' },
    });
  });

  it('the composite FK is DEFERRABLE INITIALLY IMMEDIATE (org merge defers constraints)', async () => {
    const rows = await asSystem(() =>
      db.execute(sql`
        SELECT condeferrable, condeferred FROM pg_constraint
        WHERE conname = 'connection_health_incidents_org_partner_fk'
      `),
    );
    expect([...rows]).toEqual([{ condeferrable: true, condeferred: false }]);
  });

  it('only one open row per source', async () => {
    await asSystem(() => insertIncident({ partnerId: P, orgId: A, sourceKind: 'oauth_grant', sourceId: 'dup' }));
    await expect(
      asSystem(() => insertIncident({ partnerId: P, orgId: A, sourceKind: 'oauth_grant', sourceId: 'dup' })),
    ).rejects.toMatchObject({
      cause: { code: '23505', constraint_name: 'connection_health_incidents_open_uniq' },
    });
  });

  it('a resolved row does not block a new open row for the same source', async () => {
    await asSystem(() =>
      insertIncident({
        partnerId: P,
        orgId: A,
        sourceId: 'reopened',
        resolvedAt: new Date(),
        resolution: 'recovered',
      }),
    );
    await expect(
      asSystem(() => insertIncident({ partnerId: P, orgId: A, sourceId: 'reopened' })),
    ).resolves.toEqual(expect.any(String));
  });

  it('resolved_at and resolution are set together', async () => {
    await expect(
      asSystem(() => insertIncident({ partnerId: P, orgId: A, resolvedAt: new Date(), resolution: null })),
    ).rejects.toMatchObject({
      cause: { code: '23514', constraint_name: 'connection_health_incidents_resolution_chk' },
    });
  });

  it('fix_href must be a same-origin relative path', async () => {
    await expect(
      asSystem(() => insertIncident({ partnerId: P, orgId: A, fixHref: '//evil.example/x' })),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(
      asSystem(() => insertIncident({ partnerId: P, orgId: A, fixHref: 'https://evil.example/x' })),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('deleting org A cascades its incidents and leaves partner-wide rows', async () => {
    await asSystem(() => db.delete(organizations).where(eq(organizations.id, A)));
    const ids = await asSystem(() => selectIncidentIds());
    expect(ids).not.toContain(iA);
    expect(ids).toContain(iB);
    expect(ids).toContain(iP);
  });
});

