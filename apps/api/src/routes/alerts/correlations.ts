import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, or, type SQL } from 'drizzle-orm';

import { db } from '../../db';
import { alertCorrelationGroups, alertCorrelationMembers, alertCorrelations, alerts, devices } from '../../db/schema';
import { requirePermission, requireScope } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { publishEvent } from '../../services/eventBus';
import { emitAlertStateFeedback, emitCorrelationFeedback } from '../../services/mlFeedbackEmitters';
import { PERMISSIONS } from '../../services/permissions';

export const alertCorrelationRoutes = new Hono();

const alertIdParamSchema = z.object({ alertId: z.string().uuid() });
const groupIdParamSchema = z.object({ groupId: z.string().uuid() });

const requireAlertRead = requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action);
const requireAlertWrite = requirePermission(PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action);
const requireAlertAcknowledge = requirePermission(PERMISSIONS.ALERTS_ACKNOWLEDGE.resource, PERMISSIONS.ALERTS_ACKNOWLEDGE.action);

type AuthContext = {
  scope: 'organization' | 'partner' | 'system';
  orgId?: string | null;
  accessibleOrgIds?: string[] | null;
  user: { id: string };
  canAccessOrg: (orgId: string) => boolean;
};

type AlertRow = typeof alerts.$inferSelect;
type CorrelationRow = typeof alertCorrelations.$inferSelect;
type CorrelationGroupRow = typeof alertCorrelationGroups.$inferSelect;

function orgConditionsForAuth(auth: AuthContext): SQL[] | null {
  if (auth.scope === 'organization') {
    return auth.orgId ? [eq(alerts.orgId, auth.orgId)] : null;
  }

  if (auth.scope === 'partner') {
    const orgIds = auth.accessibleOrgIds ?? [];
    return orgIds.length > 0 ? [inArray(alerts.orgId, orgIds)] : null;
  }

  return [];
}

function groupOrgConditionsForAuth(auth: AuthContext): SQL[] | null {
  if (auth.scope === 'organization') {
    return auth.orgId ? [eq(alertCorrelationGroups.orgId, auth.orgId)] : null;
  }

  if (auth.scope === 'partner') {
    const orgIds = auth.accessibleOrgIds ?? [];
    return orgIds.length > 0 ? [inArray(alertCorrelationGroups.orgId, orgIds)] : null;
  }

  return [];
}

async function getAccessibleAlert(alertId: string, auth: AuthContext): Promise<AlertRow | null> {
  const [alert] = await db
    .select()
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert || !auth.canAccessOrg(alert.orgId)) {
    return null;
  }

  return alert;
}

async function listAccessibleAlerts(auth: AuthContext): Promise<AlertRow[]> {
  const orgConditions = orgConditionsForAuth(auth);
  if (orgConditions === null) {
    return [];
  }
  if (orgConditions.length === 0) {
    return db.select().from(alerts);
  }
  return db.select().from(alerts).where(and(...orgConditions));
}

function alertDisplayDevice(alert: AlertRow & { deviceHostname?: string | null }) {
  return alert.deviceHostname ?? alert.deviceId;
}

function toGroupAlert(alert: AlertRow & { deviceHostname?: string | null }) {
  return {
    id: alert.id,
    title: alert.title,
    severity: alert.severity,
    status: alert.status,
    device: alertDisplayDevice(alert),
    triggeredAt: alert.triggeredAt,
  };
}

type GroupAlert = ReturnType<typeof toGroupAlert>;

interface CorrelationGroupForUi {
  id: string;
  rootCause: GroupAlert | null;
  relatedCount: number;
  alerts: GroupAlert[];
  correlationScore: number;
  correlationLinks: CorrelationRow[];
  createdAt: Date;
  noiseReductionPercent?: number;
  status?: string;
  memberCount?: number;
  firstSeenAt?: Date;
  lastSeenAt?: Date;
  metadata?: unknown;
}

function correlationTypeForUi(link: CorrelationRow): 'causal' | 'symptom' | 'duplicate' {
  if (link.correlationType.includes('duplicate')) return 'duplicate';
  if (link.correlationType.includes('causal')) return 'causal';
  return 'symptom';
}

