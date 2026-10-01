/**
 * "Convert to monitor" on one legacy alert rule
 * (POST /monitor-definitions/convert-from-rule/:ruleId) answered 500 on every
 * call: the route held the auth middleware's ambient request transaction while
 * the template-group converter opened its own serializable one, and
 * `assertIsolationNotNested` refused the second pooled connection. The
 * platform-admin partner conversion converted the same rule fine because its
 * route is self-managed (D30).
 *
 * Driven through the REAL authMiddleware at the production mount path
 * (`/api/v1/...`), so the SELF_MANAGED_DB_CONTEXT_ROUTES match is exercised,
 * and the result is compared row for row with what the admin path writes for
 * an identical legacy template group.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

// The route is MFA step-up gated; the integration client mints mfa:false
// tokens. Precedent: accountingPendingTenantOwedDeletes.integration.test.ts.
vi.mock('../../routes/auth/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/auth/schemas')>();
  return { ...actual, ENABLE_2FA: false };
});

import { db, SYSTEM_DB_ACCESS_CONTEXT, withDbAccessContext } from '../../db';
import {
  alertRules, alertTemplates, configPolicyAssignments, configPolicyFeatureLinks, configPolicyMonitors, configurationPolicies, devices,
  monitorConversionOutputs, monitorConversions, monitorDefinitions,
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { adminAuthForPartner } from '../../routes/admin/monitorConversion';
import { monitorDefinitionRoutes } from '../../routes/monitorDefinitions';
import { convertPartnerLegacy, previewPartnerConversion } from '../../services/monitors/conversion';
import { createIntegrationTestClient, createOrganization, createPartner, createSite, createUser } from './db-utils';

const sys = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_DB_ACCESS_CONTEXT, fn);

function app() {
  const result = new Hono();
  result.route('/api/v1/monitor-definitions', monitorDefinitionRoutes);
  return result;
}

/** One device and one standalone legacy template group (template + org-targeted rule) in `orgId`. */
async function seedLegacyGroup(orgId: string, siteId: string) {
  return sys(async () => {
    await db.insert(devices).values({
      orgId, siteId, agentId: `agent-${randomUUID()}`, hostname: 'convert-from-rule',
      osType: 'windows', osVersion: '10', architecture: 'amd64', agentVersion: '1.0.0',
      status: 'online', deviceRole: 'server',
    });
    const [template] = await db.insert(alertTemplates).values({
      orgId, name: 'Legacy CPU template', severity: 'high', titleTemplate: 't', messageTemplate: 'm',
      conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 90, durationMinutes: 5 }],
    }).returning();
    const [rule] = await db.insert(alertRules).values({
      orgId, templateId: template!.id, name: 'Standalone CPU', targetType: 'org', targetId: orgId,
    }).returning();
    return { template: template!, rule: rule! };
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Who ran it differs by design (a user vs the system actor), and hashes cover ids. */
const DROPPED = new Set(['createdBy', 'convertedBy', 'updatedBy', 'assignedBy', 'previewHash', 'compiledHash', 'createdAt', 'updatedAt', 'convertedAt', 'compiledAt']);

/**
 * Canonical form of a result set: every UUID becomes `#n` in order of first
 * appearance (keys sorted, so the order is deterministic), timestamps become
 * presence flags, actor and hash fields are dropped. Two conversions of the
 * same legacy group in different tenants are then deep-equal exactly when
 * they wrote the same rows.
 */
function canonicalize(value: unknown, ids = new Map<string, string>()): unknown {
  if (value instanceof Date) return 'timestamp';
  if (typeof value === 'string') {
    if (!UUID.test(value)) return value;
    if (!ids.has(value)) ids.set(value, `#${ids.size}`);
    return ids.get(value);
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, ids));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (DROPPED.has(key)) continue;
      out[key] = canonicalize((value as Record<string, unknown>)[key], ids);
    }
    return out;
  }
  return value;
}

