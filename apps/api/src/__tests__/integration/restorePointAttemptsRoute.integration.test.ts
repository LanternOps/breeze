/**
 * Real-PostgreSQL proof for the System Restore ledger console read path
 * (#4759, W08 of #4751). Runs as the unprivileged `breeze_app` role under forced
 * RLS, through the real auth middleware:
 *
 *  - own-org device: rows come back newest first, `sequenceNumber` is a string;
 *  - keyset pages never skip or repeat rows, including rows whose requested_at
 *    is equal and rows that differ only below the millisecond (Postgres keeps
 *    microseconds, a JS Date does not);
 *  - another org's device is a 404 and its rows never appear;
 *  - the inline-badge subqueries (script execution / software deployment) read
 *    the same ledger under RLS.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { deviceRestorePointAttemptsRoutes } from '../../routes/devices/restorePoints';
import {
  deploymentResultRestorePointSql,
  scriptExecutionRestorePointSql,
} from '../../services/restorePointInline';
import { createDevice, setupTestEnvironment } from './db-utils';
import { getAppDb, getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const app = new Hono().route('/devices', deviceRestorePointAttemptsRoutes);

async function seedAttempt(opts: {
  orgId: string;
  deviceId: string;
  requestedAt: string; // full microsecond ISO string
  status?: string;
  sequenceNumber?: string | null;
  scriptExecutionId?: string | null;
  softwareDeploymentId?: string | null;
  message?: string | null;
}): Promise<string> {
  const requestId = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO device_restore_point_attempts
      (request_id, org_id, device_id, trigger, status, requested_at, sequence_number,
       script_execution_id, software_deployment_id, message)
    VALUES (${requestId}, ${opts.orgId}, ${opts.deviceId}, 'script', ${opts.status ?? 'requested'},
            ${opts.requestedAt}::timestamptz, ${opts.sequenceNumber ?? null},
            ${opts.scriptExecutionId ?? null}, ${opts.softwareDeploymentId ?? null}, ${opts.message ?? null})
  `);
  return requestId;
}

async function get(token: string, deviceId: string, qs = '') {
  return app.request(`/devices/${deviceId}/restore-point-attempts${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe('GET /devices/:id/restore-point-attempts (real Postgres, breeze_app)', () => {
  runDb('is served as breeze_app (no superuser, no BYPASSRLS)', async () => {
    const roles = await getAppDb().execute(
      sql`SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(roles[0]).toMatchObject({ role: 'breeze_app', rolsuper: false, rolbypassrls: false });
  });

  runDb('returns own-org rows newest first with a string sequenceNumber', async () => {
    const env = await setupTestEnvironment({ rolePermissions: [{ resource: 'devices', action: 'read' }] });
    const device = await createDevice({ orgId: env.organization.id, siteId: env.site.id });
    const oldest = await seedAttempt({ orgId: env.organization.id, deviceId: device.id, requestedAt: '2026-09-01T10:00:00.000000Z' });
    const newest = await seedAttempt({
      orgId: env.organization.id,
      deviceId: device.id,
      requestedAt: '2026-09-02T10:00:00.000000Z',
      status: 'created',
      sequenceNumber: '9223372036854775807',
    });

    const res = await get(env.token, device.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attempts.map((a: { requestId: string }) => a.requestId)).toEqual([newest, oldest]);
    expect(body.attempts[0].sequenceNumber).toBe('9223372036854775807');
    expect(body.attempts[1].status).toBe('requested');
    expect(body.nextBefore).toBeUndefined();
  });

  runDb('keyset pages never skip or repeat across equal and sub-millisecond requested_at', async () => {
    const env = await setupTestEnvironment({ rolePermissions: [{ resource: 'devices', action: 'read' }] });
    const device = await createDevice({ orgId: env.organization.id, siteId: env.site.id });
    const rows: Array<{ id: string; at: string }> = [];
    const add = async (at: string) =>
      rows.push({ id: await seedAttempt({ orgId: env.organization.id, deviceId: device.id, requestedAt: at }), at });
    // Three rows sharing one instant, three differing only in microseconds,
    // one clearly older -- 7 rows, paged 2 at a time.
    for (let i = 0; i < 3; i++) await add('2026-09-02T10:00:00.500000Z');
    for (const micros of ['500123', '500456', '500789']) await add(`2026-09-02T10:00:00.${micros}Z`);
    await add('2026-09-01T10:00:00.000000Z');

    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 10; page++) {
      const qs = `?limit=2${before ? `&before=${before}` : ''}`;
      const body = await (await get(env.token, device.id, qs)).json();
      seen.push(...body.attempts.map((a: { requestId: string }) => a.requestId));
      before = body.nextBefore;
      if (!before) break;
    }
    // Full order, not just membership: requested_at desc, then request_id desc.
    const expected = [...rows]
      .sort((x, y) => (x.at === y.at ? (x.id < y.id ? 1 : -1) : x.at < y.at ? 1 : -1))
      .map((r) => r.id);
    expect(seen).toEqual(expected);
  });

  runDb("another org's device is a 404 and its rows never leak", async () => {
    const a = await setupTestEnvironment({ rolePermissions: [{ resource: 'devices', action: 'read' }] });
    const b = await setupTestEnvironment({ rolePermissions: [{ resource: 'devices', action: 'read' }] });
    const aDevice = await createDevice({ orgId: a.organization.id, siteId: a.site.id });
    const bDevice = await createDevice({ orgId: b.organization.id, siteId: b.site.id });
    await seedAttempt({ orgId: a.organization.id, deviceId: aDevice.id, requestedAt: '2026-09-02T10:00:00.000000Z', message: 'org-a-secret' });
    await seedAttempt({ orgId: b.organization.id, deviceId: bDevice.id, requestedAt: '2026-09-02T10:00:00.000000Z', message: 'org-b-secret' });

    const cross = await get(b.token, aDevice.id);
    expect(cross.status).toBe(404);
    expect(await cross.text()).not.toContain('org-a-secret');

    const own = await get(b.token, bDevice.id);
    expect(own.status).toBe(200);
    const text = await own.text();
    expect(text).toContain('org-b-secret');
    expect(text).not.toContain('org-a-secret');
  });

  runDb('rejects malformed paging with 400 against the live stack', async () => {
    const env = await setupTestEnvironment({ rolePermissions: [{ resource: 'devices', action: 'read' }] });
    const device = await createDevice({ orgId: env.organization.id, siteId: env.site.id });
    expect((await get(env.token, device.id, '?before=garbage')).status).toBe(400);
    expect((await get(env.token, device.id, '?limit=abc')).status).toBe(400);
  });

  runDb('requires devices:read', async () => {
    const env = await setupTestEnvironment({ rolePermissions: [{ resource: 'scripts', action: 'read' }] });
    const device = await createDevice({ orgId: env.organization.id, siteId: env.site.id });
    expect((await get(env.token, device.id)).status).toBe(403);
  });
});

describe('inline restore-point subqueries (script execution / software deployment)', () => {
  runDb('resolve the newest ledger row for the link id, and null when there is none', async () => {
    const env = await setupTestEnvironment({ rolePermissions: [{ resource: 'devices', action: 'read' }] });
    const device = await createDevice({ orgId: env.organization.id, siteId: env.site.id });
    const executionId = randomUUID();
    const deploymentId = randomUUID();
    await seedAttempt({ orgId: env.organization.id, deviceId: device.id, requestedAt: '2026-09-01T10:00:00.000000Z', scriptExecutionId: executionId });
    await seedAttempt({
      orgId: env.organization.id,
      deviceId: device.id,
      requestedAt: '2026-09-02T10:00:00.000000Z',
      status: 'busy',
      scriptExecutionId: executionId,
      softwareDeploymentId: deploymentId,
    });

    const rows = await withSystemDbAccessContext(async () =>
      await db.execute<{ script: unknown; none: unknown; software: unknown; wrongDevice: unknown }>(sql`select
        ${scriptExecutionRestorePointSql(sql`${executionId}::uuid`)} as script,
        ${scriptExecutionRestorePointSql(sql`${randomUUID()}::uuid`)} as none,
        ${deploymentResultRestorePointSql(sql`${deploymentId}::uuid`, sql`${device.id}::uuid`)} as software,
        ${deploymentResultRestorePointSql(sql`${deploymentId}::uuid`, sql`${randomUUID()}::uuid`)} as "wrongDevice"`),
    );
    const row = Array.from(rows)[0];
    expect(row!.script).toMatchObject({ status: 'busy' });
    expect(row!.none).toBeNull();
    expect(row!.software).toMatchObject({ status: 'busy' });
    expect(row!.wrongDevice).toBeNull();
  });
});
