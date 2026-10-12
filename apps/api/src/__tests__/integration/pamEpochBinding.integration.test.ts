/**
 * PAM ownership epochs W3 (#8205): lineage binding and the result path.
 *
 * Binding and result resolution prove ownership through the device's epoch
 * lineage (`breeze_pam_epoch_binding`, SECURITY DEFINER) instead of the
 * RLS-scoped live-org join. A candidate from an earlier epoch is `retired`
 * (v2) / `stale` (v1) when its actuation is closed or a retirement marker
 * exists, otherwise `unresolved`. A result for a historical-epoch actuation
 * writes nothing.
 *
 * Histories production cannot create before W6 come from the W1 fixture
 * (`seedMovedDeviceWithHistory`). The only extra seeding here mutates that
 * fixture's epoch-1 chain over the superuser connection with triggers
 * suppressed, to reach the "historical but not closed" state.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { pamReconciliationRoutes } from '../../routes/agents/pamReconciliation';
import { commandsRoutes } from '../../routes/agents/commands';
import {
  recordPamActuationResult,
  type PamAgentResultV2,
} from '../../services/pamActuationResult';
import { resolvePamReconciliationBindings } from '../../services/pamReconciliationBinding';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { createOrganization, createPartner } from './db-utils';
import { seedMovedDeviceWithHistory, type SeededMovedDevice } from './ownershipEpochFixture';
import { getTestDb } from './setup';

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

type Row = Record<string, unknown>;

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

function agentIdOf(seed: SeededMovedDevice): string {
  return `agent-${seed.deviceId}`;
}

function currentOrg(seed: SeededMovedDevice, path: readonly string[]): string {
  return seed.orgs[path[path.length - 1]!]!.id;
}

function historicalCandidate(seed: SeededMovedDevice) {
  return { observationId: randomUUID(), actuationId: seed.epoch1.actuationId, generation: 1 };
}

/** Runs raw SQL on the superuser connection with every user/FK trigger suppressed. */
async function asReplica(fn: (tx: postgres.TransactionSql) => Promise<unknown>): Promise<void> {
  const client = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await client.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await fn(tx);
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

/** Reopen the epoch-1 actuation (not closed). */
async function reopenEpoch1(seed: SeededMovedDevice): Promise<void> {
  await asReplica((tx) => tx`
    UPDATE pam_actuations
    SET desired_state = 'active', observed_state = 'verified_active',
        cleanup_requested_at = NULL, cleaned_at = NULL
    WHERE id = ${seed.epoch1.actuationId}`);
}

async function dropRetirementMarker(seed: SeededMovedDevice): Promise<void> {
  await asReplica((tx) => tx`
    DELETE FROM pam_ledger_retirements
    WHERE device_id = ${seed.deviceId} AND actuation_id = ${seed.epoch1.actuationId}`);
}

function bindingApp(seed: SeededMovedDevice, orgId: string): Hono {
  const app = new Hono();
  app.use('/agents/*', async (c, next) => {
    c.set('agent', {
      deviceId: seed.deviceId,
      orgId,
      partnerId: seed.partnerId,
      agentId: agentIdOf(seed),
      siteId: Object.values(seed.orgs).find((o) => o.id === orgId)!.siteId,
      role: 'agent',
    });
    await next();
  });
  app.route('/agents', pamReconciliationRoutes);
  return app;
}

async function bindViaRoute(
  seed: SeededMovedDevice,
  orgId: string,
  protocolVersion: number,
  candidates: Array<ReturnType<typeof historicalCandidate>>,
): Promise<{ status: number; body: Row }> {
  const response = await bindingApp(seed, orgId).request(
    `/agents/${agentIdOf(seed)}/pam/reconciliation-bindings`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion, candidates }),
    },
  );
  return { status: response.status, body: await response.json() as Row };
}

