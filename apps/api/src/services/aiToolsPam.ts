import { and, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  devices,
  elevationAudit,
  elevationRequests,
  organizations,
  pamRules,
  type NewElevationAuditEntry,
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { publishEvent, type EventType } from './eventBus';
import { evaluatePamRules, type PamRuleMatch } from './pamRuleEngine';

// Input schemas for these tools live in the canonical `toolInputSchemas`
// registry in ./aiToolSchemas (validated centrally by executeTool).

type PamHandler = (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;
type ElevationStatus = 'pending' | 'auto_approved' | 'denied';

const ACTIVE_STATUSES = ['approved', 'auto_approved', 'actuating'] as const;
const DEFAULT_DURATION_MINUTES = 30;

function orgWhere(auth: AuthContext, orgIdCol: Parameters<AuthContext['orgCondition']>[0]): SQL | undefined {
  return auth.orgCondition(orgIdCol) ?? undefined;
}

function safeHandler(toolName: string, fn: PamHandler): PamHandler {
  return async (input, auth) => {
    try {
      return await fn(input, auth);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      console.error(`[pam:${toolName}] ${err?.constructor?.name ?? 'Error'}:`, message, err);
      return JSON.stringify({ error: 'Operation failed. Check server logs for details.' });
    }
  };
}

async function safePublish(
  type: EventType,
  orgId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await publishEvent(type, orgId, payload, 'brain');
  } catch (err) {
    console.error(`[PAM Brain] event publish failed (${type}):`, err);
  }
}

function clampNumber(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(1, Math.trunc(n)), max);
}

function toIso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : null;
}

async function loadDeviceWithAccess(deviceId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(devices.id, deviceId)];
  const oc = orgWhere(auth, devices.orgId);
  if (oc) conditions.push(oc);

  const [device] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      siteId: devices.siteId,
      partnerId: organizations.partnerId,
    })
    .from(devices)
    .innerJoin(organizations, eq(devices.orgId, organizations.id))
    .where(and(...conditions))
    .limit(1);

  if (!device) return null;
  if (auth.canAccessSite && !auth.canAccessSite(device.siteId)) return null;
  return device;
}

async function loadEnabledPamRules(device: { orgId: string; siteId: string | null }, auth: AuthContext) {
  const conditions: SQL[] = [
    eq(pamRules.orgId, device.orgId),
    eq(pamRules.enabled, true),
    device.siteId
      ? or(isNull(pamRules.siteId), eq(pamRules.siteId, device.siteId))!
      : isNull(pamRules.siteId),
  ];
  const oc = orgWhere(auth, pamRules.orgId);
  if (oc) conditions.push(oc);

  return db.select().from(pamRules).where(and(...conditions));
}

function resolveDecision(
  ruleMatch: PamRuleMatch | null,
  requestedDurationMinutes: number,
): {
  status: ElevationStatus;
  expiresAt: Date | null;
  approvedAt: Date | null;
  denialReason: string | null;
  effectiveDurationMinutes: number;
} {
  const now = new Date();
  const effectiveDurationMinutes = clampNumber(
    ruleMatch?.approvalDurationMinutes ?? requestedDurationMinutes,
    requestedDurationMinutes,
    480,
  );

  if (ruleMatch?.verdict === 'auto_approve') {
    return {
      status: 'auto_approved',
      approvedAt: now,
      expiresAt: new Date(now.getTime() + effectiveDurationMinutes * 60_000),
      denialReason: null,
      effectiveDurationMinutes,
    };
  }
  if (ruleMatch?.verdict === 'auto_deny') {
    return {
      status: 'denied',
      approvedAt: null,
      expiresAt: null,
      denialReason: `Blocked by PAM rule "${ruleMatch.ruleName}"`,
      effectiveDurationMinutes,
    };
  }
  return { status: 'pending', approvedAt: null, expiresAt: null, denialReason: null, effectiveDurationMinutes };
}

function eventPayload(row: {
  id: string;
  deviceId: string;
  flowType: string;
  status: string;
  subjectUsername?: string;
}, ruleMatch?: PamRuleMatch | null) {
  return {
    elevationRequestId: row.id,
    deviceId: row.deviceId,
    flowType: row.flowType,
    status: row.status,
    ...(row.subjectUsername ? { subjectUsername: row.subjectUsername } : {}),
    triggerSource: 'brain',
    ...(ruleMatch ? { pamRuleId: ruleMatch.ruleId } : {}),
  };
}

