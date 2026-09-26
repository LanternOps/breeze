import './setup';
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { alerts, alertRules, alertTemplates, devices, monitorDefinitions, monitorConversions, monitorConversionOutputs, networkMonitors, networkMonitorAlertRules, networkMonitorResults } from '../../db/schema';
import { createSystemAuthContext } from '../../services/featureConfigResolver';
import { listConversionLedger, retireSource, revertConversion } from '../../services/monitors/conversion';
import { carryNetworkAlerts } from '../../services/monitors/conversion/networkHistory';
import { OPEN_ALERT_STATUSES } from '../../services/monitors/conversion/loadSources';
import { createOrganization, createPartner, createSite } from './db-utils';

const scoped = <T>(orgId: string, action: () => Promise<T>) => withDbAccessContext({
  scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null,
}, action);

async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const assetId = randomUUID();
  await scoped(org.id, () => db.execute(sql`
    INSERT INTO discovered_assets (id, org_id, site_id, ip_address)
    VALUES (${assetId}::uuid, ${org.id}::uuid, ${site.id}::uuid, '192.0.2.1')
  `));
  return { orgId: org.id, partnerId: partner.id, siteId: site.id, assetId };
}

describe('network check compiled-row asset ownership', () => {
  it('accepts a same-org asset and retains the existing site binding guard', async () => {
    const owner = await fixture();
    await scoped(owner.orgId, async () => {
      const rows = await db.execute(sql`
        INSERT INTO network_monitors (org_id, asset_id, site_id, name, monitor_type, target)
        VALUES (${owner.orgId}::uuid, ${owner.assetId}::uuid, ${owner.siteId}::uuid,
          'Owned check', 'icmp_ping', '192.0.2.1')
        RETURNING asset_id, org_id, site_id
      `);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ asset_id: owner.assetId, org_id: owner.orgId, site_id: owner.siteId });
    });
  });

  it('rejects a foreign-org asset through the existing ownership trigger', async () => {
    const owner = await fixture();
    const foreign = await fixture();
    await expect(scoped(owner.orgId, () => db.execute(sql`
      INSERT INTO network_monitors (org_id, asset_id, name, monitor_type, target)
      VALUES (${owner.orgId}::uuid, ${foreign.assetId}::uuid, 'Foreign check', 'icmp_ping', '192.0.2.1')
    `))).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('rejects a partner-owned row naming an asset even when the asset is visible', async () => {
    const owner = await fixture();
    await expect(withDbAccessContext({
      scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
    }, () => db.execute(sql`
      INSERT INTO network_monitors (partner_id, asset_id, name, monitor_type, target)
      VALUES (${owner.partnerId}::uuid, ${owner.assetId}::uuid, 'Partner check', 'icmp_ping', '192.0.2.1')
    `))).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('installs the asset/org FK as deferrable and initially immediate', async () => {
    const owner = await fixture();
    await scoped(owner.orgId, async () => {
      const constraints = await db.execute(sql`
        SELECT condeferrable, condeferred, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'network_monitors'::regclass AND conname = 'network_monitors_asset_org_fk'
      `);
      expect(constraints).toHaveLength(1);
      expect(constraints[0]).toMatchObject({ condeferrable: true, condeferred: false });
      expect(constraints[0]?.definition).toContain('FOREIGN KEY (asset_id, org_id)');
      expect(constraints[0]?.definition).toContain('REFERENCES discovered_assets(id, org_id)');
      await db.execute(sql`SET CONSTRAINTS network_monitors_asset_org_fk DEFERRED`);
      await db.execute(sql`SET CONSTRAINTS network_monitors_asset_org_fk IMMEDIATE`);
    });
  });
});


describe('network check retirement history', () => {
  it('records a named zero-output retirement and restores the source and rules without changing history', async () => {
    const owner = await fixture();
    const original = await scoped(owner.orgId, async () => {
      const [source] = await db.insert(networkMonitors).values({
        orgId: owner.orgId, assetId: owner.assetId, siteId: owner.siteId,
        name: 'Branch router ping', monitorType: 'icmp_ping', target: '192.0.2.1',
        config: { packetSize: 128 }, pollingInterval: 90, timeout: 10,
      }).returning();
      const rules = await db.insert(networkMonitorAlertRules).values([
        { monitorId: source!.id, condition: 'status_down', severity: 'high', isActive: true },
        { monitorId: source!.id, condition: 'response_time', threshold: '500', severity: 'medium', isActive: false },
      ]).returning();
      const [device] = await db.insert(devices).values({
        orgId: owner.orgId, siteId: owner.siteId, agentId: `agent-${randomUUID()}`,
        hostname: 'network-history', osType: 'linux', osVersion: '1.0', architecture: 'amd64',
        agentVersion: '1.0.0', status: 'offline',
      }).returning();
      const history = await db.insert(alerts).values([...OPEN_ALERT_STATUSES, 'resolved' as const, 'dismissed' as const].map(status => ({
        orgId: owner.orgId, deviceId: device!.id, severity: 'high' as const, status,
        title: 'Router unreachable', context: { source: 'network_monitor', monitorId: source!.id, alertRuleId: rules[0]!.id },
        resolvedAt: status === 'resolved' ? new Date('2026-01-01T00:00:00Z') : null,
      }))).returning();
      const [result] = await db.insert(networkMonitorResults).values({
        orgId: owner.orgId, monitorId: source!.id, deviceId: device!.id, status: 'offline', error: 'timeout',
      }).returning();
      return { source: source!, rules, history, result: result! };
    });
    const auth = createSystemAuthContext();
    // Transaction-owning public services must run outside ambient request contexts.
    const { conversionId } = await retireSource('network_monitors', original.source.id, 'operator', auth);
    await scoped(owner.orgId, async () => {
      const [entry] = await db.select().from(monitorConversions).where(eq(monitorConversions.id, conversionId));
      expect(entry).toMatchObject({ convertedBy: null, sourceState: { name: original.source.name } });
      expect(await db.select().from(monitorConversionOutputs).where(eq(monitorConversionOutputs.conversionId, conversionId))).toEqual([]);
      const ledger = await listConversionLedger({ orgId: owner.orgId }, auth);
      expect(ledger.items).toEqual([expect.objectContaining({ id: conversionId, sourceName: original.source.name, outputs: [], revertable: true })]);
      expect(ledger.nextCursor).toBeNull();
      const [retired] = await db.select().from(networkMonitors).where(eq(networkMonitors.id, original.source.id));
      expect(retired).toMatchObject({ isActive: false, retiredReason: 'operator', retiredAt: expect.any(Date) });
      const rules = await db.select().from(networkMonitorAlertRules).where(eq(networkMonitorAlertRules.monitorId, original.source.id));
      expect(rules).toHaveLength(2);
      for (const rule of rules) expect(rule).toMatchObject({ retiredReason: 'operator', retiredAt: expect.any(Date) });
      expect(await db.select().from(alerts).where(eq(alerts.orgId, owner.orgId)).orderBy(alerts.id))
        .toEqual([...original.history].sort((a, b) => a.id.localeCompare(b.id)));
    });

    await revertConversion(conversionId, auth);
    await scoped(owner.orgId, async () => {
      const [restored] = await db.select().from(networkMonitors).where(eq(networkMonitors.id, original.source.id));
      expect(restored).toEqual({ ...original.source, updatedAt: expect.any(Date) });
      expect(await db.select().from(networkMonitorAlertRules).where(eq(networkMonitorAlertRules.monitorId, original.source.id)).orderBy(networkMonitorAlertRules.id))
        .toEqual([...original.rules].sort((a, b) => a.id.localeCompare(b.id)));
      expect(await db.select().from(alerts).where(eq(alerts.orgId, owner.orgId)).orderBy(alerts.id))
        .toEqual([...original.history].sort((a, b) => a.id.localeCompare(b.id)));
      expect(await db.select().from(networkMonitorResults).where(eq(networkMonitorResults.monitorId, original.source.id))).toEqual([original.result]);
      const ledger = await listConversionLedger({ orgId: owner.orgId }, auth);
      expect(ledger.items[0]).toMatchObject({ id: conversionId, revertable: false, revertedAt: expect.any(String) });
    });
  });

  it('refuses an invisible source before writing a ledger row', async () => {
    const owner = await fixture();
    const foreign = await fixture();
    const [source] = await scoped(foreign.orgId, () => db.insert(networkMonitors).values({
      orgId: foreign.orgId, name: 'Private router', monitorType: 'icmp_ping', target: '192.0.2.2',
    }).returning());
    const auth = { ...createSystemAuthContext(), scope: 'organization' as const,
      orgId: owner.orgId, accessibleOrgIds: [owner.orgId], partnerId: owner.partnerId,
      canAccessOrg: (id: string) => id === owner.orgId };
    await expect(retireSource('network_monitors', source!.id, 'operator', auth)).rejects.toMatchObject({ status: 404 });
    await scoped(foreign.orgId, async () => {
      expect(await db.select().from(monitorConversions).where(eq(monitorConversions.sourceId, source!.id))).toEqual([]);
      const [unchanged] = await db.select().from(networkMonitors).where(eq(networkMonitors.id, source!.id));
      expect(unchanged).toEqual(source);
    });
  });
});


it('carries coexisting open legacy alerts without violating compiled-rule subject uniqueness', async () => {
  const owner = await fixture();
  await scoped(owner.orgId, async () => {
    const [source] = await db.insert(networkMonitors).values({
      orgId: owner.orgId, name: 'Router with several legacy alerts', monitorType: 'icmp_ping', target: '192.0.2.1',
    }).returning();
    const [device] = await db.insert(devices).values({
      orgId: owner.orgId, siteId: owner.siteId, agentId: `agent-${randomUUID()}`,
      hostname: 'network-carry', osType: 'linux', osVersion: '1.0', architecture: 'amd64',
      agentVersion: '1.0.0', status: 'offline',
    }).returning();
    const [definition] = await db.insert(monitorDefinitions).values({
      orgId: owner.orgId, name: source!.name, kind: 'network_check', severity: 'high',
      condition: { type: 'network_check', checkType: 'icmp_ping', target: source!.target },
    }).returning();
    const [template] = await db.insert(alertTemplates).values({
      orgId: owner.orgId, name: 'Compiled router check', conditions: definition!.condition,
      severity: 'high', titleTemplate: 'Router unreachable', messageTemplate: 'Router unreachable',
      managedByMonitorId: definition!.id,
    }).returning();
    const [rule] = await db.insert(alertRules).values({
      orgId: owner.orgId, templateId: template!.id, name: template!.name,
      targetType: 'monitor', targetId: definition!.id, managedByMonitorId: definition!.id,
    }).returning();
    await db.update(monitorDefinitions).set({ compiledAlertRuleId: rule!.id, compiledAlertTemplateId: template!.id })
      .where(eq(monitorDefinitions.id, definition!.id));
    const original = await db.insert(alerts).values(OPEN_ALERT_STATUSES.map(status => ({
      orgId: owner.orgId, deviceId: device!.id, status, severity: 'high' as const,
      title: `Router ${status}`, subjectKey: null,
      context: { source: 'network_monitor', monitorId: source!.id, alertRuleId: randomUUID() },
    }))).returning();

    const refs = await carryNetworkAlerts(db, source!, { ...definition!, compiledAlertRuleId: rule!.id });
    expect(refs).toHaveLength(OPEN_ALERT_STATUSES.length);
    for (const alert of original) expect(refs).toContainEqual({
      id: alert.id, ruleId: null, configPolicyId: null, monitorId: null, subjectKey: null, context: alert.context,
    });
    const carried = await db.select().from(alerts).where(eq(alerts.orgId, owner.orgId));
    expect(carried).toHaveLength(original.length);
    expect(carried.filter(alert => alert.subjectKey === null)).toHaveLength(1);
    expect(new Set(carried.map(alert => alert.subjectKey)).size).toBe(original.length);
    for (const alert of carried) {
      expect(alert).toMatchObject({
        ruleId: rule!.id, monitorId: definition!.id, configPolicyId: null, resolvedAt: null,
        status: original.find(item => item.id === alert.id)!.status,
        context: { convertedFrom: { sourceTable: 'network_monitors', sourceId: source!.id } },
      });
    }
  });
});
