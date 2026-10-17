/**
 * Real-PostgreSQL proof for restore-point outcome ingest (#4757, W06 of #4751),
 * as the unprivileged `breeze_app` role under forced RLS.
 *
 * A request is stamped by the real W05 chokepoint (dispatchScriptToDevice with
 * a system_protection policy on), then the agent's outcome is posted through
 * the real result handlers -- the HTTP route under the org context
 * agentAuthMiddleware opens, and the WebSocket handler:
 *
 *  - ledger `requested` -> terminal, outcome columns populated, command linked;
 *  - a replayed frame leaves the ledger row unchanged;
 *  - a forged requestId, or another device's requestId, creates and changes
 *    nothing;
 *  - an unknown-status outcome leaves the row `requested` and the command
 *    completed.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceCommands,
  devices,
} from '../../db/schema';
import { deviceRestorePointAttempts } from '../../db/schema/deviceRestorePointAttempts';
import { createAgentWsHandlers } from '../../routes/agentWs';
import { commandsRoutes } from '../../routes/agents/commands';
import { dispatchScriptToDevice } from '../../services/scriptDispatch';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

const fakeWs = { send: vi.fn(), close: vi.fn() } as unknown as Parameters<
  ReturnType<typeof createAgentWsHandlers>['onMessage']
>[1];

const createdPolicies: string[] = [];

afterEach(async () => {
  // One transaction per policy: deleting two partners' policies in one
  // transaction trips the partner-export lock hierarchy guard.
  for (const id of createdPolicies) {
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.delete(configurationPolicies).where(eq(configurationPolicies.id, id)),
    );
  }
  createdPolicies.length = 0;
});

interface Tenant {
  partnerId: string;
  orgId: string;
  siteId: string;
  device: typeof devices.$inferSelect;
}

async function seedTenant(): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await withDbAccessContext(SYSTEM_CTX, async () => {
    const [d] = await db.insert(devices).values({
      orgId: org.id,
      siteId: site.id,
      agentId: `rpi-${randomUUID()}`,
      hostname: `rpi-${randomUUID().slice(0, 8)}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'amd64',
      agentVersion: '0.99.0',
      status: 'offline',
      deviceRole: 'workstation',
    }).returning();
    return d!;
  });
  await withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db.insert(configurationPolicies).values({
      orgId: org.id,
      partnerId: null,
      name: `system protection ${randomUUID()}`,
      status: 'active',
    }).returning();
    createdPolicies.push(policy!.id);
    await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id,
      featureType: 'system_protection',
      inlineSettings: { beforeScripts: true, labelPrefix: 'Acme' },
    });
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy!.id,
      level: 'organization',
      targetId: org.id,
      priority: 0,
    });
  });
  return { partnerId: partner.id, orgId: org.id, siteId: site.id, device };
}

/** Stamp through the real W05 chokepoint, then mark the command delivered. */
async function stamp(t: Tenant): Promise<{ commandId: string; requestId: string }> {
  const result = await withDbAccessContext(orgContext(t.orgId, t.partnerId), () =>
    dispatchScriptToDevice({
      device: t.device,
      source: { kind: 'raw', content: 'Write-Output ok', language: 'powershell', provenance: 'restore-point-ingest-it' },
    }),
  );
  if (!result.ok) throw new Error('dispatch failed');
  const requestId = await withSystemDbAccessContext(async () => {
    const [row] = await db.select({ payload: deviceCommands.payload }).from(deviceCommands)
      .where(eq(deviceCommands.id, result.commandId));
    await db.update(deviceCommands).set({ status: 'sent' }).where(eq(deviceCommands.id, result.commandId));
    return ((row!.payload as Record<string, unknown>).restorePoint as { requestId: string }).requestId;
  });
  return { commandId: result.commandId, requestId };
}

async function ledgerRow(requestId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(deviceRestorePointAttempts).where(eq(deviceRestorePointAttempts.requestId, requestId)),
  );
  return row;
}

async function ledgerCount(requestId: string): Promise<number> {
  const rows = await withSystemDbAccessContext(() =>
    db.select({ id: deviceRestorePointAttempts.id }).from(deviceRestorePointAttempts)
      .where(eq(deviceRestorePointAttempts.requestId, requestId)),
  );
  return rows.length;
}

async function commandRow(commandId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ status: deviceCommands.status, result: deviceCommands.result }).from(deviceCommands)
      .where(eq(deviceCommands.id, commandId)),
  );
  return row as { status: string; result: Record<string, unknown> | null };
}

