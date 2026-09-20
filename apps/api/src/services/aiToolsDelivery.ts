import { z } from 'zod';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db';
import { notificationChannels, notificationRoutingRules, escalationPolicies } from '../db/schema';
import { hasSatisfiedMfa, type AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { writeAuditEvent, requestLikeFromSnapshot } from './auditEvents';
import { deliveryToolSchema } from './aiToolSchemas';
import { createRoutingRuleSchema, updateRoutingRuleSchema, upsertDefaultRowSchema,
  canAccessRoutingSites, routingSiteIds, getRoutingRuleWithAccess } from './delivery/railContracts';
import { createPolicySchema, updatePolicySchema } from './delivery/railContracts';
import { resolveWriteOrgId, getEscalationPolicyWithOrgCheck } from './delivery/railContracts';
import { canManagePartnerWidePolicies, canReadPartnerWideRows, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from './partnerWideAccess';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from './siteCeilingAccess';
import { DeliveryWriteError, assertDefaultRowPatch, escalationPolicyCompatible,
  upsertDefaultRow, type RoutingOwner } from './delivery/routingRuleWrites';
import { railOwnershipCondition, partnerIdForOrg } from './delivery/railOwnership';
import { previewDelivery } from './delivery/describeDelivery';
import { readInheritedRails } from './delivery/inheritedRails';
import { validatePolicyUsers } from './delivery/railContracts';

const READS = new Set(['resolve', 'list_routing', 'list_escalation']);
type Input = z.infer<typeof deliveryToolSchema>;
function fail(status: 400 | 403 | 404 | 409, message: string): never { throw new DeliveryWriteError(status, message); }
function resolveOwner(input: Input, auth: AuthContext): RoutingOwner {
  if (input.ownerScope === 'partner') {
    if (!auth.partnerId || !canReadPartnerWideRows(auth, auth.partnerId)) fail(403, PARTNER_WIDE_WRITE_DENIED_MESSAGE);
    return { orgId: null, partnerId: auth.partnerId };
  }
  const owner = resolveWriteOrgId(auth, input.orgId);
  if (owner.error || !owner.orgId) fail(owner.status ?? 400, owner.error ?? 'Organization context required');
  if (!auth.canAccessOrg(owner.orgId)) fail(403, 'Access to this organization denied');
  return { orgId: owner.orgId, partnerId: null };
}
function assertWritable(owner: RoutingOwner, auth: AuthContext): void {
  if (owner.orgId === null && !canManagePartnerWidePolicies(auth)) fail(403, PARTNER_WIDE_WRITE_DENIED_MESSAGE);
}
async function validateChannels(ids: string[], owner: RoutingOwner): Promise<void> {
  const unique = [...new Set(ids)]; if (!unique.length) return;
  const axis = owner.orgId !== null
    ? railOwnershipCondition(notificationChannels.orgId, notificationChannels.partnerId, owner.orgId, await partnerIdForOrg(owner.orgId))
    : and(isNull(notificationChannels.orgId), eq(notificationChannels.partnerId, owner.partnerId!));
  const rows = await db.select({ id: notificationChannels.id }).from(notificationChannels).where(and(axis, inArray(notificationChannels.id, unique)));
  if (rows.length !== unique.length) fail(400, 'Notification channels are not available to this owner');
}
async function validateRouting(data: { channelIds?: string[]; escalationPolicyId?: string | null; conditions?: unknown }, owner: RoutingOwner, auth: AuthContext): Promise<void> {
  if (data.channelIds !== undefined) await validateChannels(data.channelIds, owner);
  if (data.escalationPolicyId && !(await escalationPolicyCompatible(data.escalationPolicyId, owner))) fail(400, 'Escalation policy is not available to this rule owner');
  if (data.conditions !== undefined && !(await canAccessRoutingSites(auth, owner, routingSiteIds(data.conditions), true))) fail(403, 'Routing rule sites are outside your permitted sites');
}
function auditDeliveryWrite(
  auth: AuthContext,
  action: string,
  resourceType: string,
  row: { orgId: string | null; id: string; name: string },
  details?: Record<string, unknown>,
): void {
  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId: row.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action,
      resourceType,
      resourceId: row.id,
      resourceName: row.name,
      result: 'success',
      details: { ...details, tool_name: 'manage_delivery' },
    });
  } catch (error) {
    console.error('[manage_delivery] audit write failed', error);
  }
}
async function execute(input: Input, auth: AuthContext): Promise<unknown> {
  if (!['organization','partner','system'].includes(auth.scope)) fail(403, 'Scope not permitted');
  if (!READS.has(input.action)) {
    if (!canMutateOrgWideGovernance(auth)) fail(403, SITE_CEILING_WRITE_DENIED_MESSAGE);
    // Agent writes require upstream Tier-3 supervised approval instead of human MFA.
    if (auth.principal?.kind !== 'ai_agent' && !hasSatisfiedMfa(auth)) fail(403, 'MFA required');
  }
  if (input.action === 'resolve') return previewDelivery({ orgId: input.orgId!, severity: input.severity!, kind: input.kind, siteId: input.siteId, monitorId: input.monitorId }, auth);
  if (input.action === 'list_routing' || input.action === 'list_escalation') {
    const owner = resolveOwner(input, auth);
    const partnerId = owner.orgId ? await partnerIdForOrg(owner.orgId, db) : null;
    const inherited = owner.orgId && partnerId ? await readInheritedRails(
      input.action === 'list_routing' ? 'routing' : 'escalation',
      { orgId: owner.orgId, partnerId, allowedSiteIds: auth.allowedSiteIds }, db,
    ) : [];
    if (input.action === 'list_routing') {
      const axis = owner.orgId !== null ? eq(notificationRoutingRules.orgId, owner.orgId)
        : and(isNull(notificationRoutingRules.orgId), eq(notificationRoutingRules.partnerId, owner.partnerId!));
      const rows = await db.select().from(notificationRoutingRules).where(axis)
        .orderBy(asc(notificationRoutingRules.isDefault), asc(notificationRoutingRules.priority), asc(notificationRoutingRules.id)).limit(100);
      const visible = await Promise.all(rows.map(async row =>
        await canAccessRoutingSites(auth, owner, routingSiteIds(row.conditions), false) ? row : null));
      return { data: [...visible.filter(row => row !== null), ...inherited].slice(0, 100) };
    }
    const axis = owner.orgId !== null ? eq(escalationPolicies.orgId, owner.orgId)
      : and(isNull(escalationPolicies.orgId), eq(escalationPolicies.partnerId, owner.partnerId!));
    const own = await db.select().from(escalationPolicies).where(axis).orderBy(asc(escalationPolicies.id)).limit(100);
    return { data: [...own, ...inherited].slice(0, 100) };
  }
  if (input.action === 'create_routing' || input.action === 'set_default') {
    const owner = resolveOwner(input, auth); assertWritable(owner, auth);
    if (input.action === 'set_default') {
      const data = upsertDefaultRowSchema.omit({ ownerScope: true }).strict().parse(input.data);
      await validateRouting(data, owner, auth);
      const row = await upsertDefaultRow(owner, { channelIds: data.channelIds, escalationPolicyId: data.escalationPolicyId ?? null }, auth);
      auditDeliveryWrite(auth, 'notification_routing_rule.default_upsert', 'notification_routing_rule', row,
        { channelCount: data.channelIds.length, inboxOnly: data.channelIds.length === 0 });
      return { data: row };
    }
    const data = createRoutingRuleSchema.omit({ ownerScope: true }).strict().parse(input.data);
    await validateRouting(data, owner, auth);
    const [row] = await db.insert(notificationRoutingRules).values({ ...owner, name: data.name, priority: data.priority,
      conditions: data.conditions, channelIds: [...new Set(data.channelIds)], enabled: data.enabled,
      escalationPolicyId: data.escalationPolicyId ?? null, isDefault: false }).returning();
    if (!row) throw new Error('Insert returned no row');
    auditDeliveryWrite(auth, 'notification_routing_rule.create', 'notification_routing_rule', row,
      { priority: data.priority, channelCount: data.channelIds.length });
    return { data: row };
  }
  if (input.action === 'update_routing' || input.action === 'delete_routing') {
    const row = await getRoutingRuleWithAccess(input.id!, auth);
    if (!row) fail(404, 'Routing rule not found');
    const owner = { orgId: row.orgId, partnerId: row.partnerId }; assertWritable(owner, auth);
    if (!(await canAccessRoutingSites(auth, owner, routingSiteIds(row.conditions), true))) fail(403, 'Routing rule sites are outside your permitted sites');
    if (input.action === 'delete_routing') {
      if (row.isDefault && row.orgId === null) fail(409, 'The partner Everything else row cannot be deleted; empty its channels for inbox delivery (escalation still applies)');
      // assertWritable above enforces governance for deleting the optional org default.
      const deleted = await db.delete(notificationRoutingRules).where(eq(notificationRoutingRules.id, row.id)).returning({ id: notificationRoutingRules.id });
      if (!deleted.length) fail(404, 'Routing rule not found');
      auditDeliveryWrite(auth, 'notification_routing_rule.delete', 'notification_routing_rule', row);
      return { data: { id: row.id, deleted: true } };
    }
    const data = updateRoutingRuleSchema.strict().parse(input.data);
    if (!Object.keys(data).length) fail(400, 'No updates provided');
    if (row.isDefault) assertDefaultRowPatch(data);
    else if (data.channelIds?.length === 0) fail(400, 'channelIds must contain at least one channel');
    await validateRouting(data, owner, auth);
    const [updated] = await db.update(notificationRoutingRules).set({ ...data, updatedAt: new Date() })
      .where(eq(notificationRoutingRules.id, row.id)).returning();
    if (!updated) fail(404, 'Routing rule not found');
    auditDeliveryWrite(auth, 'notification_routing_rule.update', 'notification_routing_rule',
      { ...row, name: updated.name ?? row.name }, { updatedFields: Object.keys(data) });
    return { data: updated };
  }
  if (input.action === 'create_escalation') {
    const owner = resolveOwner(input, auth); assertWritable(owner, auth);
    const data = createPolicySchema.omit({ ownerScope: true, orgId: true }).strict().parse(input.data);
    await validateChannels(data.steps.flatMap(step => step.channelIds), owner);
    await validatePolicyUsers(data.steps, owner, auth);
    const [row] = await db.insert(escalationPolicies).values({ ...owner, name: data.name, steps: data.steps }).returning();
    if (!row) throw new Error('Insert returned no row');
    auditDeliveryWrite(auth, 'escalation_policy.create', 'escalation_policy', row,
      { stepCount: Array.isArray(row.steps) ? row.steps.length : undefined });
    return { data: row };
  }
  const row = await getEscalationPolicyWithOrgCheck(input.id!, auth);
  if (!row) fail(404, 'Escalation policy not found');
  const owner = { orgId: row.orgId, partnerId: row.partnerId }; assertWritable(owner, auth);
  if (input.action === 'delete_escalation') {
    const deleted = await db.delete(escalationPolicies).where(eq(escalationPolicies.id, row.id)).returning({ id: escalationPolicies.id });
    if (!deleted.length) fail(404, 'Escalation policy not found');
    auditDeliveryWrite(auth, 'escalation_policy.delete', 'escalation_policy', row);
    return { data: { id: row.id, deleted: true } };
  }
  const data = updatePolicySchema.strict().parse(input.data);
  if (!Object.keys(data).length) fail(400, 'No updates provided');
  if (data.steps) {
    await validateChannels(data.steps.flatMap(step => step.channelIds), owner);
    await validatePolicyUsers(data.steps, owner, auth, row.steps);
  }
  const [updated] = await db.update(escalationPolicies).set({ ...data, updatedAt: new Date() }).where(eq(escalationPolicies.id, row.id)).returning();
  if (!updated) fail(404, 'Escalation policy not found');
  auditDeliveryWrite(auth, 'escalation_policy.update', 'escalation_policy',
    { ...updated, orgId: row.orgId }, { updatedFields: Object.keys(data) });
  return { data: updated };
}
export function registerDeliveryTools(registry: Map<string, AiTool>): void {
  registry.set('manage_delivery', {
    tier: 1,
    domain: 'monitoring',
    searchHint: 'alert delivery: preview, routing rules, default destinations, escalation policies and recipients',
    definition: {
      name: 'manage_delivery',
      description: 'Alert delivery; writes need approval. channelIds: [] means inbox-only. Channel CRUD: manage_notification_channels. Actions: resolve,list_routing,create_routing,update_routing,delete_routing,set_default,list_escalation,create_escalation,update_escalation,delete_escalation.',
      input_schema: z.toJSONSchema(deliveryToolSchema) as AiTool['definition']['input_schema'],
    },
    handler: async (raw, auth) => {
      try { return JSON.stringify(await execute(deliveryToolSchema.parse(raw), auth)); }
      catch (error) {
        if (error instanceof z.ZodError) return JSON.stringify({ error: error.issues[0]?.message ?? 'Invalid delivery request', status: 400 });
        if (error instanceof DeliveryWriteError) return JSON.stringify({ error: error.message, status: error.status });
        console.error('[manage_delivery] Operation failed', error);
        return JSON.stringify({ error: 'Delivery operation failed' });
      }
    },
  });
}
