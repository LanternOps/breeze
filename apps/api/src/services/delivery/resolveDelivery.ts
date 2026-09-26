/**
 * ONE delivery decision (spec §Delivery resolution, W05b). Used by the
 * dispatcher (system context), by GET /alerts/delivery/resolve (request
 * context — the partner-wide SELECT branch makes the partner's rows visible
 * to an org token) and by the manage_delivery AI tool. If the three ever
 * disagree, deliveryResolution.integration.test.ts is the proof.
 *
 * Precedence, first hit wins:
 *   1. monitor deliveryMode 'none'      → inbox only            (monitor_none)
 *   2. monitor deliveryMode 'channels'  → monitor's channels    (monitor_channels)
 *   3. first matching routing row       → row's channels        (routing_rule)
 *   4. org is_default row, else partner is_default row          (default_row)
 *   5. nothing                          → inbox only            (none)
 * Escalation resolves independently: monitor's (mode ≠ none) ?? winning row's ?? null.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AlertSeverity, MonitorKind } from '@breeze/shared';
import { db } from '../../db';
import { monitorDefinitions, notificationChannels, notificationRoutingRules, type RoutingRuleConditions } from '../../db/schema';
import { partnerIdForOrg, railOwnershipCondition, type DbExecutor } from './railOwnership';

export type DeliverySource =
  | 'monitor_none'
  | 'monitor_channels'
  | 'routing_rule'
  | 'default_row'
  | 'none';

export interface ResolveDeliveryInput {
  orgId: string;
  severity: AlertSeverity;
  monitorId?: string | null;
  kind?: MonitorKind | null;
  siteId?: string | null;

}

export interface ResolvedDelivery {
  /** Eligible, visible, enabled, owner-valid destinations only (D21). */
  channelIds: string[];
  skippedChannelIds: Array<{ id: string; reason: 'disabled' | 'unavailable' }>;
  escalationPolicyId: string | null;
  source: DeliverySource;
  routingRuleId?: string;
  routingRuleName?: string;
}

type MonitorDelivery = 'inherit' | 'channels' | 'none';

function uniq(ids: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

export function routingRuleMatches(
  conditions: RoutingRuleConditions | null | undefined,
  facts: { severity: string; kind: string | null; siteId: string | null }
): boolean {
  const c = conditions ?? {};
  if (Array.isArray(c.severities) && c.severities.length > 0 && !c.severities.includes(facts.severity)) return false;
  // Fail closed: a kind-scoped row never catches an alert with no monitor kind.
  if (Array.isArray(c.monitorKinds) && c.monitorKinds.length > 0 && (!facts.kind || !c.monitorKinds.includes(facts.kind))) return false;
  // Fail closed (unchanged): a site-scoped row never catches an alert whose device site is unknown.
  if (Array.isArray(c.siteIds) && c.siteIds.length > 0 && (!facts.siteId || !c.siteIds.includes(facts.siteId))) return false;
  return true;
}

/** Non-default first; then priority ASC; then org rows before partner rows. */
export function orderRoutingRows<T extends { isDefault: boolean; priority: number; orgId: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? 1 : -1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    const aOrg = a.orgId !== null ? 0 : 1;
    const bOrg = b.orgId !== null ? 0 : 1;
    return aOrg - bOrg;
  });
}

