/**
 * #11225: the agent paths from the #11203 audit. Each case forces a real
 * statement failure where a catch means to survive it, runs the real handler on
 * real Postgres as `breeze_app`, and asserts both halves: the catch's intended
 * answer reaches the agent, and the work the same transaction did survives.
 */
import './setup';

import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const faults = vi.hoisted(() => ({
  /** A db.select() whose field map has this key fails on the current transaction. */
  selectWithField: null as string | null,
  /** How many selects the fault hit, so a case cannot pass by never reaching it. */
  selectHits: 0,
  approvers: null as string[] | null,
  /** Elevation ingest refuses a device with UAC capture off, the default. */
  pamEnabled: false,
}));

vi.mock('../../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db')>();
  const { sql: rawSql } = await import('drizzle-orm');
  const failingQuery = () => {
    // Bound at call time, like a real query builder: `then` may run after the
    // caller's withDbTransaction scope has exited.
    const query = actual.db.execute(rawSql`SELECT 1/0`);
    const chain: unknown = new Proxy(function noop() {}, {
      get: (_target, prop) => (prop === 'then'
        ? (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => query.then(resolve, reject)
        : () => chain),
    });
    return chain;
  };
  return {
    ...actual,
    db: new Proxy(actual.db, {
      get(target, prop) {
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        if (prop !== 'select') return value;
        return (fields?: Record<string, unknown>) => {
          if (faults.selectWithField && fields && faults.selectWithField in fields) {
            faults.selectHits += 1;
            return failingQuery();
          }
          return (value as (f?: unknown) => unknown)(fields);
        };
      },
    }),
  };
});

vi.mock('../../services/sentry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/sentry')>();
  return { ...actual, captureException: vi.fn() };
});

vi.mock('../../routes/agents/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/agents/helpers')>();
  return {
    ...actual,
    buildPamConfigUpdate: async (...args: Parameters<typeof actual.buildPamConfigUpdate>) => {
      const settings = await actual.buildPamConfigUpdate(...args);
      return faults.pamEnabled ? { ...settings, uacInterceptionEnabled: true } : settings;
    },
  };
});

vi.mock('../../services/pamApprovers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/pamApprovers')>();
  return {
    ...actual,
    resolveElevationApprovers: async (orgId: string) =>
      faults.approvers ?? actual.resolveElevationApprovers(orgId),
  };
});

import {
  agentLogs,
  approvalRequests,
  deviceEventLogs,
  devices,
  deviceIpHistory,
  elevationRequests,
  onedriveDeviceState,
} from '../../db/schema';
import { elevationRequestsRoutes } from '../../routes/agents/elevationRequests';
import { eventLogsRoutes } from '../../routes/agents/eventlogs';
import { heartbeatRoutes } from '../../routes/agents/heartbeat';
import { createAgentWsHandlers } from '../../routes/agentWs';
import { captureException } from '../../services/sentry';
import { clearStatementFaults, failWritesOn } from './caughtQueryFaults';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const CREDENTIAL_HASH = createHash('sha256').update('caught-query-agent').digest('hex');

async function deviceFixture(overrides: Partial<typeof devices.$inferInsert> = {}) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const agentId = `caught-query-${randomUUID()}`;
  const [device] = await getTestDb().insert(devices).values({
    orgId: org.id,
    siteId: site.id,
    agentId,
    agentTokenHash: CREDENTIAL_HASH,
    hostname: `caught-query-${randomUUID()}`,
    osType: 'windows',
    osVersion: 'test',
    architecture: 'amd64',
    agentVersion: '1.0.0-test',
    status: 'online',
    lastSeenAt: new Date(Date.now() - 60_000),
    enrolledAt: new Date(),
    ...overrides,
  }).returning();
  return {
    deviceId: device!.id,
    agentId,
    orgId: org.id,
    siteId: site.id,
    partnerId: partner.id,
  };
}
type DeviceFixture = Awaited<ReturnType<typeof deviceFixture>>;

function readDevice(deviceId: string) {
  return getTestDb().select().from(devices).where(eq(devices.id, deviceId)).then((rows) => rows[0]!);
}

function agentApp(
  device: DeviceFixture,
  routes: Hono,
  role: 'agent' | 'watchdog' = 'agent',
): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', {
      deviceId: device.deviceId,
      agentId: device.agentId,
      orgId: device.orgId,
      siteId: device.siteId,
      partnerId: device.partnerId,
      role,
      isPreAssignment: false,
    } as never);
    await next();
  });
  app.route('/agents', routes);
  return app;
}

