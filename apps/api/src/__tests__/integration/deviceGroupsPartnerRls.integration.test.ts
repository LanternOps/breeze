import './setup';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { deviceGroups } from '../../db/schema';
import { pgErrorCode, pgErrorConstraint } from '../../utils/pgErrors';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';

const SYSTEM_CTX: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null };
const partnerContext = (partnerId: string, orgIds: string[]): DbAccessContext => ({
  scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null, currentPartnerId: partnerId,
});
const orgContext = (orgId: string, currentPartnerId: string | null): DbAccessContext => ({
  scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId,
});

async function expectSqlState(fn: () => Promise<unknown>, code: string, constraint?: string) {
  let raised: unknown;
  try { await fn(); } catch (err) { raised = err; }
  expect(raised, `expected SQLSTATE ${code}`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
  if (constraint) expect(pgErrorConstraint(raised)).toBe(constraint);
}

async function fixture() {
  const p = await createPartner();
  const q = await createPartner();
  const a = await createOrganization({ partnerId: p.id });
  const b = await createOrganization({ partnerId: p.id });
  const c = await createOrganization({ partnerId: q.id });
  return { p: p.id, q: q.id, a: a.id, b: b.id, c: c.id };
}

// Plan D3: the DB admits partner rows in W1; Drizzle's orgId type flips in W2a.
async function partnerGroup(partnerId: string) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [row] = await db.execute<{ id: string }>(sql`
      INSERT INTO device_groups (partner_id, name, type)
      VALUES (${partnerId}, 'Partner group', 'dynamic') RETURNING id`);
    return row!.id;
  });
}
async function orgGroup(orgId: string) {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(deviceGroups).values({ orgId, name: 'Organization group' }).returning());
  return row!.id;
}

