import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { canonicalizeArguments } from '@breeze/shared/canonicalize';
import {
  topologyPolicyRoutingContextsSchema,
  type TopologyPolicyDefinition,
  type TopologyScope,
  type TopologyTargetDefinition,
} from '@breeze/shared';
import { db, withDbTransaction } from '../../db';
import { auditLogs, networkMonitors, topologyMonitorBindings, topologyMonitoringPolicies, topologyProbeTargets } from '../../db/schema';
import { requireTopologySiteAccess, type TopologyRequestContext } from './access';
import { loadPolicyTargetPins } from './monitoringArming';
import { TopologyOperationError } from './operationErrors';

/**
 * Monitor reuse (M3-D5). ONE validator decides whether an existing network
 * monitor measures exactly what a recurring policy context would: same site
 * (null-site legacy monitors are ineligible), same destination, port/path,
 * protocol and request semantics, and a compatible address family. Missing
 * evidence refuses equivalence. A binding records a digest of the monitor
 * definition it was validated against; every reuse re-validates it and a
 * drifted binding is dropped (the external monitor itself is never touched).
 */
export type MonitorCandidate = { siteId: string | null; isActive: boolean; monitorType: string; target: string; config: unknown };
export type MonitorEquivalence =
  | { equivalent: true; metricRole: 'port_reachability' | 'service_response' | 'name_resolution' }
  | { equivalent: false; reason: string };

const host = (value: string) => value.trim().toLowerCase().replace(/\.$/, '');
const config = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const refuse = (reason: string): MonitorEquivalence => ({ equivalent: false, reason });

export function topologyMonitorEquivalence(
  policy: { recipeId: string; targets: ReadonlyArray<TopologyTargetDefinition> },
  context: { siteId: string; family: 'ipv4' | 'ipv6' },
  monitor: MonitorCandidate,
): MonitorEquivalence {
  if (policy.recipeId !== 'target_connectivity' && policy.recipeId !== 'dns_basic') return refuse('recipe_not_reusable');
  if (policy.targets.length !== 1) return refuse(policy.targets.length ? 'target_ambiguous' : 'target_not_configured');
  if (monitor.siteId === null || monitor.siteId !== context.siteId) return refuse('monitor_site_mismatch');
  if (!monitor.isActive) return refuse('monitor_disabled');
  const target = policy.targets[0]!;
  if (!target.families.includes(context.family)) return refuse('family_mismatch');
  const cfg = config(monitor.config);
  switch (target.kind) {
    case 'tcp': {
      if (monitor.monitorType !== 'tcp_port') return refuse('protocol_mismatch');
      const literal = isIP(monitor.target);
      if (literal && (literal === 6 ? 'ipv6' : 'ipv4') !== context.family) return refuse('family_mismatch');
      if (host(monitor.target) !== host(target.host) || cfg.port !== target.port) return refuse('destination_mismatch');
      return { equivalent: true, metricRole: 'port_reachability' };
    }
    case 'https': {
      if (monitor.monitorType !== 'http_check') return refuse('protocol_mismatch');
      let url: URL;
      try { url = new URL(typeof cfg.url === 'string' ? cfg.url : monitor.target); } catch { return refuse('destination_unverified'); }
      const port = url.port ? Number(url.port) : 443;
      if (url.protocol !== 'https:' || host(url.hostname) !== host(target.hostname) || port !== target.port || `${url.pathname}${url.search}` !== target.path) {
        return refuse('destination_mismatch');
      }
      if ((typeof cfg.method === 'string' ? cfg.method : 'GET') !== target.method) return refuse('request_mismatch');
      if ((typeof cfg.expectedStatus === 'number' ? cfg.expectedStatus : 200) !== target.expectedStatus) return refuse('request_mismatch');
      if ((cfg.followRedirects === true) !== (target.maxRedirects > 0)) return refuse('request_mismatch');
      if (target.proxyMode !== 'direct') return refuse('request_mismatch');
      return { equivalent: true, metricRole: 'service_response' };
    }
    case 'dns_name': {
      if (monitor.monitorType !== 'dns_check') return refuse('protocol_mismatch');
      const record = typeof cfg.recordType === 'string' ? cfg.recordType : 'A';
      if (host(typeof cfg.hostname === 'string' ? cfg.hostname : monitor.target) !== host(target.hostname)) return refuse('destination_mismatch');
      if (record !== (context.family === 'ipv6' ? 'AAAA' : 'A') || cfg.nameserver !== undefined) return refuse('request_mismatch');
      return { equivalent: true, metricRole: 'name_resolution' };
    }
  }
}