async function buildCorrelationGroups(auth: AuthContext): Promise<CorrelationGroupForUi[]> {
  const orgAlerts = await listAccessibleAlerts(auth);
  const orgAlertIds = orgAlerts.map((alert) => alert.id);
  if (orgAlertIds.length === 0) {
    return [];
  }

  const deviceRows = await db
    .select({ id: devices.id, hostname: devices.hostname })
    .from(devices)
    .where(inArray(devices.id, orgAlerts.map((alert) => alert.deviceId)));
  const deviceNames = new Map(deviceRows.map((device) => [device.id, device.hostname]));
  const alertMap = new Map(
    orgAlerts.map((alert) => [alert.id, { ...alert, deviceHostname: deviceNames.get(alert.deviceId) ?? null }])
  );

  const scopedCorrelations = await db
    .select()
    .from(alertCorrelations)
    .where(
      and(
        inArray(alertCorrelations.parentAlertId, orgAlertIds),
        inArray(alertCorrelations.childAlertId, orgAlertIds)
      )
    )
    .orderBy(desc(alertCorrelations.createdAt));

  const parent = new Map<string, string>();
  const find = (id: string): string => {
    if (!parent.has(id)) parent.set(id, id);
    if (parent.get(id) !== id) parent.set(id, find(parent.get(id)!));
    return parent.get(id)!;
  };
  const union = (a: string, b: string) => {
    parent.set(find(a), find(b));
  };

  for (const correlation of scopedCorrelations) {
    union(correlation.parentAlertId, correlation.childAlertId);
  }

  const groupMap = new Map<string, string[]>();
  for (const correlation of scopedCorrelations) {
    const root = find(correlation.parentAlertId);
    const alertIds = groupMap.get(root) ?? [];
    if (!alertIds.includes(correlation.parentAlertId)) alertIds.push(correlation.parentAlertId);
    if (!alertIds.includes(correlation.childAlertId)) alertIds.push(correlation.childAlertId);
    groupMap.set(root, alertIds);
  }

  return [...groupMap.entries()].map(([rootId, alertIds]) => {
    const groupAlerts = alertIds
      .map((id) => alertMap.get(id))
      .filter((alert): alert is AlertRow & { deviceHostname?: string | null } => Boolean(alert))
      .sort((a, b) => b.triggeredAt.getTime() - a.triggeredAt.getTime());
    const groupCorrelations = scopedCorrelations.filter(
      (correlation) => alertIds.includes(correlation.parentAlertId) || alertIds.includes(correlation.childAlertId)
    );
    const rootCause = groupAlerts[0] ?? alertMap.get(rootId);
    const avgConfidence = groupCorrelations.length > 0
      ? groupCorrelations.reduce((sum, correlation) => sum + Number(correlation.confidence ?? 0), 0) / groupCorrelations.length
      : 0;

    return {
      id: rootId,
      rootCause: rootCause ? toGroupAlert(rootCause) : null,
      relatedCount: Math.max(groupAlerts.length - 1, 0),
      alerts: groupAlerts.map(toGroupAlert),
      correlationScore: Math.round(avgConfidence * 100) / 100,
      correlationLinks: groupCorrelations,
      createdAt: groupCorrelations[0]?.createdAt ?? new Date(),
    };
  }).filter((group) => group.rootCause !== null);
}

async function getAccessiblePersistedGroup(groupId: string, auth: AuthContext): Promise<CorrelationGroupRow | null> {
  const groupOrgConditions = groupOrgConditionsForAuth(auth);
  if (groupOrgConditions === null) {
    return null;
  }

  const where = and(
    eq(alertCorrelationGroups.id, groupId),
    ...(groupOrgConditions.length > 0 ? groupOrgConditions : [])
  );

  const [group] = await db
    .select()
    .from(alertCorrelationGroups)
    .where(where)
    .limit(1);

  return group ?? null;
}

