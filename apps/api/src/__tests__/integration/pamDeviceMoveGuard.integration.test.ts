import './setup';

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import postgres, { type Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { moveOrgRoutes } from '../../routes/devices/moveOrg';
import { createAccessToken } from '../../services/jwt';
import {
  createOrganization,
  createPartner,
  createSite,
  setupTestEnvironment,
} from './db-utils';
import { replayMigration } from './replayMigration';
import { getTestDb } from './setup';

type PamObservedState =
  | 'pending_dispatch'
  | 'verified_active'
  | 'cleanup_pending'
  | 'cleaned'
  | 'failed'
  | 'legacy_untracked';

interface MoveFixture {
  deviceId: string;
  partnerId: string;
  sourceOrgId: string;
  sourceSiteId: string;
  targetOrgId: string;
  targetSiteId: string;
  requestId: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

interface RouteFixture {
  sourceOrgId: string;
  sourceSiteId: string;
  targetOrgId: string;
  targetSiteId: string;
  deviceId: string;
  ticketId: string;
  requestId: string;
  commandId: string;
  actuationId: string;
  resultId: string;
  postMove: () => Response | Promise<Response>;
}

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function pgErrorFields(error: unknown): { code?: string; constraint?: string } {
  const wrapped = error as {
    code?: string;
    constraint_name?: string;
    cause?: { code?: string; constraint_name?: string };
  } | undefined;
  const node = wrapped?.cause ?? wrapped;
  return { code: node?.code, constraint: node?.constraint_name };
}

async function expectPgError(
  operation: () => Promise<unknown>,
  expected: { code: string; constraint: string },
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(pgErrorFields(error)).toEqual(expected);
    return;
  }
  throw new Error(`expected PostgreSQL ${expected.code} (${expected.constraint})`);
}

async function capturePgError(operation: () => Promise<unknown>): Promise<{
  code?: string;
  constraint?: string;
} | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    return pgErrorFields(error);
  }
}

async function waitForBlockedBackend(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await getTestDb().execute<{ blocked: boolean }>(sql`
      SELECT cardinality(pg_catalog.pg_blocking_pids(${pid})) > 0 AS blocked
    `);
    if (row?.blocked) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`backend ${pid} did not block within five seconds`);
}

async function closeRaceClients(...clients: Sql[]): Promise<void> {
  const settled = await Promise.allSettled(clients.map((client) => client.end({ timeout: 1 })));
  const failures = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length > 0) throw new AggregateError(failures, 'failed to close PAM move race clients');
}

async function createMoveFixture(state?: PamObservedState): Promise<MoveFixture> {
  const adminDb = getTestDb();
  const partner = await createPartner();
  const sourceOrg = await createOrganization({ partnerId: partner.id });
  const targetOrg = await createOrganization({ partnerId: partner.id });
  const sourceSite = await createSite({ orgId: sourceOrg.id });
  const targetSite = await createSite({ orgId: targetOrg.id });
  const [device] = await adminDb.execute<{ id: string }>(sql`
    INSERT INTO devices (
      org_id, site_id, agent_id, hostname, os_type, os_version,
      architecture, agent_version
    ) VALUES (
      ${sourceOrg.id}, ${sourceSite.id}, ${`agent-${randomUUID()}`},
      ${`host-${randomUUID()}`}, 'windows', '11', 'amd64', '2.0.0'
    )
    RETURNING id
  `);
  if (!device) throw new Error('device fixture insert failed');

  const [request] = await adminDb.execute<{ id: string }>(sql`
    INSERT INTO elevation_requests (
      org_id, site_id, partner_id, device_id, flow_type,
      subject_username, reason, target_executable_path,
      target_executable_hash, status, approved_at
    ) VALUES (
      ${sourceOrg.id}, ${sourceSite.id}, ${partner.id}, ${device.id},
      'uac_intercept', 'fixture-user', 'PAM device move guard',
      'C:\\Program Files\\Fixture\\fixture.exe', ${'a'.repeat(64)},
      'approved', now()
    )
    RETURNING id
  `);
  if (!request) throw new Error('elevation request fixture insert failed');

  if (state) {
    const desiredState = state === 'cleanup_pending' || state === 'cleaned' || state === 'legacy_untracked'
      ? 'cleanup'
      : 'active';
    await adminDb.execute(sql`
      INSERT INTO pam_actuations (
        org_id, device_id, elevation_request_id, request_revision, generation,
        desired_state, observed_state, target_executable_path,
        target_executable_hash, subject_username
      ) VALUES (
        ${sourceOrg.id}, ${device.id}, ${request.id}, 1, 1,
        ${desiredState}, ${state}, 'C:\\Program Files\\Fixture\\fixture.exe',
        ${'a'.repeat(64)}, 'fixture-user'
      )
    `);
  }

  return {
    deviceId: device.id,
    partnerId: partner.id,
    sourceOrgId: sourceOrg.id,
    sourceSiteId: sourceSite.id,
    targetOrgId: targetOrg.id,
    targetSiteId: targetSite.id,
    requestId: request.id,
  };
}

