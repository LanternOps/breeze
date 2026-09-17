import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type {
  CreateTopologyDiagnosticRequest,
  TopologyDiagnosticPlan,
  TopologyDiagnosticResult,
  TopologyDiagnosticStep,
} from '@breeze/shared';

import {
  closeDb,
  db,
  runOutsideDbContext,
  withDbAccessContext,
  withSystemDbAccessContext,
} from '../../db';
import {
  deviceCommands,
  organizations,
  topologyChangeOutbox,
  topologyDiagnosticRuns,
  topologyDiagnosticSteps,
  topologyNodeBindings,
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import type { UserPermissions } from '../../services/permissions';
import type { TopologyRequestContext } from '../../services/topology/access';
import type {
  DiagnosticPlanningRepository,
  DiagnosticPlanningSnapshot,
} from '../../services/topology/diagnosticTypes';
import {
  TOPOLOGY_DIAGNOSTIC_INTENT_EVENT,
  cancelTopologyDiagnosticRun,
  createTopologyDiagnosticRun,
  getTopologyDiagnosticRun,
} from '../../services/topology/diagnosticRuns';
import {
  dispatchTopologyDiagnosticRun,
  drainTopologyDiagnosticDispatch,
  validateTopologyCommandAuthority,
} from '../../services/topology/diagnosticDispatch';
import {
  acceptTopologyDiagnosticResult,
  type AuthenticatedTopologyProducer,
} from '../../services/topology/diagnosticResults';
import { sweepTopologyDiagnosticRuns } from '../../services/topology/diagnosticSweeper';
import { clearPermissionCache } from '../../services/permissions';
import { setupTestEnvironment } from './db-utils';
import { orgContext } from './topology-fixtures';

afterAll(() => closeDb());

const GRANTS = [
  { resource: 'topology', action: 'read' },
  { resource: 'topology', action: 'write' },
  { resource: 'topology', action: 'execute' },
  { resource: 'devices', action: 'read' },
  { resource: 'devices', action: 'execute' },
];

const system = <T>(fn: () => Promise<T>) =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, 'topology diagnostic lifecycle test'));

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * A real tenant with an eligible origin. Only the PLANNING repository is faked:
 * origin selection is Task 14's contract, while everything under test here —
 * acceptance, dispatch, cancellation, results and expiry — runs against the
 * real tables, the real authorization seam and the real command transport rows.
 */