async function sourceChainDigest(seed: SeededMovedDevice): Promise<Row | undefined> {
  const [row] = await getTestDb().execute<Row>(sql`
    SELECT
      (SELECT count(*)::int FROM pam_actuation_results WHERE device_id = ${seed.deviceId}) AS results,
      (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')) FROM pam_actuation_results t
        WHERE t.device_id = ${seed.deviceId}) AS results_md5,
      (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')) FROM pam_actuations t
        WHERE t.device_id = ${seed.deviceId}) AS actuations_md5,
      (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.id), '')) FROM elevation_requests t
        WHERE t.device_id = ${seed.deviceId}) AS requests_md5,
      (SELECT count(*)::int FROM elevation_audit a
        JOIN elevation_requests r ON r.id = a.elevation_request_id
        WHERE r.device_id = ${seed.deviceId}) AS audit
  `);
  return row;
}

function cleanedResult(seed: SeededMovedDevice): PamAgentResultV2 {
  return {
    protocolVersion: 2,
    observationId: randomUUID(),
    actuationId: seed.epoch1.actuationId,
    generation: 1,
    state: 'cleaned',
    observedAt: new Date().toISOString(),
    evidence: {
      bootId: 'boot-epoch', jobMemberCount: 0, accountEnabled: false,
      accountInAdministrators: false, privilegedTokenPresent: false,
    },
  };
}

async function insertCleanupCommand(deviceId: string): Promise<string> {
  const [row] = await getTestDb().execute<{ id: string }>(sql`
    INSERT INTO device_commands (device_id, type, target_role, payload, status)
    VALUES (${deviceId}, 'pam_cleanup_v2', 'agent', '{}'::jsonb, 'sent')
    RETURNING id`);
  return row!.id;
}