export async function resolveDelivery(
  input: ResolveDeliveryInput,
  executor: DbExecutor = db
): Promise<ResolvedDelivery> {
  const orgPartnerId = await partnerIdForOrg(input.orgId, executor);
  const finish = async (decision: Omit<ResolvedDelivery, 'skippedChannelIds'>): Promise<ResolvedDelivery> => {
    const ids = uniq(decision.channelIds);
    if (!ids.length) return { ...decision, channelIds: [], skippedChannelIds: [] };
    // Use the caller's executor unchanged. Project only eligibility metadata.
    const rows = await executor.select({
      id: notificationChannels.id, orgId: notificationChannels.orgId,
      partnerId: notificationChannels.partnerId, enabled: notificationChannels.enabled,
    }).from(notificationChannels).where(inArray(notificationChannels.id, ids));
    const byId = new Map(rows.map(row => [row.id, row]));
    const skippedChannelIds: ResolvedDelivery['skippedChannelIds'] = [];
    const channelIds = ids.filter(id => {
      const channel = byId.get(id);
      // System reads can see foreign rows; org reads cannot. Apply exactly the
      // same predicate before enabled state, so neither exposes existence.
      const ownerValid = channel && (channel.orgId === input.orgId ||
        (channel.orgId === null && orgPartnerId !== null && channel.partnerId === orgPartnerId));
      const reason = !ownerValid ? 'unavailable' : !channel!.enabled ? 'disabled' : null;
      if (reason === null) return true;
      skippedChannelIds.push({ id, reason }); return false;
    });
    return { ...decision, channelIds, skippedChannelIds };
  };


  let kind: string | null = input.kind ?? null;
  let monitorMode: MonitorDelivery | null = null;
  let monitorChannels: string[] = [];
  let monitorEscalation: string | null = null;

  if (input.monitorId) {
    const [monitor] = await executor
      .select({
        kind: monitorDefinitions.kind,
        deliveryMode: monitorDefinitions.deliveryMode,
        deliveryChannelIds: monitorDefinitions.deliveryChannelIds,
        escalationPolicyId: monitorDefinitions.escalationPolicyId,
      })
      .from(monitorDefinitions)
      .where(eq(monitorDefinitions.id, input.monitorId))
      .limit(1);
    if (monitor) {
      monitorMode = monitor.deliveryMode as MonitorDelivery;
      monitorChannels = uniq(monitor.deliveryChannelIds ?? []);
      monitorEscalation = monitor.escalationPolicyId ?? null;
      kind = kind ?? monitor.kind;
    }
  }

  // 1. Inbox only is an opinion: no channels, and no escalation either.
  if (monitorMode === 'none') {
    return finish({ channelIds: [], escalationPolicyId: null, source: 'monitor_none' });
  }
  // 2. Explicit channels on the monitor.
  if (monitorMode === 'channels') {
    return finish({ channelIds: monitorChannels, escalationPolicyId: monitorEscalation, source: 'monitor_channels' });
  }

  // 3–4. Routing rows for the org and its partner, one ordering.
  const rows = orderRoutingRows(
    await executor
      .select()
      .from(notificationRoutingRules)
      .where(
        and(
          railOwnershipCondition(notificationRoutingRules.orgId, notificationRoutingRules.partnerId, input.orgId, orgPartnerId),
          eq(notificationRoutingRules.enabled, true)
        )
      )
      .orderBy(asc(notificationRoutingRules.priority))
  );

  const facts = { severity: input.severity, kind, siteId: input.siteId ?? null };
  for (const rule of rows) {
    if (rule.isDefault) continue;
    if (!routingRuleMatches(rule.conditions, facts)) continue;
    const channelIds = uniq(rule.channelIds ?? []);
    if (channelIds.length === 0) continue;
    return finish({
      channelIds,
      escalationPolicyId: monitorEscalation ?? rule.escalationPolicyId ?? null,
      source: 'routing_rule',
      routingRuleId: rule.id,
      routingRuleName: rule.name,
    });
  }

  const defaultRow =
    rows.find((r) => r.isDefault && r.orgId === input.orgId) ??
    rows.find((r) => r.isDefault && r.orgId === null);
  if (defaultRow) {
    return finish({
      channelIds: uniq(defaultRow.channelIds ?? []),
      escalationPolicyId: monitorEscalation ?? defaultRow.escalationPolicyId ?? null,
      source: 'default_row',
      routingRuleId: defaultRow.id,
      routingRuleName: defaultRow.name,
    });
  }

  // 5. Fresh install: nothing configured. Caller logs it.
  return finish({ channelIds: [], escalationPolicyId: monitorEscalation ?? null, source: 'none' });
}
