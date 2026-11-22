import './setup';

// config/env.ts reads this at import time and the client-ai admin group is
// dark (404) without it.
vi.hoisted(() => {
  process.env.CLIENT_AI_ENTRA_CLIENT_ID = process.env.CLIENT_AI_ENTRA_CLIENT_ID || '11111111-1111-4111-8111-111111111111';
});

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { getTestDb } from './setup';
import { createOrganization, setupTestEnvironment } from './db-utils';
import {
  clientAiTenantMappings,
  customFieldDefinitions,
  discoveredAssets,
  networkBaselines,
  networkChangeEvents,
  partners,
  softwareCatalog,
  softwareDeployments,
  softwareInstallMethods,
  topologyConfigTemplates,
} from '../../db/schema';
import { createAccessToken } from '../../services/jwt';
import { clientAiAdminRoutes } from '../../routes/clientAi/admin';
import { networkRoutes } from '../../routes/devices/network';
import { networkBaselineRoutes } from '../../routes/networkBaselines';
import { softwareInstallMethodRoutes } from '../../routes/softwareInstallMethods';
import { createTopologyRoutes } from '../../routes/topology';
import { customFieldRoutes } from '../../routes/customFields';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/**
 * #11203: every request runs in ONE transaction, and postgres.js rethrows a
 * failed statement when that transaction ends even if the handler caught it.
 * So `try { await db.insert(...) } catch (e) { if (unique) return 409 }`
 * answered 500. Each case here drives the real router against real PostgreSQL
 * and asserts the mapped status AND that the first successful row survived
 * with no second row. The Drizzle-mocked unit suites cannot see this.
 */

function buildApp(): Hono {
  const app = new Hono();
  app.route('/client-ai/admin', clientAiAdminRoutes);
  app.route('/devices', networkRoutes);
  app.route('/baselines', networkBaselineRoutes);
  app.route('/software', softwareInstallMethodRoutes);
  app.route('/topology', createTopologyRoutes());
  app.route('/custom-fields', customFieldRoutes);
  return app;
}

async function fixture(scope: 'organization' | 'partner' = 'organization') {
  const env = await setupTestEnvironment({ scope });
  const token = await createAccessToken({
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: scope === 'organization' ? env.organization.id : null,
    partnerId: env.partner.id,
    scope,
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  });
  return { env, token, app: buildApp() };
}

