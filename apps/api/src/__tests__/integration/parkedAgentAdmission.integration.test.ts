/**
 * Pre-assignment admission, end to end against real Postgres + Redis.
 *
 * No product path can create a parked device yet (deploy-key enrollment lands
 * later), so the device is seeded directly, the only way the database allows:
 * inside a transaction that declared an enrollment admission. Every request
 * then goes through the REAL agent router mounted at its production path, with
 * a real bearer token, so the middleware, heartbeat, command, rotation, mTLS,
 * WebSocket and Helper ingresses are all exercised as deployed.
 *
 * Proven here:
 *   1. every agent-authenticated route in the live route table outside the
 *      parked allowlist refuses a parked device (403 device_pending_assignment),
 *      while the same routes do not refuse a device in a regular org;
 *   2. the heartbeat returns commands + credential rotation only, delivers a
 *      queued self_uninstall and nothing else, and records liveness;
 *   3. the command poll/ack pair is narrowed to self_uninstall;
 *   4. token rotation (mint + confirm) and certificate renewal still work;
 *   5. the agent WebSocket upgrade and the Helper token are refused.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/parkedAgentAdmission.integration.test.ts
 */
import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite } from './db-utils';
import { seedHoldingOrg } from './unassignedPoolFixtures';
import { declareParkedDeviceAdmission } from '../../services/unassignedPool/admission';
import { deviceCommands, devices } from '../../db/schema';
import { agentRoutes, shouldSkipAgentAuth } from '../../routes/agents/index';
import { createAgentWsRoutes, validateAgentToken } from '../../routes/agentWs';
import { helperAuth } from '../../middleware/helperAuth';
import { isParkedAllowedAgentPath } from '../../middleware/agentAuthParked';

const MOUNT = '/api/v1/agents';
const UUID = '6f1c7a52-8d0e-4b8f-9a55-0f5a3d1c2b7e';
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

interface SeededAgent {
  id: string;
  agentId: string;
  agentToken: string;
  helperToken: string;
}

function credentialColumns(suffix: string) {
  const agentToken = `brz_parked_agent_${suffix}`;
  const helperToken = `brz_parked_helper_${suffix}`;
  return {
    agentToken,
    helperToken,
    values: {
      agentTokenHash: digest(agentToken),
      helperTokenHash: digest(helperToken),
      // No watchdog credential yet, which alone makes a rotation due.
      watchdogTokenHash: null,
      tokenIssuedAt: new Date(),
      // Past two thirds of the certificate lifetime: renewal is due.
      mtlsCertIssuedAt: new Date(Date.now() - 80 * 3_600_000),
      mtlsCertExpiresAt: new Date(Date.now() + 10 * 3_600_000),
      status: 'online' as const,
      osType: 'linux' as const,
      osVersion: 'test',
      architecture: 'x64',
      agentVersion: '0.70.0',
    },
  };
}

async function seedParkedAgent(orgId: string, siteId: string): Promise<SeededAgent> {
  const suffix = randomUUID().slice(0, 8);
  const creds = credentialColumns(suffix);
  const agentId = `parked-admission-${suffix}`;
  const row = await getTestDb().transaction(async (tx: any) => {
    await declareParkedDeviceAdmission(tx);
    const [inserted] = await tx.insert(devices).values({
      orgId,
      siteId,
      agentId,
      hostname: `parked-${suffix}`,
      ...creds.values,
    }).returning({ id: devices.id });
    return inserted!;
  });
  return { id: row.id, agentId, agentToken: creds.agentToken, helperToken: creds.helperToken };
}

async function seedRegularAgent(orgId: string, siteId: string): Promise<SeededAgent> {
  const suffix = randomUUID().slice(0, 8);
  const creds = credentialColumns(suffix);
  const agentId = `regular-admission-${suffix}`;
  const [row] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId,
    hostname: `regular-${suffix}`,
    ...creds.values,
  }).returning({ id: devices.id });
  return { id: row!.id, agentId, agentToken: creds.agentToken, helperToken: creds.helperToken };
}

