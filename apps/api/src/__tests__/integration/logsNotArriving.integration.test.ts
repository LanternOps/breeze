/**
 * #8612 (W05 of #8607) — "Logs not arriving" after a log-level raise, against
 * real PostgreSQL and the real JWT/auth/RLS stack (agent_logs is RLS-scoped,
 * device_commands is system-scoped; the detail route reads both under the
 * caller's request context).
 *
 * The load-bearing property: the agent_logs probe is bounded by the command's
 * created_at, NOT completed_at. The W03 canary line ships (and is stored)
 * before the API records the command's completion; a completed_at bound would
 * miss it and false-alarm. The control below proves the fixture puts the
 * canary in exactly that window.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq, gte, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';
import { agentLogs, deviceCommands, devices } from '../../db/schema';
import { coreRoutes } from '../../routes/devices/core';
import { createAccessToken } from '../../services/jwt';
import { db } from '../../db';

// Lets one test make the real service fail at the Postgres level (not a JS
// throw), so the route's handling of an aborted statement is exercised.
const failInPostgres = vi.hoisted(() => ({ on: false }));
vi.mock('../../services/logsNotArriving', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/logsNotArriving')>();
  return {
    ...actual,
    logsNotArriving: async (...args: Parameters<typeof actual.logsNotArriving>) => {
      if (failInPostgres.on) await db.execute(sql`SELECT 1 / 0`);
      return actual.logsNotArriving(...args);
    },
  };
});
afterEach(() => { failInPostgres.on = false; });

const MIN = 60_000;

async function fixture() {
  const env = await setupTestEnvironment({ scope: 'organization' });
  const suffix = randomUUID();
  const [device] = await getTestDb().insert(devices).values({
    orgId: env.organization.id,
    siteId: env.site.id,
    agentId: `logs-not-arriving-${suffix}`.slice(0, 64),
    hostname: `lna-${suffix.slice(0, 8)}`,
    osType: 'linux', osVersion: 'test', architecture: 'x86_64', agentVersion: 'test',
    status: 'online',
    logShippingState: 'ok',
  }).returning({ id: devices.id });
  if (!device) throw new Error('device fixture insert returned no row');

  const now = Date.now();
  const createdAt = new Date(now - 12 * MIN);
  const completedAt = new Date(now - 10 * MIN);
  await getTestDb().insert(deviceCommands).values({
    deviceId: device.id,
    type: 'set_log_level',
    payload: { level: 'debug', durationMinutes: 60 },
    status: 'completed',
    createdAt,
    executedAt: createdAt,
    completedAt,
    result: {
      status: 'completed',
      exitCode: 0,
      durationMs: 3,
      stdout: JSON.stringify({
        newLevel: 'debug', appliedLevel: 'debug', baseLevel: 'warn', durationMinutes: 60,
        expiresAt: new Date(now + 50 * MIN).toISOString(), persisted: true,
      }),
    },
  });

  const token = await createAccessToken({
    sub: env.user.id, email: env.user.email, roleId: env.role.id,
    orgId: env.organization.id, partnerId: env.partner.id, scope: 'organization',
    mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
  const app = new Hono();
  app.route('/devices', coreRoutes);

  async function detail() {
    const res = await app.request(`/devices/${device!.id}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as { logsNotArriving?: { since: string } | null };
  }

  return { env, deviceId: device.id, createdAt, completedAt, detail };
}

describe('logsNotArriving on device detail (real breeze_app PostgreSQL)', () => {
  it('reports the raise when no log arrived since the command was created', async () => {
    const f = await fixture();
    const body = await f.detail();
    expect(body.logsNotArriving).toEqual({ since: f.completedAt.toISOString() });
  });

  it('a canary stored between command creation and completion suppresses it (control: a completed_at bound would miss it)', async () => {
    const f = await fixture();
    const canaryAt = new Date(f.createdAt.getTime() + MIN); // after creation, before completion
    await getTestDb().insert(agentLogs).values({
      deviceId: f.deviceId,
      orgId: f.env.organization.id,
      timestamp: canaryAt,
      createdAt: canaryAt,
      level: 'info',
      component: 'heartbeat',
      message: 'log shipping level raised',
    });

    // Control: the canary is invisible to a completed_at-bounded probe, so
    // that variant would have false-alarmed on this exact fixture.
    const [{ n }] = await getTestDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(agentLogs)
      .where(and(eq(agentLogs.deviceId, f.deviceId), gte(agentLogs.createdAt, f.completedAt))) as [{ n: number }];
    expect(n).toBe(0);

    const body = await f.detail();
    expect(body.logsNotArriving).toBeNull();
  });

  it('a Postgres error inside the check does not poison the request transaction', async () => {
    // The detail route runs in one request transaction. Without a savepoint,
    // the failed statement aborts it (25P02): every later read in the handler
    // fails and the commit rejects, so the whole detail load errors instead of
    // degrading to logsNotArriving: null.
    const f = await fixture();
    failInPostgres.on = true;
    const body = await f.detail();
    expect(body.logsNotArriving).toBeNull();
  });
});