async function fixture(options: { permissions?: typeof GRANTS } = {}) {
  const env = await setupTestEnvironment({
    scope: 'organization',
    rolePermissions: options.permissions ?? GRANTS,
  });
  const orgId = env.organization.id;
  const siteId = env.site.id;
  const deviceId = crypto.randomUUID();
  const nodeId = crypto.randomUUID();
  const interfaceId = crypto.randomUUID();
  const sourceId = crypto.randomUUID();
  const evidenceId = crypto.randomUUID();

  await system(() =>
    db
      .update(organizations)
      .set({ settings: { topologyFeatureFlags: { materialization: true, diagnostics: true } } })
      .where(eq(organizations.id, orgId)),
  );

  const bindingId = await withDbAccessContext(orgContext(orgId), async () => {
    await db.execute(sql`INSERT INTO devices (id,org_id,site_id,agent_id,hostname,os_type,os_version,architecture,agent_version)
      VALUES (${deviceId}::uuid,${orgId}::uuid,${siteId}::uuid,${deviceId},'diag-origin','linux','1','amd64','1')`);
    await db.execute(sql`INSERT INTO topology_site_state (org_id,site_id) VALUES (${orgId}::uuid,${siteId}::uuid) ON CONFLICT DO NOTHING`);
    await db.execute(sql`INSERT INTO topology_nodes (id,org_id,site_id,identity_key,identity_material,kind)
      VALUES (${nodeId}::uuid,${orgId}::uuid,${siteId}::uuid,${nodeId},${JSON.stringify({ version: 1, kind: 'endpoint', sourceKey: nodeId })}::jsonb,'endpoint')`);
    await db.execute(sql`INSERT INTO topology_node_bindings (org_id,site_id,node_id,device_id)
      VALUES (${orgId}::uuid,${siteId}::uuid,${nodeId}::uuid,${deviceId}::uuid)`);
    await db.execute(sql`INSERT INTO topology_interfaces (id,org_id,site_id,owner_node_id,interface_key,epoch)
      VALUES (${interfaceId}::uuid,${orgId}::uuid,${siteId}::uuid,${nodeId}::uuid,'eth0','epoch-1')`);
    await db.execute(sql`INSERT INTO topology_collection_sources (id,org_id,site_id,producer_id,producer_kind,producer_epoch,protocol,context_key,address_family)
      VALUES (${sourceId}::uuid,${orgId}::uuid,${siteId}::uuid,${deviceId}::uuid,'agent','epoch-1','routes','default','ipv4')`);
    const [binding] = await db
      .select({ id: topologyNodeBindings.id })
      .from(topologyNodeBindings)
      .where(and(eq(topologyNodeBindings.orgId, orgId), eq(topologyNodeBindings.nodeId, nodeId)));
    return binding!.id;
  });

  const origin: TopologyDiagnosticPlan['origin'] = {
    deviceId,
    agentId: deviceId,
    nodeId,
    bindingId,
    siteId,
    contextKey: 'default',
    interfaceId,
    interfaceEpoch: 'epoch-1',
    interfaceKey: 'eth0',
    sourceId,
    producerEpoch: 'epoch-1',
    sequence: '1',
  };

  const snapshot = {
    graphRevision: '0',
    settings: {
      binding: { orgId, siteId },
      layers: { partner: null, organization: null, defaultsVersion: 1, resolverVersion: 1 },
      resolved: { settings: { outboundEnabled: true } },
      settingsRevision: '0',
      templateRevisions: {},
    },
    targets: [],
    candidates: [
      {
        eligibility: { origin, eligible: true, reasons: [], families: ['ipv4'], rank: 0 },
        routes: [],
        resolvers: [],
        gatewayEvidence: [{ address: '192.0.2.1', zone: null, interfaceId, evidenceId }],
        resolverEvidence: {},
        capabilities: new Set<string>(),
      },
    ],
  } as unknown as DiagnosticPlanningSnapshot;

  const repository: DiagnosticPlanningRepository = { load: async () => snapshot };

  const context: TopologyRequestContext = {
    scope: { orgId, siteId },
    auth: {
      user: env.user,
      scope: 'organization',
      orgId,
      partnerId: env.partner.id,
      accessibleOrgIds: [orgId],
      allowedSiteIds: null,
      // Diagnostics are execution: the planner requires a satisfied MFA claim.
      token: { mfa: true },
      canAccessOrg: (candidate: string) => candidate === orgId,
    } as unknown as AuthContext,
    permissions: {
      permissions: options.permissions ?? GRANTS,
      scope: 'organization',
      partnerId: env.partner.id,
      orgId,
      roleId: env.role.id,
    } as unknown as UserPermissions,
  };

  const request: CreateTopologyDiagnosticRequest = {
    recipeId: 'gateway_basic',
    recipeVersion: 1,
    subject: { kind: 'node', id: nodeId },
    graphRevision: '0',
  };

  return {
    env,
    orgId,
    siteId,
    deviceId,
    nodeId,
    origin,
    repository,
    context,
    request,
    scope: { orgId, siteId },
    /** Everything a route handler would run inside the request's RLS context. */
    asUser: <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(orgId), fn),
    create: (key: string, overrides: Partial<CreateTopologyDiagnosticRequest> = {}) =>
      withDbAccessContext(orgContext(orgId), () =>
        createTopologyDiagnosticRun(context, { ...request, ...overrides }, key, { repository }),
      ),
    row: async (runId: string) =>
      system(async () => {
        const [row] = await db
          .select()
          .from(topologyDiagnosticRuns)
          .where(eq(topologyDiagnosticRuns.id, runId))
          .limit(1);
        return row ?? null;
      }),
    commandsForRun: async (runId: string) =>
      system(() =>
        db
          .select()
          .from(deviceCommands)
          .where(
            and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.type, 'network_diagnostic')),
          ),
      ).then((rows) => rows.filter((row) => (row.payload as { runId?: string }).runId === runId)),
    cancelCommands: () =>
      system(() =>
        db
          .select()
          .from(deviceCommands)
          .where(
            and(
              eq(deviceCommands.deviceId, deviceId),
              eq(deviceCommands.type, 'network_diagnostic_cancel'),
            ),
          ),
      ),
    intents: (runId: string) =>
      system(() =>
        db
          .select()
          .from(topologyChangeOutbox)
          .where(
            and(
              eq(topologyChangeOutbox.eventKind, TOPOLOGY_DIAGNOSTIC_INTENT_EVENT),
              eq(topologyChangeOutbox.aggregateId, runId),
            ),
          ),
      ),
    stepsForRun: (runId: string) =>
      system(() =>
        db
          .select()
          .from(topologyDiagnosticSteps)
          .where(eq(topologyDiagnosticSteps.runId, runId)),
      ),
    /**
     * The run's deadlines are immutable by database trigger, so the clock moves
     * instead of the row — the same thing that happens in production.
     */
    afterDeadline: (run: { plan: TopologyDiagnosticPlan }) =>
      new Date(Date.parse(run.plan.deadline) + 1_000),
    producer: (commandId: string): AuthenticatedTopologyProducer => ({
      deviceId,
      agentId: deviceId,
      commandId,
    }),
  };
}