function send(app: Hono, token: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('caught constraint violations map to their status inside the request transaction (real PostgreSQL)', () => {
  runDb('PUT /client-ai/admin/orgs/:orgId/tenant-mapping: a tenant already mapped to another org answers 409 tenant_already_mapped', async () => {
    const { env, token, app } = await fixture('partner');
    await getTestDb().update(partners).set({ aiForOfficeEnabled: true }).where(eq(partners.id, env.partner.id));
    const otherOrg = await createOrganization({ partnerId: env.partner.id });
    const tenant = randomUUID();

    const first = await send(app, token, 'PUT', `/client-ai/admin/orgs/${env.organization.id}/tenant-mapping`, { entraTenantId: tenant });
    expect(first.status).toBe(200);

    const second = await send(app, token, 'PUT', `/client-ai/admin/orgs/${otherOrg.id}/tenant-mapping`, { entraTenantId: tenant });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: 'tenant_already_mapped' });

    const rows = await getTestDb().select().from(clientAiTenantMappings)
      .where(eq(clientAiTenantMappings.entraTenantId, tenant));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orgId).toBe(env.organization.id);
  });

  runDb('POST /devices/network: a duplicate IP answers 409 (drizzle-wrapped 23505 is read through pgErrorCode)', async () => {
    const { env, token, app } = await fixture();
    const body = {
      orgId: env.organization.id,
      siteId: env.site.id,
      label: 'Front desk printer',
      assetType: 'printer',
      ipAddress: '10.20.30.40',
    };

    const first = await send(app, token, 'POST', '/devices/network', body);
    expect(first.status).toBe(201);

    const second = await send(app, token, 'POST', '/devices/network', body);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: expect.stringMatching(/already exists/i) });

    const rows = await getTestDb().select({ id: discoveredAssets.id }).from(discoveredAssets)
      .where(and(eq(discoveredAssets.orgId, env.organization.id), eq(discoveredAssets.ipAddress, '10.20.30.40')));
    expect(rows).toHaveLength(1);
  });

  runDb('DELETE /baselines/:id?deleteChanges=false: a baseline with a change event answers 409 and both rows survive', async () => {
    const { env, token, app } = await fixture();
    const [baseline] = await getTestDb().insert(networkBaselines).values({
      orgId: env.organization.id,
      siteId: env.site.id,
      subnet: '10.9.8.0/24',
    }).returning();
    await getTestDb().insert(networkChangeEvents).values({
      orgId: env.organization.id,
      siteId: env.site.id,
      baselineId: baseline!.id,
      eventType: 'new_device',
      ipAddress: '10.9.8.7',
    });

    const res = await send(app, token, 'DELETE', `/baselines/${baseline!.id}?deleteChanges=false`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/change events/i) });

    const stillThere = await getTestDb().select({ id: networkBaselines.id }).from(networkBaselines)
      .where(eq(networkBaselines.id, baseline!.id));
    expect(stillThere).toHaveLength(1);
    const events = await getTestDb().select({ id: networkChangeEvents.id }).from(networkChangeEvents)
      .where(eq(networkChangeEvents.baselineId, baseline!.id));
    expect(events).toHaveLength(1);
  });

  runDb('POST /software/catalog/:id/install-methods: a duplicate platform+kind answers 409', async () => {
    const { env, token, app } = await fixture();
    const [item] = await getTestDb().insert(softwareCatalog).values({
      orgId: env.organization.id,
      name: `Catalog ${randomUUID()}`,
    }).returning();
    const body = { platform: 'windows', kind: 'winget', packageId: 'Mozilla.Firefox' };
    const path = `/software/catalog/${item!.id}/install-methods`;

    const first = await send(app, token, 'POST', path, body);
    expect(first.status).toBe(201);

    const second = await send(app, token, 'POST', path, body);
    expect(second.status).toBe(409);

    const rows = await getTestDb().select({ id: softwareInstallMethods.id }).from(softwareInstallMethods)
      .where(eq(softwareInstallMethods.catalogId, item!.id));
    expect(rows).toHaveLength(1);
  });

  runDb('DELETE /software/catalog/:id/install-methods/:methodId: a method referenced by a deployment answers 409 and survives', async () => {
    const { env, token, app } = await fixture();
    const [item] = await getTestDb().insert(softwareCatalog).values({
      orgId: env.organization.id,
      name: `Catalog ${randomUUID()}`,
    }).returning();
    const [method] = await getTestDb().insert(softwareInstallMethods).values({
      catalogId: item!.id,
      platform: 'windows',
      kind: 'winget',
      packageId: 'Mozilla.Firefox',
    }).returning();
    await getTestDb().insert(softwareDeployments).values({
      orgId: env.organization.id,
      name: 'Firefox rollout',
      installMethodId: method!.id,
      deploymentType: 'install',
      targetType: 'devices',
      scheduleType: 'immediate',
    });

    const res = await send(app, token, 'DELETE', `/software/catalog/${item!.id}/install-methods/${method!.id}`);
    expect(res.status).toBe(409);

    const rows = await getTestDb().select({ id: softwareInstallMethods.id }).from(softwareInstallMethods)
      .where(eq(softwareInstallMethods.id, method!.id));
    expect(rows).toHaveLength(1);
  });

  runDb('POST /topology/templates: a duplicate key answers 409 revision_conflict', async () => {
    const { env, token, app } = await fixture();
    const body = { ownerScope: 'organization', key: 'edge-baseline', name: 'Edge baseline' };

    const first = await send(app, token, 'POST', '/topology/templates', body);
    expect(first.status).toBe(201);

    const second = await send(app, token, 'POST', '/topology/templates', { ...body, name: 'Edge baseline two' });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: 'revision_conflict' });

    const rows = await getTestDb().select({ id: topologyConfigTemplates.id }).from(topologyConfigTemplates)
      .where(and(eq(topologyConfigTemplates.orgId, env.organization.id), eq(topologyConfigTemplates.key, 'edge-baseline')));
    expect(rows).toHaveLength(1);
  });

  runDb('PATCH /topology/templates/:id: renaming onto an existing name answers 409 revision_conflict and keeps the old name', async () => {
    const { env, token, app } = await fixture();
    const a = await send(app, token, 'POST', '/topology/templates', { ownerScope: 'organization', key: 'tpl-a', name: 'Template A' });
    const b = await send(app, token, 'POST', '/topology/templates', { ownerScope: 'organization', key: 'tpl-b', name: 'Template B' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const bRow = await b.json();

    const res = await send(app, token, 'PATCH', `/topology/templates/${bRow.id}`, {
      expectedRevision: bRow.revision,
      name: 'Template A',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'revision_conflict' });

    const [after] = await getTestDb().select({ name: topologyConfigTemplates.name }).from(topologyConfigTemplates)
      .where(eq(topologyConfigTemplates.id, bRow.id));
    expect(after!.name).toBe('Template B');
    const named = await getTestDb().select({ id: topologyConfigTemplates.id }).from(topologyConfigTemplates)
      .where(and(eq(topologyConfigTemplates.orgId, env.organization.id), eq(topologyConfigTemplates.name, 'Template A')));
    expect(named).toHaveLength(1);
  });

  runDb('POST /custom-fields: a duplicate fieldKey answers 409', async () => {
    const { env, token, app } = await fixture();
    const body = { name: 'Department', fieldKey: 'department', type: 'text' };

    const first = await send(app, token, 'POST', '/custom-fields', body);
    expect(first.status).toBe(201);

    const second = await send(app, token, 'POST', '/custom-fields', body);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: 'field-key-duplicate' });

    const rows = await getTestDb().select({ id: customFieldDefinitions.id }).from(customFieldDefinitions)
      .where(and(eq(customFieldDefinitions.orgId, env.organization.id), eq(customFieldDefinitions.fieldKey, 'department')));
    expect(rows).toHaveLength(1);
  });
});
