/**
 * Integration test — org-only AI reads, cross-org denial
 *
 * These tools have no site axis in their schema (backup/DR/C2C, security/
 * compliance, monitoring and devices/integrations/scripts families whose
 * underlying tables carry only `org_id` / `partner_id`). An org-only tool
 * asserts case
 * (iii) only — a cross-org id/row is not visible to a caller scoped to a
 * different org — plus a same-org positive control so the denial is not
 * vacuous.
 *
 * Every handler call goes through `withDbAccessContext` as the real,
 * unprivileged `breeze_app` role, so org-axis RLS is genuinely enforced (not
 * just the handler's own `orgCondition`, which several of these tools build
 * as `() => undefined` in this fixture and rely on RLS to narrow — the same
 * shape `aiToolsAuditDetailsSiteScope.integration.test.ts` uses).
 *
 * Covers:
 *   query_c2c_connections (+ clientId masking), query_c2c_jobs,
 *   search_c2c_items, query_compliance_policies, list_monitors, get_monitor,
 *   query_psa_status, query_webhooks, list_scripts, search_script_library.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { withDbAccessContext } from '../../db';
import {
  c2cConnections,
  c2cBackupConfigs,
  c2cBackupJobs,
  c2cBackupItems,
  automationPolicies,
  monitorDefinitions,
  psaConnections,
  webhooks,
  scripts,
} from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';
import { getTestDb } from './setup';
import { registerC2CTools } from '../../services/aiToolsC2C';
import { registerComplianceTools } from '../../services/aiToolsCompliance';
import { registerMonitorTools } from '../../services/aiToolsMonitors';
import { registerIntegrationTools } from '../../services/aiToolsIntegrations';
import { registerScriptTools } from '../../services/aiToolsScripts';
import { maskSecret } from '../../routes/c2c/helpers';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';

// ── Test scaffolding ────────────────────────────────────────────────────────

function handlerFor(
  register: (map: Map<string, AiTool>) => void,
  toolName: string,
): AiTool['handler'] {
  const map = new Map<string, AiTool>();
  register(map);
  const tool = map.get(toolName);
  if (!tool) throw new Error(`aiToolsOrgOnlyReadsScope: tool not registered: ${toolName}`);
  return tool.handler;
}

// Unrestricted org-scope caller (no site axis on any of these tools).
// `orgCondition: () => undefined` mirrors aiToolsAuditDetailsSiteScope's
// fixture: under breeze_app RLS the row is independently gated by org
// access, so this is the realistic shape for a handler that also builds its
// own (here empty) app-layer condition.
function makeAuth(orgId: string): AuthContext {
  return {
    user: { id: randomUUID(), email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition: () => undefined,
    canAccessOrg: (id: string) => id === orgId,
    allowedSiteIds: undefined,
    canAccessSite: () => true,
  } as unknown as AuthContext;
}

async function callAs(
  orgId: string,
  handler: AiTool['handler'],
  input: Record<string, unknown>,
): Promise<any> {
  const raw = await withDbAccessContext(
    { scope: 'organization', orgId, accessibleOrgIds: [orgId] },
    async () => handler(input, makeAuth(orgId)),
  );
  return JSON.parse(raw);
}

async function makeTwoOrgs() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  return { partner, orgA, orgB };
}

// ── Seed helpers (one insert per table, minimal required columns) ─────────

async function seedC2cConnection(orgId: string, overrides: Partial<typeof c2cConnections.$inferInsert> = {}) {
  const [row] = await getTestDb()
    .insert(c2cConnections)
    .values({
      orgId,
      provider: 'm365',
      displayName: `Conn ${randomUUID().slice(0, 8)}`,
      clientId: 'abcd1234efgh5678',
      status: 'active',
      ...overrides,
    })
    .returning();
  return row!;
}

async function seedC2cConfig(orgId: string, connectionId: string) {
  const [row] = await getTestDb()
    .insert(c2cBackupConfigs)
    .values({
      orgId,
      connectionId,
      name: `Config ${randomUUID().slice(0, 8)}`,
      backupScope: 'mailbox',
    })
    .returning();
  return row!;
}

async function seedC2cJob(orgId: string, configId: string) {
  const [row] = await getTestDb()
    .insert(c2cBackupJobs)
    .values({
      orgId,
      configId,
      status: 'completed',
      operationKind: 'sync',
    })
    .returning();
  return row!;
}

async function seedC2cItem(orgId: string, configId: string) {
  const [row] = await getTestDb()
    .insert(c2cBackupItems)
    .values({
      orgId,
      configId,
      itemType: 'mail',
      externalId: `ext-${randomUUID()}`,
      userEmail: 'user@example.com',
      subjectOrName: 'Quarterly report',
    })
    .returning();
  return row!;
}

async function seedCompliancePolicy(orgId: string) {
  const [row] = await getTestDb()
    .insert(automationPolicies)
    .values({
      orgId,
      name: `Policy ${randomUUID().slice(0, 8)}`,
      targets: {},
      rules: {},
    })
    .returning();
  return row!;
}

async function seedMonitor(orgId: string) {
  const [row] = await getTestDb()
    .insert(monitorDefinitions)
    .values({
      orgId,
      name: `Monitor ${randomUUID().slice(0, 8)}`,
      kind: 'cpu',
      severity: 'high',
      condition: { threshold: 90 },
    })
    .returning();
  return row!;
}

async function seedPsaConnection(orgId: string) {
  const [row] = await getTestDb()
    .insert(psaConnections)
    .values({
      orgId,
      provider: 'connectwise',
      name: `PSA ${randomUUID().slice(0, 8)}`,
      credentials: {},
    })
    .returning();
  return row!;
}

async function seedWebhook(orgId: string) {
  const [row] = await getTestDb()
    .insert(webhooks)
    .values({
      orgId,
      name: `Webhook ${randomUUID().slice(0, 8)}`,
      url: 'https://example.com/hooks/breeze',
      events: ['device.offline'],
    })
    .returning();
  return row!;
}

async function seedScript(orgId: string) {
  const [row] = await getTestDb()
    .insert(scripts)
    .values({
      orgId,
      name: `Script ${randomUUID().slice(0, 8)}`,
      osTypes: ['windows'],
      language: 'powershell',
      content: 'Write-Host "hi"',
    })
    .returning();
  return row!;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('AI org-only reads — cross-org denial', () => {
  // org-only: no site axis, asserting cross-org denial only

  it('query_c2c_connections: cross-org denied, same-org visible with clientId masked', async () => {
    const { orgA, orgB } = await makeTwoOrgs();
    const conn = await seedC2cConnection(orgA.id);
    const handler = handlerFor(registerC2CTools, 'query_c2c_connections');

    const asOrgB = await callAs(orgB.id, handler, {});
    expect(asOrgB.error).toBeUndefined();
    expect((asOrgB.connections ?? []).some((c: any) => c.id === conn.id)).toBe(false);

    const asOrgA = await callAs(orgA.id, handler, {});
    expect(asOrgA.error).toBeUndefined();
    const found = (asOrgA.connections ?? []).find((c: any) => c.id === conn.id);
    expect(found).toBeDefined();
    // The tool masks clientId the same way the REST route does,
    // never returning the raw value.
    expect(found.clientId).not.toBe('abcd1234efgh5678');
    expect(found.clientId).toBe(maskSecret('abcd1234efgh5678'));
  });

  it('query_c2c_jobs: cross-org denied, same-org visible', async () => {
    const { orgA, orgB } = await makeTwoOrgs();
    const conn = await seedC2cConnection(orgA.id);
    const config = await seedC2cConfig(orgA.id, conn.id);
    const job = await seedC2cJob(orgA.id, config.id);
    const handler = handlerFor(registerC2CTools, 'query_c2c_jobs');

    const asOrgB = await callAs(orgB.id, handler, {});
    expect(asOrgB.error).toBeUndefined();
    expect((asOrgB.jobs ?? []).some((j: any) => j.id === job.id)).toBe(false);

    const asOrgA = await callAs(orgA.id, handler, {});
    expect(asOrgA.error).toBeUndefined();
    expect((asOrgA.jobs ?? []).some((j: any) => j.id === job.id)).toBe(true);
  });

  it('search_c2c_items: cross-org denied, same-org visible', async () => {
    const { orgA, orgB } = await makeTwoOrgs();
    const conn = await seedC2cConnection(orgA.id);
    const config = await seedC2cConfig(orgA.id, conn.id);
    const item = await seedC2cItem(orgA.id, config.id);
    const handler = handlerFor(registerC2CTools, 'search_c2c_items');

    const asOrgB = await callAs(orgB.id, handler, {});
    expect(asOrgB.error).toBeUndefined();
    expect((asOrgB.items ?? []).some((i: any) => i.id === item.id)).toBe(false);

    const asOrgA = await callAs(orgA.id, handler, {});
    expect(asOrgA.error).toBeUndefined();
    expect((asOrgA.items ?? []).some((i: any) => i.id === item.id)).toBe(true);
  });

  it('query_compliance_policies: cross-org denied, same-org visible', async () => {
    const { orgA, orgB } = await makeTwoOrgs();
    const policy = await seedCompliancePolicy(orgA.id);
    const handler = handlerFor(registerComplianceTools, 'query_compliance_policies');

    const asOrgB = await callAs(orgB.id, handler, {});
    expect(asOrgB.error).toBeUndefined();
    expect((asOrgB.policies ?? []).some((p: any) => p.id === policy.id)).toBe(false);

    const asOrgA = await callAs(orgA.id, handler, {});
    expect(asOrgA.error).toBeUndefined();
    expect((asOrgA.policies ?? []).some((p: any) => p.id === policy.id)).toBe(true);
  });

  it('list_monitors: cross-org denied, same-org visible', async () => {
    const { orgA, orgB } = await makeTwoOrgs();
    const monitor = await seedMonitor(orgA.id);
    const handler = handlerFor(registerMonitorTools, 'list_monitors');

    const asOrgB = await callAs(orgB.id, handler, {});
    expect(asOrgB.error).toBeUndefined();
    expect((asOrgB.monitors ?? []).some((m: any) => m.id === monitor.id)).toBe(false);

    const asOrgA = await callAs(orgA.id, handler, {});
    expect(asOrgA.error).toBeUndefined();
    expect((asOrgA.monitors ?? []).some((m: any) => m.id === monitor.id)).toBe(true);
  });

  it('get_monitor: cross-org denied (not found), same-org visible', async () => {
    const { orgA, orgB } = await makeTwoOrgs();
    const monitor = await seedMonitor(orgA.id);
    const handler = handlerFor(registerMonitorTools, 'get_monitor');

    const asOrgB = await callAs(orgB.id, handler, { monitorId: monitor.id });
    expect(asOrgB.error).toBeDefined();
    expect(asOrgB.monitor).toBeUndefined();

    const asOrgA = await callAs(orgA.id, handler, { monitorId: monitor.id });
    expect(asOrgA.error).toBeUndefined();
    expect(asOrgA.monitor?.id).toBe(monitor.id);
  });

  it('query_psa_status: cross-org denied, same-org visible', async () => {
    const { orgA, orgB } = await makeTwoOrgs();
    const psa = await seedPsaConnection(orgA.id);
    const handler = handlerFor(registerIntegrationTools, 'query_psa_status');

    const asOrgB = await callAs(orgB.id, handler, {});
    expect(asOrgB.error).toBeUndefined();
    expect((asOrgB.connections ?? []).some((c: any) => c.id === psa.id)).toBe(false);

    const asOrgA = await callAs(orgA.id, handler, {});
    expect(asOrgA.error).toBeUndefined();
    expect((asOrgA.connections ?? []).some((c: any) => c.id === psa.id)).toBe(true);

    // A direct-by-id lookup for a cross-org connectionId must also be denied.
    const asOrgBById = await callAs(orgB.id, handler, { connectionId: psa.id });
    expect(asOrgBById.connection).toBeUndefined();
    expect((asOrgBById.connections ?? []).some((c: any) => c.id === psa.id)).toBe(false);
  });

  it('query_webhooks: cross-org denied, same-org visible', async () => {
    const { orgA, orgB } = await makeTwoOrgs();
    const hook = await seedWebhook(orgA.id);
    const handler = handlerFor(registerIntegrationTools, 'query_webhooks');

    const asOrgB = await callAs(orgB.id, handler, {});
    expect(asOrgB.error).toBeUndefined();
    expect((asOrgB.webhooks ?? []).some((w: any) => w.id === hook.id)).toBe(false);

    const asOrgA = await callAs(orgA.id, handler, {});
    expect(asOrgA.error).toBeUndefined();
    expect((asOrgA.webhooks ?? []).some((w: any) => w.id === hook.id)).toBe(true);
  });

  it('list_scripts: cross-org denied, same-org visible', async () => {
    const { orgA, orgB } = await makeTwoOrgs();
    const script = await seedScript(orgA.id);
    const handler = handlerFor(registerScriptTools, 'list_scripts');

    const asOrgB = await callAs(orgB.id, handler, {});
    expect(asOrgB.error).toBeUndefined();
    expect((asOrgB.scripts ?? []).some((s: any) => s.id === script.id)).toBe(false);

    const asOrgA = await callAs(orgA.id, handler, {});
    expect(asOrgA.error).toBeUndefined();
    expect((asOrgA.scripts ?? []).some((s: any) => s.id === script.id)).toBe(true);
  });

  it('search_script_library: cross-org denied, same-org visible', async () => {
    const { orgA, orgB } = await makeTwoOrgs();
    const script = await seedScript(orgA.id);
    const handler = handlerFor(registerScriptTools, 'search_script_library');

    const asOrgB = await callAs(orgB.id, handler, {});
    expect(asOrgB.error).toBeUndefined();
    expect((asOrgB.scripts ?? []).some((s: any) => s.id === script.id)).toBe(false);

    const asOrgA = await callAs(orgA.id, handler, {});
    expect(asOrgA.error).toBeUndefined();
    expect((asOrgA.scripts ?? []).some((s: any) => s.id === script.id)).toBe(true);
  });
});