async function buildPersistedCorrelationGroups(auth: AuthContext, groupId?: string): Promise<CorrelationGroupForUi[]> {
  const groupOrgConditions = groupOrgConditionsForAuth(auth);
  if (groupOrgConditions === null) {
    return [];
  }

  const groupsWhere = and(
    ...(groupId ? [eq(alertCorrelationGroups.id, groupId)] : []),
    ...(groupOrgConditions.length > 0 ? groupOrgConditions : [])
  );

  const persistedGroups = await db
    .select()
    .from(alertCorrelationGroups)
    .where(groupsWhere)
    .orderBy(desc(alertCorrelationGroups.lastSeenAt))
    .limit(groupId ? 1 : 50);

  if (persistedGroups.length === 0) {
    return [];
  }

  const groupIds = persistedGroups.map((group) => group.id);
  const members = await db
    .select()
    .from(alertCorrelationMembers)
    .where(inArray(alertCorrelationMembers.groupId, groupIds));

  const alertIds = [...new Set(members.map((member) => member.alertId))];
  const memberAlerts = alertIds.length > 0
    ? await db.select().from(alerts).where(inArray(alerts.id, alertIds))
    : [];
  const alertById = new Map(memberAlerts.map((alert) => [alert.id, alert]));

  const deviceIds = [...new Set(memberAlerts.map((alert) => alert.deviceId))];
  const deviceRows = deviceIds.length > 0
    ? await db.select({ id: devices.id, hostname: devices.hostname }).from(devices).where(inArray(devices.id, deviceIds))
    : [];
  const deviceNames = new Map(deviceRows.map((device) => [device.id, device.hostname]));

  return persistedGroups.map((group) => {
    const groupMembers = members
      .filter((member) => member.groupId === group.id)
      .sort((a, b) => {
        if (a.role === b.role) return a.createdAt.getTime() - b.createdAt.getTime();
        return a.role === 'root' ? -1 : 1;
      });
    const groupAlerts = groupMembers
      .map((member) => alertById.get(member.alertId))
      .filter((alert): alert is AlertRow => Boolean(alert))
      .map((alert) => ({ ...alert, deviceHostname: deviceNames.get(alert.deviceId) ?? null }))
      .sort((a, b) => b.triggeredAt.getTime() - a.triggeredAt.getTime());
    const rootCause =
      (group.rootAlertId ? groupAlerts.find((alert) => alert.id === group.rootAlertId) : undefined) ??
      groupAlerts[0] ??
      null;

    return {
      id: group.id,
      rootCause: rootCause ? toGroupAlert(rootCause) : null,
      relatedCount: Math.max(groupAlerts.length - 1, 0),
      alerts: groupAlerts.map(toGroupAlert),
      correlationScore: Number(group.score ?? 0),
      noiseReductionPercent: group.noiseReductionPercent,
      status: group.status,
      memberCount: group.memberCount,
      firstSeenAt: group.firstSeenAt,
      lastSeenAt: group.lastSeenAt,
      metadata: group.metadata ?? {},
      correlationLinks: [],
      createdAt: group.createdAt,
    };
  }).filter((group) => group.rootCause !== null);
}

async function getPersistedGroupAlerts(groupId: string, auth: AuthContext): Promise<AlertRow[] | null> {
  const group = await getAccessiblePersistedGroup(groupId, auth);
  if (!group) return null;

  const members = await db
    .select()
    .from(alertCorrelationMembers)
    .where(and(eq(alertCorrelationMembers.orgId, group.orgId), eq(alertCorrelationMembers.groupId, group.id)));
  if (members.length === 0) return [];

  const alertIds = members.map((member) => member.alertId);
  return db.select().from(alerts).where(and(eq(alerts.orgId, group.orgId), inArray(alerts.id, alertIds)));
}

async function updatePersistedGroupStatus(groupId: string, status: 'acknowledged' | 'resolved'): Promise<void> {
  await db
    .update(alertCorrelationGroups)
    .set({ status, updatedAt: new Date() })
    .where(eq(alertCorrelationGroups.id, groupId));
}

async function mutateAlerts(alertRows: AlertRow[], action: 'acknowledge' | 'resolve', userId: string) {
  const now = new Date();
  const eligible = action === 'acknowledge'
    ? alertRows.filter((alert) => alert.status === 'active')
    : alertRows.filter((alert) => alert.status !== 'resolved');

  if (eligible.length === 0) {
    return { updated: 0, skipped: alertRows.length };
  }

  const alertIds = eligible.map((alert) => alert.id);
  await db
    .update(alerts)
    .set(action === 'acknowledge'
      ? { status: 'acknowledged', acknowledgedAt: now, acknowledgedBy: userId }
      : { status: 'resolved', resolvedAt: now, resolvedBy: userId })
    .where(inArray(alerts.id, alertIds));

  for (const alert of eligible) {
    void publishEvent(
      action === 'acknowledge' ? 'alert.acknowledged' : 'alert.resolved',
      alert.orgId,
      {
        alertId: alert.id,
        ruleId: alert.ruleId,
        deviceId: alert.deviceId,
        ...(action === 'acknowledge' ? { acknowledgedBy: userId } : { resolvedBy: userId }),
      },
      'alerts-correlation-route',
      { userId }
    ).catch((error) => {
      console.error(`[AlertCorrelationRoute] Failed to publish alert.${action}d event:`, error);
    });

    void emitAlertStateFeedback({
      orgId: alert.orgId,
      alertId: alert.id,
      eventType: action === 'acknowledge' ? 'alert.acknowledged' : 'alert.resolved',
      outcome: action === 'acknowledge' ? 'acknowledged' : 'resolved',
      actorUserId: userId,
      occurredAt: now,
      metadata: {
        source: 'alert_correlation',
        previousStatus: alert.status,
      },
    });
  }

  return { updated: eligible.length, skipped: alertRows.length - eligible.length };
}