describe('breeze_pam_epoch_binding — function contract', () => {
  it('is SECURITY DEFINER, STABLE, search_path pinned, and executable by breeze_app only', async () => {
    const [fn] = await getTestDb().execute<Row>(sql`
      SELECT p.prosecdef AS definer,
             p.provolatile AS volatility,
             p.proconfig AS config,
             pg_get_function_result(p.oid) AS result,
             has_function_privilege('breeze_app', p.oid, 'EXECUTE') AS app,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public,
             has_function_privilege('breeze_audit_admin', p.oid, 'EXECUTE') AS audit_admin,
             (SELECT array_agg(g.name ORDER BY g.name)
                FROM (SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS name
                        FROM aclexplode(p.proacl) a
                       WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) g) AS grantees
      FROM pg_proc p
      WHERE p.oid = 'public.breeze_pam_epoch_binding(text, uuid, jsonb)'::regprocedure`);
    expect(fn).toEqual({
      definer: true,
      volatility: 's',
      config: ['search_path=public, pg_temp'],
      result: 'TABLE(ordinal integer, observation_id uuid, status text, command_id uuid)',
      app: true,
      public: false,
      audit_admin: false,
      grantees: ['breeze_app'],
    });
  });

  it('a different org\'s context sees every candidate unresolved and no command id, even with the right agent id', async () => {
    const path = ['A', 'B'] as const;
    const seed = await seedMovedDeviceWithHistory({ path });
    const partner = await createPartner();
    const stranger = await createOrganization({ partnerId: partner.id });
    const encoded = JSON.stringify([
      { ordinal: 1, observation_id: randomUUID(), actuation_id: seed.epoch1.actuationId, generation: 1 },
      { ordinal: 2, observation_id: randomUUID(), actuation_id: randomUUID(), generation: 1 },
    ]);

    for (const orgId of [stranger.id, seed.orgs.A!.id]) {
      const rows = await withDbAccessContext(orgContext(orgId), () => db.execute<Row>(sql`
        SELECT * FROM public.breeze_pam_epoch_binding(${agentIdOf(seed)}, ${seed.deviceId}::uuid, ${encoded}::jsonb)
        ORDER BY ordinal`));
      const list = ((rows as unknown as { rows?: Row[] }).rows ?? rows) as Row[];
      expect(list.map((row) => Object.keys(row).sort())).toEqual([
        ['command_id', 'observation_id', 'ordinal', 'status'],
        ['command_id', 'observation_id', 'ordinal', 'status'],
      ]);
      expect(list.map((row) => [row.ordinal, row.status, row.command_id])).toEqual([
        [1, 'unresolved', null],
        [2, 'unresolved', null],
      ]);
    }

    // The live owner's context, by contrast, retires the epoch-1 candidate.
    const own = await withDbAccessContext(orgContext(currentOrg(seed, path)), () => db.execute<Row>(sql`
      SELECT status FROM public.breeze_pam_epoch_binding(${agentIdOf(seed)}, ${seed.deviceId}::uuid, ${encoded}::jsonb)
      ORDER BY ordinal`));
    expect(((own as unknown as { rows?: Row[] }).rows ?? own) as Row[]).toEqual([
      { status: 'retired' },
      { status: 'unresolved' },
    ]);
  });

  it('a wrong agent id on the right device is unresolved', async () => {
    const path = ['A', 'B'] as const;
    const seed = await seedMovedDeviceWithHistory({ path });
    const encoded = JSON.stringify([
      { ordinal: 1, observation_id: randomUUID(), actuation_id: seed.epoch1.actuationId, generation: 1 },
    ]);
    const rows = await withDbAccessContext(orgContext(currentOrg(seed, path)), () => db.execute<Row>(sql`
      SELECT status, command_id FROM public.breeze_pam_epoch_binding('agent-impostor', ${seed.deviceId}::uuid, ${encoded}::jsonb)`));
    expect(((rows as unknown as { rows?: Row[] }).rows ?? rows) as Row[]).toEqual([
      { status: 'unresolved', command_id: null },
    ]);
  });

  it('another device presenting this device\'s retired actuation id is unresolved', async () => {
    const path = ['A', 'B'] as const;
    const seed = await seedMovedDeviceWithHistory({ path });
    const other = await seedMovedDeviceWithHistory({ path });
    const rows = await withDbAccessContext(orgContext(currentOrg(other, path)), () =>
      resolvePamReconciliationBindings({
        agentId: agentIdOf(other),
        deviceId: other.deviceId,
        protocolVersion: 2,
        candidates: [historicalCandidate(seed)],
      }));
    expect(rows.map((row) => row.status)).toEqual(['unresolved']);
  });

  it('classifies across the lineage even when the function owner is subject to forced RLS', async () => {
    // The test stack's migration role is a superuser, which bypasses RLS and
    // would make the in-body system-scope elevation untestable. Production
    // migrators may not be (NOSUPERUSER managed roles). Re-own the function to
    // the non-bypass `breeze_app` inside a rolled-back transaction and call it
    // as breeze_app with the CURRENT org's context: the epoch-1 rows belong to
    // org A and the marker table is system-only, so `retired` here proves the
    // elevation works, and the stranger context proves phase 1 still gates.
    const path = ['A', 'B'] as const;
    const seed = await seedMovedDeviceWithHistory({ path });
    const partner = await createPartner();
    const stranger = await createOrganization({ partnerId: partner.id });
    const encoded = JSON.stringify([
      { ordinal: 1, observation_id: randomUUID(), actuation_id: seed.epoch1.actuationId, generation: 1 },
    ]);
    const ROLLBACK = new Error('rollback');
    const observed: Record<string, unknown> = {};
    const client = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    try {
      await client.begin(async (tx) => {
        await tx`ALTER FUNCTION public.breeze_pam_epoch_binding(text, uuid, jsonb) OWNER TO breeze_app`;
        const [owner] = await tx<{ super: boolean; bypass: boolean }[]>`
          SELECT r.rolsuper AS super, r.rolbypassrls AS bypass
          FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
          WHERE p.oid = 'public.breeze_pam_epoch_binding(text, uuid, jsonb)'::regprocedure`;
        observed.functionOwner = owner;
        await tx`SET LOCAL ROLE breeze_app`;
        for (const [label, orgId] of [['liveOrg', currentOrg(seed, path)], ['stranger', stranger.id]] as const) {
          await tx`
            SELECT set_config('breeze.scope', 'organization', true),
                   set_config('breeze.org_id', ${orgId}, true),
                   set_config('breeze.accessible_org_ids', ${orgId}, true),
                   set_config('breeze.accessible_partner_ids', '', true),
                   set_config('breeze.user_id', '', true)`;
          const rows = await tx<{ status: string }[]>`
            SELECT status FROM public.breeze_pam_epoch_binding(
              ${agentIdOf(seed)}, ${seed.deviceId}::uuid, ${encoded}::text::jsonb)`;
          const [scope] = await tx<{ scope: string }[]>`SELECT current_setting('breeze.scope', true) AS scope`;
          observed[label] = { statuses: rows.map((row) => row.status), scopeAfter: scope!.scope };
        }
        throw ROLLBACK;
      });
    } catch (error) {
      if (error !== ROLLBACK) throw error;
    } finally {
      await client.end({ timeout: 1 });
    }
    expect(observed).toEqual({
      functionOwner: { super: false, bypass: false },
      liveOrg: { statuses: ['retired'], scopeAfter: 'organization' },
      stranger: { statuses: ['unresolved'], scopeAfter: 'organization' },
    });
  });

  it('restores the caller\'s breeze.scope after the call', async () => {
    const path = ['A', 'B'] as const;
    const seed = await seedMovedDeviceWithHistory({ path });
    const encoded = JSON.stringify([
      { ordinal: 1, observation_id: randomUUID(), actuation_id: seed.epoch1.actuationId, generation: 1 },
    ]);
    const scopes = await withDbAccessContext(orgContext(currentOrg(seed, path)), async () => {
      const before = await db.execute<Row>(sql`SELECT current_setting('breeze.scope', true) AS scope`);
      await db.execute(sql`
        SELECT * FROM public.breeze_pam_epoch_binding(${agentIdOf(seed)}, ${seed.deviceId}::uuid, ${encoded}::jsonb)`);
      const after = await db.execute<Row>(sql`SELECT current_setting('breeze.scope', true) AS scope`);
      const pick = (r: unknown) => (((r as { rows?: Row[] }).rows ?? r) as Row[])[0]!.scope;
      return { before: pick(before), after: pick(after) };
    });
    expect(scopes).toEqual({ before: 'organization', after: 'organization' });
  });
});