/** Everything a conversion of this group wrote, rooted at the org so ids line up across tenants. */
async function conversionRows(orgId: string, ruleId: string, templateId: string) {
  return sys(async () => {
    const [rule] = await db.select().from(alertRules).where(eq(alertRules.id, ruleId));
    const [template] = await db.select().from(alertTemplates).where(eq(alertTemplates.id, templateId));
    const ledger = await db.select().from(monitorConversions).where(eq(monitorConversions.orgId, orgId)).orderBy(monitorConversions.sourceTable);
    const outputs = await db.select().from(monitorConversionOutputs).where(eq(monitorConversionOutputs.orgId, orgId)).orderBy(monitorConversionOutputs.role);
    const monitors = await db.select().from(monitorDefinitions).where(eq(monitorDefinitions.orgId, orgId));
    const policies = await db.select().from(configurationPolicies).where(eq(configurationPolicies.orgId, orgId));
    const policyIds = policies.map((policy) => policy.id);
    const assignments = policyIds.length
      ? await db.select().from(configPolicyAssignments).where(eq(configPolicyAssignments.configPolicyId, policyIds[0]!))
      : [];
    const links = policyIds.length
      ? await db.select().from(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.configPolicyId, policyIds[0]!)).orderBy(configPolicyFeatureLinks.featureType)
      : [];
    const attachments = links.length
      ? await db.select().from(configPolicyMonitors).where(inArray(configPolicyMonitors.featureLinkId, links.map((link) => link.id)))
      : [];
    return { orgId, rule, template, ledger, outputs, monitors, policies, assignments, links, attachments };
  });
}

describe('POST /api/v1/monitor-definitions/convert-from-rule/:ruleId (real DB, real auth)', () => {
  it('converts a legacy rule (no nested transaction 500) and writes exactly what the admin partner conversion writes', async () => {
    // The per-rule path, as a tenant user through the production route.
    const client = await createIntegrationTestClient(app());
    const { env } = client;
    const viaRoute = await seedLegacyGroup(env.organization.id, env.site.id);

    const res = await client.post(`/api/v1/monitor-definitions/convert-from-rule/${viaRoute.rule.id}`);
    const body = await res.json() as { data?: { monitorId: string; configPolicyId: string }; error?: string };
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(body.data).toEqual({ monitorId: expect.stringMatching(UUID), configPolicyId: expect.stringMatching(UUID) });

    const routeRows = await conversionRows(env.organization.id, viaRoute.rule.id, viaRoute.template.id);
    expect(routeRows.rule!.retiredAt).not.toBeNull();
    expect(routeRows.rule!.convertedToMonitorId).toBe(body.data!.monitorId);
    expect(routeRows.template!.retiredAt).not.toBeNull();
    expect(routeRows.monitors.map((monitor) => monitor.id)).toEqual([body.data!.monitorId]);
    expect(routeRows.policies.map((policy) => policy.id)).toEqual([body.data!.configPolicyId]);
    expect(routeRows.ledger.length).toBeGreaterThan(0);

    // The admin path, for an identical group in another partner.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const viaAdmin = await seedLegacyGroup(org.id, site.id);
    const admin = await createUser({ partnerId: partner.id, orgId: null });
    const adminAuth = adminAuthForPartner({ user: { id: admin.id, email: admin.email, name: admin.name, isPlatformAdmin: true } } as AuthContext, partner.id);
    const preview = await previewPartnerConversion(partner.id, adminAuth);
    const converted = await convertPartnerLegacy(partner.id, preview.previewHash, adminAuth);
    expect(converted.converted).toBeGreaterThanOrEqual(1);
    const adminRows = await conversionRows(org.id, viaAdmin.rule.id, viaAdmin.template.id);

    expect(canonicalize(routeRows)).toEqual(canonicalize(adminRows));
  });

  it('still refuses, and leaves untouched, a rule in another tenant now that the route owns its DB context', async () => {
    const client = await createIntegrationTestClient(app());
    const partner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const otherSite = await createSite({ orgId: otherOrg.id });
    const foreign = await seedLegacyGroup(otherOrg.id, otherSite.id);

    const res = await client.post(`/api/v1/monitor-definitions/convert-from-rule/${foreign.rule.id}`);
    expect(res.status).toBe(404);
    const [rule] = await sys(() => db.select().from(alertRules).where(eq(alertRules.id, foreign.rule.id)));
    expect(rule!.retiredAt).toBeNull();
  });
});
