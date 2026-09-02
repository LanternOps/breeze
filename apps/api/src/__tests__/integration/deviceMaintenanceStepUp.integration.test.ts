/**
 * RMM-QA-176 T11 — "denied with ZERO state change", proved against a real row.
 *
 * The backlog's exit-evidence contract asks for proof that a non-assured
 * session or a machine principal cannot enter device maintenance mode *and
 * changes nothing when it tries*. Every other suite in this branch proves that
 * with test doubles: `expect(db.transaction).not.toHaveBeenCalled()` is a
 * statement about the MOCK, not about the row. The contract's claim is about
 * the row — including movement the unit mocks cannot model at all (a trigger,
 * a cascade, an `updated_at` touch). So each case here does:
 *
 *     SELECT * -> issue the denied request -> SELECT * -> expect(after).toEqual(before)
 *
 * over EVERY column of the real `devices` row, against real Postgres.
 *
 * Two ADMISSION controls sit beside the denials, because a suite where
 * everything 403s would pass while proving nothing:
 *   - an assured session presenting a REAL minted grant is admitted, the lease
 *     columns actually move, and the grant is single-use (the replay is denied
 *     and moves nothing further);
 *   - at ENABLE_2FA=false the very same request from an interactive session IS
 *     admitted and the row DOES move.
 *
 * That second control is the point of the `ENABLE_2FA=false` variant. With 2FA
 * ON, `requireMfa()` incidentally denies a machine principal (api-key/OAuth
 * contexts carry `token: {}` — spec F6), which MASKS whether the unconditional
 * `isInteractiveUserSession` gate is doing any work. With 2FA OFF,
 * `hasSatisfiedMfa` returns true for ANY context and the step-up block is
 * skipped entirely — as the control above demonstrates by being admitted — so a
 * denial observed there can only have come from `requireInteractiveSession()`.
 *
 * How the machine principal gets here: `/devices` is mounted JWT-only
 * (index.ts:840) and `authMiddleware` hard-codes `principal: { kind:
 * 'user_session' }` (middleware/auth.ts:706), so no real API key can reach the
 * route — that mount property is itself asserted below (401). To exercise the
 * route's OWN gate, the real `authMiddleware` is wrapped (not replaced): it
 * runs in full — real JWT verification, real user lookup, real RLS access
 * context — and only the resulting context's `principal`/`token` are downgraded
 * to the api-key shape before the route middleware chain sees it.
 *
 * Prerequisites (private per-worktree stack — never `test:docker:up`):
 *   pnpm test-stack up
 *
 * Run:
 *   pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/deviceMaintenanceStepUp.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ENABLE_2FA is a module constant (routes/auth/schemas.ts:11); the established
// way to flip it per test is a getter over hoisted state (precedent:
// routes/devices/commands.test.ts, routes/auth/login.test.ts:271-280).
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
            // Machine contexts are built with `token: {}` (routes/mcpServer.ts:2246).
            auth.token = {};
          }
        }
        return (next as unknown as () => Promise<unknown>)();
      }),
  };
});

import { devices } from '../../db/schema';
import { deviceRoutes } from '../../routes/devices';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { maintenanceResourceDigest, mintStepUpGrant } from '../../services/mfaStepUpGrant';
import { createIntegrationTestClient } from './db-utils';
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

const ENTRY_BODY = { enable: true, reason: 'scheduled patching', durationHours: 2 } as const;

/**
 * `execute()` returns raw driver values, so a timestamptz arrives as a STRING
 * (that is also why byte-identity here compares exactly what Postgres stores).
 * Asserts the window really is ~durationHours out, not merely non-null.
 */
function expectWindowHoursFromNow(value: unknown, hours: number): void {
  expect(typeof value).toBe('string');
  const untilMs = new Date(value as string).getTime();
  expect(Number.isNaN(untilMs)).toBe(false);
  const expected = Date.now() + hours * 3_600_000;
  expect(Math.abs(untilMs - expected)).toBeLessThan(120_000);
}

