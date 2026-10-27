/**
 * Tool Catalog W06 (#5221) Task A7 — every fact the pure converter needs about
 * one legacy Job, read once. System context with EXPLICIT owner predicates:
 * the owner is exactly the Job's owner axis (an org Job: its org and that
 * org's partner; a partner-wide Job: its partner, orgId null), and every
 * ownership answer comes from the flow rule-6 lookups (ownedReferences.ts) for
 * that owner — so a partner-wide Job never treats one org's script or channel
 * as its own.
 */
import { and, count, eq, gte, inArray, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { automationRuns, automations, devices, monitorConversions, organizations, scripts } from '../../../db/schema';
import { envFlag, flowsEnabled } from '../../../config/env';
import { resolveAutomationTargetsDetailed } from '../../automationRuntime';
import { isFlowEventDeliveryDurable } from '../../flowValidator';
import { partnerFanoutOrgCondition } from '../../partnerFanoutOrgs';
import { getUserPermissions } from '../../permissions';
import { isComplianceRemediationTarget, remediationScriptIdsOf } from '../../policyEvaluationService';
import { scriptNeedsVariableScope } from '../../sourcedParameters';
import type { ToolOwnerRef } from '../../toolSources/resolver';
import { readFlowUsage } from '../budgets';
import { fleetApprovalScope } from '../builtins/fleetApprovalScope';
import { resolveFlowLimits } from '../flowLimits';
import { findOwnedNotificationChannel, findOwnedScriptIds } from '../ownedReferences';
import type { ConversionContext } from './convertAutomation';

type AutomationRow = typeof automations.$inferSelect;

const NO_FLOW = '00000000-0000-0000-0000-000000000000';
const DAY_MS = 86_400_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Channel ids a Job names: its send_notification actions and its on-failure targets. */
export function channelIdsOf(row: Pick<AutomationRow, 'actions' | 'notificationTargets'>): string[] {
  const out = new Set<string>();
  if (Array.isArray(row.actions)) {
    for (const a of row.actions) {
      if (!isRecord(a) || a.type !== 'send_notification') continue;
      const id = a.notificationChannelId ?? a.channelId ?? a.notification_channel_id;
      if (typeof id === 'string') out.add(id);
    }
  }
  const t = row.notificationTargets;
  if (isRecord(t) && Array.isArray(t.channelIds)) for (const id of t.channelIds) if (typeof id === 'string') out.add(id);
  return [...out].sort();
}

export async function resolveJobOwner(row: Pick<AutomationRow, 'orgId' | 'partnerId'>): Promise<ToolOwnerRef | null> {
  if (row.orgId) {
    const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, row.orgId)).limit(1);
    return org?.partnerId ? { orgId: row.orgId, partnerId: org.partnerId } : null;
  }
  return row.partnerId ? { orgId: null, partnerId: row.partnerId } : null;
}

export async function loadConversionContext(row: AutomationRow, now: Date = new Date()): Promise<ConversionContext> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const owner = await resolveJobOwner(row);
    if (!owner) throw new Error(`automation ${row.id} has no resolvable owner`);

    // Scripts: ownership by the owner's rule-6 lookup; run context and pre-approvability from the row.
    const scriptIds = remediationScriptIdsOf(row.actions);
    const owned = scriptIds.length > 0 ? await findOwnedScriptIds(owner, scriptIds) : new Set<string>();
    const scriptRows = scriptIds.length > 0
      ? await db.select().from(scripts).where(and(inArray(scripts.id, scriptIds), isNull(scripts.deletedAt)))
      : [];
    const scriptMap: ConversionContext['scripts'] = new Map();
    for (const s of scriptRows) {
      const runAs = s.runAs === 'user' || s.runAs === 'elevated' ? s.runAs : 'system';
      scriptMap.set(s.id, {
        ownedByOwner: owned.has(s.id),
        effectiveRunAs: runAs,
        preApprovable: !scriptNeedsVariableScope(s) && fleetApprovalScope({ scriptId: s.id }) === 'supervised',
      });
    }

    const channels: ConversionContext['channels'] = new Map();
    for (const id of channelIdsOf(row)) {
      const c = await findOwnedNotificationChannel(owner, id);
      channels.set(id, { type: c?.type ?? 'unknown', ownedByOwner: !!c });
    }

    // The static target set — none for an event Job (it binds the triggering device).
    const trigger = isRecord(row.trigger) ? row.trigger : {};
    let currentTargets: ConversionContext['currentTargets'] = null;
    if (trigger.type !== 'event') {
      const resolved = await resolveAutomationTargetsDetailed(row);
      const ids = [...new Set(resolved.deviceIds)];
      const osRows = ids.length > 0
        ? await db.selectDistinct({ osType: devices.osType }).from(devices).where(inArray(devices.id, ids))
        : [];
      currentTargets = { count: ids.length, osTypes: new Set(osRows.map((r) => r.osType as 'windows' | 'macos' | 'linux')) };
    }

    const [monitor] = await db
      .select({ id: monitorConversions.id })
      .from(monitorConversions)
      .where(and(eq(monitorConversions.sourceTable, 'automations'), eq(monitorConversions.sourceId, row.id), isNull(monitorConversions.revertedAt)))
      .limit(1);

    let creatorHasSiteCeiling = false;
    if (row.createdBy) {
      const perms = await getUserPermissions(row.createdBy, {
        orgId: row.orgId ?? undefined,
        partnerId: owner.partnerId,
      });
      creatorHasSiteCeiling = Array.isArray(perms?.allowedSiteIds);
    }

    let partnerOrgs: ConversionContext['partnerOrgs'] = null;
    if (!row.orgId) {
      const [total] = await db.select({ n: count() }).from(organizations).where(eq(organizations.partnerId, owner.partnerId));
      const [live] = await db.select({ n: count() }).from(organizations)
        .where(and(eq(organizations.partnerId, owner.partnerId), partnerFanoutOrgCondition()));
      partnerOrgs = { live: Number(live?.n ?? 0), total: Number(total?.n ?? 0) };
    }

    const limits = await resolveFlowLimits(owner);
    const usage = await readFlowUsage(NO_FLOW, owner, now);
    const [observed] = await db
      .select({ n: count() })
      .from(automationRuns)
      .where(and(eq(automationRuns.automationId, row.id), gte(automationRuns.startedAt, new Date(now.getTime() - 30 * DAY_MS))));

    return {
      owner,
      flowsEnabled: flowsEnabled(),
      eventDispatchDurable: isFlowEventDeliveryDurable(),
      legacySecretHeaderAllowed: envFlag('AUTOMATION_WEBHOOK_ALLOW_LEGACY_SECRET', false),
      currentTargets,
      channels,
      scripts: scriptMap,
      isRemediationTarget: await isComplianceRemediationTarget(db, row, owner.partnerId),
      liveMonitorConversion: !!monitor,
      creatorHasSiteCeiling,
      partnerOrgs,
      limits: {
        monthlyRunsPerFlow: limits.monthlyRunsPerFlow,
        monthlyRunsPerOwner: limits.monthlyRunsPerOwner,
        ownerRunsThisMonth: usage.ownerRuns,
      },
      observedMonthlyRuns: Number(observed?.n ?? 0),
    };
  }, 'flows.conversion.loadConversionContext'));
}