async function insertRaceActuation(tx: Sql, fixture: MoveFixture): Promise<void> {
  await tx`
    INSERT INTO pam_actuations (
      org_id, device_id, elevation_request_id, request_revision, generation,
      desired_state, observed_state, target_executable_path,
      target_executable_hash, subject_username
    ) VALUES (
      ${fixture.sourceOrgId}, ${fixture.deviceId}, ${fixture.requestId}, 1, 1,
      'active', 'pending_dispatch', 'C:\\Program Files\\Fixture\\fixture.exe',
      ${'a'.repeat(64)}, 'fixture-user'
    )
  `;
  await tx`SET CONSTRAINTS pam_actuations_device_id_org_id_fkey IMMEDIATE`;
}

async function createRouteFixture(): Promise<RouteFixture> {
  const env = await setupTestEnvironment({ scope: 'partner' });
  const { partner, organization: sourceOrg, site: sourceSite, user, role } = env;
  const targetOrg = await createOrganization({ partnerId: partner.id });
  const targetSite = await createSite({ orgId: targetOrg.id });
  const [fixture] = await getTestDb().execute<Omit<
    RouteFixture,
    'sourceOrgId' | 'sourceSiteId' | 'targetOrgId' | 'targetSiteId' | 'postMove'
  >>(sql`
    WITH device AS (
      INSERT INTO devices (
        org_id, site_id, agent_id, hostname, os_type, os_version,
        architecture, agent_version, pam_lifetime_protocol_version
      ) VALUES (
        ${sourceOrg.id}, ${sourceSite.id}, ${`pam-move-${randomUUID()}`},
        ${`pam-move-host-${randomUUID()}`}, 'windows', '11', 'amd64', '2.0.0', 2
      ) RETURNING id, site_id
    ), ticket AS (
      INSERT INTO tickets (org_id, partner_id, device_id, ticket_number, subject, source)
      SELECT ${sourceOrg.id}, ${partner.id}, device.id, ${`PAM-${randomUUID()}`},
        'PAM move ownership fixture', 'manual'
      FROM device RETURNING id
    ), request AS (
      INSERT INTO elevation_requests (
        org_id, site_id, partner_id, device_id, flow_type, subject_username,
        reason, target_executable_path, target_executable_hash, status,
        approved_at, expires_at
      ) SELECT ${sourceOrg.id}, device.site_id, ${partner.id}, device.id,
        'uac_intercept', 'fixture-user', 'PAM move ownership fixture',
        'C:\\Program Files\\Fixture\\fixture.exe', ${'a'.repeat(64)},
        'approved', now(), now() + interval '15 minutes'
      FROM device RETURNING id, device_id
    ), command AS (
      INSERT INTO device_commands (device_id, type, target_role, payload, status)
      SELECT request.device_id, 'pam_apply_v2', 'agent', '{}'::jsonb, 'sent'
      FROM request RETURNING id
    ), actuation AS (
      INSERT INTO pam_actuations (
        org_id, device_id, elevation_request_id, request_revision, generation,
        desired_state, observed_state, current_command_id, target_executable_path,
        target_executable_hash, subject_username
      ) SELECT ${sourceOrg.id}, request.device_id, request.id, 1, 1,
        'active', 'dispatched', command.id, 'C:\\Program Files\\Fixture\\fixture.exe',
        ${'a'.repeat(64)}, 'fixture-user'
      FROM request, command RETURNING id, device_id
    ), result AS (
      INSERT INTO pam_actuation_results (
        observation_id, org_id, device_id, actuation_id, generation,
        result_kind, evidence, observed_at
      ) SELECT ${randomUUID()}, ${sourceOrg.id}, actuation.device_id, actuation.id, 1,
        'received', '{"source":"move-guard-integration"}'::jsonb, now()
      FROM actuation RETURNING id
    )
    SELECT device.id AS "deviceId", ticket.id AS "ticketId", request.id AS "requestId",
      command.id AS "commandId", actuation.id AS "actuationId", result.id AS "resultId"
    FROM device, ticket, request, command, actuation, result
  `);
  if (!fixture) throw new Error('route fixture insert failed');

  const token = await createAccessToken({
    sub: user.id,
    email: user.email,
    roleId: role.id,
    orgId: null,
    partnerId: partner.id,
    scope: 'partner',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  });
  const app = new Hono();
  app.route('/devices', moveOrgRoutes);

  return {
    ...fixture,
    sourceOrgId: sourceOrg.id,
    sourceSiteId: sourceSite.id,
    targetOrgId: targetOrg.id,
    targetSiteId: targetSite.id,
    postMove: () => app.request(`/devices/${fixture.deviceId}/move-org`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: targetOrg.id, siteId: targetSite.id }),
    }),
  };
}

