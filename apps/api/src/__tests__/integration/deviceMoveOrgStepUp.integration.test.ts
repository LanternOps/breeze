/**
 * Device move-org step-up (spec 2026-09-18 W01) — "denied with ZERO state
 * change", proved against real rows.
 *
 * Mirror of deviceMaintenanceStepUp.integration.test.ts. Each denial case does
 *   SELECT * -> denied request -> SELECT * -> expect(after).toEqual(before)
 * over EVERY column of the real `devices` row, and additionally asserts that
 * no device-scoped child row moved org (sampled through device_hardware, one
 * of the tables that denormalise org_id and are rewritten by the move). Two
 * ADMISSION controls sit beside the denials so a suite where everything 403s
 * cannot pass vacuously.
 *
 * Machine principals: `/devices` is mounted JWT-only, so the real
 * authMiddleware is WRAPPED (not replaced) and only the resulting context's
 * principal/token are downgraded to the api-key shape when a test asks.
 *
 * Prerequisites (private per-worktree stack — never `test:docker:up`):
 *   pnpm test-stack up
 * Run:
 *   set -a && . ./.env.test && set +a && cd apps/api && npx vitest run \
 *     --config vitest.integration.config.ts \
 *     src/__tests__/integration/deviceMoveOrgStepUp.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { enable2faState, principalState } = vi.hoisted(() => ({
  enable2faState: { value: true },
  principalState: { kind: 'user_session' as string },
}));

vi.mock('../../routes/auth/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/auth/schemas')>();
  return {
    ...actual,
    get ENABLE_2FA() {
      return enable2faState.value;
    },
  };
});

// PARTIAL, and deliberately a WRAPPER rather than a replacement: the real
// authMiddleware still runs end to end (JWT verify, user/epoch checks, tenant
// status, RLS db access context). Only the principal/token it publishes are
// downgraded, and only when a test asks for it — which is the one thing a real
// HTTP request to this mount cannot produce.
vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: (c: never, next: never) =>
      (actual.authMiddleware as (c: unknown, next: unknown) => Promise<unknown>)(c, async () => {
        if (principalState.kind !== 'user_session') {
          const auth = (c as unknown as { get: (k: string) => Record<string, unknown> | undefined }).get('auth');
          if (auth) {
            auth.principal = { kind: principalState.kind, id: 'api-key-1' };
            // Machine contexts are built with `token: {}` (routes/mcpServer.ts).
            auth.token = {};
          }
        }
        return (next as unknown as () => Promise<unknown>)();
      }),
  };
});

// The move fires a WS disconnect for the agent post-commit; there is no agent
// WS in this suite, so make it inert (it is not what is under test).
vi.mock('../../routes/agentWs', () => ({ disconnectAgent: vi.fn(() => false) }));

import { deviceHardware, devices } from '../../db/schema';
import { deviceRoutes } from '../../routes/devices';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { mintStepUpGrant, moveOrgResourceDigest } from '../../services/mfaStepUpGrant';
import { lockActorAssurance } from '../../services/stepUpActorAssurance';
import type { AuthContext } from '../../middleware/auth';
import { createIntegrationTestClient, createOrganization, createSite } from './db-utils';
import { getTestDb } from './setup';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/devices', deviceRoutes);
  return app;
}

/** Whole row, so "unchanged" means EVERY column — including updated_at. */
async function readDeviceRow(deviceId: string): Promise<Record<string, unknown>> {
  const [row] = (await getTestDb().execute(
    sql`SELECT * FROM devices WHERE id = ${deviceId}::uuid`,
  )) as unknown as Array<Record<string, unknown>>;
  if (!row) throw new Error(`device ${deviceId} vanished`);
  return row;
}

/** org_id of the device's denormalised device_hardware child row. */
async function readChildOrg(deviceId: string): Promise<string> {
  const [row] = (await getTestDb().execute(
    sql`SELECT org_id FROM device_hardware WHERE device_id = ${deviceId}::uuid`,
  )) as unknown as Array<{ org_id: string }>;
  if (!row) throw new Error(`device_hardware row for ${deviceId} vanished`);
  return row.org_id;
}