/** The real HTTP route under the same request-long org context agentAuthMiddleware opens. */
async function postHttpResult(t: Tenant, commandId: string, body: Record<string, unknown>): Promise<Response> {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', {
      deviceId: t.device.id,
      agentId: t.device.agentId,
      orgId: t.orgId,
      partnerId: t.partnerId,
      siteId: t.siteId,
      role: 'agent',
    });
    await withDbAccessContext(
      { scope: 'organization', orgId: t.orgId, accessibleOrgIds: [t.orgId], accessiblePartnerIds: [], currentPartnerId: null },
      async () => { await next(); },
    );
  });
  app.route('/agents', commandsRoutes);
  return app.request(`/agents/${t.device.agentId}/commands/${commandId}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function sendWsResult(t: Tenant, commandId: string, body: Record<string, unknown>): Promise<void> {
  const handlers = createAgentWsHandlers(t.device.agentId, {
    deviceId: t.device.id, orgId: t.orgId, partnerId: t.partnerId,
  });
  await handlers.onOpen({}, fakeWs);
  await handlers.onMessage({ data: JSON.stringify({ type: 'command_result', commandId, ...body }) } as MessageEvent, fakeWs);
  await handlers.onClose({}, fakeWs);
}

function outcome(requestId: string, overrides: Record<string, unknown> = {}) {
  return {
    status: 'created',
    requestId,
    sequenceNumber: '9223372036854775807',
    description: 'Acme: run command',
    attemptedAt: '2026-09-02T18:03:11Z',
    durationMs: 1234,
    ...overrides,
  };
}

const RESULT = { status: 'completed', exitCode: 0, stdout: 'ok' };

describe('restore-point outcome ingest against real Postgres', () => {
  runDb('runs as breeze_app (no superuser / BYPASSRLS), so RLS assertions are not vacuous', async () => {
    const role = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT current_user AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `)) as unknown as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
    expect(role[0]).toMatchObject({ who: 'breeze_app', rolsuper: false, rolbypassrls: false });
  });

  runDb('HTTP: requested -> terminal with outcome columns; a replayed frame changes nothing', async () => {
    const t = await seedTenant();
    const { commandId, requestId } = await stamp(t);
    expect((await ledgerRow(requestId))?.status).toBe('requested');

    const res = await postHttpResult(t, commandId, { ...RESULT, restorePoint: outcome(requestId) });
    expect(res.status).toBe(200);

    const row = await ledgerRow(requestId);
    expect(row).toMatchObject({
      status: 'created',
      orgId: t.orgId,
      deviceId: t.device.id,
      deviceCommandId: commandId,
      sequenceNumber: 9223372036854775807n,
      description: 'Acme: run command',
      acceptedExistingPoint: false,
      durationMs: 1234,
      attemptedAt: new Date('2026-09-02T18:03:11Z'),
    });
    expect(row!.receivedAt).toBeInstanceOf(Date);
    const cmd = await commandRow(commandId);
    expect(cmd.status).toBe('completed');
    expect(cmd.result?.restorePoint).toEqual(outcome(requestId));

    // Replay: the command CAS loses (already terminal) and, even if it did not,
    // the ledger CAS only claims a `requested` row.
    const replay = await postHttpResult(t, commandId, {
      ...RESULT, restorePoint: outcome(requestId, { status: 'failed', message: 'replayed' }),
    });
    expect(replay.status).toBe(200);
    const after = await ledgerRow(requestId);
    expect(after).toEqual(row);
    expect(await ledgerCount(requestId)).toBe(1);
  });

  runDb('WS: requested -> terminal after the terminal CAS (throttle path)', async () => {
    const t = await seedTenant();
    const { commandId, requestId } = await stamp(t);

    await sendWsResult(t, commandId, {
      ...RESULT,
      restorePoint: outcome(requestId, {
        status: 'existing_accepted', sequenceNumber: '17', existingPointAgeMinutes: 240, frequencyMinutes: 1440,
      }),
    });

    expect(await ledgerRow(requestId)).toMatchObject({
      status: 'existing_accepted',
      acceptedExistingPoint: true,
      existingPointAgeMinutes: 240,
      frequencyMinutes: 1440,
      sequenceNumber: 17n,
      deviceCommandId: commandId,
    });
    expect((await commandRow(commandId)).status).toBe('completed');
  });

  runDb('a forged requestId creates nothing; another device\'s requestId changes nothing', async () => {
    const victim = await seedTenant();
    const victimStamp = await stamp(victim);
    const attacker = await seedTenant();
    const attackerStamp = await stamp(attacker);

    const forged = randomUUID();
    const r1 = await postHttpResult(attacker, attackerStamp.commandId, { ...RESULT, restorePoint: outcome(forged) });
    expect(r1.status).toBe(200);
    expect(await ledgerCount(forged)).toBe(0);
    // The attacker's own row is untouched too: the outcome named another request.
    expect((await ledgerRow(attackerStamp.requestId))?.status).toBe('requested');
    expect((await commandRow(attackerStamp.commandId)).status).toBe('completed');

    // Fresh command for the attacker, now echoing the VICTIM's request id.
    const second = await stamp(attacker);
    await sendWsResult(attacker, second.commandId, { ...RESULT, restorePoint: outcome(victimStamp.requestId) });
    expect(await ledgerRow(victimStamp.requestId)).toMatchObject({
      status: 'requested', deviceId: victim.device.id, orgId: victim.orgId, receivedAt: null,
    });
    expect((await commandRow(second.commandId)).status).toBe('completed');
  });

  runDb('an unknown-status outcome leaves the row requested and the command completed', async () => {
    const t = await seedTenant();
    const { commandId, requestId } = await stamp(t);

    const res = await postHttpResult(t, commandId, {
      ...RESULT, restorePoint: outcome(requestId, { status: 'probably_fine' }),
    });
    expect(res.status).toBe(200);
    expect(await ledgerRow(requestId)).toMatchObject({ status: 'requested', receivedAt: null });
    const cmd = await commandRow(commandId);
    expect(cmd.status).toBe('completed');
    expect(cmd.result && 'restorePoint' in cmd.result).toBe(false);
  });
});