async function routeSnapshot(fixture: RouteFixture): Promise<Record<string, unknown>> {
  const [snapshot] = await getTestDb().execute<{ snapshot: Record<string, unknown> }>(sql`
    SELECT jsonb_build_object(
      'device', (SELECT to_jsonb(row) FROM devices row WHERE id = ${fixture.deviceId}),
      'ticket', (SELECT to_jsonb(row) FROM tickets row WHERE id = ${fixture.ticketId}),
      'request', (SELECT to_jsonb(row) FROM elevation_requests row WHERE id = ${fixture.requestId}),
      'command', (SELECT to_jsonb(row) FROM device_commands row WHERE id = ${fixture.commandId}),
      'actuation', (SELECT to_jsonb(row) FROM pam_actuations row WHERE id = ${fixture.actuationId}),
      'result', (SELECT to_jsonb(row) FROM pam_actuation_results row WHERE id = ${fixture.resultId}),
      'sourceOrg', (SELECT to_jsonb(row) FROM organizations row WHERE id = ${fixture.sourceOrgId}),
      'sourceSite', (SELECT to_jsonb(row) FROM sites row WHERE id = ${fixture.sourceSiteId}),
      'targetOrg', (SELECT to_jsonb(row) FROM organizations row WHERE id = ${fixture.targetOrgId}),
      'targetSite', (SELECT to_jsonb(row) FROM sites row WHERE id = ${fixture.targetSiteId})
    ) AS snapshot
  `);
  if (!snapshot) throw new Error('route snapshot query returned no row');
  return snapshot.snapshot;
}