export const topologyMonitorDigest = (monitor: MonitorCandidate & { id: string }) =>
  createHash('sha256').update(canonicalizeArguments({ id: monitor.id, siteId: monitor.siteId, isActive: monitor.isActive, monitorType: monitor.monitorType,
    target: monitor.target, config: config(monitor.config) })).digest('hex');

type BindingOrigin = { deviceId?: string; interfaceId?: string; monitorDigest?: string; targetId?: string; targetRevision?: string; policyRevision?: string };

async function policyEvidence(scope: TopologyScope, policyId: string) {
  const [policy] = await db.select().from(topologyMonitoringPolicies)
    .where(and(eq(topologyMonitoringPolicies.id, policyId), eq(topologyMonitoringPolicies.orgId, scope.orgId), eq(topologyMonitoringPolicies.siteId, scope.siteId)))
    .limit(1);
  if (!policy || policy.deletedAt !== null) return null;
  const { pins, drift } = await loadPolicyTargetPins(scope, policy.id);
  const targets = await Promise.all(pins.map(async (pin) => (await db.select({ definition: topologyProbeTargets.definition }).from(topologyProbeTargets)
    .where(and(eq(topologyProbeTargets.id, pin.id), eq(topologyProbeTargets.orgId, scope.orgId), eq(topologyProbeTargets.siteId, scope.siteId))).limit(1))[0]?.definition));
  return { policy, pins, drift, targets: targets.filter((t): t is TopologyTargetDefinition => !!t) };
}

async function readMonitor(scope: TopologyScope, monitorId: string) {
  const [monitor] = await db.select({ id: networkMonitors.id, orgId: networkMonitors.orgId, siteId: networkMonitors.siteId, isActive: networkMonitors.isActive,
    monitorType: networkMonitors.monitorType, target: networkMonitors.target, config: networkMonitors.config })
    .from(networkMonitors).where(and(eq(networkMonitors.id, monitorId), eq(networkMonitors.orgId, scope.orgId))).limit(1);
  return monitor ?? null;
}

/** Create (or replace) the binding for one armed policy context/family after full validation. */
export async function bindTopologyMonitor(
  ctx: TopologyRequestContext,
  policyId: string,
  input: { monitorId: string; contextKey: string; family: 'ipv4' | 'ipv6' },
): Promise<{ bindingId: string; metricRole: string }> {
  await requireTopologySiteAccess(ctx.auth, ctx.permissions, ctx.scope.siteId, 'configure');
  return withDbTransaction(async () => {
    const evidence = await policyEvidence(ctx.scope, policyId);
    if (!evidence) throw new TopologyOperationError('policy_not_found', 404);
    if (evidence.drift) throw new TopologyOperationError(evidence.drift, 409);
    const contexts = topologyPolicyRoutingContextsSchema.safeParse(evidence.policy.routingContexts);
    const context = contexts.success ? contexts.data.find((c) => c.contextKey === input.contextKey && c.family === input.family) : undefined;
    if (!context) throw new TopologyOperationError('context_not_armed', 409, 'Bind a monitor only to an armed policy context');
    const monitor = await readMonitor(ctx.scope, input.monitorId);
    if (!monitor) throw new TopologyOperationError('monitor_not_found', 404);
    const definition = evidence.policy.definition as TopologyPolicyDefinition;
    const verdict = topologyMonitorEquivalence({ recipeId: definition.recipeId, targets: evidence.targets }, { siteId: ctx.scope.siteId, family: input.family }, monitor);
    if (!verdict.equivalent) throw new TopologyOperationError(verdict.reason, 409, 'The monitor does not measure what this policy context measures');
    await db.delete(topologyMonitorBindings).where(and(eq(topologyMonitorBindings.orgId, ctx.scope.orgId), eq(topologyMonitorBindings.siteId, ctx.scope.siteId),
      eq(topologyMonitorBindings.policyId, policyId), eq(topologyMonitorBindings.contextKey, input.contextKey), eq(topologyMonitorBindings.family, input.family)));
    const origin: BindingOrigin = { deviceId: context.originDeviceId, monitorDigest: topologyMonitorDigest(monitor), targetId: evidence.pins[0]!.id,
      targetRevision: evidence.pins[0]!.revision, policyRevision: evidence.policy.revision.toString() };
    const [binding] = await db.insert(topologyMonitorBindings).values({
      ...ctx.scope, nodeId: context.originNodeId, monitorId: monitor.id, policyId, contextKey: input.contextKey, family: input.family,
      originPolicy: origin, metricRole: verdict.metricRole,
    }).returning({ id: topologyMonitorBindings.id });
    await db.insert(auditLogs).values({
      orgId: ctx.scope.orgId, actorType: 'user', actorId: ctx.auth.user.id, actorEmail: ctx.auth.user.email,
      action: 'topology.monitor_binding.created', resourceType: 'topology_monitor_binding', resourceId: binding!.id, result: 'success',
      details: { siteId: ctx.scope.siteId, policyId, monitorId: monitor.id, contextKey: input.contextKey, family: input.family },
    });
    return { bindingId: binding!.id, metricRole: verdict.metricRole };
  });
}

