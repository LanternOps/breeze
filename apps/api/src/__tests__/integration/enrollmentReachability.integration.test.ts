import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { db, withSystemDbAccessContext } from '../../db';
import { devices, enrollmentKeys } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { hashEnrollmentKey } from '../../services/enrollmentKeySecurity';
import { enrollmentRoutes } from '../../routes/agents/enrollment';
import { heartbeatRoutes } from '../../routes/agents/heartbeat';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const databaseUrl = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

function enrollmentApp(): Hono {
  const app = new Hono();
  app.route('/agents', enrollmentRoutes);
  return app;
}

function heartbeatApp(input: {
  deviceId: string;
  agentId: string;
  orgId: string;
  siteId: string;
  role: 'agent' | 'watchdog';
}): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', input as never);
    await next();
  });
  app.route('/agents', heartbeatRoutes);
  return app;
}

async function seedEnrollmentFixture(label: string) {
  const suffix = `${label}-${randomUUID()}`;
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const rawKey = `reachability-${suffix}`;
  await withSystemDbAccessContext(async () => {
    await db.insert(enrollmentKeys).values({
      orgId: org.id,
      siteId: site.id,
      name: `Reachability ${label}`,
      key: hashEnrollmentKey(rawKey),
      keySecretHash: null,
      usageCount: 0,
      maxUsage: null,
      expiresAt: null,
    });
  });
  return { orgId: org.id, siteId: site.id, rawKey, hostname: `reach-${suffix}` };
}

function enrollmentBody(rawKey: string, hostname: string) {
  return {
    enrollmentKey: rawKey,
    hostname,
    osType: 'linux' as const,
    osVersion: 'Integration Linux',
    architecture: 'amd64',
    agentVersion: '1.0.0-test',
  };
}

async function enroll(
  fixture: Awaited<ReturnType<typeof seedEnrollmentFixture>>,
  existingToken?: string,
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (existingToken) headers['x-agent-reenrollment-token'] = existingToken;
  return enrollmentApp().request('/agents/enroll', {
    method: 'POST',
    headers,
    body: JSON.stringify(enrollmentBody(fixture.rawKey, fixture.hostname)),
  });
}

async function selectDevice(deviceId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(devices).where(eq(devices.id, deviceId));
    return row ?? null;
  });
}

