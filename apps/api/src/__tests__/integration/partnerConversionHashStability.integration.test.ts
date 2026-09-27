/**
 * v0.118.0 US incident: the boot retirement sweep computes the partner preview
 * hash in previewPartnerConversion, then recomputes it in convertPartnerLegacy
 * and refuses on any difference (`preview_stale`). The hash covered whole
 * `devices` rows, so an agent heartbeat (last_seen_at, partner_export_updated_at,
 * status …) landing between the two snapshots failed the partner on every retry.
 * The template-group hash also read routes/channels/escalations/policies/
 * assignments/links/definitions UNSCOPED, so under the sweep's system scope any
 * write by any other tenant had the same effect.
 *
 * Hash inputs must be the conversion-relevant state only: telemetry and other
 * tenants' rows must not invalidate a preview; a real input change still must.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, SYSTEM_DB_ACCESS_CONTEXT } from '../../db';
import {
  alertRules, alertTemplates, configPolicyAlertRules, configPolicyAssignments, configPolicyFeatureLinks,
  configurationPolicies, devices, notificationChannels,
} from '../../db/schema';
import { createSystemAuthContext } from '../../services/featureConfigResolver';
import { convertPartnerLegacy, previewPartnerConversion } from '../../services/monitors/conversion';
import { createOrganization, createPartner, createSite } from './db-utils';

const sys = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_DB_ACCESS_CONTEXT, fn);
const opts = { sources: 'retired_runtime_only' as const };

async function fleet() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await sys(async () => (await db.insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: `agent-${randomUUID()}`, hostname: 'hash-stability',
    osType: 'windows', osVersion: '10', architecture: 'amd64', agentVersion: '1.0.0',
    status: 'online', deviceRole: 'server', lastSeenAt: new Date(Date.now() - 120_000),
  }).returning())[0]!);
  return { partner, org, site, device };
}

async function inlinePolicy(orgId: string) {
  return sys(async () => {
    const [policy] = await db.insert(configurationPolicies).values({ orgId, name: 'Hash stability policy', status: 'active' }).returning();
    const [link] = await db.insert(configPolicyFeatureLinks).values({ configPolicyId: policy!.id, featureType: 'alert_rule', inlineSettings: { items: [] } }).returning();
    const [rule] = await db.insert(configPolicyAlertRules).values({
      featureLinkId: link!.id, name: 'CPU high', severity: 'high', cooldownMinutes: 5, autoResolve: true,
      conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80, durationMinutes: 5 }],
      titleTemplate: 't', messageTemplate: 'm', sortOrder: 0,
    }).returning();
    await db.insert(configPolicyAssignments).values({ configPolicyId: policy!.id, level: 'organization', targetId: orgId });
    return { policy: policy!, link: link!, rule: rule! };
  });
}

async function templateGroup(orgId: string) {
  return sys(async () => {
    const [template] = await db.insert(alertTemplates).values({
      orgId, name: `Hash stability template ${randomUUID()}`, severity: 'high', titleTemplate: 't', messageTemplate: 'm',
      conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 90, durationMinutes: 5 }],
    }).returning();
    const [rule] = await db.insert(alertRules).values({
      orgId, templateId: template!.id, name: 'Standalone CPU', targetType: 'org', targetId: orgId,
    }).returning();
    return { template: template!, rule: rule! };
  });
}

/** What an agent heartbeat does to the device row between preview and convert. */
async function heartbeat(deviceId: string) {
  await sys(() => db.update(devices).set({ lastSeenAt: new Date(), status: 'online', lastUser: 'someone' }).where(eq(devices.id, deviceId)));
}

/** Unrelated write by another tenant between preview and convert. */
async function otherTenantWrite() {
  const other = await createPartner();
  await sys(() => db.insert(notificationChannels).values({ partnerId: other.id, name: `other ${randomUUID()}`, type: 'webhook' }));
}

describe('partner conversion hash stability (sweep preview → convert)', () => {
  it('an inline-rule policy converts after a device heartbeat between preview and convert', async () => {
    const f = await fleet();
    const { rule } = await inlinePolicy(f.org.id);
    const auth = createSystemAuthContext();
    const preview = await previewPartnerConversion(f.partner.id, auth, opts);
    await heartbeat(f.device.id);
    const result = await convertPartnerLegacy(f.partner.id, preview.previewHash, auth, opts);
    expect(result.converted).toBeGreaterThanOrEqual(1);
    const [after] = await sys(() => db.select().from(configPolicyAlertRules).where(eq(configPolicyAlertRules.id, rule.id)));
    expect(after!.convertedToMonitorId).not.toBeNull();
  });

  it.each([
    ['a device heartbeat', (f: Awaited<ReturnType<typeof fleet>>) => heartbeat(f.device.id)],
    ['another tenant\'s write', () => otherTenantWrite()],
  ] as const)('a standalone template group converts after %s between preview and convert', async (_label, between) => {
    const f = await fleet();
    const { rule } = await templateGroup(f.org.id);
    const auth = createSystemAuthContext();
    const preview = await previewPartnerConversion(f.partner.id, auth, opts);
    await between(f);
    const result = await convertPartnerLegacy(f.partner.id, preview.previewHash, auth, opts);
    expect(result.converted).toBeGreaterThanOrEqual(1);
    const [after] = await sys(() => db.select().from(alertRules).where(eq(alertRules.id, rule.id)));
    expect(after!.retiredAt).not.toBeNull();
  });

  it('still refuses when a conversion-relevant input changed (control)', async () => {
    const f = await fleet();
    await inlinePolicy(f.org.id);
    await templateGroup(f.org.id);
    const auth = createSystemAuthContext();
    const preview = await previewPartnerConversion(f.partner.id, auth, opts);
    // Device role drives role-filtered assignment targeting.
    await sys(() => db.update(devices).set({ deviceRole: 'workstation' }).where(eq(devices.id, f.device.id)));
    await expect(convertPartnerLegacy(f.partner.id, preview.previewHash, auth, opts))
      .rejects.toMatchObject({ code: 'preview_stale' });
  });

  it('still refuses when the partner\'s own delivery inputs changed (control)', async () => {
    const f = await fleet();
    await templateGroup(f.org.id);
    const auth = createSystemAuthContext();
    const preview = await previewPartnerConversion(f.partner.id, auth, opts);
    await sys(() => db.insert(notificationChannels).values({ orgId: f.org.id, name: `own ${randomUUID()}`, type: 'webhook' }));
    await expect(convertPartnerLegacy(f.partner.id, preview.previewHash, auth, opts))
      .rejects.toMatchObject({ code: 'preview_stale' });
  });
});