alertCorrelationRoutes.get(
  '/correlations',
  requireScope('organization', 'partner', 'system'),
  requireAlertRead,
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const persistedGroups = await buildPersistedCorrelationGroups(auth);
    const groups = persistedGroups.length > 0 ? persistedGroups : await buildCorrelationGroups(auth);
    return c.json({ groups, data: groups });
  }
);

alertCorrelationRoutes.get(
  '/correlations/:groupId',
  requireScope('organization', 'partner', 'system'),
  requireAlertRead,
  zValidator('param', groupIdParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { groupId } = c.req.valid('param');
    const [group] = await buildPersistedCorrelationGroups(auth, groupId);
    if (!group) {
      return c.json({ error: 'Correlation group not found' }, 404);
    }

    return c.json({ group, data: group });
  }
);

alertCorrelationRoutes.post(
  '/correlations/:groupId/acknowledge',
  requireScope('organization', 'partner', 'system'),
  requireAlertAcknowledge,
  zValidator('param', groupIdParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { groupId } = c.req.valid('param');
    const persistedGroupAlerts = await getPersistedGroupAlerts(groupId, auth);
    const groups = persistedGroupAlerts === null ? await buildCorrelationGroups(auth) : [];
    const group = groups.find((candidate) => candidate.id === groupId);
    if (persistedGroupAlerts === null && !group) {
      return c.json({ error: 'Correlation group not found' }, 404);
    }

    const groupAlertIds = persistedGroupAlerts !== null ? persistedGroupAlerts.map((alert) => alert.id) : group!.alerts.map((alert) => alert.id);
    const groupAlerts = persistedGroupAlerts ?? await db.select().from(alerts).where(inArray(alerts.id, groupAlertIds));
    const result = await mutateAlerts(groupAlerts, 'acknowledge', auth.user.id);
    if (persistedGroupAlerts !== null) {
      await updatePersistedGroupStatus(groupId, 'acknowledged');
    }

    writeRouteAudit(c, {
      orgId: groupAlerts[0]?.orgId,
      action: 'alert_correlation.acknowledge_group',
      resourceType: 'alert_correlation',
      resourceId: groupId,
      details: { alertIds: groupAlertIds, ...result },
    });

    if (groupAlerts[0]) {
      void emitCorrelationFeedback({
        orgId: groupAlerts[0].orgId,
        correlationId: groupId,
        eventType: 'correlation.accepted',
        outcome: 'accepted',
        actorUserId: auth.user.id,
        metadata: {
          action: 'acknowledge_group',
          alertIds: groupAlertIds,
          updated: result.updated,
          skipped: result.skipped,
        },
      });
    }

    return c.json(result);
  }
);

alertCorrelationRoutes.post(
  '/correlations/:groupId/resolve',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  zValidator('param', groupIdParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { groupId } = c.req.valid('param');
    const persistedGroupAlerts = await getPersistedGroupAlerts(groupId, auth);
    const groups = persistedGroupAlerts === null ? await buildCorrelationGroups(auth) : [];
    const group = groups.find((candidate) => candidate.id === groupId);
    if (persistedGroupAlerts === null && !group) {
      return c.json({ error: 'Correlation group not found' }, 404);
    }

    const groupAlertIds = persistedGroupAlerts !== null ? persistedGroupAlerts.map((alert) => alert.id) : group!.alerts.map((alert) => alert.id);
    const groupAlerts = persistedGroupAlerts ?? await db.select().from(alerts).where(inArray(alerts.id, groupAlertIds));
    const result = await mutateAlerts(groupAlerts, 'resolve', auth.user.id);
    if (persistedGroupAlerts !== null) {
      await updatePersistedGroupStatus(groupId, 'resolved');
    }

    writeRouteAudit(c, {
      orgId: groupAlerts[0]?.orgId,
      action: 'alert_correlation.resolve_group',
      resourceType: 'alert_correlation',
      resourceId: groupId,
      details: { alertIds: groupAlertIds, ...result },
    });

    if (groupAlerts[0]) {
      void emitCorrelationFeedback({
        orgId: groupAlerts[0].orgId,
        correlationId: groupId,
        eventType: 'correlation.accepted',
        outcome: 'accepted',
        actorUserId: auth.user.id,
        metadata: {
          action: 'resolve_group',
          alertIds: groupAlertIds,
          updated: result.updated,
          skipped: result.skipped,
        },
      });
    }

    return c.json(result);
  }
);

