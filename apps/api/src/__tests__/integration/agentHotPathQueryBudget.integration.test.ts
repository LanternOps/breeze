/**
 * #8053 — DB cost budget for the two hottest agent request paths, measured
 * against REAL PostgreSQL.
 *
 * Every agent heartbeats every 60 s and polls `/unifi-collectors` every 30 s,
 * so per-request transaction and statement counts multiply by the whole fleet:
 * at v0.121 the API's single event loop saturated at ~200-250 online agents.
 * These budgets pin the counts after #8053 so a new per-beat transaction or a
 * re-introduced per-request reload shows up as a red test instead of as the
 * next production saturation.
 *
 * How it counts: `postgres` is wrapped so the request pool (the one client
 * named `application_name: 'breeze-api'`, i.e. the production `db`) gets a
 * postgres.js `debug` hook. The hook sees every statement that pool sends —
 * `begin` (a top-level transaction), `savepoint`, the RLS `set_config`
 * prologue and every data statement. Fixture setup uses the separate
 * superuser test client and is never counted. The hook only records while
 * armed, around one request plus a short settle window for work the route
 * defers until after its transaction (`runAfterDbContextExit`).
 *
 * The agent-auth middleware is not mounted here (the agent context is set
 * directly, as in enrollmentReachability.integration.test.ts), so its one
 * transaction per request is outside these numbers; #8053 does not change it.
 *
 * The heartbeat budget is asserted on a STEADY-STATE beat, not on an immediate
 * re-beat: the clock moves 61 s (one beat interval), a sibling device in the
 * same org beats first (so org-wide and global caches are as warm as they are
 * for any org with more than one device), and the device's own Redis policy
 * caches are dropped (their 120 s TTL misses on about every other 60 s beat;
 * this measures the miss). That is the beat production actually pays for.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const recorder = vi.hoisted(() => ({
  recording: false,
  statements: [] as string[],
}));

vi.mock('postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof import('postgres')>();
  const original = (actual as unknown as { default: (...args: unknown[]) => unknown }).default;
  const wrapped = (...args: unknown[]) => {
    const urlOrOptions = args[0];
    const options = (typeof urlOrOptions === 'string' ? args[1] : urlOrOptions) as
      | { connection?: { application_name?: string } }
      | undefined;
    if (options?.connection?.application_name === 'breeze-api') {
      const instrumented = {
        ...options,
        debug: (_connection: number, query: string) => {
          if (recorder.recording) recorder.statements.push(query);
        },
      };
      return typeof urlOrOptions === 'string'
        ? original(urlOrOptions, instrumented)
        : original(instrumented);
    }
    return original(...args);
  };
  Object.assign(wrapped, original);
  return { ...actual, default: wrapped };
});

import { db, withSystemDbAccessContext } from '../../db';
import { enrollmentKeys } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestRedis } from './setup';
import { hashEnrollmentKey } from '../../services/enrollmentKeySecurity';
import { enrollmentRoutes } from '../../routes/agents/enrollment';
import { heartbeatRoutes } from '../../routes/agents/heartbeat';
import { unifiTelemetryRoutes } from '../../routes/agents/unifiTelemetry';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// One heartbeat interval, plus a second so a TTL of exactly 60 s has expired.
const NEXT_BEAT_MS = 61_000;

interface Measurement {
  status: number;
  transactions: number;
  savepoints: number;
  statements: number;
}

function summarize(status: number, statements: string[]): Measurement {
  const normalized = statements.map((s) => s.trim().toLowerCase());
  return {
    status,
    transactions: normalized.filter((s) => s === 'begin' || s.startsWith('begin ')).length,
    savepoints: normalized.filter((s) => s.startsWith('savepoint')).length,
    statements: normalized.length,
  };
}

async function measure(run: () => Promise<Response>): Promise<Measurement> {
  recorder.statements = [];
  recorder.recording = true;
  try {
    const response = await run();
    // Deferred post-transaction work (runAfterDbContextExit) is part of the
    // per-request cost; give it a moment to land before disarming.
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (process.env.DUMP_8053) {
      console.log(recorder.statements.map((s, i) => `${i}: ${s.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n'));
    }
    return summarize(response.status, recorder.statements);
  } finally {
    recorder.recording = false;
  }
}

// Shifts Date.now() only (cache expiry clocks); real timers and `new Date()`
// are untouched, so the driver and the route behave normally.
let clockOffsetMs = 0;
function advanceClock(ms: number): void {
  clockOffsetMs += ms;
}

async function seedOrg(label: string) {
  const suffix = `${label}-${randomUUID()}`;
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const rawKey = `hotpath-${suffix}`;
  await withSystemDbAccessContext(async () => {
    await db.insert(enrollmentKeys).values({
      orgId: org.id,
      siteId: site.id,
      name: `Hot path ${label}`,
      key: hashEnrollmentKey(rawKey),
      keySecretHash: null,
      usageCount: 0,
      maxUsage: null,
      expiresAt: null,
    });
  });
  return { partnerId: partner.id, orgId: org.id, siteId: site.id, rawKey, suffix };
}

type SeededOrg = Awaited<ReturnType<typeof seedOrg>>;

async function enrollDevice(org: SeededOrg, hostname: string) {
  const app = new Hono();
  app.route('/agents', enrollmentRoutes);
  const response = await app.request('/agents/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enrollmentKey: org.rawKey,
      hostname: `${hostname}-${org.suffix}`,
      osType: 'linux',
      osVersion: 'Integration Linux',
      architecture: 'amd64',
      agentVersion: '1.0.0-test',
    }),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { deviceId: string; agentId: string };
  return {
    deviceId: body.deviceId,
    agentId: body.agentId,
    orgId: org.orgId,
    siteId: org.siteId,
    partnerId: org.partnerId,
  };
}

type EnrolledDevice = Awaited<ReturnType<typeof enrollDevice>>;

function agentApp(device: EnrolledDevice): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', {
      deviceId: device.deviceId,
      agentId: device.agentId,
      orgId: device.orgId,
      siteId: device.siteId,
      partnerId: device.partnerId,
      role: 'agent',
      isPreAssignment: false,
    } as never);
    await next();
  });
  app.route('/agents', heartbeatRoutes);
  app.route('/agents', unifiTelemetryRoutes);
  return app;
}

function heartbeat(device: EnrolledDevice): Promise<Response> {
  return Promise.resolve(agentApp(device).request(`/agents/${device.agentId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'ok', agentVersion: '1.0.0-test', metricsAvailable: false }),
  }));
}

function pollCollectors(device: EnrolledDevice): Promise<Response> {
  return Promise.resolve(agentApp(device).request(`/agents/${device.agentId}/unifi-collectors`, { method: 'GET' }));
}

/** Drop the device's own Redis policy caches (helper, pam, event log, ...). */
async function dropDeviceRedisCaches(deviceId: string): Promise<void> {
  const redis = getTestRedis();
  const keys = await redis.keys(`*${deviceId}*`);
  if (keys.length > 0) await redis.del(...keys);
}