/** A plausible agent frame for the single required ICMP step of `gateway_basic`. */
function resultFor(
  run: { id: string; attemptId: string; commandId: string | null; plan: TopologyDiagnosticPlan },
  overrides: Partial<TopologyDiagnosticResult> = {},
): TopologyDiagnosticResult {
  const steps: TopologyDiagnosticStep[] = run.plan.steps.map((step) => ({
    id: step.id,
    state: 'succeeded',
    reason: null,
    attribution: {
      originDeviceId: run.plan.origin.deviceId,
      originAgentId: run.plan.origin.agentId,
      requestedMethod: step.method,
      actualMethod: step.method,
      destinationId: step.destinationId,
      resolvedIp: '192.0.2.1',
      family: 'ipv4',
      port: null,
      interfaceId: run.plan.origin.interfaceId,
      localAddress: null,
      contextKey: run.plan.origin.contextKey,
      tableKey: null,
      nextHop: null,
      proxyUsed: null,
      quality: 'observed',
      routeChanged: false,
      evidenceRefs: [],
    },
    startedAt: null,
    finishedAt: null,
    receivedAt: null,
    truncated: false,
    details: { latencyMs: 4 },
  }));
  return {
    version: 1,
    runId: run.id,
    attemptId: run.attemptId,
    commandId: run.commandId!,
    planDigest: run.plan.digest,
    steps,
    truncated: false,
    ...overrides,
  };
}

async function accepted(f: Fixture, key = crypto.randomUUID()) {
  const run = await f.create(key);
  return run;
}

