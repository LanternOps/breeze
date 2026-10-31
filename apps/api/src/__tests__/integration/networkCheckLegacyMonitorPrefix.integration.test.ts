/**
 * Live-Postgres proof for
 * 2027-01-18-166000-network-checks-strip-legacy-monitor-prefix.sql.sql (#7358):
 * managed network checks compiled before #7359 lose their "[monitor] "
 * prefix, unless the plain name would collide with another check visible in
 * the same list, and nothing else is touched.
 *
 * setup.ts has already applied every migration to an empty database, so each
 * test seeds the pre-cleanup state and replays the file.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { monitorDefinitions, networkMonitors } from '../../db/schema';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';
import { replayMigration } from './replayMigration';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const MIGRATION = '2027-01-18-166000-network-checks-strip-legacy-monitor-prefix.sql.sql';

type Owner = { orgId: string; partnerId: null } | { orgId: null; partnerId: string };

const orgOwner = (orgId: string): Owner => ({ orgId, partnerId: null });
const partnerOwner = (partnerId: string): Owner => ({ orgId: null, partnerId });

async function createDefinition(owner: Owner, name: string): Promise<string> {
  const [def] = await getTestDb()
    .insert(monitorDefinitions)
    .values({
      ...owner,
      name,
      kind: 'network_check',
      condition: {
        checkType: 'http_check',
        target: 'https://portal.example.test/health',
        expectStatus: 200,
        pollingIntervalSeconds: 60,
        timeoutSeconds: 5,
        consecutiveFailures: 2,
      },
      severity: 'high',
    } as never)
    .returning({ id: monitorDefinitions.id });
  return def!.id;
}

async function createCheck(owner: Owner, name: string, managedByMonitorId: string | null = null) {
  const [row] = await getTestDb()
    .insert(networkMonitors)
    .values({
      ...owner,
      name,
      managedByMonitorId,
      monitorType: 'http_check',
      target: 'https://portal.example.test/health',
    })
    .returning({ id: networkMonitors.id, updatedAt: networkMonitors.updatedAt });
  return row!;
}

/** A pre-#7359 compiled check: "[monitor] <definition name>". */
async function createLegacyManagedCheck(owner: Owner, definitionName: string) {
  const defId = await createDefinition(owner, definitionName);
  return createCheck(owner, `[monitor] ${definitionName}`, defId);
}

async function namesById(ids: string[]): Promise<Record<string, string>> {
  const rows = await getTestDb()
    .select({ id: networkMonitors.id, name: networkMonitors.name })
    .from(networkMonitors)
    .where(inArray(networkMonitors.id, ids));
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

async function newOrg() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  return { partnerId: partner.id, orgId: org.id };
}