async function seedCurrentEpochActuation(seed: SeededMovedDevice, orgLabel: string): Promise<{ actuationId: string; commandId: string }> {
  const org = seed.orgs[orgLabel]!;
  const [row] = await getTestDb().execute<{ actuationId: string; commandId: string }>(sql`
    WITH request AS (
      INSERT INTO elevation_requests (
        org_id, site_id, partner_id, device_id, flow_type, subject_username, reason,
        target_executable_path, status, approved_at, expires_at
      ) VALUES (
        ${org.id}, ${org.siteId}, ${seed.partnerId}, ${seed.deviceId}, 'uac_intercept', 'fixture-user',
        'current epoch', 'C:\\Fixture\\fixture.exe', 'approved', now(), now() + interval '15 minutes'
      ) RETURNING id
    ), command AS (
      INSERT INTO device_commands (device_id, type, target_role, payload, status)
      VALUES (${seed.deviceId}, 'pam_apply_v2', 'agent', '{}'::jsonb, 'sent')
      RETURNING id
    ), actuation AS (
      INSERT INTO pam_actuations (
        org_id, device_id, elevation_request_id, request_revision, generation,
        desired_state, observed_state, current_command_id, target_executable_path, subject_username
      )
      SELECT ${org.id}, ${seed.deviceId}, request.id, 1, 2, 'active', 'dispatched', command.id,
             'C:\\Fixture\\fixture.exe', 'fixture-user'
      FROM request, command
      RETURNING id
    )
    SELECT actuation.id AS "actuationId", command.id AS "commandId" FROM actuation, command`);
  return row!;
}