describe('device move-org step-up: denial leaves the device and its children untouched', () => {
  let app: Hono;
  let env: Awaited<ReturnType<typeof createIntegrationTestClient>>;
  let deviceId: string;
  let sourceOrgId: string;
  let targetOrgId: string;
  let targetSiteId: string;

  beforeEach(async () => {
    enable2faState.value = true;
    principalState.kind = 'user_session';

    app = buildApp();
    // Partner-scope fixture: the route requires partner or system scope. The
    // fixture token is mfa:false (db-utils), i.e. the NON-assured session.
    env = await createIntegrationTestClient(app, { scope: 'partner' });
    sourceOrgId = env.env.organization.id;
    const target = await createOrganization({ partnerId: env.env.partner.id });
    targetOrgId = target.id;
    targetSiteId = (await createSite({ orgId: targetOrgId, name: 'Target site' })).id;

    const suffix = randomUUID();
    const [device] = await getTestDb()
      .insert(devices)
      .values({
        orgId: sourceOrgId,
        siteId: env.env.site.id,
        agentId: `move-stepup-${suffix}`,
        hostname: `move-stepup-${suffix.slice(0, 12)}`,
        displayName: 'Move Step-Up Fixture',
        osType: 'windows',
        osVersion: '11',
        architecture: 'x64',
        agentVersion: 'test',
        status: 'online',
        lastSeenAt: new Date(),
      })
      .returning({ id: devices.id });
    if (!device) throw new Error('move step-up fixture device insert failed');
    deviceId = device.id;

    // One denormalised child row so "nothing moved" is asserted beyond the
    // devices table itself.
    await getTestDb()
      .insert(deviceHardware)
      .values({ deviceId, orgId: sourceOrgId, cpuModel: 'fixture-cpu' });
  });

  const body = () => ({ orgId: targetOrgId, siteId: targetSiteId });

  /**
   * An ASSURED partner-scope session (mfa: true), with its `sid` exposed so a
   * test can mint a grant bound to this exact session.
   */
  async function assuredSession(): Promise<{ sid: string; post: (path: string, body: unknown) => Promise<Response> }> {
    const sid = randomUUID();
    const payload: Omit<TokenPayload, 'type'> = {
      sub: env.env.user.id,
      email: env.env.user.email,
      roleId: env.env.role.id,
      orgId: null,
      partnerId: env.env.partner.id,
      scope: 'partner',
      mfa: true,
      aep: 1,
      mep: 1,
      sid,
    };
    const token = await createAccessToken(payload);
    return {
      sid,
      post: (path: string, b: unknown) => Promise.resolve(app.request(path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(b),
      })),
    };
  }

  async function mintFor(sid: string, acceptCurrencyMismatch = false): Promise<string> {
    const grant = await mintStepUpGrant({
      userId: env.env.user.id,
      operation: 'device_move_org',
      authEpoch: 1,
      mfaEpoch: 1,
      sid,
      resourceDigest: moveOrgResourceDigest({ deviceId, targetOrgId, targetSiteId, acceptCurrencyMismatch }),
    });
    if (!grant) throw new Error('grant mint failed (Redis?)');
    return grant;
  }

  it('a NON-ASSURED session is denied and nothing moves', async () => {
    const before = await readDeviceRow(deviceId);
    const res = await env.post(`/devices/${deviceId}/move-org`, body());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(await readDeviceRow(deviceId)).toEqual(before);
    expect(await readChildOrg(deviceId)).toBe(sourceOrgId);
  });

  it('an assured session with NO grant is denied and nothing moves', async () => {
    const { post } = await assuredSession();
    const before = await readDeviceRow(deviceId);
    const res = await post(`/devices/${deviceId}/move-org`, body());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await readDeviceRow(deviceId)).toEqual(before);
    expect(await readChildOrg(deviceId)).toBe(sourceOrgId);
  });

  it('a grant minted for a DIFFERENT destination is denied and nothing moves', async () => {
    const { sid, post } = await assuredSession();
    const otherSite = await createSite({ orgId: targetOrgId, name: 'Other site' });
    const grant = await mintStepUpGrant({
      userId: env.env.user.id,
      operation: 'device_move_org',
      authEpoch: 1,
      mfaEpoch: 1,
      sid,
      resourceDigest: moveOrgResourceDigest({ deviceId, targetOrgId, targetSiteId: otherSite.id }),
    });
    expect(grant).toBeTruthy();
    const before = await readDeviceRow(deviceId);
    const res = await post(`/devices/${deviceId}/move-org`, { ...body(), stepUpGrant: grant });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await readDeviceRow(deviceId)).toEqual(before);
    expect(await readChildOrg(deviceId)).toBe(sourceOrgId);
  });

  it('a grant minted WITHOUT acceptCurrencyMismatch cannot authorise a move that sets it', async () => {
    const { sid, post } = await assuredSession();
    const grant = await mintFor(sid, false);
    const before = await readDeviceRow(deviceId);
    const res = await post(`/devices/${deviceId}/move-org`, { ...body(), acceptCurrencyMismatch: true, stepUpGrant: grant });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await readDeviceRow(deviceId)).toEqual(before);
  });

  it('an X-API-Key request never reaches the route and nothing moves', async () => {
    const before = await readDeviceRow(deviceId);
    const res = await app.request(`/devices/${deviceId}/move-org`, {
      method: 'POST',
      headers: { 'X-API-Key': 'brz_not_a_real_key', 'Content-Type': 'application/json' },
      body: JSON.stringify(body()),
    });
    expect(res.status).toBe(401);
    expect(await readDeviceRow(deviceId)).toEqual(before);
  });

  it('holds the actor epoch lock until the move transaction finishes', async () => {
    const binding = { userId: env.env.user.id, operation: 'device_move_org' as const, authEpoch: 1, mfaEpoch: 1, sid: randomUUID(), resourceDigest: '' };
    await getTestDb().transaction(async (tx) => {
      expect(await lockActorAssurance(tx, { user: { id: binding.userId }, token: { aep: 1, mep: 1 } } as AuthContext, binding)).toBe(true);
      let blocked = false;
      try {
        await getTestDb().transaction(async (resetTx) => {
          await resetTx.execute(sql`SET LOCAL lock_timeout = '100ms'`);
          await resetTx.execute(sql`UPDATE users SET mfa_epoch = mfa_epoch + 1 WHERE id = ${binding.userId}::uuid`);
        });
      } catch (error) {
        const pgError = (error as { cause?: { code?: string }; code?: string }).cause ?? error as { code?: string };
        expect(pgError.code).toBe('55P03');
        blocked = true;
      }
      expect(blocked).toBe(true);
    });
  });

  it('ADMISSION CONTROL: an assured session with a REAL grant moves the device and its child row; the replay does not', async () => {
    const { sid, post } = await assuredSession();
    const grant = await mintFor(sid);
    const before = await readDeviceRow(deviceId);

    const res = await post(`/devices/${deviceId}/move-org`, { ...body(), stepUpGrant: grant });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });

    const admitted = await readDeviceRow(deviceId);
    expect(admitted).not.toEqual(before);
    expect(admitted.org_id).toBe(targetOrgId);
    expect(admitted.site_id).toBe(targetSiteId);
    expect(await readChildOrg(deviceId)).toBe(targetOrgId);

    // Single-use: replaying the SAME grant is denied at the grant, not at the
    // "same org" 400. Move the device (and its child) back first so the replay
    // is a legitimate-looking request for the exact bound intent.
    await getTestDb().execute(sql`UPDATE devices SET org_id = ${sourceOrgId}::uuid, site_id = ${env.env.site.id}::uuid WHERE id = ${deviceId}::uuid`);
    const replay = await post(`/devices/${deviceId}/move-org`, { ...body(), stepUpGrant: grant });
    expect(replay.status).toBe(403);
    expect(await replay.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect((await readDeviceRow(deviceId)).org_id).toBe(sourceOrgId);
  });

  describe('ENABLE_2FA=false', () => {
    beforeEach(() => {
      enable2faState.value = false;
    });

    it('CONTROL: an interactive session with no grant IS admitted and the row moves', async () => {
      const { post } = await assuredSession();
      const res = await post(`/devices/${deviceId}/move-org`, body());
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
      expect((await readDeviceRow(deviceId)).org_id).toBe(targetOrgId);
      expect(await readChildOrg(deviceId)).toBe(targetOrgId);
    });

    it.each(['api_key', 'oauth_grant'])('denies a %s principal with no state change — the interactive gate, not MFA, is doing the work', async (kind) => {
      principalState.kind = kind;
      const { post } = await assuredSession();
      const before = await readDeviceRow(deviceId);
      const res = await post(`/devices/${deviceId}/move-org`, body());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Interactive user session required' });
      expect(await readDeviceRow(deviceId)).toEqual(before);
      expect(await readChildOrg(deviceId)).toBe(sourceOrgId);
    });
  });
});
