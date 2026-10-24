/**
 * software_compliance_status RLS — device-join isolation (#6958 PR E, shape 5).
 *
 * Migration under test: 2027-01-04-120500-software-compliance-rls-service-watches.sql.
 *
 * The table has no org_id; it reaches its tenant through `device_id → devices.org_id`.
 * 0039-software-policies-rls.sql created exactly these four policies, but a FRESH
 * database never runs 0039: autoMigrate applies 0001-baseline.sql and only
 * MARKS 0002–0065 applied, and the baseline carries no RLS for this table. So
 * every database created from the baseline (CI, new self-hosters, the test
 * stack) had the table open until this migration. PR E puts an agent-read
 * surface on it (derived service watches), so isolation is asserted here
 * through the real breeze_app driver, not inferred from the policy text.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { softwareComplianceStatus, softwarePolicies } from '../../db/schema';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function orgCtx(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

function partnerCtx(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
  };
}

/** Copied from middleware/agentAuth.ts (the agent request's own context). */
function agentCtx(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: partnerId,
  } as DbAccessContext;
}

type World = {
  partnerA: string; partnerB: string;
  orgA1: string; orgA2: string; orgB: string;
  devA1: string; devA2: string; devB: string;
  policyA1: string; policyA2: string; policyB: string;
  rowA1: string; rowA2: string; rowB: string;
};

let w: World;
const createdPolicyIds: string[] = [];

async function seedWorld(): Promise<World> {
  const partnerA = (await createPartner())!.id;
  const partnerB = (await createPartner())!.id;
  const orgA1 = (await createOrganization({ partnerId: partnerA }))!.id;
  const orgA2 = (await createOrganization({ partnerId: partnerA }))!.id;
  const orgB = (await createOrganization({ partnerId: partnerB }))!.id;
  const devA1 = (await createDevice({ orgId: orgA1, siteId: (await createSite({ orgId: orgA1 }))!.id })).id;
  const devA2 = (await createDevice({ orgId: orgA2, siteId: (await createSite({ orgId: orgA2 }))!.id })).id;
  const devB = (await createDevice({ orgId: orgB, siteId: (await createSite({ orgId: orgB }))!.id })).id;

  return withDbAccessContext(SYSTEM_CTX, async () => {
    const policy = async (orgId: string) => {
      const [p] = await db.insert(softwarePolicies).values({
        orgId, name: `rls ${orgId}`, mode: 'allowlist', rules: { software: [{ name: 'Ctrld' }] },
      }).returning({ id: softwarePolicies.id });
      createdPolicyIds.push(p!.id);
      return p!.id;
    };
    const policyA1 = await policy(orgA1);
    const policyA2 = await policy(orgA2);
    const policyB = await policy(orgB);
    const row = async (deviceId: string, policyId: string) => {
      const [r] = await db.insert(softwareComplianceStatus).values({
        deviceId, policyId, status: 'compliant', lastChecked: new Date(), violations: [],
      }).returning({ id: softwareComplianceStatus.id });
      return r!.id;
    };
    return {
      partnerA, partnerB, orgA1, orgA2, orgB, devA1, devA2, devB, policyA1, policyA2, policyB,
      rowA1: await row(devA1, policyA1),
      rowA2: await row(devA2, policyA2),
      rowB: await row(devB, policyB),
    };
  });
}

/** Drizzle wraps the driver error; the RLS refusal is the cause's SQLSTATE 42501. */
async function expectRlsRefusal(run: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected the write to be refused').toBeDefined();
  const cause = (caught as { cause?: { code?: string; message?: string } }).cause;
  expect(cause?.code).toBe('42501');
  expect(cause?.message).toMatch(/row-level security/i);
}

async function visibleRowIds(ctx: DbAccessContext): Promise<string[]> {
  const ids = [w.rowA1, w.rowA2, w.rowB];
  const rows = await withDbAccessContext(ctx, () =>
    db.select({ id: softwareComplianceStatus.id }).from(softwareComplianceStatus)
      .where(inArray(softwareComplianceStatus.id, ids)));
  return rows.map((r) => r.id).sort();
}

describe('software_compliance_status RLS (#6958 PR E)', () => {
  beforeEach(async () => {
    w = await seedWorld();
  });

  afterEach(async () => {
    if (createdPolicyIds.length === 0) return;
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.delete(softwarePolicies).where(inArray(softwarePolicies.id, createdPolicyIds)));
    createdPolicyIds.length = 0;
  });

  it('an org session sees only its own devices\' rows', async () => {
    expect(await visibleRowIds(orgCtx(w.orgA1, w.partnerA))).toEqual([w.rowA1]);
  });

  it('an org session cannot INSERT a row for another org\'s device', async () => {
    await expectRlsRefusal(() => withDbAccessContext(orgCtx(w.orgA1, w.partnerA), () =>
      db.insert(softwareComplianceStatus).values({
        deviceId: w.devB, policyId: w.policyA1, status: 'compliant', lastChecked: new Date(),
      })));
  });

  it('an org session\'s UPDATE of another org\'s device row matches zero rows', async () => {
    const updated = await withDbAccessContext(orgCtx(w.orgA1, w.partnerA), () =>
      db.update(softwareComplianceStatus).set({ status: 'non_compliant' })
        .where(eq(softwareComplianceStatus.id, w.rowB))
        .returning({ id: softwareComplianceStatus.id }));
    expect(updated).toEqual([]);
    const [still] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ status: softwareComplianceStatus.status }).from(softwareComplianceStatus)
        .where(eq(softwareComplianceStatus.id, w.rowB)));
    expect(still?.status).toBe('compliant');
  });

  it('an org session cannot move its own row onto another org\'s device (WITH CHECK)', async () => {
    await expectRlsRefusal(() => withDbAccessContext(orgCtx(w.orgA1, w.partnerA), () =>
      db.update(softwareComplianceStatus).set({ deviceId: w.devB })
        .where(eq(softwareComplianceStatus.id, w.rowA1))));
  });

  it('a partner session sees every org it can access, and nothing of another partner', async () => {
    expect(await visibleRowIds(partnerCtx(w.partnerA, [w.orgA1, w.orgA2])))
      .toEqual([w.rowA1, w.rowA2].sort());
  });

  it('the agent-shaped context reads its own device\'s row only (currentPartnerId grants no device-join read)', async () => {
    expect(await visibleRowIds(agentCtx(w.orgA1, w.partnerA))).toEqual([w.rowA1]);
  });

  it('system context sees every row', async () => {
    expect(await visibleRowIds(SYSTEM_CTX)).toEqual([w.rowA1, w.rowA2, w.rowB].sort());
  });

  it('service_watches round-trips through the Drizzle column', async () => {
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.update(softwareComplianceStatus).set({ serviceWatches: [{ name: 'ctrld' }] })
        .where(eq(softwareComplianceStatus.id, w.rowA1)));
    const [row] = await withDbAccessContext(agentCtx(w.orgA1, w.partnerA), () =>
      db.select({ serviceWatches: softwareComplianceStatus.serviceWatches }).from(softwareComplianceStatus)
        .where(eq(softwareComplianceStatus.id, w.rowA1)));
    expect(row?.serviceWatches).toEqual([{ name: 'ctrld' }]);
  });
});