alertCorrelationRoutes.get(
  '/:alertId/correlations',
  requireScope('organization', 'partner', 'system'),
  requireAlertRead,
  zValidator('param', alertIdParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { alertId } = c.req.valid('param');

    const alert = await getAccessibleAlert(alertId, auth);
    if (!alert) {
      return c.json({ error: 'Alert not found' }, 404);
    }

    const links = await db
      .select()
      .from(alertCorrelations)
      .where(
        or(
          eq(alertCorrelations.parentAlertId, alertId),
          eq(alertCorrelations.childAlertId, alertId)
        )
      )
      .orderBy(desc(alertCorrelations.createdAt));

    const relatedIds = [...new Set(links.map((link) =>
      link.parentAlertId === alertId ? link.childAlertId : link.parentAlertId
    ))];
    const relatedAlerts = relatedIds.length > 0
      ? await db.select().from(alerts).where(and(eq(alerts.orgId, alert.orgId), inArray(alerts.id, relatedIds)))
      : [];
    const relatedById = new Map(relatedAlerts.map((relatedAlert) => [relatedAlert.id, relatedAlert]));

    const visibleLinks: CorrelationRow[] = [];
    const correlations = links
      .map((link) => {
        const relatedId = link.parentAlertId === alertId ? link.childAlertId : link.parentAlertId;
        const relatedAlert = relatedById.get(relatedId);
        if (!relatedAlert) return null;
        visibleLinks.push(link);
        return {
          id: link.id,
          title: relatedAlert.title,
          type: correlationTypeForUi(link),
          confidence: Number(link.confidence ?? 0),
        };
      })
      .filter((item): item is { id: string; title: string; type: 'causal' | 'symptom' | 'duplicate'; confidence: number } => Boolean(item));

    const timelineAlerts = [alert, ...relatedAlerts].sort((a, b) => a.triggeredAt.getTime() - b.triggeredAt.getTime());
    const timeline = timelineAlerts.map((timelineAlert) => ({
      id: timelineAlert.id,
      label: timelineAlert.title,
      time: timelineAlert.triggeredAt.toISOString(),
      severity: timelineAlert.severity,
    }));
    const maxConfidence = correlations.reduce((max, correlation) => Math.max(max, correlation.confidence), 0);

    return c.json({
      alert,
      correlations,
      correlationLinks: visibleLinks,
      relatedAlerts,
      timeline,
      summary: {
        relatedCount: relatedAlerts.length,
        rootCauseConfidence: maxConfidence,
        lastUpdate: (visibleLinks[0]?.createdAt ?? alert.createdAt).toISOString(),
      },
      data: { alert, correlations: visibleLinks, relatedAlerts },
    });
  }
);

alertCorrelationRoutes.post(
  '/:alertId/correlations/acknowledge',
  requireScope('organization', 'partner', 'system'),
  requireAlertAcknowledge,
  zValidator('param', alertIdParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { alertId } = c.req.valid('param');
    const alert = await getAccessibleAlert(alertId, auth);
    if (!alert) {
      return c.json({ error: 'Alert not found' }, 404);
    }

    const links = await db
      .select()
      .from(alertCorrelations)
      .where(or(eq(alertCorrelations.parentAlertId, alertId), eq(alertCorrelations.childAlertId, alertId)));
    const relatedIdsForMutation = links.map((link) => link.parentAlertId === alertId ? link.childAlertId : link.parentAlertId);
    const relatedAlerts = relatedIdsForMutation.length > 0
      ? await db.select().from(alerts).where(and(eq(alerts.orgId, alert.orgId), inArray(alerts.id, relatedIdsForMutation)))
      : [];
    const result = await mutateAlerts([alert, ...relatedAlerts], 'acknowledge', auth.user.id);

    writeRouteAudit(c, {
      orgId: alert.orgId,
      action: 'alert_correlation.acknowledge_related',
      resourceType: 'alert',
      resourceId: alert.id,
      resourceName: alert.title,
      details: { relatedAlertIds: relatedAlerts.map((relatedAlert) => relatedAlert.id), ...result },
    });

    void emitCorrelationFeedback({
      orgId: alert.orgId,
      correlationId: alert.id,
      eventType: 'correlation.accepted',
      outcome: 'accepted',
      actorUserId: auth.user.id,
      metadata: {
        action: 'acknowledge_related',
        relatedAlertIds: relatedAlerts.map((relatedAlert) => relatedAlert.id),
        updated: result.updated,
        skipped: result.skipped,
      },
    });

    return c.json(result);
  }
);