describe('breeze_pam_epoch_binding — review follow-ups', () => {
  it('an erased actuation\'s marker answers only for its own device', async () => {
    const path = ['A', 'B'] as const;
    const seed = await seedMovedDeviceWithHistory({ path });
    const other = await seedMovedDeviceWithHistory({ path });
    await cascadeDeleteOrg(seed.orgs.A!.id, randomUUID(), 'erasure@epoch-binding.test');

    for (const version of [1, 2]) {
      const item = historicalCandidate(seed);
      const { body } = await bindViaRoute(other, currentOrg(other, path), version, [item]);
      expect(body).toEqual({
        protocolVersion: version,
        dispositions: [{ status: 'unresolved', observationId: item.observationId }],
      });
    }
  }, 120_000);

  it('a historical non-closed, unmarked actuation result is rejected and writes nothing', async () => {
    const path = ['A', 'B'] as const;
    const seed = await seedMovedDeviceWithHistory({ path });
    await reopenEpoch1(seed);
    await dropRetirementMarker(seed);
    const before = await sourceChainDigest(seed);
    const commandId = await insertCleanupCommand(seed.deviceId);
    await expect(withDbAccessContext(orgContext(currentOrg(seed, path)), () => recordPamActuationResult({
      agentId: agentIdOf(seed), deviceId: seed.deviceId, commandId, result: cleanedResult(seed),
    }))).resolves.toBe('rejected');
    expect(await sourceChainDigest(seed)).toEqual(before);
  });

  it('a failure inside the elevated phase leaves the caller\'s scope intact', async () => {
    const path = ['A', 'B'] as const;
    const seed = await seedMovedDeviceWithHistory({ path });
    const bad = JSON.stringify([{ ordinal: 1, observation_id: randomUUID(), actuation_id: 'not-a-uuid', generation: 1 }]);
    const ROLLBACK = new Error('rollback');
    const observed: Record<string, unknown> = {};
    const client = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    try {
      await client.begin(async (tx) => {
        await tx`SET LOCAL ROLE breeze_app`;
        const orgId = currentOrg(seed, path);
        await tx`
          SELECT set_config('breeze.scope', 'organization', true),
                 set_config('breeze.org_id', ${orgId}, true),
                 set_config('breeze.accessible_org_ids', ${orgId}, true),
                 set_config('breeze.accessible_partner_ids', '', true),
                 set_config('breeze.user_id', '', true)`;
        try {
          await tx.savepoint(async (sp) => {
            await sp`SELECT * FROM public.breeze_pam_epoch_binding(
              ${agentIdOf(seed)}, ${seed.deviceId}::uuid, ${bad}::text::jsonb)`;
          });
          observed.error = null;
        } catch (error) {
          observed.error = (error as { code?: string }).code;
        }
        const [scope] = await tx<{ scope: string }[]>`SELECT current_setting('breeze.scope', true) AS scope`;
        observed.scopeAfter = scope!.scope;
        throw ROLLBACK;
      });
    } catch (error) {
      if (error !== ROLLBACK) throw error;
    } finally {
      await client.end({ timeout: 1 });
    }
    // 22P02 = invalid_text_representation, raised after the elevation.
    expect(observed).toEqual({ error: '22P02', scopeAfter: 'organization' });
  });

  it('a mixed batch keeps per-candidate dispositions and order through the route (v1 and v2)', async () => {
    const path = ['A', 'B'] as const;
    const seed = await seedMovedDeviceWithHistory({ path });
    const current = await seedCurrentEpochActuation(seed, 'B');
    const bound = { observationId: randomUUID(), actuationId: current.actuationId, generation: 2 };
    const stale = { observationId: randomUUID(), actuationId: current.actuationId, generation: 1 };
    const historical = historicalCandidate(seed);
    const unknown = { observationId: randomUUID(), actuationId: randomUUID(), generation: 1 };

    const v2 = await bindViaRoute(seed, currentOrg(seed, path), 2, [historical, bound, unknown, stale]);
    expect(v2.body).toEqual({
      protocolVersion: 2,
      dispositions: [
        { status: 'retired', observationId: historical.observationId },
        { status: 'bound', observationId: bound.observationId, commandId: current.commandId },
        { status: 'unresolved', observationId: unknown.observationId },
        { status: 'stale', observationId: stale.observationId },
      ],
    });
    const v1 = await bindViaRoute(seed, currentOrg(seed, path), 1, [historical, bound, unknown, stale]);
    expect(v1.body).toEqual({
      protocolVersion: 1,
      dispositions: [
        { status: 'stale', observationId: historical.observationId },
        { status: 'bound', observationId: bound.observationId, commandId: current.commandId },
        { status: 'unresolved', observationId: unknown.observationId },
        { status: 'stale', observationId: stale.observationId },
      ],
    });
  });
});

