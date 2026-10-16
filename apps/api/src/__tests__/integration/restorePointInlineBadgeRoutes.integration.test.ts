/**
 * Route-level proof for the System Restore inline badges (#8584, follow-up to
 * #4759 W08 of #4751), as the unprivileged `breeze_app` role under forced RLS,
 * through the real auth middleware:
 *
 *  - GET /scripts/executions/:id carries `restorePoint` = the newest ledger row
 *    for that execution, or null when Breeze never asked;
 *  - GET /software/deployments/:id/results carries a per-device
 *    `restorePoint`, matched on deployment AND device;
 *  - RLS negative: the inline subquery filters only on the link id, so a
 *    ledger row stamped with ANOTHER org that names this org's execution id is
 *    hidden by RLS alone. The control runs the same subquery in system scope
 *    and proves the foreign row is really there and would have won;
 *  - the `list_device_restore_point_attempts` AI tool reads the same ledger
 *    under the caller's RLS context and refuses another org's device.
 *
 * `script_execution_id` / `software_deployment_id` carry no FK (the ledger row
 * is written before/independently of those rows), which is why a cross-org
 * link id is representable at all. The software badge additionally matches
 * `device_id`, and the composite (device_id, org_id) FK makes a foreign-org row
 * naming this org's device impossible, so its cross-org case is structural.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  deploymentResults,
  scriptExecutions,
  scripts,
  softwareCatalog,
  softwareDeployments,
  softwareVersions,
} from '../../db/schema';
import { scriptRoutes } from '../../routes/scripts';
import { softwareRoutes } from '../../routes/software';
import { scriptExecutionRestorePointSql } from '../../services/restorePointInline';
import { registerRestorePointTools } from '../../services/aiToolsRestorePoints';
import type { AiTool } from '../../services/aiTools';
import type { AuthContext } from '../../middleware/auth';
import { createDevice, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// Production prefixes, so the auth middleware behaves as it does when mounted.
const app = new Hono();
app.route('/api/v1/scripts', scriptRoutes);
app.route('/api/v1/software', softwareRoutes);

const READ = [
  { resource: 'devices', action: 'read' },
  { resource: 'scripts', action: 'read' },
];

async function seedAttempt(opts: {
  orgId: string;
  deviceId: string;
  requestedAt: string;
  status?: string;
  trigger?: string;
  scriptExecutionId?: string | null;
  softwareDeploymentId?: string | null;
  message?: string | null;
}): Promise<string> {
  const requestId = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO device_restore_point_attempts
      (request_id, org_id, device_id, trigger, status, requested_at,
       script_execution_id, software_deployment_id, message)
    VALUES (${requestId}, ${opts.orgId}, ${opts.deviceId}, ${opts.trigger ?? 'script'},
            ${opts.status ?? 'requested'}, ${opts.requestedAt}::timestamptz,
            ${opts.scriptExecutionId ?? null}, ${opts.softwareDeploymentId ?? null}, ${opts.message ?? null})
  `);
  return requestId;
}

async function seedExecution(orgId: string, deviceId: string): Promise<string> {
  const [script] = await getTestDb().insert(scripts).values({
    orgId,
    name: `rp-badge-${randomUUID().slice(0, 8)}`,
    osTypes: ['windows'],
    language: 'powershell',
    content: 'exit 0',
  }).returning({ id: scripts.id });
  const [execution] = await getTestDb().insert(scriptExecutions).values({
    scriptId: script!.id,
    deviceId,
    orgId,
    status: 'completed',
  }).returning({ id: scriptExecutions.id });
  return execution!.id;
}

async function seedDeployment(orgId: string, deviceIds: string[]): Promise<string> {
  const [catalog] = await getTestDb().insert(softwareCatalog)
    .values({ orgId, name: `rp-badge-${randomUUID()}` })
    .returning({ id: softwareCatalog.id });
  const [version] = await getTestDb().insert(softwareVersions)
    .values({ catalogId: catalog!.id, version: '1.0.0', downloadUrl: 'https://example.invalid/rp.msi' })
    .returning({ id: softwareVersions.id });
  const [deployment] = await getTestDb().insert(softwareDeployments).values({
    orgId,
    name: 'rp badge deployment',
    softwareVersionId: version!.id,
    deploymentType: 'install',
    targetType: 'devices',
    targetIds: deviceIds,
    scheduleType: 'immediate',
    dispatchedAt: new Date(),
  }).returning({ id: softwareDeployments.id });
  await getTestDb().insert(deploymentResults)
    .values(deviceIds.map((deviceId) => ({ deploymentId: deployment!.id, deviceId, status: 'completed' as const })));
  return deployment!.id;
}

function get(token: string, path: string) {
  return app.request(path, { headers: { Authorization: `Bearer ${token}` } });
}

describe('GET /scripts/executions/:id restorePoint badge (real Postgres, breeze_app)', () => {
  runDb('carries the newest ledger row for the execution, and null when Breeze never asked', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    const device = await createDevice({ orgId: env.organization.id, siteId: env.site.id });
    const withAttempts = await seedExecution(env.organization.id, device.id);
    const without = await seedExecution(env.organization.id, device.id);
    await seedAttempt({ orgId: env.organization.id, deviceId: device.id, requestedAt: '2026-09-01T10:00:00.000000Z', scriptExecutionId: withAttempts });
    const newest = await seedAttempt({
      orgId: env.organization.id,
      deviceId: device.id,
      requestedAt: '2026-09-02T10:00:00.000000Z',
      status: 'created',
      scriptExecutionId: withAttempts,
      message: 'checkpoint ok',
    });

    const res = await get(env.token, `/api/v1/scripts/executions/${withAttempts}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(withAttempts);
    expect(body.restorePoint).toMatchObject({ status: 'created', requestId: newest, message: 'checkpoint ok' });

    const none = await get(env.token, `/api/v1/scripts/executions/${without}`);
    expect(none.status).toBe(200);
    expect((await none.json()).restorePoint).toBeNull();
  });

  runDb("RLS hides another org's ledger row that names this org's execution", async () => {
    const a = await setupTestEnvironment({ rolePermissions: READ });
    const b = await setupTestEnvironment({ rolePermissions: READ });
    const aDevice = await createDevice({ orgId: a.organization.id, siteId: a.site.id });
    const bDevice = await createDevice({ orgId: b.organization.id, siteId: b.site.id });
    const aExecution = await seedExecution(a.organization.id, aDevice.id);
    const aOnlyForeign = await seedExecution(a.organization.id, aDevice.id);

    const own = await seedAttempt({
      orgId: a.organization.id, deviceId: aDevice.id, requestedAt: '2026-09-01T10:00:00.000000Z',
      status: 'created', scriptExecutionId: aExecution,
    });
    // Newer than A's own row, so it would win `order by requested_at desc`.
    const foreign = await seedAttempt({
      orgId: b.organization.id, deviceId: bDevice.id, requestedAt: '2026-09-03T10:00:00.000000Z',
      status: 'failed', scriptExecutionId: aExecution, message: 'org-b-secret',
    });
    await seedAttempt({
      orgId: b.organization.id, deviceId: bDevice.id, requestedAt: '2026-09-03T10:00:00.000000Z',
      status: 'failed', scriptExecutionId: aOnlyForeign, message: 'org-b-secret',
    });

    // Control: without RLS the subquery really does pick org B's row.
    const unscoped = await withSystemDbAccessContext(() => db.execute<{ rp: { requestId: string } | null }>(
      sql`select ${scriptExecutionRestorePointSql(sql`${aExecution}::uuid`)} as rp`,
    ));
    expect(Array.from(unscoped)[0]!.rp?.requestId).toBe(foreign);

    const res = await get(a.token, `/api/v1/scripts/executions/${aExecution}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).restorePoint).toMatchObject({ requestId: own, status: 'created' });
    expect(text).not.toContain('org-b-secret');

    const onlyForeign = await get(a.token, `/api/v1/scripts/executions/${aOnlyForeign}`);
    expect(onlyForeign.status).toBe(200);
    const onlyForeignText = await onlyForeign.text();
    expect(JSON.parse(onlyForeignText).restorePoint).toBeNull();
    expect(onlyForeignText).not.toContain('org-b-secret');
  });
});

describe('GET /software/deployments/:id/results restorePoint badge (real Postgres, breeze_app)', () => {
  runDb('matches each result on deployment and device, null for a device Breeze never asked about', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    const asked = await createDevice({ orgId: env.organization.id, siteId: env.site.id, hostname: 'rp-asked' });
    const notAsked = await createDevice({ orgId: env.organization.id, siteId: env.site.id, hostname: 'rp-not-asked' });
    const deploymentId = await seedDeployment(env.organization.id, [asked.id, notAsked.id]);
    const otherDeploymentId = await seedDeployment(env.organization.id, [notAsked.id]);
    await seedAttempt({
      orgId: env.organization.id, deviceId: asked.id, requestedAt: '2026-09-01T10:00:00.000000Z',
      trigger: 'software_install', softwareDeploymentId: deploymentId,
    });
    const newest = await seedAttempt({
      orgId: env.organization.id, deviceId: asked.id, requestedAt: '2026-09-02T10:00:00.000000Z',
      trigger: 'software_install', status: 'existing_accepted', softwareDeploymentId: deploymentId,
    });
    // Same device, different deployment: must not bleed into this one.
    await seedAttempt({
      orgId: env.organization.id, deviceId: notAsked.id, requestedAt: '2026-09-04T10:00:00.000000Z',
      trigger: 'software_install', status: 'failed', softwareDeploymentId: otherDeploymentId,
    });

    const res = await get(env.token, `/api/v1/software/deployments/${deploymentId}/results`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    const byDevice = new Map(body.data.map((r: { deviceId: string; restorePoint: unknown }) => [r.deviceId, r.restorePoint]));
    expect(byDevice.get(asked.id)).toMatchObject({ requestId: newest, status: 'existing_accepted' });
    expect(byDevice.get(notAsked.id)).toBeNull();
  });
});

describe('list_device_restore_point_attempts AI tool (real Postgres, breeze_app)', () => {
  function handler(): AiTool['handler'] {
    const tools = new Map<string, AiTool>();
    registerRestorePointTools(tools);
    return tools.get('list_device_restore_point_attempts')!.handler;
  }

  // App-layer org predicate disabled, so RLS is the only org defense exercised.
  function orgAuth(orgId: string, over: Partial<Record<string, unknown>> = {}): AuthContext {
    return {
      principal: { kind: 'user_session' },
      user: { id: randomUUID(), email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
      token: {},
      partnerId: null,
      orgId,
      scope: 'organization',
      accessibleOrgIds: [orgId],
      orgCondition: () => undefined,
      canAccessOrg: () => true,
      allowedSiteIds: undefined,
      allowedDeviceIds: undefined,
      canAccessSite: () => true,
      ...over,
    } as unknown as AuthContext;
  }

  function ctx(orgId: string): DbAccessContext {
    return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
  }

  runDb("lists own-device rows newest first and refuses another org's device", async () => {
    const a = await setupTestEnvironment({ rolePermissions: READ });
    const b = await setupTestEnvironment({ rolePermissions: READ });
    const aDevice = await createDevice({ orgId: a.organization.id, siteId: a.site.id });
    const older = await seedAttempt({ orgId: a.organization.id, deviceId: aDevice.id, requestedAt: '2026-09-01T10:00:00.000000Z', trigger: 'patch' });
    const newer = await seedAttempt({
      orgId: a.organization.id, deviceId: aDevice.id, requestedAt: '2026-09-02T10:00:00.000000Z',
      status: 'created', message: 'org-a-secret',
    });

    const own = JSON.parse(await withDbAccessContext(ctx(a.organization.id), () =>
      handler()({ deviceId: aDevice.id }, orgAuth(a.organization.id))));
    expect(own.attempts.map((r: { requestId: string }) => r.requestId)).toEqual([newer, older]);
    expect(own.hasMore).toBe(false);

    const filtered = JSON.parse(await withDbAccessContext(ctx(a.organization.id), () =>
      handler()({ deviceId: aDevice.id, trigger: 'patch' }, orgAuth(a.organization.id))));
    expect(filtered.attempts.map((r: { requestId: string }) => r.requestId)).toEqual([older]);

    const crossText = await withDbAccessContext(ctx(b.organization.id), () =>
      handler()({ deviceId: aDevice.id }, orgAuth(b.organization.id)));
    expect(JSON.parse(crossText)).toEqual({ error: 'Device not found or access denied' });
    expect(crossText).not.toContain('org-a-secret');
  });
  runDb('pages newest first across tied requested_at with no repeat or gap', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    const device = await createDevice({ orgId: env.organization.id, siteId: env.site.id });
    const rows: Array<{ id: string; at: string }> = [];
    for (const at of [
      '2026-09-03T10:00:00.000000Z',
      '2026-09-02T10:00:00.500000Z',
      '2026-09-02T10:00:00.500000Z',
      '2026-09-02T10:00:00.500000Z',
      '2026-09-01T10:00:00.000000Z',
    ]) rows.push({ id: await seedAttempt({ orgId: env.organization.id, deviceId: device.id, requestedAt: at }), at });
    const expected = [...rows]
      .sort((x, y) => (x.at === y.at ? (x.id < y.id ? 1 : -1) : x.at < y.at ? 1 : -1))
      .map((r) => r.id);

    const auth = orgAuth(env.organization.id);
    const seen: string[] = [];
    const hasMore: boolean[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const body = JSON.parse(await withDbAccessContext(ctx(env.organization.id), () =>
        handler()({ deviceId: device.id, limit: 2, ...(cursor ? { cursor } : {}) }, auth)));
      seen.push(...body.attempts.map((r: { requestId: string }) => r.requestId));
      hasMore.push(body.hasMore);
      cursor = body.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toEqual(expected);
    expect(hasMore).toEqual([true, true, false]);
  });

  runDb('refuses a device outside the caller site or device allowlist (real verifyDeviceAccess)', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    const device = await createDevice({ orgId: env.organization.id, siteId: env.site.id });
    await seedAttempt({ orgId: env.organization.id, deviceId: device.id, requestedAt: '2026-09-02T10:00:00.000000Z', message: 'site-secret' });
    const call = (over: Record<string, unknown>) => withDbAccessContext(ctx(env.organization.id), () =>
      handler()({ deviceId: device.id }, orgAuth(env.organization.id, over)));

    // Control: the unrestricted caller does see the row.
    expect(await call({})).toContain('site-secret');
    for (const over of [
      { allowedSiteIds: [randomUUID()], canAccessSite: () => false },
      { allowedDeviceIds: [randomUUID()] },
    ]) {
      const text = await call(over);
      expect(JSON.parse(text)).toEqual({ error: 'Device not found or access denied' });
      expect(text).not.toContain('site-secret');
    }
  });
});