describe(MIGRATION, () => {
  runDb('strips the prefix from org- and partner-owned managed checks, and a re-run is a no-op', async () => {
    const { partnerId, orgId } = await newOrg();
    const suffix = randomUUID().slice(0, 8);
    const orgCheck = await createLegacyManagedCheck(orgOwner(orgId), `Portal ${suffix}`);
    const partnerCheck = await createLegacyManagedCheck(partnerOwner(partnerId), `Gateway ${suffix}`);
    // A definition whose own name starts with the prefix: strip exactly one.
    const doubled = await createLegacyManagedCheck(orgOwner(orgId), `[monitor] Edge ${suffix}`);
    // Back-date it so the rename's updated_at bump is observable.
    const seededUpdatedAt = new Date('2020-01-01T00:00:00Z');
    await getTestDb()
      .update(networkMonitors)
      .set({ updatedAt: seededUpdatedAt })
      .where(inArray(networkMonitors.id, [orgCheck.id]));

    await replayMigration(MIGRATION);

    const ids = [orgCheck.id, partnerCheck.id, doubled.id];
    expect(await namesById(ids)).toEqual({
      [orgCheck.id]: `Portal ${suffix}`,
      [partnerCheck.id]: `Gateway ${suffix}`,
      [doubled.id]: `[monitor] Edge ${suffix}`,
    });

    const [afterFirst] = await getTestDb()
      .select({ updatedAt: networkMonitors.updatedAt })
      .from(networkMonitors)
      .where(inArray(networkMonitors.id, [orgCheck.id]));
    expect(afterFirst!.updatedAt.getTime()).toBeGreaterThan(seededUpdatedAt.getTime());

    await replayMigration(MIGRATION);

    expect(await namesById(ids)).toEqual({
      [orgCheck.id]: `Portal ${suffix}`,
      [partnerCheck.id]: `Gateway ${suffix}`,
      [doubled.id]: `[monitor] Edge ${suffix}`,
    });
    const [afterSecond] = await getTestDb()
      .select({ updatedAt: networkMonitors.updatedAt })
      .from(networkMonitors)
      .where(inArray(networkMonitors.id, [orgCheck.id]));
    expect(afterSecond!.updatedAt.toISOString()).toBe(afterFirst!.updatedAt.toISOString());
  });

  runDb('leaves unmanaged checks and managed checks not named after their definition alone', async () => {
    const { orgId } = await newOrg();
    const suffix = randomUUID().slice(0, 8);
    const unmanaged = await createCheck(orgOwner(orgId), `[monitor] Hand made ${suffix}`);
    const defId = await createDefinition(orgOwner(orgId), `Renamed ${suffix}`);
    const mismatched = await createCheck(orgOwner(orgId), `[monitor] Something else ${suffix}`, defId);
    const caseDiffers = await createCheck(
      orgOwner(orgId),
      `[Monitor] Cased ${suffix}`,
      await createDefinition(orgOwner(orgId), `Cased ${suffix}`),
    );

    await replayMigration(MIGRATION);

    expect(await namesById([unmanaged.id, mismatched.id, caseDiffers.id])).toEqual({
      [unmanaged.id]: `[monitor] Hand made ${suffix}`,
      [mismatched.id]: `[monitor] Something else ${suffix}`,
      [caseDiffers.id]: `[Monitor] Cased ${suffix}`,
    });
  });

  runDb('skips a managed check whose plain name is already used in the same org', async () => {
    const { orgId } = await newOrg();
    const name = `Router ${randomUUID().slice(0, 8)}`;
    const operatorCheck = await createCheck(orgOwner(orgId), name);
    const managed = await createLegacyManagedCheck(orgOwner(orgId), name);

    await replayMigration(MIGRATION);

    expect(await namesById([operatorCheck.id, managed.id])).toEqual({
      [operatorCheck.id]: name,
      [managed.id]: `[monitor] ${name}`,
    });
  });

  runDb('skips across an org and its partner-wide checks, in both directions', async () => {
    const { partnerId, orgId } = await newOrg();
    const suffix = randomUUID().slice(0, 8);

    // Partner-wide operator check vs. an org's managed check.
    const partnerWide = await createCheck(partnerOwner(partnerId), `Uplink ${suffix}`);
    const orgManaged = await createLegacyManagedCheck(orgOwner(orgId), `Uplink ${suffix}`);

    // Org operator check vs. a partner-wide managed check.
    const orgOperator = await createCheck(orgOwner(orgId), `DNS ${suffix}`);
    const partnerManaged = await createLegacyManagedCheck(partnerOwner(partnerId), `DNS ${suffix}`);

    await replayMigration(MIGRATION);

    expect(await namesById([partnerWide.id, orgManaged.id, orgOperator.id, partnerManaged.id])).toEqual({
      [partnerWide.id]: `Uplink ${suffix}`,
      [orgManaged.id]: `[monitor] Uplink ${suffix}`,
      [orgOperator.id]: `DNS ${suffix}`,
      [partnerManaged.id]: `[monitor] DNS ${suffix}`,
    });
  });

  runDb('skips two managed checks that would both become the same name', async () => {
    // Definition names are unique per owner, so twins can only arise across a
    // partner-wide definition and one of its orgs' definitions.
    const { partnerId, orgId } = await newOrg();
    const name = `Twin ${randomUUID().slice(0, 8)}`;
    const a = await createLegacyManagedCheck(partnerOwner(partnerId), name);
    const b = await createLegacyManagedCheck(orgOwner(orgId), name);

    await replayMigration(MIGRATION);

    expect(await namesById([a.id, b.id])).toEqual({
      [a.id]: `[monitor] ${name}`,
      [b.id]: `[monitor] ${name}`,
    });
  });

  runDb('does not treat the same name in an unrelated org as a collision', async () => {
    const first = await newOrg();
    const second = await newOrg();
    const name = `Printer ${randomUUID().slice(0, 8)}`;
    const elsewhere = await createCheck(orgOwner(second.orgId), name);
    // Sibling org under the SAME partner, org-owned on both sides: separate lists.
    const sibling = await createOrganization({ partnerId: first.partnerId });
    const siblingCheck = await createCheck(orgOwner(sibling.id), name);
    const managed = await createLegacyManagedCheck(orgOwner(first.orgId), name);

    await replayMigration(MIGRATION);

    expect(await namesById([elsewhere.id, siblingCheck.id, managed.id])).toEqual({
      [elsewhere.id]: name,
      [siblingCheck.id]: name,
      [managed.id]: name,
    });
  });
});
