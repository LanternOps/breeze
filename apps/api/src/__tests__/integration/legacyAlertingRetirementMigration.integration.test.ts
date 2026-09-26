/**
 * W05d Task 1 — the re-key migration moves each policy's monitoring settings
 * row from its `monitoring` link to its `monitors` link (creating the link),
 * mirrors checkIntervalSeconds onto the link, and is a no-op on replay.
 * Real Postgres: the migration is SQL and the unique index on
 * feature_link_id is what makes the duplicate case interesting.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, SYSTEM_DB_ACCESS_CONTEXT } from '../../db';
import {
  configPolicyFeatureLinks,
  configPolicyMonitoringSettings,
  configPolicyMonitoringWatches,
  configurationPolicies,
} from '../../db/schema';
import { updateFeatureLink, removeFeatureLink } from '../../services/configurationPolicy';
import { replayMigration } from './replayMigration';
import { createOrganization, createPartner } from './db-utils';

const MIGRATION = '2026-10-31-110000-legacy-alerting-retirement-sweep.sql';
const SYSTEM_CTX = SYSTEM_DB_ACCESS_CONTEXT;

const created: string[] = [];
afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const id of created.splice(0)) {
      await db.delete(configurationPolicies).where(eq(configurationPolicies.id, id));
    }
  });
});

async function policyWithMonitoringLink(orgId: string, checkIntervalSeconds: number, alsoMonitorsLink: boolean) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db.insert(configurationPolicies).values({ orgId, name: `W05d ${Math.random()}`, status: 'active' }).returning();
    created.push(policy!.id);
    const [monitoringLink] = await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id, featureType: 'monitoring', inlineSettings: { checkIntervalSeconds, watches: [] },
    }).returning();
    await db.insert(configPolicyMonitoringSettings).values({ featureLinkId: monitoringLink!.id, checkIntervalSeconds });
    let monitorsLinkId: string | null = null;
    if (alsoMonitorsLink) {
      const [m] = await db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policy!.id, featureType: 'monitors', inlineSettings: { items: [] },
      }).returning();
      monitorsLinkId = m!.id;
    }
    return { policyId: policy!.id, monitoringLinkId: monitoringLink!.id, monitorsLinkId };
  });
}

async function settingsLinkFor(policyId: string) {
  return withDbAccessContext(SYSTEM_CTX, () =>
    db.select({
      featureType: configPolicyFeatureLinks.featureType,
      linkId: configPolicyFeatureLinks.id,
      inline: configPolicyFeatureLinks.inlineSettings,
      interval: configPolicyMonitoringSettings.checkIntervalSeconds,
      settingsId: configPolicyMonitoringSettings.id,
      settingsUpdatedAt: configPolicyMonitoringSettings.updatedAt,
      linkUpdatedAt: configPolicyFeatureLinks.updatedAt,
    })
      .from(configPolicyMonitoringSettings)
      .innerJoin(configPolicyFeatureLinks, eq(configPolicyFeatureLinks.id, configPolicyMonitoringSettings.featureLinkId))
      .where(eq(configPolicyFeatureLinks.configPolicyId, policyId))
      .orderBy(configPolicyFeatureLinks.featureType),
  );
}

describe('2026-10-31-110000-legacy-alerting-retirement-sweep.sql', () => {
  it('re-keys a monitoring-only policy onto a freshly created monitors link and mirrors the interval', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { policyId } = await policyWithMonitoringLink(org.id, 90, false);

    await replayMigration(MIGRATION);

    const rows = await settingsLinkFor(policyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.featureType).toBe('monitors');
    expect(rows[0]!.interval).toBe(90);
    expect((rows[0]!.inline as Record<string, unknown>).checkIntervalSeconds).toBe(90);
    expect((rows[0]!.inline as Record<string, unknown>).inheritance).toBe('cumulative');
    expect((rows[0]!.inline as Record<string, unknown>).items).toEqual([]);
  });

  it('re-keys onto the existing monitors link when the policy has both', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { policyId, monitorsLinkId } = await policyWithMonitoringLink(org.id, 120, true);

    await replayMigration(MIGRATION);

    const rows = await settingsLinkFor(policyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.linkId).toBe(monitorsLinkId);
    expect((rows[0]!.inline as Record<string, unknown>).checkIntervalSeconds).toBe(120);
  });

  it('is a no-op on replay', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { policyId } = await policyWithMonitoringLink(org.id, 45, false);
    await replayMigration(MIGRATION);
    const before = await settingsLinkFor(policyId);
    await replayMigration(MIGRATION);
    const after = await settingsLinkFor(policyId);
    expect(after).toEqual(before);
    const links = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ n: sql<number>`count(*)::int` }).from(configPolicyFeatureLinks)
        .where(and(eq(configPolicyFeatureLinks.configPolicyId, policyId), eq(configPolicyFeatureLinks.featureType, 'monitors'))),
    );
    expect(links[0]!.n).toBe(1);
  });

  it('preserves an existing monitors attachment set and inheritance while correcting a stale interval', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { policyId, monitorsLinkId } = await policyWithMonitoringLink(org.id, 150, true);
    const inline = { items: [{ monitorId: '00000000-0000-4000-8000-000000000001' }], inheritance: 'replace', checkIntervalSeconds: 60 };
    await withDbAccessContext(SYSTEM_CTX, () => db.update(configPolicyFeatureLinks)
      .set({ inlineSettings: inline }).where(eq(configPolicyFeatureLinks.id, monitorsLinkId!)));

    await replayMigration(MIGRATION);

    expect((await settingsLinkFor(policyId))[0]!.inline).toEqual({ ...inline, checkIntervalSeconds: 150 });
  });

  it('retains both settings rows and their watches when the monitors link already owns settings', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { policyId, monitoringLinkId, monitorsLinkId } = await policyWithMonitoringLink(org.id, 90, true);
    const [legacy] = await settingsLinkFor(policyId);
    const watches = await withDbAccessContext(SYSTEM_CTX, async () => {
      const [existing] = await db.insert(configPolicyMonitoringSettings).values({
        featureLinkId: monitorsLinkId!, checkIntervalSeconds: 180,
      }).returning();
      return db.insert(configPolicyMonitoringWatches).values([
        { settingsId: legacy!.settingsId, watchType: 'service', name: 'legacy-service' },
        { settingsId: existing!.id, watchType: 'process', name: 'retired-process', retiredAt: new Date(), retiredReason: 'converted' },
      ]).returning();
    });

    await replayMigration(MIGRATION);

    const rows = await settingsLinkFor(policyId);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.linkId === monitoringLinkId)).toEqual(legacy);
    expect(rows.find((row) => row.linkId === monitorsLinkId)).toMatchObject({
      interval: 180, inline: { items: [], checkIntervalSeconds: 180 },
    });
    const readWatches = () => withDbAccessContext(SYSTEM_CTX, () => db.select()
      .from(configPolicyMonitoringWatches)
      .where(inArray(configPolicyMonitoringWatches.id, watches.map((watch) => watch.id)))
      .orderBy(configPolicyMonitoringWatches.name));
    expect(await readWatches()).toEqual(watches);
    await replayMigration(MIGRATION);
    expect(await settingsLinkFor(policyId)).toEqual(rows);
    expect(await readWatches()).toEqual(watches);
  });

  it('preserves settings and watch identities when re-keying, including retired history', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { policyId, monitoringLinkId } = await policyWithMonitoringLink(org.id, 75, false);
    const [before] = await settingsLinkFor(policyId);
    const [watch] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(configPolicyMonitoringWatches)
      .values({ settingsId: before!.settingsId, watchType: 'service', name: 'historical-service', retiredAt: new Date(), retiredReason: 'converted' })
      .returning());

    await replayMigration(MIGRATION);

    expect((await settingsLinkFor(policyId))[0]).toMatchObject({ settingsId: before!.settingsId, interval: 75, featureType: 'monitors' });
    await withDbAccessContext(SYSTEM_CTX, async () => {
      expect(await db.select().from(configPolicyMonitoringWatches).where(eq(configPolicyMonitoringWatches.id, watch!.id))).toEqual([watch]);
      expect(await db.select().from(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.id, monitoringLinkId))).toHaveLength(1);
    });
  });

  it.each(['cumulative', 'replace'] as const)('empty %s Save and removal retain retired watch history', async (inheritance) => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { policyId } = await policyWithMonitoringLink(org.id, 60, false);
    await replayMigration(MIGRATION);
    await withDbAccessContext(SYSTEM_CTX, async () => {
      const [link] = await db.select().from(configPolicyFeatureLinks).where(and(
        eq(configPolicyFeatureLinks.configPolicyId, policyId),
        eq(configPolicyFeatureLinks.featureType, 'monitors')));
      const [settings] = await db.select().from(configPolicyMonitoringSettings)
        .where(eq(configPolicyMonitoringSettings.featureLinkId, link!.id));
      const [watch] = await db.insert(configPolicyMonitoringWatches).values({
        settingsId: settings!.id, watchType: 'service', name: 'Spooler',
        retiredAt: new Date(), retiredReason: 'operator',
      }).returning();
      await updateFeatureLink(link!.id, {
        inlineSettings: { items: [], inheritance, checkIntervalSeconds: 45 },
      }, policyId);
      await removeFeatureLink(link!.id, policyId);
      expect(await db.select().from(configPolicyMonitoringWatches)
        .where(eq(configPolicyMonitoringWatches.id, watch!.id))).toEqual([watch]);
      expect(await db.select().from(configPolicyMonitoringSettings)
        .where(eq(configPolicyMonitoringSettings.id, settings!.id)))
        .toEqual([expect.objectContaining({ id: settings!.id, checkIntervalSeconds: 45 })]);
      const [saved] = await db.select().from(configPolicyFeatureLinks)
        .where(eq(configPolicyFeatureLinks.id, link!.id));
      expect(saved!.inlineSettings).toMatchObject({ items: [], inheritance, checkIntervalSeconds: 45 });
    });
  });
});