describe('heartbeat catches inside the request transaction (real PostgreSQL)', () => {
  afterEach(clearStatementFaults);

  const beat = (device: DeviceFixture, role: 'agent' | 'watchdog', body: Record<string, unknown>) =>
    agentApp(device, heartbeatRoutes, role).request(`/agents/${device.agentId}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'ok', agentVersion: '1.0.0-test', metricsAvailable: false, ...body }),
    });

  runDb('CONTROL: a watchdog beat with restart activity writes its trail row', async () => {
    const device = await deviceFixture();
    const res = await beat(device, 'watchdog', { role: 'watchdog', watchdogState: 'MONITORING', mainAgentRestartCount24h: 3 });
    expect(res.status, await res.clone().text()).toBe(200);
    const logs = await getTestDb().select().from(agentLogs).where(eq(agentLogs.deviceId, device.deviceId));
    expect(logs.map((row) => row.component)).toContain('watchdog');
  });

  runDb('a failed restart-activity log answers 200 and keeps the watchdog write', async () => {
    const device = await deviceFixture();
    await failWritesOn('agent_logs');
    const res = await beat(device, 'watchdog', { role: 'watchdog', watchdogState: 'MONITORING', mainAgentRestartCount24h: 3 });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await readDevice(device.deviceId)).watchdogLastSeen).not.toBeNull();
  });

  runDb('a failed watchdog status write still answers the beat', async () => {
    const device = await deviceFixture();
    await failWritesOn('devices', { ops: 'UPDATE', when: 'NEW.watchdog_last_seen IS DISTINCT FROM OLD.watchdog_last_seen' });
    const res = await beat(device, 'watchdog', { role: 'watchdog', watchdogState: 'MONITORING' });
    expect(res.status, await res.clone().text()).toBe(200);
  });

  runDb('a failed onedrive state upsert answers 200 and keeps the device write', async () => {
    const device = await deviceFixture();
    const before = (await readDevice(device.deviceId)).lastSeenAt!;
    await failWritesOn('onedrive_device_state');
    const res = await beat(device, 'agent', {
      onedriveDeviceState: { signedIn: true, filesOnDemandOn: true },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await readDevice(device.deviceId)).lastSeenAt!.getTime()).toBeGreaterThan(before.getTime());
    expect(await getTestDb().select().from(onedriveDeviceState).where(eq(onedriveDeviceState.deviceId, device.deviceId))).toEqual([]);
  });
});

describe('agent socket catches inside the message transaction (real PostgreSQL)', () => {
  const opened: Array<() => Promise<void>> = [];
  beforeEach(() => {
    faults.selectWithField = null;
    faults.selectHits = 0;
    vi.mocked(captureException).mockClear();
  });
  afterEach(async () => {
    faults.selectWithField = null;
    await clearStatementFaults();
    // An open socket keeps a ping timer that could report into a later case.
    while (opened.length > 0) await opened.pop()!();
  });

  async function openSocket(device: DeviceFixture) {
    const sent: Array<Record<string, unknown>> = [];
    const ws = {
      send: (frame: string) => { sent.push(JSON.parse(frame) as Record<string, unknown>); },
      close: () => {},
    } as unknown as Parameters<ReturnType<typeof createAgentWsHandlers>['onMessage']>[1];
    const handlers = createAgentWsHandlers(device.agentId, {
      agentId: device.agentId,
      siteId: device.siteId,
      installIncarnation: 1,
      deviceId: device.deviceId,
      orgId: device.orgId,
      partnerId: device.partnerId,
      credentialTokenHash: CREDENTIAL_HASH,
    });
    await handlers.onOpen({}, ws);
    opened.push(async () => { await handlers.onClose({}, ws); });
    sent.length = 0;
    vi.mocked(captureException).mockClear();
    return {
      sent,
      handlers,
      ws,
      send: (message: Record<string, unknown>) =>
        handlers.onMessage({ data: JSON.stringify(message) } as MessageEvent, ws),
    };
  }

  runDb('update_status: a failed attempt-record read does not cost the status flip', async () => {
    const device = await deviceFixture();
    const socket = await openSocket(device);
    faults.selectWithField = 'attemptCount';
    await socket.send({ type: 'update_status', targetVersion: `9.9.${Date.now()}` });
    faults.selectWithField = null;
    expect(faults.selectHits).toBe(1);
    expect(socket.sent.filter((frame) => frame.code === 'PROCESSING_ERROR')).toEqual([]);
    const row = await readDevice(device.deviceId);
    expect(row.status).toBe('updating');
    // The read failed, so this is a fresh episode.
    expect(row.updateAttemptCount).toBe(1);
  });

  runDb('update_status: a failed write stays a logged no-op with no error frame, and the next frame retries it', async () => {
    const device = await deviceFixture();
    const socket = await openSocket(device);
    const version = `9.8.${Date.now()}`;
    await failWritesOn('devices', { ops: 'UPDATE', when: `NEW.status = 'updating'` });
    await socket.send({ type: 'update_status', targetVersion: version });
    expect(socket.sent.filter((frame) => frame.code === 'PROCESSING_ERROR')).toEqual([]);
    expect((await readDevice(device.deviceId)).status).toBe('online');

    await clearStatementFaults();
    await socket.send({ type: 'update_status', targetVersion: version });
    expect((await readDevice(device.deviceId)).status).toBe('updating');
  });

  runDb('CONTROL heartbeat: a failed IP history write is already isolated by its own tx savepoint', async () => {
    const device = await deviceFixture();
    const socket = await openSocket(device);
    const before = (await readDevice(device.deviceId)).lastSeenAt!;
    await failWritesOn('device_ip_history');
    await socket.send({
      type: 'heartbeat',
      timestamp: Date.now(),
      ipHistoryUpdate: {
        currentIPs: [{ interfaceName: 'eth0', ipAddress: '192.0.2.10', ipType: 'ipv4', assignmentType: 'dhcp' }],
      },
    });
    expect(socket.sent.map((frame) => frame.type)).toContain('heartbeat_ack');
    expect((await readDevice(device.deviceId)).lastSeenAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(await getTestDb().select().from(deviceIpHistory).where(eq(deviceIpHistory.deviceId, device.deviceId))).toEqual([]);
  });

  runDb('heartbeat: a failed status write still acknowledges the frame', async () => {
    const device = await deviceFixture();
    const socket = await openSocket(device);
    await failWritesOn('devices', { ops: 'UPDATE', when: 'NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at' });
    await socket.send({ type: 'heartbeat', timestamp: Date.now() });
    expect(socket.sent.filter((frame) => frame.code === 'PROCESSING_ERROR')).toEqual([]);
    expect(socket.sent.map((frame) => frame.type)).toContain('heartbeat_ack');
  });

  runDb('onClose: a failed status read falls back to offline and reports once, not again at commit', async () => {
    const device = await deviceFixture();
    const socket = await openSocket(device);
    faults.selectWithField = 'hostname';
    await socket.handlers.onClose({}, socket.ws);
    faults.selectWithField = null;
    expect(faults.selectHits).toBe(1);
    expect((await readDevice(device.deviceId)).status).toBe('offline');
    expect(vi.mocked(captureException)).toHaveBeenCalledTimes(1);
  });

  runDb('onError: a failed status read falls back to offline with no commit failure', async () => {
    const device = await deviceFixture();
    const socket = await openSocket(device);
    faults.selectWithField = 'status';
    socket.handlers.onError({}, socket.ws);
    await vi.waitFor(async () => {
      expect((await readDevice(device.deviceId)).status).toBe('offline');
    }, { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    faults.selectWithField = null;
    expect(faults.selectHits).toBeGreaterThan(0);
    expect(vi.mocked(captureException)).not.toHaveBeenCalled();
  });
});

describe('eventlogs catches inside the request transaction (real PostgreSQL)', () => {
  afterEach(clearStatementFaults);

  const event = (index: number, message = `event ${index}`) => ({
    timestamp: new Date(Date.now() - 60_000 + index).toISOString(),
    level: 'error',
    category: 'system',
    source: 'caught-query',
    eventId: `evt-${index}`,
    message,
  });
  const submit = (device: DeviceFixture, events: unknown[]) =>
    agentApp(device, eventLogsRoutes).request(`/agents/${device.agentId}/eventlogs`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
    });

  runDb('a failed second batch keeps the first and answers the partial failure body', async () => {
    const device = await deviceFixture();
    const events = Array.from({ length: 150 }, (_, index) => event(index, index === 120 ? 'poison' : undefined));
    await failWritesOn('device_event_logs', { ops: 'INSERT', when: `NEW.message = 'poison'` });
    const res = await submit(device, events);
    expect(res.status).toBe(500);
    const body = await res.json() as { success: boolean; error: string; count: number; expectedCount: number };
    expect(body).toMatchObject({ success: false, error: 'Partial insert failure', count: 100, expectedCount: 150 });
    const rows = await getTestDb().select().from(deviceEventLogs).where(eq(deviceEventLogs.deviceId, device.deviceId));
    expect(rows).toHaveLength(100);
  });

  /** Run a submit with one kind of select failing, and prove the fault fired. */
  async function submitWithFailedSelect(device: DeviceFixture, field: string) {
    faults.selectHits = 0;
    faults.selectWithField = field;
    try {
      const res = await submit(device, [event(1)]);
      expect(faults.selectHits).toBeGreaterThan(0);
      return res;
    } finally {
      faults.selectWithField = null;
    }
  }

  runDb('a failed settings read falls back to the defaults and keeps the device lookup answer', async () => {
    const device = await deviceFixture();
    const res = await submitWithFailedSelect(device, 'deviceRole');
    expect(res.status, await res.clone().text()).toBe(200);
    const rows = await getTestDb().select().from(deviceEventLogs).where(eq(deviceEventLogs.deviceId, device.deviceId));
    expect(rows).toHaveLength(1);
  });

  runDb('a failed forwarding-config read answers 200 and keeps the inserted rows', async () => {
    const device = await deviceFixture();
    const res = await submitWithFailedSelect(device, 'settings');
    expect(res.status, await res.clone().text()).toBe(200);
    const rows = await getTestDb().select().from(deviceEventLogs).where(eq(deviceEventLogs.deviceId, device.deviceId));
    expect(rows).toHaveLength(1);
  });
});

describe('elevation request catches inside their transactions (real PostgreSQL)', () => {
  beforeEach(() => { faults.pamEnabled = true; });
  afterEach(async () => {
    faults.pamEnabled = false;
    faults.selectWithField = null;
    faults.approvers = null;
    await clearStatementFaults();
  });

  const elevation = (device: DeviceFixture) =>
    agentApp(device, elevationRequestsRoutes).request(`/agents/${device.agentId}/elevation-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subject_username: 'caught-query-user',
        target_executable_path: 'C:\\Windows\\System32\\notepad.exe',
      }),
    });

  runDb('a failed decisioning read fails safe to pending and commits the request', async () => {
    const device = await deviceFixture();
    faults.selectHits = 0;
    faults.selectWithField = 'verdict';
    const res = await elevation(device);
    faults.selectWithField = null;
    expect(faults.selectHits).toBe(1);
    expect(res.status, await res.clone().text()).toBe(201);
    const rows = await getTestDb().select().from(elevationRequests).where(eq(elevationRequests.deviceId, device.deviceId));
    expect(rows.map((row) => row.status)).toEqual(['pending']);
  });

  runDb('a pending request fans out to its approvers: the insert runs after the request row commits', async () => {
    const device = await deviceFixture();
    const approver = await createUser({ partnerId: device.partnerId, orgId: device.orgId, email: `approver-${randomUUID()}@example.com` });
    faults.approvers = [approver.id];
    const res = await elevation(device);
    expect(res.status, await res.clone().text()).toBe(201);
    const rows = await getTestDb().select().from(approvalRequests).where(eq(approvalRequests.userId, approver.id));
    expect(rows).toHaveLength(1);
  });

  runDb('a failed mobile approval insert for one approver still fans out to the next', async () => {
    const device = await deviceFixture();
    const first = await createUser({ partnerId: device.partnerId, orgId: device.orgId, email: `first-${randomUUID()}@example.com` });
    const second = await createUser({ partnerId: device.partnerId, orgId: device.orgId, email: `second-${randomUUID()}@example.com` });
    faults.approvers = [first.id, second.id];
    await failWritesOn('approval_requests', { ops: 'INSERT', when: `NEW.user_id = '${first.id}'` });
    const res = await elevation(device);
    expect(res.status, await res.clone().text()).toBe(201);
    const rows = await getTestDb().select().from(approvalRequests).where(inArray(approvalRequests.userId, [first.id, second.id]));
    expect(rows.map((row) => row.userId)).toEqual([second.id]);
  });
});