async function postHeartbeat(
  app: Hono,
  agentId: string,
  body: Record<string, unknown>,
) {
  return app.request(`/agents/${agentId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function waitForBackendsBlockedBy(
  blockerPid: number,
  minimum: number,
  label: string,
): Promise<number[]> {
  const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const deadline = Date.now() + 10_000;
  try {
    for (;;) {
      const rows = await admin<{ pid: number }[]>`
        SELECT pid
        FROM pg_catalog.pg_stat_activity
        WHERE datname = current_database()
          AND state = 'active'
          AND ${blockerPid} = ANY(pg_catalog.pg_blocking_pids(pid))
        ORDER BY pid
      `;
      if (rows.length >= minimum) return rows.map((row) => row.pid);
      if (Date.now() > deadline) {
        const blocked = await admin<{
          pid: number;
          state: string;
          waitEventType: string | null;
          waitEvent: string | null;
          blockers: number[];
          query: string;
        }[]>`
          SELECT pid, state, wait_event_type AS "waitEventType", wait_event AS "waitEvent",
                 pg_catalog.pg_blocking_pids(pid) AS blockers, query
          FROM pg_catalog.pg_stat_activity
          WHERE datname = current_database()
            AND cardinality(pg_catalog.pg_blocking_pids(pid)) > 0
          ORDER BY pid
        `;
        throw new Error(
          `${label}: expected >= ${minimum} backends blocked by pid ${blockerPid} within 10s; ` +
          `blocked=${JSON.stringify(blocked)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    await admin.end({ timeout: 1 });
  }
}

describe('enrollment reachability — real PostgreSQL (RMM-QA-039)', () => {
  runDb('fresh enrollment starts pending with no fabricated lastSeenAt', async () => {
    const fixture = await seedEnrollmentFixture('fresh');
    const response = await enroll(fixture);
    expect(response.status).toBe(201);
    const body = await response.json() as { deviceId: string };

    const row = await selectDevice(body.deviceId);
    expect(row?.status).toBe('pending');
    expect(row?.lastSeenAt).toBeNull();
  });

  runDb('re-enrollment preserves heartbeat time; main and watchdog credentials keep separate reachability axes', async () => {
    const fixture = await seedEnrollmentFixture('channels');
    const firstResponse = await enroll(fixture);
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json() as {
      deviceId: string;
      agentId: string;
      authToken: string;
    };
    const historicalLastSeenAt = new Date('2026-07-01T12:34:56.789Z');
    await withSystemDbAccessContext(async () => {
      await db.update(devices).set({
        status: 'offline',
        lastSeenAt: historicalLastSeenAt,
      }).where(eq(devices.id, first.deviceId));
    });

    const reenrollResponse = await enroll(fixture, first.authToken);
    expect(reenrollResponse.status).toBe(201);
    const reenrolled = await reenrollResponse.json() as {
      deviceId: string;
      agentId: string;
    };
    expect(reenrolled.deviceId).toBe(first.deviceId);
    const afterReenroll = await selectDevice(first.deviceId);
    expect(afterReenroll?.status).toBe('pending');
    expect(afterReenroll?.lastSeenAt?.toISOString()).toBe(historicalLastSeenAt.toISOString());

    const mainApp = heartbeatApp({
      deviceId: first.deviceId,
      agentId: reenrolled.agentId,
      orgId: fixture.orgId,
      siteId: fixture.siteId,
      role: 'agent',
    });
    const mainResponse = await postHeartbeat(mainApp, reenrolled.agentId, {
      status: 'ok',
      agentVersion: '1.0.0-test',
      metricsAvailable: false,
    });
    expect(mainResponse.status).toBe(200);
    const afterMain = await selectDevice(first.deviceId);
    expect(afterMain?.status).toBe('online');
    expect(afterMain?.lastSeenAt?.getTime()).toBeGreaterThan(historicalLastSeenAt.getTime());

    const mainLastSeenAt = afterMain!.lastSeenAt!;
    const watchdogApp = heartbeatApp({
      deviceId: first.deviceId,
      agentId: reenrolled.agentId,
      orgId: fixture.orgId,
      siteId: fixture.siteId,
      role: 'watchdog',
    });
    const watchdogResponse = await postHeartbeat(watchdogApp, reenrolled.agentId, {
      status: 'ok',
      agentVersion: '1.0.0-watchdog',
      role: 'watchdog',
      watchdogState: 'MONITORING',
    });
    expect(watchdogResponse.status).toBe(200);
    const afterWatchdog = await selectDevice(first.deviceId);
    expect(afterWatchdog?.status).toBe('online');
    expect(afterWatchdog?.lastSeenAt?.toISOString()).toBe(mainLastSeenAt.toISOString());
    expect(afterWatchdog?.watchdogStatus).toBe('connected');
    expect(afterWatchdog?.watchdogLastSeen).not.toBeNull();
    expect(afterWatchdog?.watchdogVersion).toBe('1.0.0-watchdog');
  });

  runDb('a re-enrollment that owns the row first cannot overwrite the later committed main heartbeat', async () => {
    const fixture = await seedEnrollmentFixture('race');
    const firstResponse = await enroll(fixture);
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json() as {
      deviceId: string;
      agentId: string;
      authToken: string;
    };
    const historicalLastSeenAt = new Date('2026-07-02T01:02:03.456Z');
    await withSystemDbAccessContext(async () => {
      await db.update(devices).set({
        status: 'offline',
        lastSeenAt: historicalLastSeenAt,
      }).where(eq(devices.id, first.deviceId));
    });

    const mainApp = heartbeatApp({
      deviceId: first.deviceId,
      agentId: first.agentId,
      orgId: fixture.orgId,
      siteId: fixture.siteId,
      role: 'agent',
    });
    const holder = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    let releaseHolder!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderPromise: Promise<unknown> | undefined;
    let reenrollPromise: Promise<Response> | undefined;
    let heartbeatPromise: Promise<Response> | undefined;
    try {
      const [holderPidRow] = await holder<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (!holderPidRow) throw new Error('row-lock holder backend has no pid');
      const holderPid = holderPidRow.pid;
      let holderReady!: () => void;
      const holderReadyPromise = new Promise<void>((resolve) => {
        holderReady = resolve;
      });
      holderPromise = holder.begin(async (tx) => {
        await tx`SELECT id FROM devices WHERE id = ${first.deviceId} FOR UPDATE`;
        holderReady();
        await releasePromise;
      });
      await holderReadyPromise;

      reenrollPromise = enroll(fixture, first.authToken);
      const [reenrollPid] = await waitForBackendsBlockedBy(
        holderPid!,
        1,
        're-enrollment row lock',
      );

      heartbeatPromise = postHeartbeat(mainApp, first.agentId, {
        status: 'ok',
        agentVersion: '1.0.1-race',
        metricsAvailable: false,
      });
      await waitForBackendsBlockedBy(
        reenrollPid!,
        1,
        'main heartbeat queued behind re-enrollment',
      );

      releaseHolder();
      await holderPromise;
      const [reenrollResult, heartbeatResult] = await Promise.allSettled([
        reenrollPromise,
        heartbeatPromise,
      ]);
      expect(reenrollResult.status).toBe('fulfilled');
      expect(heartbeatResult.status).toBe('fulfilled');
      if (reenrollResult.status === 'fulfilled') expect(reenrollResult.value.status).toBe(201);
      if (heartbeatResult.status === 'fulfilled') expect(heartbeatResult.value.status).toBe(200);

      const finalRow = await selectDevice(first.deviceId);
      expect(finalRow?.status).toBe('online');
      expect(finalRow?.lastSeenAt?.getTime()).toBeGreaterThan(historicalLastSeenAt.getTime());
    } finally {
      releaseHolder();
      if (holderPromise) await Promise.allSettled([holderPromise]);
      await Promise.allSettled([reenrollPromise, heartbeatPromise].filter(Boolean) as Promise<Response>[]);
      await holder.end({ timeout: 1 });
    }
  }, 30_000);
});