describe('topology diagnostic run acceptance', () => {
  it('persists the run and its dispatch intent in one transaction', async () => {
    const f = await fixture();
    const run = await accepted(f);

    expect(run.state).toBe('queued');
    expect(run.commandId).toBeNull();
    expect(run.plan.origin.deviceId).toBe(f.deviceId);
    expect(run.plan.scope).toEqual({ orgId: f.orgId, siteId: f.siteId });

    const row = await f.row(run.id);
    expect(row).toMatchObject({ orgId: f.orgId, siteId: f.siteId, state: 'queued' });
    expect(await f.intents(run.id)).toHaveLength(1);
    // Acceptance alone must never reach the agent.
    expect(await f.commandsForRun(run.id)).toHaveLength(0);
  });

  it('returns the existing run for a replayed key and 409s a changed body', async () => {
    const f = await fixture();
    const first = await f.create('bounded-run');
    const replay = await f.create('bounded-run');
    expect(replay.id).toBe(first.id);
    expect(await f.intents(first.id)).toHaveLength(1);

    await expect(f.create('bounded-run', { graphRevision: '9' })).rejects.toMatchObject({
      code: 'idempotency_key_conflict',
      status: 409,
    });
  });

  it('refuses a replay after the requester loses topology execute', async () => {
    const f = await fixture();
    await f.create('revoked-run');
    clearPermissionCache();

    const stripped: TopologyRequestContext = {
      ...f.context,
      permissions: {
        ...f.context.permissions,
        permissions: GRANTS.filter((grant) => grant.action !== 'execute'),
      } as UserPermissions,
    };
    await expect(
      f.asUser(() => createTopologyDiagnosticRun(stripped, f.request, 'revoked-run', { repository: f.repository })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a run for a site the caller cannot see, without creating a row', async () => {
    const f = await fixture();
    const other = await fixture();
    const crossSite: TopologyRequestContext = { ...f.context, scope: other.scope };
    await expect(
      f.asUser(() => createTopologyDiagnosticRun(crossSite, other.request, 'cross', { repository: f.repository })),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await system(() => db.select().from(topologyDiagnosticRuns)),
    ).toHaveLength(0);
  });
});

describe('topology diagnostic dispatch', () => {
  it('creates exactly one command across a crash after the command insert', async () => {
    const f = await fixture();
    const run = await accepted(f);

    // The worker committed the command row and then died before delivery.
    await expect(
      dispatchTopologyDiagnosticRun(f.scope, run.id, {
        deliver: async () => {
          throw new Error('worker crashed after command insert');
        },
      }),
    ).rejects.toThrow(/crashed/);
    expect(await f.commandsForRun(run.id)).toHaveLength(1);

    await dispatchTopologyDiagnosticRun(f.scope, run.id, { deliver: async () => true });
    const commands = await f.commandsForRun(run.id);
    expect(commands).toHaveLength(1);
    expect((await f.row(run.id))!.commandId).toBe(commands[0]!.id);
  });

  it('binds one command when two workers dispatch the same run concurrently', async () => {
    const f = await fixture();
    const run = await accepted(f);

    const results = await Promise.allSettled([
      dispatchTopologyDiagnosticRun(f.scope, run.id, { deliver: async () => true }),
      dispatchTopologyDiagnosticRun(f.scope, run.id, { deliver: async () => true }),
    ]);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(0);
    expect(await f.commandsForRun(run.id)).toHaveLength(1);
  });

  it('seals the delivered command against the accepted plan', async () => {
    const f = await fixture();
    const run = await accepted(f);
    await dispatchTopologyDiagnosticRun(f.scope, run.id, { deliver: async () => true });

    const [command] = await f.commandsForRun(run.id);
    expect(command).toMatchObject({ type: 'network_diagnostic', status: 'pending' });
    expect(command!.payload).toMatchObject({
      type: 'network_diagnostic',
      version: 1,
      runId: run.id,
      attemptId: run.attemptId,
      commandId: command!.id,
      planDigest: run.plan.digest,
      expiresAt: run.plan.deadline,
    });

    const decision = await system(() =>
      validateTopologyCommandAuthority(
        { id: command!.id, type: command!.type, deviceId: f.deviceId, payload: command!.payload },
        command!.payload,
      ),
    );
    expect(decision.allow).toBe(true);
  });

  it('drains the durable intent and marks it delivered', async () => {
    const f = await fixture();
    const run = await accepted(f);

    expect(await drainTopologyDiagnosticDispatch({ deliver: async () => true })).toBeGreaterThan(0);
    expect(await f.commandsForRun(run.id)).toHaveLength(1);
    expect((await f.intents(run.id))[0]!.payload).toMatchObject({ state: 'dispatched' });
    // A second drain must not re-dispatch a run whose intent is settled.
    await drainTopologyDiagnosticDispatch({ deliver: async () => true });
    expect(await f.commandsForRun(run.id)).toHaveLength(1);
  });

  it('never dispatches a run whose deadline already passed', async () => {
    const f = await fixture();
    const run = await accepted(f);

    await dispatchTopologyDiagnosticRun(f.scope, run.id, {
      deliver: async () => true,
      now: f.afterDeadline(run),
    });
    expect(await f.commandsForRun(run.id)).toHaveLength(0);
    expect((await f.row(run.id))!.state).toBe('expired');
  });
});

describe('topology diagnostic cancellation', () => {
  it('blocks undispatched work and settles the run without touching an agent', async () => {
    const f = await fixture();
    const run = await accepted(f);

    const cancelled = await f.asUser(() => cancelTopologyDiagnosticRun(f.context, run.id));
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.cancelRequestedAt).not.toBeNull();

    await dispatchTopologyDiagnosticRun(f.scope, run.id, { deliver: async () => true });
    expect(await f.commandsForRun(run.id)).toHaveLength(0);
  });

  it('refuses to bind a command to a run a concurrent stop already marked', async () => {
    const f = await fixture();
    const run = await accepted(f);
    // The exact race the dispatch CAS exists for: the stop lands after the run
    // was read as dispatchable but before its command was bound.
    await system(() =>
      db.execute(sql`UPDATE topology_diagnostic_runs SET cancel_requested_at=now() WHERE id=${run.id}::uuid`),
    );

    await dispatchTopologyDiagnosticRun(f.scope, run.id, { deliver: async () => true });
    expect(await f.commandsForRun(run.id)).toHaveLength(0);
    expect(await f.row(run.id)).toMatchObject({
      state: 'cancelled',
      failureReason: 'cancelled_before_dispatch',
    });
  });

  it('keeps a dispatched run stop-requested until its deadline, then expires it', async () => {
    const f = await fixture();
    const run = await accepted(f);
    await dispatchTopologyDiagnosticRun(f.scope, run.id, { deliver: async () => true });

    const stopping = await f.asUser(() => cancelTopologyDiagnosticRun(f.context, run.id));
    expect(stopping.state).not.toBe('cancelled');
    expect(stopping.cancelRequestedAt).not.toBeNull();

    // A cancel request must stop the queued command from ever being delivered.
    const [command] = await f.commandsForRun(run.id);
    const decision = await system(() =>
      validateTopologyCommandAuthority(
        { id: command!.id, type: command!.type, deviceId: f.deviceId, payload: command!.payload },
        command!.payload,
      ),
    );
    expect(decision).toEqual({ allow: false, reason: 'scope_changed' });

    await sweepTopologyDiagnosticRuns({ now: f.afterDeadline(run) });
    const row = await f.row(run.id);
    expect(row).toMatchObject({ state: 'expired', failureReason: 'cancellation_unconfirmed' });
  });

  it('hands the agent stop to the durable worker exactly once', async () => {
    const f = await fixture();
    const run = await accepted(f);
    await dispatchTopologyDiagnosticRun(f.scope, run.id, { deliver: async () => true });
    await f.asUser(() => cancelTopologyDiagnosticRun(f.context, run.id));

    await drainTopologyDiagnosticDispatch({ deliver: async () => true });
    const stops = await f.cancelCommands();
    expect(stops).toHaveLength(1);
    expect(stops[0]!.payload).toEqual({
      version: 1,
      runId: run.id,
      attemptId: run.attemptId,
      commandId: (await f.row(run.id))!.commandId,
    });

    // The intent is settled, so a later tick cannot send a second stop.
    await drainTopologyDiagnosticDispatch({ deliver: async () => true });
    expect(await f.cancelCommands()).toHaveLength(1);
  });

  it('is idempotent and never rewrites a terminal run', async () => {
    const f = await fixture();
    const run = await accepted(f);
    const first = await f.asUser(() => cancelTopologyDiagnosticRun(f.context, run.id));
    const second = await f.asUser(() => cancelTopologyDiagnosticRun(f.context, run.id));
    expect(second.state).toBe('cancelled');
    expect(second.cancelRequestedAt).toBe(first.cancelRequestedAt);
    expect(second.finishedAt).toBe(first.finishedAt);
  });

  it('hides a run from another tenant behind 404 instead of cancelling it', async () => {
    const f = await fixture();
    const other = await fixture();
    const run = await accepted(f);
    await expect(other.asUser(() => cancelTopologyDiagnosticRun(other.context, run.id))).rejects.toMatchObject({
      status: 404,
    });
    expect((await f.row(run.id))!.state).toBe('queued');
  });
});

describe('topology diagnostic results', () => {
  it('completes the run and records its steps once', async () => {
    const f = await fixture();
    const run = await accepted(f);
    await dispatchTopologyDiagnosticRun(f.scope, run.id, { deliver: async () => true });
    const [command] = await f.commandsForRun(run.id);
    const current = (await f.asUser(() => getTopologyDiagnosticRun(f.context, run.id)))!;

    const first = await acceptTopologyDiagnosticResult(
      f.producer(command!.id),
      resultFor(current),
    );
    expect(first).toEqual({ accepted: true, historicalOnly: false });

    const settled = (await f.asUser(() => getTopologyDiagnosticRun(f.context, run.id)))!;
    expect(settled.state).toBe('completed');
    expect(settled.assessment).toBe('healthy');
    expect(settled.coverage).toBe('complete');
    expect(settled.steps).toHaveLength(run.plan.steps.length);

    // A redelivered frame must not duplicate step evidence or reopen the run.
    const replay = await acceptTopologyDiagnosticResult(
      f.producer(command!.id),
      resultFor(current),
    );
    expect(replay).toEqual({ accepted: true, historicalOnly: true });
    expect(await f.stepsForRun(run.id)).toHaveLength(run.plan.steps.length);
    expect((await f.row(run.id))!.state).toBe('completed');
  });

  it('stores a late result as historical without resurrecting an expired run', async () => {
    const f = await fixture();
    const run = await accepted(f);
    await dispatchTopologyDiagnosticRun(f.scope, run.id, { deliver: async () => true });
    const [command] = await f.commandsForRun(run.id);
    const current = (await f.asUser(() => getTopologyDiagnosticRun(f.context, run.id)))!;

    await f.asUser(() => cancelTopologyDiagnosticRun(f.context, run.id));
    await sweepTopologyDiagnosticRuns({ now: f.afterDeadline(run) });

    expect(
      await acceptTopologyDiagnosticResult(f.producer(command!.id), resultFor(current)),
    ).toMatchObject({ accepted: true, historicalOnly: true });

    expect((await f.asUser(() => getTopologyDiagnosticRun(f.context, run.id)))?.state).toBe('expired');
    const steps = await f.stepsForRun(run.id);
    expect(steps).toHaveLength(run.plan.steps.length);
    expect(steps.every((step) => step.historicalOnly)).toBe(true);
  });

  it.each([
    ['a foreign origin device', (f: Fixture, commandId: string) => ({ ...f.producer(commandId), deviceId: crypto.randomUUID() })],
    ['a command id the producer was not issued', (f: Fixture) => f.producer(crypto.randomUUID())],
  ] as const)('refuses a result from %s', async (_label, build) => {
    const f = await fixture();
    const run = await accepted(f);
    await dispatchTopologyDiagnosticRun(f.scope, run.id, { deliver: async () => true });
    const [command] = await f.commandsForRun(run.id);
    const current = (await f.asUser(() => getTopologyDiagnosticRun(f.context, run.id)))!;

    await expect(
      acceptTopologyDiagnosticResult(build(f, command!.id), resultFor(current)),
    ).rejects.toMatchObject({ code: 'diagnostic_result_unauthorized' });
    expect(await f.stepsForRun(run.id)).toHaveLength(0);
    expect((await f.row(run.id))!.state).not.toBe('completed');
  });

  it.each([
    ['attempt', { attemptId: crypto.randomUUID() }],
    ['plan digest', { planDigest: 'b'.repeat(64) }],
    ['run', { runId: crypto.randomUUID() }],
  ] as const)('refuses a result that re-points its %s', async (_label, overrides) => {
    const f = await fixture();
    const run = await accepted(f);
    await dispatchTopologyDiagnosticRun(f.scope, run.id, { deliver: async () => true });
    const [command] = await f.commandsForRun(run.id);
    const current = (await f.asUser(() => getTopologyDiagnosticRun(f.context, run.id)))!;

    await expect(
      acceptTopologyDiagnosticResult(f.producer(command!.id), resultFor(current, overrides)),
    ).rejects.toMatchObject({ code: 'diagnostic_result_unauthorized' });
    expect(await f.stepsForRun(run.id)).toHaveLength(0);
  });

  it('refuses a structurally invalid frame instead of storing partial evidence', async () => {
    const f = await fixture();
    const run = await accepted(f);
    await dispatchTopologyDiagnosticRun(f.scope, run.id, { deliver: async () => true });
    const [command] = await f.commandsForRun(run.id);
    const current = (await f.asUser(() => getTopologyDiagnosticRun(f.context, run.id)))!;

    const truncated = resultFor(current);
    await expect(
      acceptTopologyDiagnosticResult(f.producer(command!.id), {
        ...truncated,
        steps: [{ ...truncated.steps[0]!, state: 'nonsense' as TopologyDiagnosticStep['state'] }],
      }),
    ).rejects.toThrow();
    expect(await f.stepsForRun(run.id)).toHaveLength(0);
  });

  it('cannot cancel a run that already completed', async () => {
    const f = await fixture();
    const run = await accepted(f);
    await dispatchTopologyDiagnosticRun(f.scope, run.id, { deliver: async () => true });
    const [command] = await f.commandsForRun(run.id);
    const current = (await f.asUser(() => getTopologyDiagnosticRun(f.context, run.id)))!;
    await acceptTopologyDiagnosticResult(f.producer(command!.id), resultFor(current));

    expect((await f.asUser(() => cancelTopologyDiagnosticRun(f.context, run.id))).state).toBe('completed');
  });
});

describe('topology diagnostic budgets and sweeping', () => {
  it('refuses a run over the per-agent concurrency budget and releases it on a terminal path', async () => {
    const f = await fixture();
    const first = await accepted(f);
    await accepted(f);

    await expect(f.create(crypto.randomUUID())).rejects.toMatchObject({
      code: 'diagnostic_quota_exceeded',
      status: 429,
      retryAfterSeconds: expect.any(Number),
    });

    await f.asUser(() => cancelTopologyDiagnosticRun(f.context, first.id));
    // The released slot proves the budget is derived from live state, not a
    // counter that a terminal transition could forget to decrement.
    await expect(f.create(crypto.randomUUID())).resolves.toMatchObject({ state: 'queued' });
  });

  it('expires an abandoned run and stops its queued command from ever landing', async () => {
    const f = await fixture();
    const run = await accepted(f);
    await dispatchTopologyDiagnosticRun(f.scope, run.id, { deliver: async () => true });

    expect(await sweepTopologyDiagnosticRuns({ now: f.afterDeadline(run) })).toBeGreaterThan(0);
    const row = await f.row(run.id);
    expect(row).toMatchObject({ state: 'expired', failureReason: 'deadline_exceeded' });
    expect(row!.finishedAt).not.toBeNull();

    const [command] = await f.commandsForRun(run.id);
    expect(command!.status).toBe('cancelled');
  });

  it('leaves a live run alone', async () => {
    const f = await fixture();
    const run = await accepted(f);
    await sweepTopologyDiagnosticRuns();
    expect((await f.row(run.id))!.state).toBe('queued');
  });
});

describe('topology diagnostic reads', () => {
  it('returns a run with its plan and hides another tenant behind null', async () => {
    const f = await fixture();
    const other = await fixture();
    const run = await accepted(f);

    const view = await f.asUser(() => getTopologyDiagnosticRun(f.context, run.id));
    expect(view).toMatchObject({ id: run.id, state: 'queued', steps: [] });
    expect(view!.plan.digest).toBe(run.plan.digest);
    expect(await other.asUser(() => getTopologyDiagnosticRun(other.context, run.id))).toBeNull();
  });
});
