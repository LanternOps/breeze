import './setup';

import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { alertCorrelations, alerts, devices, sites } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// Real DbAccessContext shape (apps/api/src/db/index.ts) has NO `partnerId`
// field — mirrors the `orgContext` helper convention used elsewhere in this
// suite (e.g. backupSnapshotRetirementsRls.integration.test.ts).
function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

interface Fixture {
  orgAId: string;
  orgBId: string;
  alertA1: string;
  alertA2: string;
  alertB1: string;
}

// Two orgs under one partner, each with a device and alerts. Built under the
// system context so the seeding itself is never what the assertions measure.
async function seed(tag: string): Promise<Fixture> {
  const unique = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const { orgAId, orgBId } = await withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    return { orgAId: orgA.id, orgBId: orgB.id };
  });

  // One transaction per org's fixtures on purpose: the partner-export site
  // trigger (breeze_partner_export_lock_orgs_exclusive) demands org locks be
  // taken in ascending UUID order within a transaction, so touching two orgs'
  // sites in a single system context aborts with P0001 on random org ids.
  async function alertFor(orgId: string, suffix: string): Promise<string> {
    return withSystemDbAccessContext(async () => {
      const [site] = await db
        .insert(sites)
        .values({ orgId, name: `AC site ${unique}-${suffix}` })
        .returning({ id: sites.id });
      const [device] = await db
        .insert(devices)
        .values({
          orgId,
          siteId: site!.id,
          agentId: `ac-agent-${unique}-${suffix}`,
          hostname: `ac-host-${unique}-${suffix}`,
          osType: 'windows',
          osVersion: '11',
          architecture: 'x86_64',
          agentVersion: '0.0.0-test',
          status: 'online',
        })
        .returning({ id: devices.id });
      const [alert] = await db
        .insert(alerts)
        .values({
          orgId,
          deviceId: device!.id,
          severity: 'medium',
          title: `AC alert ${unique}-${suffix}`,
        })
        .returning({ id: alerts.id });
      return alert!.id;
    });
  }

  return {
    orgAId,
    orgBId,
    alertA1: await alertFor(orgAId, 'a1'),
    alertA2: await alertFor(orgAId, 'a2'),
    alertB1: await alertFor(orgBId, 'b1'),
  };
}

// #5607: the 2026-05-30 policy joined `alerts` on parent_alert_id ONLY, so a
// cross-org edge (parent in org A, child in org B) was readable under an org-A
// token — the child alert's id, correlation type, confidence and metadata all
// leaked. The follow-up migration ANDs the same EXISTS on child_alert_id.
runDb('a cross-org correlation edge is invisible to BOTH endpoint orgs', async () => {
  const { orgAId, orgBId, alertA1, alertB1 } = await seed('cross');

  const crossEdgeId = await withSystemDbAccessContext(async () => {
    const [row] = await db
      .insert(alertCorrelations)
      .values({ parentAlertId: alertA1, childAlertId: alertB1, correlationType: 'causal' })
      .returning({ id: alertCorrelations.id });
    return row!.id;
  });

  // The parent's org: this is the read the old parent-only policy allowed.
  const underOrgA = await withDbAccessContext(orgContext(orgAId), () =>
    db.select().from(alertCorrelations).where(eq(alertCorrelations.id, crossEdgeId))
  );
  expect(underOrgA.length).toBe(0);

  // The child's org: the old policy already denied this one; assert it stays denied.
  const underOrgB = await withDbAccessContext(orgContext(orgBId), () =>
    db.select().from(alertCorrelations).where(eq(alertCorrelations.id, crossEdgeId))
  );
  expect(underOrgB.length).toBe(0);
});

// Positive control. Without this, the assertion above would pass just as well
// against a policy that denies EVERY row (a dropped grant, a broken predicate),
// which would silently break the alert-correlation feature instead of fixing it.
runDb('a same-org correlation edge stays visible to its own org and invisible to another', async () => {
  const { orgAId, orgBId, alertA1, alertA2 } = await seed('same');

  const sameOrgEdgeId = await withSystemDbAccessContext(async () => {
    const [row] = await db
      .insert(alertCorrelations)
      .values({ parentAlertId: alertA1, childAlertId: alertA2, correlationType: 'causal' })
      .returning({ id: alertCorrelations.id });
    return row!.id;
  });

  const underOrgA = await withDbAccessContext(orgContext(orgAId), () =>
    db.select().from(alertCorrelations).where(eq(alertCorrelations.id, sameOrgEdgeId))
  );
  expect(underOrgA.length).toBe(1);
  expect(underOrgA[0]!.childAlertId).toBe(alertA2);

  const underOrgB = await withDbAccessContext(orgContext(orgBId), () =>
    db.select().from(alertCorrelations).where(eq(alertCorrelations.id, sameOrgEdgeId))
  );
  expect(underOrgB.length).toBe(0);
});

// The WITH CHECK half: an org-A token holding a legitimate org-A parent alert
// must not be able to attach an org-B alert as the child.
runDb('forges a cross-org correlation insert from the parent org and gets 42501', async () => {
  const { orgAId, alertA1, alertA2, alertB1 } = await seed('forge');

  await expect(
    withDbAccessContext(orgContext(orgAId), () =>
      db
        .insert(alertCorrelations)
        .values({ parentAlertId: alertA1, childAlertId: alertB1, correlationType: 'causal' })
    )
    // A Drizzle `.insert(...)` rejection wraps the Postgres error under
    // `.cause`, not a top-level `.code`.
  ).rejects.toMatchObject({ cause: { code: '42501' } });

  // Positive control for the same slot: the same context CAN write a
  // both-endpoints-in-org-A edge, so the 42501 above is the child check firing
  // and not a blanket INSERT denial.
  await withDbAccessContext(orgContext(orgAId), () =>
    db
      .insert(alertCorrelations)
      .values({ parentAlertId: alertA1, childAlertId: alertA2, correlationType: 'causal' })
  );
});