describe('PAM device organization-move database guard', () => {
  for (const state of [
    'pending_dispatch',
    'verified_active',
    'cleanup_pending',
    'cleaned',
    'failed',
    'legacy_untracked',
  ] as const) {
    it(`rejects a direct organization change with ${state} PAM history`, async () => {
      const fixture = await createMoveFixture(state);

      await expectPgError(
        () => getTestDb().execute(sql`
          UPDATE devices
          SET org_id = ${fixture.targetOrgId}::uuid
          WHERE id = ${fixture.deviceId}::uuid
        `),
        { code: '23514', constraint: 'devices_pam_history_move_guard' },
      );
    });
  }

  it('allows an otherwise-valid move for a device with no PAM history', async () => {
    const fixture = await createMoveFixture();

    await getTestDb().execute(sql`
      UPDATE devices
      SET org_id = ${fixture.targetOrgId}::uuid,
          site_id = ${fixture.targetSiteId}::uuid
      WHERE id = ${fixture.deviceId}::uuid
    `);

    const [device] = await getTestDb().execute<{ orgId: string; siteId: string }>(sql`
      SELECT org_id AS "orgId", site_id AS "siteId"
      FROM devices
      WHERE id = ${fixture.deviceId}::uuid
    `);
    expect(device).toEqual({ orgId: fixture.targetOrgId, siteId: fixture.targetSiteId });
  });

  it('lets a committed actuation win and rejects the waiting move with the named guard', async () => {
    const fixture = await createMoveFixture();
    const actuationClient = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    const moveClient = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    const actuationLocked = deferred<void>();
    const releaseActuation = deferred<void>();
    const moveEntered = deferred<number>();
    let actuationWork: Promise<void> | undefined;
    let moveWork: Promise<{ code?: string; constraint?: string } | null> | undefined;

    try {
      actuationWork = actuationClient.begin(async (tx) => {
        await insertRaceActuation(tx as unknown as Sql, fixture);
        actuationLocked.resolve();
        await releaseActuation.promise;
      });
      await actuationLocked.promise;

      moveWork = capturePgError(() => moveClient.begin(async (tx) => {
        const [backend] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        if (!backend) throw new Error('move backend pid missing');
        moveEntered.resolve(backend.pid);
        await tx`
          UPDATE devices
          SET org_id = ${fixture.targetOrgId}, site_id = ${fixture.targetSiteId}
          WHERE id = ${fixture.deviceId}
        `;
      }));
      await waitForBlockedBackend(await moveEntered.promise);
      releaseActuation.resolve();
      await actuationWork;

      expect(await moveWork).toEqual({
        code: '23514',
        constraint: 'devices_pam_history_move_guard',
      });
      const [device] = await getTestDb().execute<{ orgId: string }>(sql`
        SELECT org_id AS "orgId" FROM devices WHERE id = ${fixture.deviceId}
      `);
      const actuations = await getTestDb().execute(sql`
        SELECT id FROM pam_actuations
        WHERE device_id = ${fixture.deviceId} AND org_id = ${fixture.sourceOrgId}
      `);
      expect(device?.orgId).toBe(fixture.sourceOrgId);
      expect(actuations).toHaveLength(1);
    } finally {
      releaseActuation.resolve();
      await Promise.allSettled([actuationWork, moveWork].filter(Boolean) as Promise<unknown>[]);
      await closeRaceClients(actuationClient, moveClient);
    }
  }, 15_000);

  it('lets a committed move win and rejects the stale-source actuation insert', async () => {
    const fixture = await createMoveFixture();
    const moveClient = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    const actuationClient = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    const moveLocked = deferred<void>();
    const releaseMove = deferred<void>();
    const actuationEntered = deferred<number>();
    let moveWork: Promise<void> | undefined;
    let actuationWork: Promise<{ code?: string; constraint?: string } | null> | undefined;

    try {
      moveWork = moveClient.begin(async (tx) => {
        await tx`
          UPDATE devices
          SET org_id = ${fixture.targetOrgId}, site_id = ${fixture.targetSiteId}
          WHERE id = ${fixture.deviceId}
        `;
        moveLocked.resolve();
        await releaseMove.promise;
      });
      await moveLocked.promise;

      actuationWork = capturePgError(() => actuationClient.begin(async (tx) => {
        const [backend] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        if (!backend) throw new Error('actuation backend pid missing');
        actuationEntered.resolve(backend.pid);
        await insertRaceActuation(tx as unknown as Sql, fixture);
      }));
      await waitForBlockedBackend(await actuationEntered.promise);
      releaseMove.resolve();
      await moveWork;

      expect(await actuationWork).toMatchObject({ code: '23503' });
      const [device] = await getTestDb().execute<{ orgId: string }>(sql`
        SELECT org_id AS "orgId" FROM devices WHERE id = ${fixture.deviceId}
      `);
      const actuations = await getTestDb().execute(sql`
        SELECT id FROM pam_actuations WHERE device_id = ${fixture.deviceId}
      `);
      expect(device?.orgId).toBe(fixture.targetOrgId);
      expect(actuations).toHaveLength(0);
    } finally {
      releaseMove.resolve();
      await Promise.allSettled([moveWork, actuationWork].filter(Boolean) as Promise<unknown>[]);
      await closeRaceClients(moveClient, actuationClient);
    }
  }, 15_000);

  it('returns 409 through the real route without mutating ownership or evidence', async () => {
    const fixture = await createRouteFixture();
    const before = await routeSnapshot(fixture);

    const response = await fixture.postMove();
    const body = await response.json();

    expect(response.status, JSON.stringify(body)).toBe(409);
    expect(body).toEqual({
      error: 'Device organization move is blocked because durable PAM lifecycle evidence exists',
      code: 'PAM_DEVICE_MOVE_BLOCKED',
    });
    expect(await routeSnapshot(fixture)).toEqual(before);

    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    const audits = await getTestDb().execute<{
      orgId: string;
      action: string;
      details: Record<string, unknown>;
    }>(sql`
      SELECT org_id AS "orgId", action, details
      FROM audit_logs
      WHERE resource_id = ${fixture.deviceId}
        AND action LIKE 'device.move_org.%'
      ORDER BY action
    `);
    expect(audits).toEqual([{
      orgId: fixture.sourceOrgId,
      action: 'device.move_org.failed',
      details: { code: 'PAM_DEVICE_MOVE_BLOCKED' },
    }]);
  });

  it('does not grant PAM table privileges when the migration is re-applied', async () => {
    const readPamGrants = () => getTestDb().execute<{
      tableName: string;
      privilegeType: string;
    }>(sql`
      SELECT table_name AS "tableName", privilege_type AS "privilegeType"
      FROM information_schema.role_table_grants
      WHERE grantee = 'breeze_app'
        AND table_name IN ('pam_actuations', 'pam_actuation_results')
      ORDER BY table_name, privilege_type
    `);
    const before = await readPamGrants();

    // replayMigration (not a bare readFile + sql.raw) re-applies every LATER
    // migration that redefines breeze_device_child_orgid_tables() too — this
    // file's body is superseded by
    // 2026-10-08-101300-device-move-exclude-billing-evidence.sql, and a bare
    // replay of THIS file alone would silently strip that migration's
    // invoice_line_devices exclusion for the rest of this vitest process
    // (see billingEvidenceDeviceMove.integration.test.ts, #3205 W07 / #4838).
    await replayMigration('2026-09-17-pam-device-move-guard.sql');

    expect(await readPamGrants()).toEqual(before);
  });
});
