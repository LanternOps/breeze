/**
 * W05d Task 4 — the boot sweep converts a convertible inline rule, retires an
 * unconvertible one with a reason, records the partner marker, and the count
 * check reads zero afterwards. Runs W05c1's real converter against real RLS:
 * a system context per partner, never a bare pool.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, SYSTEM_DB_ACCESS_CONTEXT } from '../../db';
import { configPolicyAlertRules, configPolicyMonitoringSettings, configPolicyMonitoringWatches, configPolicyFeatureLinks, configPolicyMonitors, configurationPolicies, monitorDefinitions, monitorConversions, partners, users } from '../../db/schema';
import { runLegacyAlertingRetirement, checkLegacyAlertingRetired } from '../../services/monitors/conversion/retirementSweep';
import { revertConversion } from '../../services/monitors/conversion/convert';
import { readRetirementReport } from '../../services/monitors/conversion/loadSources';
import { createSystemAuthContext } from '../../services/featureConfigResolver';
import type { AuthContext } from '../../middleware/auth';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM_CTX = SYSTEM_DB_ACCESS_CONTEXT;
const policyIds: string[] = [];
beforeEach(() => vi.stubEnv('BREEZE_LEGACY_ALERTING_SWEEP', 'true'));
afterEach(() => vi.unstubAllEnvs());
afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const id of policyIds.splice(0)) await db.delete(configurationPolicies).where(eq(configurationPolicies.id, id));
  });
});

describe('legacy alerting retirement sweep', () => {
  it('counts an unretired watch under a re-keyed monitors link even with the sweep disabled', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await withDbAccessContext(SYSTEM_CTX, async () => {
      const [policy] = await db.insert(configurationPolicies).values({ orgId: org.id, name: 'Watch count', status: 'active' }).returning();
      policyIds.push(policy!.id);
      const [link] = await db.insert(configPolicyFeatureLinks).values({ configPolicyId: policy!.id, featureType: 'monitors' }).returning();
      const [settings] = await db.insert(configPolicyMonitoringSettings).values({ featureLinkId: link!.id }).returning();
      await db.insert(configPolicyMonitoringWatches).values({ settingsId: settings!.id, watchType: 'service', name: 'example-service' });
    });
    vi.stubEnv('BREEZE_LEGACY_ALERTING_SWEEP', 'false');
    expect(await runLegacyAlertingRetirement()).toEqual({ partners: 0, converted: 0, retired: 0, failed: 0,
      remaining: { configPolicyAlertRules: 0, configPolicyMonitoringWatches: 1 } });
  });
  it('converts, retires with reason, writes the marker, and the count check is zero', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { policyId, convertibleId, customId } = await withDbAccessContext(SYSTEM_CTX, async () => {
      const [policy] = await db.insert(configurationPolicies).values({ orgId: org.id, name: 'W05d sweep', status: 'active' }).returning();
      policyIds.push(policy!.id);
      const [link] = await db.insert(configPolicyFeatureLinks).values({ configPolicyId: policy!.id, featureType: 'alert_rule', inlineSettings: { items: [] } }).returning();
      const [a] = await db.insert(configPolicyAlertRules).values({
        featureLinkId: link!.id, name: 'CPU high', severity: 'high', cooldownMinutes: 5, autoResolve: true,
        conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80, durationMinutes: 5 }],
        titleTemplate: 't', messageTemplate: 'm', sortOrder: 0,
      }).returning();
      const [b] = await db.insert(configPolicyAlertRules).values({
        featureLinkId: link!.id, name: 'Custom thing', severity: 'low', cooldownMinutes: 5, autoResolve: false,
        conditions: [{ type: 'custom', script: 'x' }], titleTemplate: 't', messageTemplate: 'm', sortOrder: 1,
      }).returning();
      return { policyId: policy!.id, convertibleId: a!.id, customId: b!.id };
    });

    expect(await checkLegacyAlertingRetired()).toEqual({ configPolicyAlertRules: 2, configPolicyMonitoringWatches: 0 });

    // No fabricated users: a clean fixture has no synthetic zero-UUID actor.
    await withDbAccessContext(SYSTEM_CTX, async () => {
      expect(await db.select().from(users).where(eq(users.id, '00000000-0000-0000-0000-000000000000'))).toEqual([]);
    });
    const run = await runLegacyAlertingRetirement();
    expect(run.failed).toBe(0);
    expect(run.converted).toBeGreaterThanOrEqual(1);
    expect(run.retired).toBeGreaterThanOrEqual(1);

    const original = await withDbAccessContext(SYSTEM_CTX, async () => {
      const [conv] = await db.select().from(configPolicyAlertRules).where(eq(configPolicyAlertRules.id, convertibleId));
      expect(conv!.retiredAt).not.toBeNull();
      // C1 records successful conversion as operator retirement plus monitor provenance.
      expect(conv!.retiredReason).toBe('operator');
      expect(conv!.convertedToMonitorId).not.toBeNull();
      const [attach] = await db.select().from(configPolicyMonitors).where(eq(configPolicyMonitors.monitorId, conv!.convertedToMonitorId!));
      expect(attach).toBeDefined();
      const [def] = await db.select().from(monitorDefinitions).where(eq(monitorDefinitions.id, conv!.convertedToMonitorId!));
      expect(def!.kind).toBe('cpu');
      expect(def!.orgId).toBe(org.id);
      expect(def!.createdBy).toBeNull();
      const ledgers = await db.select().from(monitorConversions)
        .where(eq(monitorConversions.sourceId, convertibleId));
      expect(ledgers).toHaveLength(1);
      expect(ledgers[0]!.convertedBy).toBeNull();

      const [cust] = await db.select().from(configPolicyAlertRules).where(eq(configPolicyAlertRules.id, customId));
      expect(cust!.retiredAt).not.toBeNull();
      expect(cust!.retiredReason).toBe('unconvertible:custom_condition');
      expect(cust!.convertedToMonitorId).toBeNull();

      const [p] = await db.select({ settings: partners.settings }).from(partners).where(eq(partners.id, partner.id));
      const marker = (p!.settings as { legacyAlertingRetirement: { version: number; unconvertible: unknown[] } }).legacyAlertingRetirement;
      expect(marker.version).toBe(1);
      expect(marker.unconvertible).toEqual([expect.objectContaining({ sourceId: customId })]);
      return { source: conv, definition: def, ledger: ledgers[0], attachment: attach };
    });
    // Revert owns its serializable transaction; never nest it in the snapshot context.
    await expect(revertConversion(original.ledger!.id, createSystemAuthContext()))
      .rejects.toMatchObject({ code: 'conversion_revert_unavailable' });
    await withDbAccessContext(SYSTEM_CTX, async () => {
      const [source] = await db.select().from(configPolicyAlertRules).where(eq(configPolicyAlertRules.id, convertibleId));
      const [definition] = await db.select().from(monitorDefinitions).where(eq(monitorDefinitions.id, original.definition!.id));
      const [ledger] = await db.select().from(monitorConversions).where(eq(monitorConversions.id, original.ledger!.id));
      const [attachment] = await db.select().from(configPolicyMonitors).where(eq(configPolicyMonitors.id, original.attachment!.id));
      expect({ source, definition, ledger, attachment }).toEqual(original);
    });

    expect(await checkLegacyAlertingRetired()).toEqual({ configPolicyAlertRules: 0, configPolicyMonitoringWatches: 0 });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const orgAuth: AuthContext = { ...createSystemAuthContext(), scope: 'organization',
      orgId: org.id, partnerId: partner.id, accessibleOrgIds: [org.id],
      canAccessOrg: id => id === org.id,
      orgCondition: column => eq(column, org.id),
    };
    await withDbAccessContext({ scope: 'organization', orgId: org.id,
      accessibleOrgIds: [org.id], currentPartnerId: partner.id }, async () => {
      const report = await readRetirementReport(orgAuth, org.id);
      expect(report.unconvertible).toEqual([expect.objectContaining({
        sourceId: customId, policyId, policyName: 'W05d sweep', reason: 'unconvertible:custom_condition',
      })]);
      expect(report.sweep).toBeNull();
      await expect(readRetirementReport(orgAuth, otherOrg.id)).rejects.toThrow('Organization access denied');
    });
    await withDbAccessContext(SYSTEM_CTX, async () => {
      const report = await readRetirementReport(createSystemAuthContext(), otherOrg.id);
      expect(report.unconvertible).toEqual([]);
      expect(report.sweep).toBeNull();
      const partnerAuth: AuthContext = { ...createSystemAuthContext(), scope: 'partner',
        partnerId: partner.id, partnerOrgAccess: 'all',
        orgCondition: column => eq(column, org.id),
      };
      expect((await readRetirementReport(partnerAuth, null)).sweep).toEqual({
        sweptAt: expect.any(String), converted: expect.any(Number), retired: expect.any(Number),
      });
      expect((await readRetirementReport({ ...partnerAuth, partnerOrgAccess: 'selected' }, null)).sweep).toBeNull();
    });
    expect(policyId).toBeTruthy();
    expect(await runLegacyAlertingRetirement()).toMatchObject({ partners: 0, converted: 0, retired: 0, failed: 0 });
  });
});