describe('reconciliation binding — historical candidates (v1 / v2)', () => {
  it('v1 historical candidate is stale, never unresolved', async () => {
    const path = ['A', 'B'] as const;
    const seed = await seedMovedDeviceWithHistory({ path });
    const item = historicalCandidate(seed);
    const { status, body } = await bindViaRoute(seed, currentOrg(seed, path), 1, [item]);
    expect(status).toBe(200);
    expect(body).toEqual({
      protocolVersion: 1,
      dispositions: [{ status: 'stale', observationId: item.observationId }],
    });
  });

  it('v2 historical candidate is retired', async () => {
    const path = ['A', 'B'] as const;
    const seed = await seedMovedDeviceWithHistory({ path });
    const item = historicalCandidate(seed);
    const { status, body } = await bindViaRoute(seed, currentOrg(seed, path), 2, [item]);
    expect(status).toBe(200);
    expect(body).toEqual({
      protocolVersion: 2,
      dispositions: [{ status: 'retired', observationId: item.observationId }],
    });
  });

  it('v2 historical non-closed candidate is unresolved (v1 likewise)', async () => {
    const path = ['A', 'B'] as const;
    const seed = await seedMovedDeviceWithHistory({ path });
    await reopenEpoch1(seed);
    await dropRetirementMarker(seed);
    for (const version of [1, 2]) {
      const item = historicalCandidate(seed);
      const { body } = await bindViaRoute(seed, currentOrg(seed, path), version, [item]);
      expect(body).toEqual({
        protocolVersion: version,
        dispositions: [{ status: 'unresolved', observationId: item.observationId }],
      });
    }
  });

  it('either arm alone retires: closed without a marker, and a marker without closure', async () => {
    const path = ['A', 'B'] as const;
    const closedOnly = await seedMovedDeviceWithHistory({ path });
    await dropRetirementMarker(closedOnly);
    const markerOnly = await seedMovedDeviceWithHistory({ path });
    await reopenEpoch1(markerOnly);

    for (const seed of [closedOnly, markerOnly]) {
      const item = historicalCandidate(seed);
      const { body } = await bindViaRoute(seed, currentOrg(seed, path), 2, [item]);
      expect(body).toEqual({
        protocolVersion: 2,
        dispositions: [{ status: 'retired', observationId: item.observationId }],
      });
    }
  });

  it('A -> B -> A: the epoch-1 actuation in the same org is retired, not treated as current', async () => {
    const path = ['A', 'B', 'A'] as const;
    const seed = await seedMovedDeviceWithHistory({ path });
    expect(currentOrg(seed, path)).toBe(seed.orgs.A!.id);
    const item = historicalCandidate(seed);
    const v2 = await bindViaRoute(seed, seed.orgs.A!.id, 2, [item]);
    expect(v2.body).toEqual({
      protocolVersion: 2,
      dispositions: [{ status: 'retired', observationId: item.observationId }],
    });
    const v1 = await bindViaRoute(seed, seed.orgs.A!.id, 1, [item]);
    expect(v1.body).toEqual({
      protocolVersion: 1,
      dispositions: [{ status: 'stale', observationId: item.observationId }],
    });
  });

  it('protocolVersion 3 is rejected with 400', async () => {
    const path = ['A', 'B'] as const;
    const seed = await seedMovedDeviceWithHistory({ path });
    const { status } = await bindViaRoute(seed, currentOrg(seed, path), 3, [historicalCandidate(seed)]);
    expect(status).toBe(400);
  });
});

