/**
 * Real-PostgreSQL proof for persistent log-correlation rule admission.
 *
 * Rules write one shared org-wide snapshot and may create an alert. A caller
 * with a defined site ceiling must therefore be rejected before that service
 * path runs; only an unrestricted caller may update the global state.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { expect, it } from 'vitest';

import { db, withSystemDbAccessContext } from '../../db';
import {
  alerts,
  deviceEventLogs,
  devices,
  logCorrelationRules,
  logCorrelations,
  organizationUsers,
} from '../../db/schema';
import { logsRoutes } from '../../routes/logs';
import { clearPermissionCache } from '../../services/permissions';
import { createAccessToken } from '../../services/jwt';
import { createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function mfaToken(env: TestEnvironment): Promise<string> {
  return createAccessToken({
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: env.organization.id,
    partnerId: env.partner.id,
    scope: 'organization',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  });
}

async function setSiteCeiling(env: TestEnvironment, siteIds: string[] | null): Promise<void> {
  await withSystemDbAccessContext(async () => {
    await db
      .update(organizationUsers)
      .set({ siteIds })
      .where(and(
        eq(organizationUsers.userId, env.user.id),
        eq(organizationUsers.orgId, env.organization.id),
      ));
  });
  await clearPermissionCache(env.user.id);
}

async function invokeRules(token: string): Promise<Response> {
  const app = new Hono();
  app.route('/logs', logsRoutes);
  return app.request('/logs/correlation/detect', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({}),
  });
}

runDb('denies selected and empty site ceilings without persistent effects, then allows unrestricted execution', async () => {
  const env = await setupTestEnvironment();
  const hiddenSite = await createSite({ orgId: env.organization.id });
  const testDb = getTestDb();

  const [visibleDevice, hiddenDevice] = await testDb
    .insert(devices)
    .values([
      {
        orgId: env.organization.id,
        siteId: env.site.id,
        agentId: `corr-visible-${randomUUID()}`,
        hostname: 'corr-visible-host',
        osType: 'linux',
        osVersion: '1',
        architecture: 'amd64',
        agentVersion: 'test',
        status: 'online',
      },
      {
        orgId: env.organization.id,
        siteId: hiddenSite.id,
        agentId: `corr-hidden-${randomUUID()}`,
        hostname: 'corr-hidden-host',
        osType: 'linux',
        osVersion: '1',
        architecture: 'amd64',
        agentVersion: 'test',
        status: 'online',
      },
    ])
    .returning({ id: devices.id });

  if (!visibleDevice || !hiddenDevice) throw new Error('failed to seed correlation devices');

  const marker = `correlation-marker-${randomUUID()}`;
  await testDb.insert(deviceEventLogs).values([
    {
      orgId: env.organization.id,
      deviceId: visibleDevice.id,
      timestamp: new Date(),
      level: 'error',
      category: 'application',
      source: 'integration-test',
      message: marker,
    },
    {
      orgId: env.organization.id,
      deviceId: hiddenDevice.id,
      timestamp: new Date(),
      level: 'error',
      category: 'application',
      source: 'integration-test',
      message: marker,
    },
  ]);

  const [rule] = await testDb
    .insert(logCorrelationRules)
    .values({
      orgId: env.organization.id,
      name: 'Site authority integration rule',
      pattern: marker,
      minOccurrences: 1,
      minDevices: 1,
      timeWindow: 300,
      severity: 'warning',
      alertOnMatch: true,
      isActive: true,
    })
    .returning({ id: logCorrelationRules.id });
  if (!rule) throw new Error('failed to seed correlation rule');

  const token = await mfaToken(env);
  for (const ceiling of [[env.site.id], []] as string[][]) {
    await setSiteCeiling(env, ceiling);
    const denied = await invokeRules(token);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'Access denied' });

    const [ruleState, correlationRows, alertRows] = await Promise.all([
      testDb
        .select({ lastMatchedAt: logCorrelationRules.lastMatchedAt })
        .from(logCorrelationRules)
        .where(eq(logCorrelationRules.id, rule.id)),
      testDb
        .select({ id: logCorrelations.id })
        .from(logCorrelations)
        .where(eq(logCorrelations.ruleId, rule.id)),
      testDb
        .select({ id: alerts.id })
        .from(alerts)
        .where(eq(alerts.orgId, env.organization.id)),
    ]);
    expect(ruleState[0]?.lastMatchedAt).toBeNull();
    expect(correlationRows).toEqual([]);
    expect(alertRows).toEqual([]);
  }

  await setSiteCeiling(env, null);
  const allowed = await invokeRules(token);
  const body = await allowed.json() as {
    count: number;
    detections: Array<{ affectedDevices: Array<{ deviceId: string }> }>;
    error?: string;
  };
  expect(allowed.status, body.error).toBe(200);
  expect(body.count).toBe(1);
  expect(body.detections[0]?.affectedDevices.map((device) => device.deviceId).sort())
    .toEqual([visibleDevice.id, hiddenDevice.id].sort());

  const [ruleState, correlationRows, alertRows] = await Promise.all([
    testDb
      .select({ lastMatchedAt: logCorrelationRules.lastMatchedAt })
      .from(logCorrelationRules)
      .where(eq(logCorrelationRules.id, rule.id)),
    testDb
      .select({ affectedDevices: logCorrelations.affectedDevices, sampleLogs: logCorrelations.sampleLogs })
      .from(logCorrelations)
      .where(eq(logCorrelations.ruleId, rule.id)),
    testDb
      .select({ deviceId: alerts.deviceId })
      .from(alerts)
      .where(eq(alerts.orgId, env.organization.id)),
  ]);
  expect(ruleState[0]?.lastMatchedAt).toBeInstanceOf(Date);
  expect(correlationRows).toHaveLength(1);
  expect(correlationRows[0]?.affectedDevices).toHaveLength(2);
  expect(correlationRows[0]?.sampleLogs).toHaveLength(2);
  expect(alertRows).toHaveLength(1);
  expect([visibleDevice.id, hiddenDevice.id]).toContain(alertRows[0]?.deviceId);
});
