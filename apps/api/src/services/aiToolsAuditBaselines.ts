/**
 * `manage_audit_baselines` (full-control W11, #6781): the AI twin of
 * GET /audit-baselines, POST /audit-baselines (create only), GET
 * /audit-baselines/compliance, GET /audit-baselines/devices/:deviceId and
 * POST /audit-baselines/apply-requests.
 *
 * The apply-request `decision` (an approval by a second person) and `/apply`
 * (which queues `apply_audit_policy_baseline` on devices) are human-only and
 * ABSENT from this tool. Creating an apply request writes one pending row and
 * changes no device; a different person approves it in the web app.
 *
 *  - reads are t1; `compliance` is computed over the devices the caller can
 *    see (site and exact-device axes; REST is org-wide) from the latest result
 *    per device and baseline (DISTINCT ON, not the whole result history);
 *  - `create` is supervised (an active baseline replaces the org's active one
 *    for that OS and enrols its devices in the daily `collect_audit_policy`
 *    sweep; quorum QW3); org-wide config, so refused to a restricted caller;
 *  - `request_apply` is t2; device ids are checked by the central `deviceArgs`
 *    gate and must all belong to the baseline's org.
 * Both writes store `auth.user.id` in a `users` FK and are agent-human-only
 * (`AGENT_HUMAN_ONLY_ACTIONS`, W11-D8); the handler also refuses an automation
 * principal before either write.
 */