async function queueCommand(deviceId: string, type: string): Promise<string> {
  const [row] = await getTestDb().insert(deviceCommands).values({
    deviceId,
    type,
    payload: type === 'script' ? { scriptId: 'noop', content: 'echo hi' } : {},
    status: 'pending',
    targetRole: 'agent',
  }).returning({ id: deviceCommands.id });
  return row!.id;
}

function buildAgentApp(): Hono {
  const app = new Hono();
  app.route(MOUNT, agentRoutes);
  return app;
}

async function send(
  app: Hono,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${token}` } };
  if (method !== 'GET') {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  return app.request(path, init);
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Every agent-token-authenticated endpoint in the live route table. */
function agentAuthedEndpoints(agentId: string): Array<{ method: string; pattern: string; path: string }> {
  const seen = new Set<string>();
  const out: Array<{ method: string; pattern: string; path: string }> = [];
  for (const route of agentRoutes.routes) {
    if (route.method === 'ALL') continue; // .use() registrations, covered by their endpoints
    if (!route.path.startsWith('/:id/')) continue;
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const concrete = route.path
      .replace(':id', agentId)
      .replace(/:[A-Za-z]+/g, (param) => (param === ':name' ? 'x' : UUID));
    const path = `${MOUNT}${concrete}`;
    if (shouldSkipAgentAuth(path, agentId)) continue;
    out.push({ method: route.method, pattern: route.path, path });
  }
  return out;
}

const heartbeatBody = {
  agentVersion: '0.70.1',
  status: 'ok',
  metrics: { cpuPercent: 99, ramPercent: 99, ramUsedMb: 4096, diskPercent: 99, diskUsedGb: 500 },
};

let partnerId: string;
let pool: { orgId: string; siteId: string };
let regularOrgId: string;
let regularSiteId: string;

// setup.ts truncates tenant tables before every test, so the tenant is
// re-seeded per test.
beforeEach(async () => {
  const partner = await createPartner({ status: 'active' });
  partnerId = partner.id;
  pool = await seedHoldingOrg(partnerId);
  // Helper enabled so the regular device's Helper session is admitted.
  const org = await createOrganization({ partnerId, status: 'active', settings: { helper: { enabled: true } } });
  const site = await createSite({ orgId: org.id });
  regularOrgId = org.id;
  regularSiteId = site.id;
});

describe('parked device — agent route admission (live route table)', () => {
  it('refuses every agent-authenticated route outside the allowlist, and only for the parked device', async () => {
    const parked = await seedParkedAgent(pool.orgId, pool.siteId);
    const regular = await seedRegularAgent(regularOrgId, regularSiteId);
    const app = buildAgentApp();

    const endpoints = agentAuthedEndpoints(parked.agentId);
    const denied = endpoints.filter((ep) => !isParkedAllowedAgentPath(ep.path.split('/').filter(Boolean), parked.agentId));
    // Floor so a broken enumeration cannot pass vacuously.
    expect(endpoints.length).toBeGreaterThanOrEqual(38);
    expect(denied.length).toBe(endpoints.length - 6);

    const admitted: string[] = [];
    for (const ep of denied) {
      const res = await send(app, ep.method, ep.path, parked.agentToken);
      const body = await readBody(res);
      if (res.status !== 403 || JSON.stringify(body) !== JSON.stringify({ error: 'device_pending_assignment' })) {
        admitted.push(`${ep.method} ${ep.pattern} -> ${res.status} ${JSON.stringify(body)}`);
      }
    }
    expect(admitted).toEqual([]);

    // Control: a device in a regular org reaches the handlers of a sample of
    // the same routes (validation errors are fine — the refusal is not).
    const sample = ['POST /:id/logs', 'PUT /:id/hardware', 'GET /:id/config', 'PUT /:id/security/recovery-keys'];
    for (const key of sample) {
      const [method, pattern] = key.split(' ') as [string, string];
      const path = `${MOUNT}${pattern.replace(':id', regular.agentId)}`;
      const res = await send(app, method, path, regular.agentToken);
      const body = await readBody(res);
      expect(body, `${key} for a regular device`).not.toEqual({ error: 'device_pending_assignment' });
      expect(res.status, `${key} for a regular device`).not.toBe(401);
    }
  }, 120_000);
});

describe('parked device — minimal heartbeat', () => {
  it('returns commands and credential rotation only, delivers self_uninstall and nothing else, and records liveness', async () => {
    const parked = await seedParkedAgent(pool.orgId, pool.siteId);
    const scriptId = await queueCommand(parked.id, 'script');
    const uninstallId = await queueCommand(parked.id, 'self_uninstall');
    const app = buildAgentApp();

    const res = await send(app, 'POST', `${MOUNT}/${parked.agentId}/heartbeat`, parked.agentToken, heartbeatBody);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(['commands', 'renewCert', 'rotateToken']);
    expect(body.renewCert).toBe(true);
    expect(body.rotateToken).toBe(true);
    const delivered = body.commands as Array<{ id: string; type: string }>;
    expect(delivered.map((cmd) => cmd.id)).toEqual([uninstallId]);

    // Refused work is terminal, not stranded: the parked claim cancels it.
    const [script] = await getTestDb().select({
      status: deviceCommands.status,
      executedAt: deviceCommands.executedAt,
      result: deviceCommands.result,
    }).from(deviceCommands).where(eq(deviceCommands.id, scriptId));
    expect(script).toMatchObject({ status: 'cancelled', executedAt: null });
    expect(script!.result).toMatchObject({ reason: 'device_pending_assignment' });

    const [row] = await getTestDb().select({
      lastSeenAt: devices.lastSeenAt,
      status: devices.status,
      agentVersion: devices.agentVersion,
    }).from(devices).where(eq(devices.id, parked.id));
    expect(row!.status).toBe('online');
    expect(row!.agentVersion).toBe('0.70.1');
    expect(row!.lastSeenAt).not.toBeNull();
  });

  it('a device in a regular org still gets the full heartbeat (positive control)', async () => {
    const regular = await seedRegularAgent(regularOrgId, regularSiteId);
    const res = await send(buildAgentApp(), 'POST', `${MOUNT}/${regular.agentId}/heartbeat`, regular.agentToken, heartbeatBody);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toContain('configUpdate');
  });
});

describe('parked device — lifecycle command poll and ack', () => {
  it('claims only self_uninstall and refuses results for any other command type', async () => {
    const parked = await seedParkedAgent(pool.orgId, pool.siteId);
    const scriptId = await queueCommand(parked.id, 'script');
    const uninstallId = await queueCommand(parked.id, 'self_uninstall');
    const app = buildAgentApp();

    const poll = await send(app, 'GET', `${MOUNT}/${parked.agentId}/commands`, parked.agentToken);
    expect(poll.status, await poll.clone().text()).toBe(200);
    const { commands } = (await poll.json()) as { commands: Array<{ id: string }> };
    expect(commands.map((cmd) => cmd.id)).toEqual([uninstallId]);
    const [refused] = await getTestDb().select({ status: deviceCommands.status, result: deviceCommands.result })
      .from(deviceCommands).where(eq(deviceCommands.id, scriptId));
    expect(refused!.status).toBe('cancelled');
    expect(refused!.result).toMatchObject({ reason: 'device_pending_assignment' });

    const scriptAck = await send(app, 'POST', `${MOUNT}/${parked.agentId}/commands/${scriptId}/result`, parked.agentToken, {
      status: 'completed',
      exitCode: 0,
    });
    expect(scriptAck.status).toBe(403);
    expect(await scriptAck.json()).toEqual({ error: 'drain_restricted' });

    const uninstallAck = await send(app, 'POST', `${MOUNT}/${parked.agentId}/commands/${uninstallId}/result`, parked.agentToken, {
      status: 'completed',
      exitCode: 0,
    });
    expect(uninstallAck.status, await uninstallAck.clone().text()).toBe(200);
    const [row] = await getTestDb().select({ status: deviceCommands.status })
      .from(deviceCommands).where(eq(deviceCommands.id, uninstallId));
    expect(row!.status).toBe('completed');

    const intent = await send(app, 'POST', `${MOUNT}/${parked.agentId}/uninstall-intent`, parked.agentToken);
    expect(intent.status).toBe(200);
    expect(await intent.json()).toEqual({ acknowledged: true });
  });
});

describe('parked device — credential rotation', () => {
  it('mints and confirms a token rotation, and the rotated token authenticates', async () => {
    const parked = await seedParkedAgent(pool.orgId, pool.siteId);
    const app = buildAgentApp();

    const mint = await send(app, 'POST', `${MOUNT}/${parked.agentId}/rotate-token`, parked.agentToken);
    expect(mint.status, await mint.clone().text()).toBe(200);
    const rotated = (await mint.json()) as { authToken: string; confirmationRequired: boolean };
    expect(rotated.confirmationRequired).toBe(true);
    expect(rotated.authToken.startsWith('brz_')).toBe(true);

    const confirm = await send(app, 'POST', `${MOUNT}/${parked.agentId}/rotate-token/confirm`, rotated.authToken);
    expect(confirm.status, await confirm.clone().text()).toBe(200);

    const [row] = await getTestDb().select({ agentTokenHash: devices.agentTokenHash, pendingTokenHash: devices.pendingTokenHash })
      .from(devices).where(eq(devices.id, parked.id));
    expect(row).toEqual({ agentTokenHash: digest(rotated.authToken), pendingTokenHash: null });

    const beat = await send(app, 'POST', `${MOUNT}/${parked.agentId}/heartbeat`, rotated.authToken, heartbeatBody);
    expect(beat.status, await beat.clone().text()).toBe(200);
  });

  it('reaches certificate renewal: the parked device passes renewal authentication and the tenant gate', async () => {
    const parked = await seedParkedAgent(pool.orgId, pool.siteId);
    const res = await send(buildAgentApp(), 'POST', `${MOUNT}/renew-cert`, parked.agentToken);
    // The test stack has no certificate provider configured, so the route stops
    // at its provider check — AFTER bearer authentication, device status and
    // the tenant-status gate have all admitted the parked device.
    expect(res.status, await res.clone().text()).toBe(400);
    expect(await res.json()).toEqual({ error: 'mTLS not configured' });
  });
});

describe('parked device — WebSocket and Helper ingresses', () => {
  it('refuses the agent WebSocket upgrade; a regular device is accepted', async () => {
    const parked = await seedParkedAgent(pool.orgId, pool.siteId);
    const regular = await seedRegularAgent(regularOrgId, regularSiteId);

    expect(await validateAgentToken(parked.agentId, parked.agentToken)).toEqual({ ok: false, reason: 'unauthorized' });
    const accepted = await validateAgentToken(regular.agentId, regular.agentToken);
    expect(accepted.ok).toBe(true);

    let upgraded = 0;
    const wsApp = createAgentWsRoutes((() => async () => {
      upgraded += 1;
      return new Response('ws', { status: 101 });
    }) as never);
    const res = await wsApp.request(`/${parked.agentId}/ws`, { headers: { Authorization: `Bearer ${parked.agentToken}` } });
    expect(res.status).toBe(401);
    expect(upgraded).toBe(0);
  });

  it('refuses a Helper session for the parked device; a regular device is admitted', async () => {
    const parked = await seedParkedAgent(pool.orgId, pool.siteId);
    const regular = await seedRegularAgent(regularOrgId, regularSiteId);
    const app = new Hono();
    app.use('*', helperAuth);
    app.get('/probe', (c) => c.json({ deviceId: c.get('helperDevice').id }));

    const refused = await app.request('/probe', { headers: { Authorization: `Bearer ${parked.helperToken}` } });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'device_pending_assignment' });

    const admitted = await app.request('/probe', { headers: { Authorization: `Bearer ${regular.helperToken}` } });
    expect(admitted.status, await admitted.clone().text()).toBe(200);
    expect(await admitted.json()).toEqual({ deviceId: regular.id });
  });
});

describe('parked device — fixture sanity', () => {
  it('the seeded device really sits in the holding org', async () => {
    const parked = await seedParkedAgent(pool.orgId, pool.siteId);
    const [row] = await getTestDb().select({ orgId: devices.orgId })
      .from(devices).where(and(eq(devices.id, parked.id), eq(devices.orgId, pool.orgId)));
    expect(row).toEqual({ orgId: pool.orgId });
    expect(partnerId).toBeTruthy();
  });
});
