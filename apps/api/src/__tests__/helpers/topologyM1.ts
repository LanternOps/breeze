import { sql } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { createTopologyGraph, createTopologyTenant, orgContext } from '../integration/topology-fixtures';

export async function seedTopologyM1Fixture() {
  const scope=await createTopologyGraph();
  const otherScope=await createTopologyTenant();
  const sourceId=crypto.randomUUID(),interfaceId=crypto.randomUUID(),runId=crypto.randomUUID(),observationId=crypto.randomUUID();
  const relationshipId=await withDbAccessContext(orgContext(scope.orgId),async()=>{
    await db.execute(sql`INSERT INTO topology_interfaces (id,org_id,site_id,owner_node_id,interface_key,epoch)
      VALUES (${interfaceId}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,${scope.nodeId}::uuid,'if-1','epoch-1')`);
    await db.execute(sql`INSERT INTO topology_collection_sources (id,org_id,site_id,producer_id,producer_kind,producer_epoch,protocol,context_key)
      VALUES (${sourceId}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,${scope.deviceId}::uuid,'agent','epoch-1','routes','main')`);
    await db.execute(sql`INSERT INTO topology_collection_runs (id,org_id,site_id,source_id,producer_id,producer_epoch,sequence,snapshot_id,content_digest,
      observed_at,effective_at,outcome,snapshot,normalized_bytes,expected_interval_seconds)
      VALUES (${runId}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,${sourceId}::uuid,${scope.deviceId}::uuid,'epoch-1',1,gen_random_uuid(),${'a'.repeat(64)},now(),now(),'complete','{}',2,300)`);
    const [relationship]=await db.execute(sql`SELECT id FROM topology_relationships WHERE org_id=${scope.orgId}::uuid AND site_id=${scope.siteId}::uuid`);
    const id=String(relationship!.id);
    await db.execute(sql`INSERT INTO topology_observations (id,org_id,site_id,run_id,observation_key,subject_node_id,subject_interface_id,relationship_id,method,evidence_class,
      attributes,observed_at,effective_at,received_at,fresh_until)
      VALUES (${observationId}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,${runId}::uuid,'route-1',${scope.nodeId}::uuid,${interfaceId}::uuid,${id}::uuid,'os_route','observed','{}',now(),now(),now(),now()+interval '15 minutes')`);
    await db.execute(sql`INSERT INTO topology_relationship_support (org_id,site_id,relationship_id,source_id,latest_observation_id,producer_epoch,sequence,content_digest,
      first_positive_at,last_positive_at,effective_at,fresh_until)
      VALUES (${scope.orgId}::uuid,${scope.siteId}::uuid,${id}::uuid,${sourceId}::uuid,${observationId}::uuid,'epoch-1',1,${'a'.repeat(64)},now(),now(),now(),now()+interval '15 minutes')`);
    return id;
  });
  return {...scope,scope,otherScope,sourceId,interfaceId,runId,observationId,relationshipId,orgContext:orgContext(scope.orgId),otherOrgContext:orgContext(otherScope.orgId)};
}

/**
 * A persisted, deliverable `network_diagnostic` command with its parent run —
 * the real rows both transports claim from. Every mutator below changes only
 * live state, never the payload: the point is that a digest-sealed plan stops
 * being deliverable because the world moved, not because the payload was
 * rewritten.
 */