describe('agent hot-path DB budget (#8053) — real PostgreSQL', () => {
  beforeEach(() => {
    recorder.recording = false;
    recorder.statements = [];
    clockOffsetMs = 0;
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffsetMs);
  });
  afterEach(() => {
    recorder.recording = false;
    vi.restoreAllMocks();
  });

  runDb('the request pool is instrumented (guards the budget tests below against a vacuous zero)', async () => {
    const measured = await measure(async () => {
      await withSystemDbAccessContext(async () => { await db.execute('select 1' as never); });
      return new Response(null, { status: 204 });
    });
    expect(measured.transactions).toBe(1);
    expect(measured.statements).toBeGreaterThanOrEqual(3);
  });

  runDb('POST /agents/:id/heartbeat: a steady-state beat stays inside its transaction and statement budget', async () => {
    const org = await seedOrg('heartbeat');
    const device = await enrollDevice(org, 'target');
    const sibling = await enrollDevice(org, 'sibling');

    const cold = await measure(() => heartbeat(device));
    const warm = await measure(() => heartbeat(device));

    advanceClock(NEXT_BEAT_MS);
    expect((await heartbeat(sibling)).status).toBe(200);
    await dropDeviceRedisCaches(device.deviceId);
    const steady = await measure(() => heartbeat(device));

    console.log(
      '[#8053 budget] heartbeat cold:', JSON.stringify(cold),
      'warm:', JSON.stringify(warm),
      'steady:', JSON.stringify(steady),
    );

    expect(cold.status).toBe(200);
    expect(warm.status).toBe(200);
    expect(steady.status).toBe(200);
    // Org block + the shared post-commit policy context + the OneDrive context.
    // Before #8053: 9 transactions, 96 statements on this same beat.
    expect(steady.transactions).toBeLessThanOrEqual(3);
    // Pinned at the measured count (69) plus one. Any new per-beat transaction
    // costs at least three (BEGIN, the RLS prologue, COMMIT), so it trips this.
    // If a change legitimately adds a query, raise this number in the same PR
    // and say why; the remaining bulk is ~26 repeated device/org/group reads
    // across the policy resolvers (#8053 follow-up).
    expect(steady.statements).toBeLessThanOrEqual(70);
  });

  runDb('GET /agents/:id/unifi-collectors: a device with no collectors costs one probe, then nothing until the TTL', async () => {
    const org = await seedOrg('collectors');
    const device = await enrollDevice(org, 'poller');

    const cold = await measure(() => pollCollectors(device));
    const warm = await measure(() => pollCollectors(device));
    advanceClock(NEXT_BEAT_MS);
    const nextPoll = await measure(() => pollCollectors(device));
    console.log(
      '[#8053 budget] unifi-collectors cold:', JSON.stringify(cold),
      'warm:', JSON.stringify(warm),
      'next minute:', JSON.stringify(nextPoll),
    );

    expect(cold.status).toBe(200);
    expect(warm.status).toBe(200);
    expect(await (await pollCollectors(device)).json()).toEqual({ collectors: [] });
    expect(cold.transactions).toBeLessThanOrEqual(1);
    expect(cold.statements).toBeLessThanOrEqual(4);
    expect(warm.transactions).toBe(0);
    expect(warm.statements).toBe(0);
    expect(nextPoll.statements).toBe(0);
  });
});