/** Remove a binding; the external monitor is never deleted or edited. */
export async function unbindTopologyMonitor(ctx: TopologyRequestContext, bindingId: string): Promise<{ removed: boolean }> {
  await requireTopologySiteAccess(ctx.auth, ctx.permissions, ctx.scope.siteId, 'configure');
  if (!/^[0-9a-f-]{36}$/i.test(bindingId)) throw new TopologyOperationError('monitor_binding_not_found', 404);
  const removed = await db.delete(topologyMonitorBindings)
    .where(and(eq(topologyMonitorBindings.id, bindingId), eq(topologyMonitorBindings.orgId, ctx.scope.orgId), eq(topologyMonitorBindings.siteId, ctx.scope.siteId)))
    .returning({ id: topologyMonitorBindings.id });
  return { removed: removed.length > 0 };
}

/**
 * Reuse check for one scheduled slot (scheduler, inside its transaction): a
 * still-equivalent binding means the external monitor supplies this context's
 * health and no probe run is created; a drifted binding is dropped so the
 * policy measures for itself again.
 */
export async function reusableTopologyMonitor(scope: TopologyScope, policy: { id: string; revision: bigint; definition: TopologyPolicyDefinition },
  context: { contextKey: string; family: 'ipv4' | 'ipv6' }): Promise<string | null> {
  const [binding] = await db.select().from(topologyMonitorBindings)
    .where(and(eq(topologyMonitorBindings.orgId, scope.orgId), eq(topologyMonitorBindings.siteId, scope.siteId), eq(topologyMonitorBindings.policyId, policy.id),
      eq(topologyMonitorBindings.contextKey, context.contextKey), eq(topologyMonitorBindings.family, context.family)))
    .limit(1);
  if (!binding?.monitorId) return null;
  const evidence = await policyEvidence(scope, policy.id);
  const monitor = await readMonitor(scope, binding.monitorId);
  const origin = binding.originPolicy as BindingOrigin;
  const current = !!evidence && !evidence.drift && !!monitor
    && origin.monitorDigest === topologyMonitorDigest(monitor)
    && origin.targetId === evidence.pins[0]?.id && origin.targetRevision === evidence.pins[0]?.revision
    && topologyMonitorEquivalence({ recipeId: policy.definition.recipeId, targets: evidence.targets }, { siteId: scope.siteId, family: context.family }, monitor).equivalent;
  if (current) return binding.monitorId;
  await db.delete(topologyMonitorBindings).where(eq(topologyMonitorBindings.id, binding.id));
  return null;
}