export async function seedTopologyCommandFixture(
  overrides: { acceptedAt?: Date; orphanRun?: boolean } = {},
) {
  const { and, eq } = await import('drizzle-orm');
  const { withSystemDbAccessContext, runOutsideDbContext } = await import('../../db');
  const { deviceCommands, topologyNodeBindings } = await import('../../db/schema');
  const { topologyDiagnosticPlanDigest } = await import('../../services/topology/diagnosticPlanner');
  const { claimPendingCommandsForDevice, claimPendingCommandForDelivery } = await import('../../services/commandDispatch');
  const { commandAcceptsAgentResult } = await import('../../services/commandResultAcceptance');
  const { validateCriticalCommandResult } = await import('../../services/agentCommandResultValidation');
  const { topologyDiagnosticCommandSchema } = await import('@breeze/shared');

  const scope = await createTopologyGraph();
  const otherSite = await withDbAccessContext(orgContext(scope.orgId), async () => {
    const [row] = await db.execute(sql`INSERT INTO sites (org_id,name) VALUES (${scope.orgId}::uuid,'diagnostic-other') RETURNING id`);
    return String(row!.id);
  });
  const sourceId = crypto.randomUUID(), runId = crypto.randomUUID(), attemptId = crypto.randomUUID();
  const commandId = crypto.randomUUID(), destinationId = crypto.randomUUID(), stepId = crypto.randomUUID();
  const evidenceId = crypto.randomUUID();

  const bindingId = await withDbAccessContext(orgContext(scope.orgId), async () => {
    await db.execute(sql`INSERT INTO topology_collection_sources (id,org_id,site_id,producer_id,producer_kind,producer_epoch,protocol,context_key,address_family)
      VALUES (${sourceId}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,${scope.deviceId}::uuid,'agent','epoch-1','routes','default','ipv4')`);
    const [binding] = await db.select({ id: topologyNodeBindings.id }).from(topologyNodeBindings)
      .where(and(eq(topologyNodeBindings.orgId, scope.orgId), eq(topologyNodeBindings.nodeId, scope.nodeId)));
    return binding!.id;
  });

  const acceptedAt = overrides.acceptedAt ?? new Date();
  const queueDeadline = new Date(acceptedAt.getTime() + 30_000);
  const deadline = new Date(acceptedAt.getTime() + 120_000);
  const plan = {
    version: 1 as const, recipeId: 'gateway_basic' as const, recipeVersion: 1 as const,
    scope: { orgId: scope.orgId, siteId: scope.siteId },
    subject: { kind: 'node' as const, id: scope.nodeId },
    origin: {
      deviceId: scope.deviceId, agentId: scope.deviceId, nodeId: scope.nodeId, bindingId,
      siteId: scope.siteId, contextKey: 'default', interfaceId: null, interfaceEpoch: null,
      interfaceKey: null, sourceId, producerEpoch: 'epoch-1', sequence: '1',
    },
    family: 'ipv4' as const, graphRevision: '0', settingsRevision: '0', contextRevision: '1',
    templateVersions: { partner: null, org: null, defaults: 1, resolver: 1 },
    destinations: [{ id: destinationId, target: { kind: 'observed_gateway' as const, address: '192.0.2.1', zone: null, interfaceId: evidenceId, evidenceId } }],
    steps: [{ id: stepId, method: 'icmp' as const, destinationId, required: true, packetCount: 3, timeoutMs: 1000, payloadBytes: 32 }],
    limits: { maxConcurrentSteps: 2, maxTargetAddresses: 4, maxResolvers: 2, queueTimeoutSeconds: 30, executionTimeoutSeconds: 90, lifetimeSeconds: 120 },
    acceptedAt: acceptedAt.toISOString(), queueDeadline: queueDeadline.toISOString(),
    deadline: deadline.toISOString(), digest: '0'.repeat(64), reasons: [] as string[],
  };
  plan.digest = topologyDiagnosticPlanDigest(plan);
  const payload = topologyDiagnosticCommandSchema.parse({
    type: 'network_diagnostic', version: 1, runId, attemptId, commandId, plan,
    planDigest: plan.digest, expiresAt: plan.deadline,
  });

  if (!overrides.orphanRun) {
    await withDbAccessContext(orgContext(scope.orgId), async () => {
      await db.execute(sql`INSERT INTO topology_diagnostic_runs
        (id,org_id,site_id,recipe_id,recipe_version,requester_id,subject_node_id,origin_node_id,origin_snapshot,plan,plan_digest,idempotency_key,body_hash,attempt_id,command_id,queued_at,queue_deadline,deadline)
        VALUES (${runId}::uuid,${scope.orgId}::uuid,${scope.siteId}::uuid,'gateway_basic',1,${crypto.randomUUID()}::uuid,${scope.nodeId}::uuid,${scope.nodeId}::uuid,
        ${JSON.stringify(plan.origin)}::jsonb,${JSON.stringify(plan)}::jsonb,${plan.digest},${runId},${'1'.repeat(64)},${attemptId}::uuid,${commandId}::uuid,
        ${acceptedAt.toISOString()}::timestamptz,${queueDeadline.toISOString()}::timestamptz,${deadline.toISOString()}::timestamptz)`);
    });
  }
  await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.execute(sql`INSERT INTO device_commands (id,device_id,type,status,payload,target_role)
      VALUES (${commandId}::uuid,${scope.deviceId}::uuid,'network_diagnostic','pending',${JSON.stringify(payload)}::jsonb,'agent')`)));

  const commandRow = () => runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(deviceCommands).where(eq(deviceCommands.id, commandId)).limit(1);
    return row!;
  }));

  return {
    ...scope, otherSite, runId, attemptId, commandId, sourceId, bindingId, plan, payload, commandRow,
    /** Live state moves; the sealed payload does not. */
    async moveOriginToOtherSite() {
      await withDbAccessContext(orgContext(scope.orgId), () =>
        db.execute(sql`UPDATE devices SET site_id=${otherSite}::uuid WHERE id=${scope.deviceId}::uuid`));
    },
    async revokeOriginSource() {
      await withDbAccessContext(orgContext(scope.orgId), () =>
        db.execute(sql`UPDATE topology_collection_sources SET revoked_at=now() WHERE id=${sourceId}::uuid`));
    },
    async changeSiteConfiguration() {
      await withDbAccessContext(orgContext(scope.orgId), () =>
        db.execute(sql`UPDATE topology_site_state SET settings_revision=settings_revision+1 WHERE site_id=${scope.siteId}::uuid`));
    },
    /**
     * Put a row the database fence already cancelled back to `pending`, so the
     * application layer has to refuse it on its own evidence. Proves the
     * delivery check is not leaning on the inventory-move trigger.
     */
    async reopenCommand() {
      await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        db.execute(sql`UPDATE device_commands SET status='pending', completed_at=NULL, result=NULL WHERE id=${commandId}::uuid`)));
    },
    /** Claim through the real transport seam and report what the agent got. */
    async claimThrough(transport: 'http' | 'websocket') {
      const claimed = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
        const rows = transport === 'http'
          ? await claimPendingCommandsForDevice(scope.deviceId, 10, 'agent')
          : [await claimPendingCommandForDelivery(commandId)];
        return rows.flatMap((row) => (row ? [row.id] : []));
      }));
      const row = await commandRow();
      return {
        delivered: claimed.includes(commandId),
        status: row.status,
        reason: (row.result as { reason?: string } | null)?.reason ?? null,
      };
    },
    /** A result frame signed by a DIFFERENT authenticated agent. */
    async resultFromOtherAgent() {
      const other = await createTopologyGraph();
      const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        db.select().from(deviceCommands)
          .where(and(eq(deviceCommands.id, commandId), eq(deviceCommands.deviceId, other.deviceId)))
          .limit(1)));
      return { accepted: !!row, foreignDeviceId: other.deviceId };
    },
    /** Result acceptance for the owning agent, ids and digest pinned. */
    acceptResult(result: unknown, status: 'completed' | 'failed' = 'completed') {
      const row = { status, result };
      if (!commandAcceptsAgentResult('sent', null, 'network_diagnostic')) return { accepted: false };
      try {
        validateCriticalCommandResult('network_diagnostic', { commandId, status: row.status, result }, { commandPayload: payload });
        return { accepted: true };
      } catch (e) {
        return { accepted: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

/**
 * M2 `physical-enrichment` release fixture: the M1 no-management seed enriched
 * through the real SNMP/UniFi transports, with the deterministic variants
 * `fdb-only`, `qbridge-shared-fdb`, `reciprocal-parallel`,
 * `partial-controller-page`, `source-remap`, `manual-pinned-import` and
 * `legacy-agent-positive-only` (see ./topologyPhysical.ts).
 */
export { PHYSICAL_FIXTURE, TOPOLOGY_PHYSICAL_VARIANTS, seedTopologyPhysicalFixture, type TopologyPhysicalFixture, type TopologyPhysicalVariant } from './topologyPhysical';