export function registerPamTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  registerTool({
    tier: 3,
    deviceArgs: ['deviceId'],
    definition: {
      name: 'request_elevation',
      description: 'Request a temporary PAM elevation for an OS/user account on a managed device.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Target device UUID' },
          subjectUsername: { type: 'string', description: 'OS or local/domain username to elevate' },
          reason: { type: 'string', description: 'Reason for the elevation request' },
          durationMinutes: { type: 'number', description: 'Requested duration in minutes (default 30, max 480)' },
          subjectAdGroups: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional AD/local groups for PAM rule matching',
          },
        },
        required: ['deviceId', 'subjectUsername', 'reason'],
      },
    },
    handler: safeHandler('request_elevation', async (input, auth) => {
      const deviceId = input.deviceId as string;
      const subjectUsername = input.subjectUsername as string;
      const reason = input.reason as string;
      if (!deviceId || !subjectUsername || !reason) {
        return JSON.stringify({ error: 'deviceId, subjectUsername, and reason are required' });
      }

      const device = await loadDeviceWithAccess(deviceId, auth);
      if (!device) return JSON.stringify({ error: 'Device not found or access denied' });

      const now = new Date();
      const durationMinutes = clampNumber(input.durationMinutes, DEFAULT_DURATION_MINUTES, 480);
      const rules = await loadEnabledPamRules(device, auth);
      const ruleMatch = evaluatePamRules(rules as any, {
        subjectUsername,
        subjectAdGroups: Array.isArray(input.subjectAdGroups)
          ? input.subjectAdGroups.filter((g): g is string => typeof g === 'string')
          : undefined,
        at: now,
      });
      const decision = resolveDecision(ruleMatch, durationMinutes);
      const metadata = {
        triggerSource: 'brain',
        requestedByUserId: auth.user.id,
        requestedDurationMinutes: durationMinutes,
        ...(ruleMatch ? { pamRuleId: ruleMatch.ruleId, pamRuleName: ruleMatch.ruleName } : {}),
      };

      const [row] = await db
        .insert(elevationRequests)
        .values({
          orgId: device.orgId,
          siteId: device.siteId ?? null,
          partnerId: device.partnerId ?? auth.partnerId ?? null,
          deviceId: device.id,
          flowType: 'tech_jit_admin',
          subjectUserId: null,
          subjectUsername,
          reason,
          status: decision.status,
          requestedAt: now,
          approvedAt: decision.approvedAt,
          expiresAt: decision.expiresAt,
          denialReason: decision.denialReason,
          metadata,
        })
        .returning({
          id: elevationRequests.id,
          status: elevationRequests.status,
          expiresAt: elevationRequests.expiresAt,
        });

      if (!row) return JSON.stringify({ error: 'Failed to record elevation request' });

      const auditRows: NewElevationAuditEntry[] = [
        {
          orgId: device.orgId,
          elevationRequestId: row.id,
          eventType: 'requested',
          actor: 'system',
          actorUserId: auth.user.id,
          details: {
            subjectUsername,
            reason,
            triggerSource: 'brain',
          },
          occurredAt: now,
        },
      ];
      if (ruleMatch && (decision.status === 'auto_approved' || decision.status === 'denied')) {
        auditRows.push({
          orgId: device.orgId,
          elevationRequestId: row.id,
          eventType: decision.status,
          actor: 'policy',
          details: {
            pamRuleId: ruleMatch.ruleId,
            pamRuleName: ruleMatch.ruleName,
            triggerSource: 'brain',
            ...(decision.status === 'auto_approved'
              ? { durationMinutes: decision.effectiveDurationMinutes }
              : {}),
          },
          occurredAt: now,
        });
      }
      await db.insert(elevationAudit).values(auditRows);

      const payload = eventPayload(
        {
          id: row.id,
          deviceId: device.id,
          flowType: 'tech_jit_admin',
          status: row.status,
          subjectUsername,
        },
        ruleMatch,
      );
      await safePublish('elevation.requested', device.orgId, payload);
      if (decision.status === 'auto_approved') {
        await safePublish('elevation.auto_approved', device.orgId, payload);
      } else if (decision.status === 'denied') {
        await safePublish('elevation.denied', device.orgId, payload);
      }

      return JSON.stringify({
        elevationRequestId: row.id,
        status: row.status,
        ...(row.expiresAt ? { expiresAt: toIso(row.expiresAt) } : {}),
        ...(ruleMatch ? { pamRuleId: ruleMatch.ruleId } : {}),
      });
    }),
  });

  registerTool({
    tier: 2,
    definition: {
      name: 'revoke_elevation',
      description: 'Revoke an active PAM elevation request.',
      input_schema: {
        type: 'object' as const,
        properties: {
          elevationRequestId: { type: 'string', description: 'Elevation request UUID to revoke' },
          reason: { type: 'string', description: 'Reason for revocation' },
        },
        required: ['elevationRequestId', 'reason'],
      },
    },
    handler: safeHandler('revoke_elevation', async (input, auth) => {
      const elevationRequestId = input.elevationRequestId as string;
      const reason = input.reason as string;
      if (!elevationRequestId || !reason) {
        return JSON.stringify({ error: 'elevationRequestId and reason are required' });
      }

      const now = new Date();
      const result = await db.transaction(async (tx) => {
        const conditions: SQL[] = [eq(elevationRequests.id, elevationRequestId)];
        const oc = orgWhere(auth, elevationRequests.orgId);
        if (oc) conditions.push(oc);

        const [existing] = await tx
          .select({
            id: elevationRequests.id,
            orgId: elevationRequests.orgId,
            siteId: elevationRequests.siteId,
            deviceId: elevationRequests.deviceId,
            flowType: elevationRequests.flowType,
            status: elevationRequests.status,
          })
          .from(elevationRequests)
          .where(and(...conditions))
          .limit(1);

        if (!existing) return { kind: 'not_found' as const };
        // Site axis (parity with routes/pam.ts revoke): deny a request whose
        // device site is outside a site-restricted caller's allowlist. Reported
        // as not_found so it doesn't leak the row's existence.
        if (auth.canAccessSite && existing.siteId && !auth.canAccessSite(existing.siteId)) {
          return { kind: 'not_found' as const };
        }

        const updateConditions: SQL[] = [
          eq(elevationRequests.id, elevationRequestId),
          inArray(elevationRequests.status, [...ACTIVE_STATUSES]),
        ];
        const updateOrg = orgWhere(auth, elevationRequests.orgId);
        if (updateOrg) updateConditions.push(updateOrg);

        const updated = await tx
          .update(elevationRequests)
          .set({
            status: 'revoked',
            revokedAt: now,
            revokedByUserId: auth.user.id,
            revokedReason: reason,
            updatedAt: now,
          })
          .where(and(...updateConditions))
          .returning({ id: elevationRequests.id });

        if (updated.length === 0) {
          return { kind: 'conflict' as const, currentStatus: existing.status };
        }

        await tx.insert(elevationAudit).values({
          orgId: existing.orgId,
          elevationRequestId: existing.id,
          eventType: 'revoked',
          actor: 'system',
          actorUserId: auth.user.id,
          details: { reason, triggerSource: 'brain' },
          occurredAt: now,
        });

        return { kind: 'ok' as const, row: existing };
      });

      if (result.kind === 'not_found') {
        return JSON.stringify({ error: 'Elevation request not found or access denied' });
      }
      if (result.kind === 'conflict') {
        return JSON.stringify({
          error: `Request is not active (current status: ${result.currentStatus})`,
        });
      }

      await safePublish('elevation.revoked', result.row.orgId, {
        elevationRequestId: result.row.id,
        deviceId: result.row.deviceId,
        flowType: result.row.flowType,
        status: 'revoked',
        revokedByUserId: auth.user.id,
        triggerSource: 'brain',
      });

      return JSON.stringify({ elevationRequestId: result.row.id, status: 'revoked' });
    }),
  });

  registerTool({
    tier: 1,
    deviceArgs: ['deviceId'],
    definition: {
      name: 'get_elevation_history',
      description: 'List recent PAM elevation requests in the accessible organization scope.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'Optional target device UUID filter' },
          status: { type: 'string', description: 'Optional elevation status filter' },
          flowType: { type: 'string', description: 'Optional elevation flow type filter' },
          limit: { type: 'number', description: 'Max rows (default 25, max 100)' },
        },
        required: [],
      },
    },
    handler: safeHandler('get_elevation_history', async (input, auth) => {
      const conditions: SQL[] = [];
      const oc = orgWhere(auth, elevationRequests.orgId);
      if (oc) conditions.push(oc);
      if (typeof input.deviceId === 'string') conditions.push(eq(elevationRequests.deviceId, input.deviceId));
      if (typeof input.status === 'string') conditions.push(eq(elevationRequests.status, input.status as any));
      if (typeof input.flowType === 'string') conditions.push(eq(elevationRequests.flowType, input.flowType as any));

      const limit = clampNumber(input.limit, 25, 100);
      const rows = await db
        .select({
          id: elevationRequests.id,
          deviceId: elevationRequests.deviceId,
          flowType: elevationRequests.flowType,
          status: elevationRequests.status,
          subjectUsername: elevationRequests.subjectUsername,
          reason: elevationRequests.reason,
          requestedAt: elevationRequests.requestedAt,
          approvedAt: elevationRequests.approvedAt,
          expiresAt: elevationRequests.expiresAt,
          revokedAt: elevationRequests.revokedAt,
          denialReason: elevationRequests.denialReason,
          revokedReason: elevationRequests.revokedReason,
          metadata: elevationRequests.metadata,
        })
        .from(elevationRequests)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(elevationRequests.requestedAt))
        .limit(limit);

      return JSON.stringify(
        rows.map((row) => ({
          elevationRequestId: row.id,
          deviceId: row.deviceId,
          flowType: row.flowType,
          status: row.status,
          subjectUsername: row.subjectUsername,
          reason: row.reason,
          requestedAt: toIso(row.requestedAt),
          approvedAt: toIso(row.approvedAt),
          expiresAt: toIso(row.expiresAt),
          revokedAt: toIso(row.revokedAt),
          denialReason: row.denialReason,
          revokedReason: row.revokedReason,
          triggerSource:
            row.metadata && typeof row.metadata === 'object'
              ? (row.metadata as Record<string, unknown>).triggerSource
              : undefined,
        })),
      );
    }),
  });
}