describe('device maintenance step-up: denial leaves the row byte-identical (RMM-QA-176)', () => {
  let app: Hono;
  let env: Awaited<ReturnType<typeof createIntegrationTestClient>>;
  let deviceId: string;

  beforeEach(async () => {
    enable2faState.value = true;
    principalState.kind = 'user_session';

    app = buildApp();
    // The default fixture token is mfa:false (db-utils.ts) — it IS the
    // non-assured session, no extra construction needed.
    env = await createIntegrationTestClient(app, { scope: 'organization' });

    const suffix = randomUUID();
    const [device] = await getTestDb()
      .insert(devices)
      .values({
        orgId: env.env.organization.id,
        siteId: env.env.site.id,
        agentId: `maint-stepup-${suffix}`,
        hostname: `maint-stepup-${suffix.slice(0, 12)}`,
        displayName: 'Maintenance Step-Up Fixture',
        osType: 'windows',
        osVersion: '11',
        architecture: 'x64',
        agentVersion: 'test',
        status: 'online',
        lastSeenAt: new Date(),
      })
      .returning({ id: devices.id });
    if (!device) throw new Error('maintenance step-up fixture device insert failed');
    deviceId = device.id;
  });

  /**
   * An ASSURED session (mfa: true), with its `sid` exposed so a test can mint a
   * grant bound to this exact session.
   */
  async function assuredSession(): Promise<{
    sid: string;
    post: (path: string, body: unknown) => Promise<Response>;
  }> {
    const sid = randomUUID();
    const payload: Omit<TokenPayload, 'type'> = {
      sub: env.env.user.id,
      email: env.env.user.email,
      roleId: env.env.role.id,
      orgId: env.env.organization.id,
      partnerId: env.env.partner.id,
      scope: 'organization',
      mfa: true,
      aep: 1,
      mep: 1,
      sid,
    };
    const token = await createAccessToken(payload);
    return {
      sid,
      post: (path: string, body: unknown) => Promise.resolve(app.request(path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })),
    };
  }

  it('a NON-ASSURED session is denied and the device row does not move', async () => {
    const before = await readDeviceRow(deviceId);

    const res = await env.post(`/devices/${deviceId}/maintenance`, ENTRY_BODY);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });

    // EVERY column, not just the four lease columns: a denial that touched
    // updated_at or status would still be a state change.
    expect(await readDeviceRow(deviceId)).toEqual(before);
  });

  it('an assured session with NO step-up grant is denied and the device row does not move', async () => {
    const { post } = await assuredSession();
    const before = await readDeviceRow(deviceId);

    const res = await post(`/devices/${deviceId}/maintenance`, ENTRY_BODY);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });

    expect(await readDeviceRow(deviceId)).toEqual(before);
  });

  it('an X-API-Key request never reaches the route and the device row does not move', async () => {
    const before = await readDeviceRow(deviceId);

    const res = await app.request(`/devices/${deviceId}/maintenance`, {
      method: 'POST',
      headers: { 'X-API-Key': 'brz_not_a_real_key', 'Content-Type': 'application/json' },
      body: JSON.stringify(ENTRY_BODY),
    });
    expect(res.status).toBe(401);

    expect(await readDeviceRow(deviceId)).toEqual(before);
  });

  it('the bulk route denies the same two ways with no row movement', async () => {
    const before = await readDeviceRow(deviceId);
    const body = { deviceIds: [deviceId], reason: 'scheduled patching', durationHours: 2 };

    // (a) non-assured session -> MFA gate.
    const nonAssured = await env.post('/devices/bulk/maintenance', body);
    expect(nonAssured.status).toBe(403);
    expect(await nonAssured.json()).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(await readDeviceRow(deviceId)).toEqual(before);

    // (b) assured session, no grant -> step-up gate. Both denials happen before
    // phase 2 (consume) and phase 3 (the transaction), so the grant is not
    // burned and no row moves — the D2 "zero state change by construction"
    // claim, checked rather than asserted.
    const { post } = await assuredSession();
    const noGrant = await post('/devices/bulk/maintenance', body);
    expect(noGrant.status).toBe(403);
    expect(await noGrant.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await readDeviceRow(deviceId)).toEqual(before);
  });

  it('ADMISSION CONTROL: an assured session with a REAL grant moves the row, and the replay does not', async () => {
    const { sid, post } = await assuredSession();
    const before = await readDeviceRow(deviceId);

    const grant = await mintStepUpGrant({
      userId: env.env.user.id,
      operation: 'device_maintenance',
      authEpoch: 1,
      mfaEpoch: 1,
      sid,
      resourceDigest: maintenanceResourceDigest({
        deviceIds: [deviceId],
        reason: ENTRY_BODY.reason,
        durationHours: ENTRY_BODY.durationHours,
      }),
    });
    expect(grant).not.toBeNull();

    const res = await post(`/devices/${deviceId}/maintenance`, { ...ENTRY_BODY, stepUpGrant: grant });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, action: 'enable' });

    // The denials above are only meaningful if an ALLOWED request writes: this
    // is the same row read, showing what "moved" looks like.
    const admitted = await readDeviceRow(deviceId);
    expect(admitted).not.toEqual(before);
    expect(admitted.status).toBe('maintenance');
    expect(admitted.maintenance_reason).toBe('scheduled patching');
    expectWindowHoursFromNow(admitted.maintenance_until, ENTRY_BODY.durationHours);
    expect(typeof admitted.maintenance_started_at).toBe('string');
    expect(admitted.maintenance_started_by).toBe(env.env.user.id);

    // Single-use: the SAME grant replayed is denied, and nothing moves again.
    const replay = await post(`/devices/${deviceId}/maintenance`, { ...ENTRY_BODY, stepUpGrant: grant });
    expect(replay.status).toBe(403);
    expect(await replay.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await readDeviceRow(deviceId)).toEqual(admitted);
  });

  describe('ENABLE_2FA=false — the configuration where the MFA gate admits everyone', () => {
    beforeEach(() => {
      enable2faState.value = false;
    });

    it('CONTROL: an interactive session with mfa:false IS admitted and the row DOES move', async () => {
      const before = await readDeviceRow(deviceId);

      // No grant, mfa:false — and it succeeds, because with 2FA off
      // hasSatisfiedMfa returns true for any context and the step-up block is
      // skipped. That is what makes the next case's denial attributable to
      // isInteractiveUserSession and to nothing else.
      const res = await env.post(`/devices/${deviceId}/maintenance`, ENTRY_BODY);
      expect(res.status).toBe(200);

      const after = await readDeviceRow(deviceId);
      expect(after).not.toEqual(before);
      expect(after.status).toBe('maintenance');
      expectWindowHoursFromNow(after.maintenance_until, ENTRY_BODY.durationHours);
      expect(after.maintenance_reason).toBe('scheduled patching');
    });

    it('a MACHINE principal is denied on entry by the interactive-session gate and the row does not move', async () => {
      principalState.kind = 'api_key';
      const before = await readDeviceRow(deviceId);

      const res = await env.post(`/devices/${deviceId}/maintenance`, ENTRY_BODY);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Interactive user session required' });

      expect(await readDeviceRow(deviceId)).toEqual(before);
    });

    it('a MACHINE principal is denied on the BULK route too, and the row does not move', async () => {
      principalState.kind = 'api_key';
      const before = await readDeviceRow(deviceId);

      const res = await env.post('/devices/bulk/maintenance', {
        deviceIds: [deviceId],
        reason: 'scheduled patching',
        durationHours: 2,
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Interactive user session required' });

      expect(await readDeviceRow(deviceId)).toEqual(before);
    });

    it('a MACHINE principal is denied on EXIT too, and the row does not move', async () => {
      // Exit is deliberately un-gated for MFA (D3) — the interactive gate is
      // the ONLY thing standing between a machine principal and ending a
      // maintenance window, on a deployment with 2FA off.
      await getTestDb().execute(sql`
        UPDATE devices
        SET status = 'maintenance',
            maintenance_started_at = now(),
            maintenance_until = now() + interval '2 hours',
            maintenance_reason = 'scheduled patching'
        WHERE id = ${deviceId}::uuid
      `);
      principalState.kind = 'api_key';
      const before = await readDeviceRow(deviceId);

      const res = await env.post(`/devices/${deviceId}/maintenance`, { enable: false });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Interactive user session required' });

      expect(await readDeviceRow(deviceId)).toEqual(before);
    });
  });
});