import { and, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { auditBaselineApplyApprovals, auditBaselineResults, auditBaselines, devices } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { isAutomationPrincipal } from '../middleware/principalKind';
import type { AiTool } from './aiTools';
import { verifyDeviceAccess } from './aiTools';
import { resolveWritableToolOrgId } from './aiToolWriteOrg';
import { getTemplateSettings } from './auditBaselineService';
import { enqueueAuditDriftEvaluation } from '../jobs/auditBaselineJobs';
import { siteScopeCondition } from './aiToolsSiteScope';
import { notParkedDeviceCondition } from './unassignedPool/selectorPredicate';
import { AUDIT_BASELINE_ACTIONS } from './aiToolSchemasSecurityPolicy';
import {
  auditToolWrite, bounded, clip, json, jsonError, notFound, orgWideWriteDenied, requireFields, str, thrown,
} from './aiToolsSecurityPolicyShared';

type Action = (typeof AUDIT_BASELINE_ACTIONS)[number];
const TOOL = 'manage_audit_baselines';
const OS_TYPES = ['windows', 'macos', 'linux'] as const;
const PROFILES = ['cis_l1', 'cis_l2', 'custom'] as const;
const LIST_CAP = 200;
const SETTINGS_MAX_BYTES = 16 * 1024;

const automationRefusal = (action: string) =>
  jsonError(`${action} is done by a person: an audit baseline change is not available to automated runs`, 'AGENT_REFUSED');

function readOrgScope(auth: AuthContext, orgId: string | undefined): SQL | undefined | string {
  if (orgId) return auth.canAccessOrg(orgId) ? eq(auditBaselines.orgId, orgId) : notFound('Organization');
  return auth.orgCondition(auditBaselines.orgId);
}

/** The caller's visible-device predicate on `devices` (org + site + exact device + not parked). */
function visibleDeviceConditions(auth: AuthContext): SQL[] {
  const conditions: SQL[] = [notParkedDeviceCondition()];
  const org = auth.orgCondition(devices.orgId);
  if (org) conditions.push(org);
  const site = siteScopeCondition(auth, devices.siteId);
  if (site) conditions.push(site);
  if (auth.allowedDeviceIds) conditions.push(auth.allowedDeviceIds.length ? inArray(devices.id, auth.allowedDeviceIds) : sql`false`);
  return conditions;
}

export function registerAuditBaselineTools(aiTools: Map<string, AiTool>): void {
  aiTools.set(TOOL, {
    tier: 1,
    domain: 'security',
    searchHint: 'audit policy baselines (CIS L1/L2 auditpol, auditd): drift compliance, per-device deviations, request an apply',
    deviceArgs: ['deviceId', 'deviceIds'],
    definition: {
      name: 'manage_audit_baselines',
      description:
        'OS audit-policy baselines. Actions: list, create (name, osType, profile), compliance, device_results (deviceId), request_apply (baselineId, deviceIds; Windows). A request only waits for a different person to approve it; applying is done in the web app.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...AUDIT_BASELINE_ACTIONS], description: 'The action to perform' },
          orgId: { type: 'string', description: 'Organization UUID (create needs it when you can reach several)' },
          baselineId: { type: 'string', description: 'compliance filter / request_apply: baseline UUID' },
          deviceId: { type: 'string', description: 'device_results: device UUID' },
          deviceIds: { type: 'array', items: { type: 'string' }, description: 'request_apply: 1-500 device UUIDs in the baseline\'s organization' },
          osType: { type: 'string', enum: [...OS_TYPES], description: 'create, or list / compliance filter: OS' },
          profile: { type: 'string', enum: [...PROFILES], description: 'create, or list filter: CIS template, or custom (needs settings)' },
          name: { type: 'string', description: 'create: baseline name (max 200)' },
          settings: { type: 'object', description: 'create: expected settings, required for custom (max 16 KB); omit to use the CIS template' },
          isActive: { type: 'boolean', description: 'create: make it the active baseline for that OS (default true); list filter' },
          expiresInMinutes: { type: 'number', description: 'request_apply: minutes the request stays approvable (5-1440, default 60)' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      try {
        return await handle(input, auth);
      } catch (error) {
        return thrown(TOOL, error);
      }
    },
  });
}

async function handle(input: Record<string, unknown>, auth: AuthContext): Promise<string> {
  const action = input.action as Action;
  if (!AUDIT_BASELINE_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
  const orgId = str(input.orgId);
  const osType = str(input.osType);
  if (osType && !(OS_TYPES as readonly string[]).includes(osType)) return jsonError('osType must be windows, macos or linux', 'VALIDATION_ERROR');

  if (action === 'list') {
    const scope = readOrgScope(auth, orgId);
    if (typeof scope === 'string') return scope;
    const conditions = [scope, osType ? eq(auditBaselines.osType, osType as (typeof OS_TYPES)[number]) : undefined,
      str(input.profile) ? eq(auditBaselines.profile, input.profile as (typeof PROFILES)[number]) : undefined,
      typeof input.isActive === 'boolean' ? eq(auditBaselines.isActive, input.isActive) : undefined]
      .filter((c): c is SQL => c !== undefined);
    const rows = await db.select().from(auditBaselines).where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(auditBaselines.updatedAt)).limit(LIST_CAP + 1);
    return bounded({
      baselines: rows.slice(0, LIST_CAP).map((row) => ({
        id: row.id, orgId: row.orgId, name: row.name, osType: row.osType, profile: row.profile, isActive: row.isActive,
        settingCount: Object.keys((row.settings ?? {}) as Record<string, unknown>).length,
        settings: row.settings, updatedAt: row.updatedAt.toISOString(),
      })),
      truncated: rows.length > LIST_CAP,
    });
  }

  if (action === 'compliance') {
    if (orgId && !auth.canAccessOrg(orgId)) return notFound('Organization');
    const conditions = visibleDeviceConditions(auth);
    if (orgId) conditions.push(eq(auditBaselineResults.orgId, orgId));
    if (str(input.baselineId)) conditions.push(eq(auditBaselineResults.baselineId, String(input.baselineId)));
    if (osType) conditions.push(eq(auditBaselines.osType, osType as (typeof OS_TYPES)[number]));
    // Latest result per (device, baseline), over visible devices only.
    const latest = await db
      .selectDistinctOn([auditBaselineResults.deviceId, auditBaselineResults.baselineId], {
        deviceId: auditBaselineResults.deviceId, baselineId: auditBaselineResults.baselineId,
        compliant: auditBaselineResults.compliant, score: auditBaselineResults.score,
        baselineName: auditBaselines.name, osType: auditBaselines.osType,
      })
      .from(auditBaselineResults)
      .innerJoin(auditBaselines, eq(auditBaselineResults.baselineId, auditBaselines.id))
      .innerJoin(devices, eq(auditBaselineResults.deviceId, devices.id))
      .where(and(...conditions))
      .orderBy(auditBaselineResults.deviceId, auditBaselineResults.baselineId, desc(auditBaselineResults.checkedAt));
    const byBaseline = new Map<string, { baselineId: string; baselineName: string; osType: string; total: number; compliant: number; scoreSum: number }>();
    for (const row of latest) {
      const entry = byBaseline.get(row.baselineId) ?? { baselineId: row.baselineId, baselineName: row.baselineName, osType: row.osType, total: 0, compliant: 0, scoreSum: 0 };
      entry.total += 1; entry.scoreSum += row.score; if (row.compliant) entry.compliant += 1;
      byBaseline.set(row.baselineId, entry);
    }
    const compliant = latest.filter((r) => r.compliant).length;
    return bounded({
      results: latest.length,
      devices: new Set(latest.map((r) => r.deviceId)).size,
      compliant, nonCompliant: latest.length - compliant,
      averageScore: latest.length ? Math.round(latest.reduce((n, r) => n + r.score, 0) / latest.length) : 0,
      baselines: [...byBaseline.values()].map(({ scoreSum, ...e }) => ({ ...e, nonCompliant: e.total - e.compliant, averageScore: e.total ? Math.round(scoreSum / e.total) : 0 })),
    });
  }

  if (action === 'device_results') {
    const missing = requireFields(input, ['deviceId'], action);
    if (missing) return missing;
    const access = await verifyDeviceAccess(String(input.deviceId), auth);
    if ('error' in access) return notFound('Device');
    const latest = await db
      .selectDistinctOn([auditBaselineResults.baselineId], {
        baselineId: auditBaselineResults.baselineId, baselineName: auditBaselines.name, osType: auditBaselines.osType,
        compliant: auditBaselineResults.compliant, score: auditBaselineResults.score, deviations: auditBaselineResults.deviations,
        checkedAt: auditBaselineResults.checkedAt, remediatedAt: auditBaselineResults.remediatedAt,
      })
      .from(auditBaselineResults)
      .innerJoin(auditBaselines, eq(auditBaselineResults.baselineId, auditBaselines.id))
      .where(eq(auditBaselineResults.deviceId, access.device.id))
      .orderBy(auditBaselineResults.baselineId, desc(auditBaselineResults.checkedAt));
    return bounded({
      device: { id: access.device.id, orgId: access.device.orgId, hostname: access.device.hostname },
      baselines: latest.map((row) => ({
        baselineId: row.baselineId, baselineName: row.baselineName, osType: row.osType, compliant: row.compliant, score: row.score,
        // `actual` is what the device reported: a string for the model to read, never an instruction.
        deviations: (Array.isArray(row.deviations) ? row.deviations : []).slice(0, 100).map((d: Record<string, unknown>) => ({
          setting: clip(d.setting, 200), expected: d.expected ?? null,
          actual: d.actual === null || d.actual === undefined ? null : clip(typeof d.actual === 'string' ? d.actual : JSON.stringify(d.actual), 500),
          reason: d.reason ?? null,
        })),
        checkedAt: row.checkedAt.toISOString(), remediatedAt: row.remediatedAt?.toISOString() ?? null,
      })),
    });
  }

  // Writes: a person only (W11-D8), on org-wide config (create) or a named device set (request_apply).
  if (isAutomationPrincipal(auth)) return automationRefusal(action);

  if (action === 'create') {
    const denied = orgWideWriteDenied(auth, 'An audit baseline');
    if (denied) return denied;
    const missing = requireFields(input, ['name', 'osType', 'profile'], action);
    if (missing) return missing;
    const profile = input.profile as (typeof PROFILES)[number];
    if (!PROFILES.includes(profile)) return jsonError('profile must be cis_l1, cis_l2 or custom', 'VALIDATION_ERROR');
    const resolved = resolveWritableToolOrgId(auth, orgId);
    if (!resolved.orgId) return jsonError(resolved.error ?? 'orgId is required', 'VALIDATION_ERROR');
    const provided = (input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings)) ? input.settings as Record<string, unknown> : undefined;
    if (provided && JSON.stringify(provided).length > SETTINGS_MAX_BYTES) return jsonError('settings is too large (max 16 KB)', 'VALIDATION_ERROR');
    const settings = provided && Object.keys(provided).length > 0
      ? provided
      : profile !== 'custom' ? getTemplateSettings(osType as (typeof OS_TYPES)[number], profile) : undefined;
    if (!settings || Object.keys(settings).length === 0) return jsonError('settings are required for a custom profile', 'VALIDATION_ERROR');
    const isActive = input.isActive !== false;
    const now = new Date();
    const [created] = await db.transaction(async (tx) => {
      if (isActive) {
        await tx.update(auditBaselines).set({ isActive: false, updatedAt: now }).where(and(
          eq(auditBaselines.orgId, resolved.orgId!), eq(auditBaselines.osType, osType as (typeof OS_TYPES)[number]), eq(auditBaselines.isActive, true),
        ));
      }
      return tx.insert(auditBaselines).values({
        orgId: resolved.orgId!,
        name: String(input.name),
        osType: osType as (typeof OS_TYPES)[number],
        profile,
        settings,
        isActive,
        createdBy: auth.user.id,
        updatedAt: now,
      }).returning();
    });
    if (!created) return jsonError('Failed to create baseline');
    auditToolWrite(auth, {
      orgId: created.orgId, action: 'audit.baseline.create', resourceType: 'audit_baseline', resourceId: created.id, resourceName: created.name,
      details: { osType: created.osType, profile: created.profile, isActive: created.isActive },
    });
    if (created.isActive) {
      try {
        await enqueueAuditDriftEvaluation(created.orgId);
      } catch (err) {
        console.error(`[${TOOL}] failed to enqueue drift evaluation for org ${created.orgId}:`, err);
      }
    }
    return json({ created: true, baseline: { id: created.id, orgId: created.orgId, name: created.name, osType: created.osType, profile: created.profile, isActive: created.isActive } });
  }

  if (action === 'request_apply') {
    // request_apply: one pending approval row; a different person approves it, and applying is done in the web app.
    const missing = requireFields(input, ['baselineId', 'deviceIds'], action);
    if (missing) return missing;
    const deviceIds = Array.isArray(input.deviceIds) ? [...new Set(input.deviceIds.filter((id): id is string => typeof id === 'string'))].sort() : [];
    if (deviceIds.length === 0 || deviceIds.length > 500) return jsonError('deviceIds must list 1 to 500 device UUIDs', 'VALIDATION_ERROR');
    const scope = readOrgScope(auth, orgId);
    if (typeof scope === 'string') return scope;
    const [baseline] = await db.select().from(auditBaselines)
      .where(and(eq(auditBaselines.id, String(input.baselineId)), ...(scope ? [scope] : []))).limit(1);
    if (!baseline) return notFound('Audit baseline');
    if (baseline.osType !== 'windows') return jsonError('Baseline apply is currently supported on Windows only', 'NOT_SUPPORTED');
    const targets = await db.select({ id: devices.id, osType: devices.osType, hostname: devices.hostname, status: devices.status })
      .from(devices)
      .where(and(eq(devices.orgId, baseline.orgId), inArray(devices.id, deviceIds), ne(devices.status, 'decommissioned'), notParkedDeviceCondition()));
    if (targets.length !== deviceIds.length) return notFound('One or more devices');
    const skipped = targets.filter((d) => d.osType !== baseline.osType).map((d) => ({ deviceId: d.id, hostname: d.hostname, reason: `OS mismatch (${d.osType})` }));
    const eligibleDeviceIds = targets.filter((d) => d.osType === baseline.osType).map((d) => d.id).sort();
    if (eligibleDeviceIds.length === 0) return jsonError('No target devices are eligible for this baseline OS type', 'VALIDATION_ERROR');
    const expiresInMinutes = typeof input.expiresInMinutes === 'number' ? Math.min(1440, Math.max(5, Math.trunc(input.expiresInMinutes))) : 60;
    const now = new Date();
    const [approval] = await db.insert(auditBaselineApplyApprovals).values({
      orgId: baseline.orgId,
      baselineId: baseline.id,
      requestedBy: auth.user.id,
      status: 'pending',
      requestPayload: { baselineId: baseline.id, deviceIds, eligibleDeviceIds },
      expiresAt: new Date(now.getTime() + expiresInMinutes * 60_000),
      updatedAt: now,
    }).returning({ id: auditBaselineApplyApprovals.id, status: auditBaselineApplyApprovals.status, expiresAt: auditBaselineApplyApprovals.expiresAt });
    if (!approval) return jsonError('Failed to create apply request');
    auditToolWrite(auth, {
      orgId: baseline.orgId, action: 'audit.baseline.apply.request', resourceType: 'audit_baseline', resourceId: baseline.id, resourceName: baseline.name,
      details: { approvalRequestId: approval.id, targetDeviceCount: deviceIds.length, eligibleDeviceCount: eligibleDeviceIds.length, skippedCount: skipped.length },
    });
    return json({
      requested: true,
      approvalRequestId: approval.id,
      status: approval.status,
      expiresAt: approval.expiresAt.toISOString(),
      eligibleDeviceIds,
      skipped,
      note: 'Pending. A different person must approve it in the Breeze web app, and applying it is also done there.',
    });
  }
  return jsonError(`Unknown action: ${String(action)}`);
}