describe('partner-owned device groups RLS (#10521 W1)', () => {
  it('XOR: both owners or neither → 23514 device_groups_one_owner_chk', async () => {
    const f = await fixture();
    for (const [orgId, partnerId] of [[f.a, f.p], [null, null]]) {
      await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () => db.execute(sql`
        INSERT INTO device_groups (org_id, partner_id, name) VALUES (${orgId}, ${partnerId}, 'Invalid owner')`)),
      '23514', 'device_groups_one_owner_chk');
    }
  });

  it('partner row with site_id or parent_id → 23514 device_groups_partner_shape_chk', async () => {
    const f = await fixture();
    const site = await createSite({ orgId: f.a });
    const parent = await orgGroup(f.a);
    for (const [siteId, parentId] of [[site.id, null], [null, parent]]) {
      await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () => db.execute(sql`
        INSERT INTO device_groups (partner_id, site_id, parent_id, name)
        VALUES (${f.p}, ${siteId}, ${parentId}, 'Invalid shape')`)),
      '23514', 'device_groups_partner_shape_chk');
    }
  });

  it('partner_id change and org_id NULL↔NOT NULL flips raise device_groups_owner_immutable; org A→B on an org group succeeds', async () => {
    const f = await fixture();
    const partnerId = await partnerGroup(f.p);
    const orgId = await orgGroup(f.a);
    for (const statement of [
      sql`UPDATE device_groups SET partner_id = ${f.q} WHERE id = ${partnerId}`,
      sql`UPDATE device_groups SET org_id = ${f.a}, partner_id = NULL WHERE id = ${partnerId}`,
      sql`UPDATE device_groups SET org_id = NULL, partner_id = ${f.p} WHERE id = ${orgId}`,
    ]) {
      await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () => db.execute(statement)),
        '23514', 'device_groups_owner_immutable');
    }
    await withDbAccessContext(SYSTEM_CTX, async () => {
      await db.update(deviceGroups).set({ orgId: f.b }).where(eq(deviceGroups.id, orgId));
      expect((await db.select().from(deviceGroups).where(eq(deviceGroups.id, orgId)))[0]?.orgId).toBe(f.b);
    });
  });

  it('an org group whose parent is a partner group fails at COMMIT', async () => {
    const f = await fixture();
    const parent = await partnerGroup(f.p);
    let reachedCommit = false;
    await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, async () => {
      await db.transaction(async (tx) => {
        await tx.insert(deviceGroups).values({ orgId: f.a, parentId: parent, name: 'Invalid parent' });
      });
      reachedCommit = true; // The outer context owns COMMIT; the explicit transaction is a savepoint.
    }), '23514', 'device_groups_parent_owner_kind');
    expect(reachedCommit).toBe(true);
  });

  it('an existing org group re-parented under a partner group fails at COMMIT', async () => {
    const f = await fixture();
    const parent = await partnerGroup(f.p);
    const child = await orgGroup(f.a);
    await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, async () => {
      await db.update(deviceGroups).set({ parentId: parent }).where(eq(deviceGroups.id, child));
    }), '23514', 'device_groups_parent_owner_kind');
  });

  it("org token of partner P inserting a partner_id = P group → 42501 (the SELECT branch never admits writes)", async () => {
    const f = await fixture();
    await expectSqlState(() => withDbAccessContext(orgContext(f.a, f.p), () => db.execute(sql`
      INSERT INTO device_groups (partner_id, name) VALUES (${f.p}, 'Org-forged partner group')`)), '42501');
  });

  it('partner A context inserting partner_id = B → 42501', async () => {
    const f = await fixture();
    await expectSqlState(() => withDbAccessContext(partnerContext(f.p, [f.a, f.b]), () => db.execute(sql`
      INSERT INTO device_groups (partner_id, name) VALUES (${f.q}, 'Foreign group')`)), '42501');
  });

  it("org token of partner P sees P's partner group, UPDATE/DELETE affect 0 rows; org token of partner Q sees none", async () => {
    const f = await fixture();
    const id = await partnerGroup(f.p);
    await withDbAccessContext(orgContext(f.a, f.p), async () => {
      expect(await db.select().from(deviceGroups).where(eq(deviceGroups.id, id))).toHaveLength(1);
      expect(await db.update(deviceGroups).set({ name: 'Forbidden' }).where(eq(deviceGroups.id, id)).returning()).toEqual([]);
      expect(await db.delete(deviceGroups).where(eq(deviceGroups.id, id)).returning()).toEqual([]);
    });
    await withDbAccessContext(orgContext(f.c, f.q), async () => {
      expect(await db.select().from(deviceGroups).where(eq(deviceGroups.id, id))).toEqual([]);
    });
  });

  it('agent-auth context (org scope, no partner access, currentPartnerId = device partner) sees the partner group; with currentPartnerId null it does not', async () => {
    const f = await fixture();
    const id = await partnerGroup(f.p);
    for (const currentPartnerId of [f.p, null]) {
      await withDbAccessContext(orgContext(f.a, currentPartnerId), async () => {
        expect(await db.select().from(deviceGroups).where(eq(deviceGroups.id, id))).toHaveLength(currentPartnerId ? 1 : 0);
      });
    }
  });

  it("org isolation: org A cannot see org B's group", async () => {
    const f = await fixture();
    const id = await orgGroup(f.b);
    await withDbAccessContext(orgContext(f.a, f.p), async () => {
      expect(await db.select().from(deviceGroups).where(eq(deviceGroups.id, id))).toEqual([]);
    });
  });

  it('partner context reads and writes its own partner group', async () => {
    const f = await fixture();
    await withDbAccessContext(partnerContext(f.p, [f.a, f.b]), async () => {
      const [row] = await db.execute<{ id: string }>(sql`
        INSERT INTO device_groups (partner_id, name, type) VALUES (${f.p}, 'Own group', 'dynamic') RETURNING id`);
      expect(await db.select().from(deviceGroups).where(eq(deviceGroups.id, row!.id))).toHaveLength(1);
      expect(await db.update(deviceGroups).set({ name: 'Updated' }).where(eq(deviceGroups.id, row!.id)).returning()).toHaveLength(1);
      expect(await db.delete(deviceGroups).where(eq(deviceGroups.id, row!.id)).returning()).toHaveLength(1);
    });
  });

  it('a cross-partner membership in a partner group is rejected at COMMIT', async () => {
    const f = await fixture();
    const id = await partnerGroup(f.p);
    const site = await createSite({ orgId: f.c });
    const device = await createDevice({ orgId: f.c, siteId: site.id });
    let reachedCommit = false;
    await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, async () => {
      await db.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO device_group_memberships (device_id, group_id, org_id)
          VALUES (${device.id}, ${id}, ${f.c})`);
      });
      reachedCommit = true;
    }), '23503', 'device_group_memberships_group_owner_check');
    expect(reachedCommit).toBe(true);
  });
});
