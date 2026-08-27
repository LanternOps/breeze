import './setup';

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { createOrganization, createPartner, createSite } from './db-utils';
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
});