describe('result path — historical epochs write nothing', () => {
  it('a structured cleaned result for a historical actuation is retired (service) / stale (v1 ack) with zero rows written', async () => {
    const path = ['A', 'B'] as const;
    const seed = await seedMovedDeviceWithHistory({ path });
    const before = await sourceChainDigest(seed);
    const commandId = await insertCleanupCommand(seed.deviceId);

    await expect(withDbAccessContext(orgContext(currentOrg(seed, path)), () => recordPamActuationResult({
      agentId: agentIdOf(seed), deviceId: seed.deviceId, commandId, result: cleanedResult(seed),
    }))).resolves.toBe('retired');

    const app = new Hono();
    app.use('/agents/*', async (c, next) => {
      c.set('agent', {
        deviceId: seed.deviceId, orgId: currentOrg(seed, path), partnerId: seed.partnerId,
        agentId: agentIdOf(seed), siteId: seed.orgs.B!.siteId, role: 'agent',
      });
      await next();
    });
    app.route('/agents', commandsRoutes);
    const response = await withDbAccessContext(orgContext(currentOrg(seed, path)), async () =>
      app.request(`/agents/${agentIdOf(seed)}/commands/${commandId}/result`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commandId, status: 'completed', result: cleanedResult(seed) }),
      }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ protocolVersion: 1, classification: 'stale' });

    expect(await sourceChainDigest(seed)).toEqual(before);
    expect(before!.results).toBe(1);
  });

  it('A -> B -> A: a result for the epoch-1 actuation is never appended to epoch 1', async () => {
    const path = ['A', 'B', 'A'] as const;
    const seed = await seedMovedDeviceWithHistory({ path });
    const before = await sourceChainDigest(seed);
    const commandId = await insertCleanupCommand(seed.deviceId);
    // Point the epoch-1 actuation at this command so the old live-org lookup
    // would have matched it.
    await asReplica((tx) => tx`
      UPDATE pam_actuations SET current_command_id = ${commandId} WHERE id = ${seed.epoch1.actuationId}`);
    const beforeWithCommand = await sourceChainDigest(seed);

    await expect(withDbAccessContext(orgContext(seed.orgs.A!.id), () => recordPamActuationResult({
      agentId: agentIdOf(seed), deviceId: seed.deviceId, commandId,
      result: { ...cleanedResult(seed), state: 'failed', failureCode: 'late' },
    }))).resolves.toBe('retired');
    expect(await sourceChainDigest(seed)).toEqual(beforeWithCommand);
    expect(before!.results).toBe(1);
  });
});

describe('retirement marker survives source erasure', () => {
  it('after org A is erased, the epoch-1 candidate is retired (v2) / stale (v1), never unresolved', async () => {
    const path = ['A', 'B'] as const;
    const seed = await seedMovedDeviceWithHistory({ path });

    await cascadeDeleteOrg(seed.orgs.A!.id, randomUUID(), 'erasure@epoch-binding.test');

    const [state] = await getTestDb().execute<Row>(sql`
      SELECT
        (SELECT count(*)::int FROM pam_actuations WHERE id = ${seed.epoch1.actuationId}) AS actuations,
        (SELECT count(*)::int FROM pam_ledger_retirements
          WHERE device_id = ${seed.deviceId} AND actuation_id = ${seed.epoch1.actuationId}) AS markers,
        (SELECT count(*)::int FROM devices WHERE id = ${seed.deviceId}) AS devices`);
    expect(state).toEqual({ actuations: 0, markers: 1, devices: 1 });

    const v2Item = historicalCandidate(seed);
    const v2 = await bindViaRoute(seed, currentOrg(seed, path), 2, [v2Item]);
    expect(v2.body).toEqual({
      protocolVersion: 2,
      dispositions: [{ status: 'retired', observationId: v2Item.observationId }],
    });
    const v1Item = historicalCandidate(seed);
    const v1 = await bindViaRoute(seed, currentOrg(seed, path), 1, [v1Item]);
    expect(v1.body).toEqual({
      protocolVersion: 1,
      dispositions: [{ status: 'stale', observationId: v1Item.observationId }],
    });

    // The result path agrees, and writes nothing.
    const commandId = await insertCleanupCommand(seed.deviceId);
    await expect(withDbAccessContext(orgContext(currentOrg(seed, path)), () => recordPamActuationResult({
      agentId: agentIdOf(seed), deviceId: seed.deviceId, commandId, result: cleanedResult(seed),
    }))).resolves.toBe('retired');
    const [count] = await getTestDb().execute<Row>(sql`
      SELECT count(*)::int AS n FROM pam_actuation_results WHERE device_id = ${seed.deviceId}`);
    expect(count).toEqual({ n: 0 });
  }, 120_000);
});
