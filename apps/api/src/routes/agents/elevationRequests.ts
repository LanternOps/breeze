import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  approvalRequests,
  devices,
  elevationAudit,
  elevationRequests,
  pamOrgConfig,
  pamRules,
  pamSignerGroups,
} from '../../db/schema';
import { writeAuditEvent } from '../../services/auditEvents';
import { getRedis } from '../../services/redis';
import { rateLimiter } from '../../services/rate-limit';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import { evaluatePamBridge, type PamBridgeVerdict } from '../../services/pamBridge';
import { evaluatePamRules, type PamRuleMatch } from '../../services/pamRuleEngine';
import { publishEvent, type EventType } from '../../services/eventBus';
import { resolveElevationApprovers } from '../../services/pamApprovers';
import { buildApprovalPush, getUserPushTokens, sendExpoPush } from '../../services/expoPush';
import type { RiskTier } from '@breeze/shared';

// PAM Track 3: agent-side endpoint that records UAC consent.exe observations
// as `elevation_requests` rows with flow_type='uac_intercept'. Auth is the
// standard agent bearer token (agentAuthMiddleware, mounted in
// routes/agents/index.ts). The middleware attaches { deviceId, agentId,
// orgId, siteId, role } to ctx.var.agent.
//
// #1163: ingest now runs the decisioning chain before inserting —
//   1. software-policy bridge (services/pamBridge.ts): allowlist →
//      auto_approved, blocklist → denied;
//   2. PAM-native rules (services/pamRuleEngine.ts) when no policy binds:
//      auto_approve / auto_deny / require_approval / ignore;
//   3. otherwise the row stays 'pending' (manual approval queue).
// Every outcome writes elevation_audit + emits an elevation.* event.
// Decisioning errors fail SAFE to 'pending' — never auto-approve on error.

// Body cap: 32 KB. Agent CommandLine fields can be long (multi-arg installer
// invocations) but anything beyond 32 KB is almost certainly junk or abuse.
const ELEVATION_REQUEST_MAX_BODY_BYTES = 32 * 1024;

// Rate limit: 10 req/s per device. UAC prompts are rare in normal use; a
// machine emitting more than this is misbehaving or being flooded. 600 in a
// 60-second window approximates 10/s while smoothing over bursts.
const ELEVATION_REQUEST_RATE_LIMIT = 600;
const ELEVATION_REQUEST_RATE_WINDOW_SECONDS = 60;

// How long an auto-approved elevation stays valid when neither the matching
// pam_rule nor (future) org config specifies a duration. Conservative: the
// uac_intercept flow only needs the window in which consent.exe is satisfied.
const PAM_DEFAULT_AUTO_APPROVAL_DURATION_MINUTES = 15;

// #1254: how long a fanned-out mobile approval_request stays actionable. The
// technician has this long to tap approve/deny before it self-expires; the
// underlying elevation has its own (null-until-approved) expiry.
const PAM_MOBILE_APPROVAL_TTL_MINUTES = 15;

/**
 * Map a software-policy bridge verdict + signer presence to the mobile
 * approval risk tier shown on the technician's phone. Pure — unit-tested.
 *
 * At the pending insert site `verdict` is effectively null (an allowlist /
 * blocklist match would already have auto-decided the elevation, so the row
 * never reaches the mobile bridge). The signer signal still matters: an
 * UNSIGNED binary asking for admin is riskier than a signed one, so it tiers
 * up. A blocklist verdict (defensive — shouldn't reach here) is 'critical'; an
 * allowlist verdict is 'low'.
 */
export function elevationVerdictToRiskTier(
  verdict: PamBridgeVerdict | null,
  hasSigner: boolean,
): RiskTier {
  if (verdict?.match === 'blocklist') return 'critical';
  if (verdict?.match === 'allowlist') return 'low';
  return hasSigner ? 'medium' : 'high';
}

/**
 * Last path segment of a Windows or POSIX path. `node:path` basename only
 * splits on the host separator, but the agent always reports Windows-style
 * backslash paths, so split on both.
 */
function pathBasename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

export const elevationRequestSchema = z.object({
  subject_username: z.string().min(1).max(255),
  target_executable_path: z.string().min(1).max(4096),
  target_executable_hash: z.string().max(128).optional(),
  target_executable_signer: z.string().max(255).optional(),
  pid: z.number().int().min(0).max(2 ** 32 - 1).optional(),
  parent_image: z.string().max(4096).optional(),
  command_line: z.string().max(8192).optional(),
  observed_at: z.string().datetime({ offset: true }).optional(),
});

export type ElevationRequestPayload = z.infer<typeof elevationRequestSchema>;

type IngestDecision =
  | { kind: 'pending' }
  | {
      kind: 'auto_approved';
      source: 'policy' | 'rule';
      policyId?: string;
      rule?: PamRuleMatch;
      durationMinutes: number;
    }
  | { kind: 'denied'; source: 'policy' | 'rule' | 'default'; policyId?: string; rule?: PamRuleMatch }
  | { kind: 'ignored'; rule: PamRuleMatch };

/** Event emission must never fail ingest — the row is already committed. */
async function safePublish(
  type: EventType,
  orgId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await publishEvent(type, orgId, payload, 'pam-ingest');
  } catch (err) {
    console.error(`[ElevationRequests] event publish failed (${type}):`, err);
  }
}

/**
 * #1254 — mobile approval bridge. For a freshly-inserted PENDING uac_intercept
 * elevation, fan out one mobile approval_request per eligible technician
 * approver and push each to their phone. Whichever approver decides first on
 * mobile mirrors that decision back onto the elevation (see decideHandler in
 * routes/approvals.ts) and expires the siblings.
 *
 * BEST-EFFORT: the elevation row is already committed and the agent's 201 must
 * not depend on this. The whole body is wrapped in try/catch by the caller, and
 * each per-approver push is additionally swallowed so one bad token can't drop
 * the rest. No actuate command is enqueued (parity with pam.ts respond — that's
 * deferred to #1150).
 */
async function fanOutMobileApprovals(args: {
  elevationRequestId: string;
  device: { id: string; orgId: string; hostname: string };
  payload: ElevationRequestPayload;
  reason: string;
  bridgeVerdict: PamBridgeVerdict | null;
  expiresAt: Date;
}): Promise<void> {
  const { elevationRequestId, device, payload, reason, bridgeVerdict, expiresAt } = args;

  const hasSigner = !!payload.target_executable_signer;
  const riskTier = elevationVerdictToRiskTier(bridgeVerdict, hasSigner);
  const exeName = pathBasename(payload.target_executable_path);
  const actionLabel = exeName ? `Elevate ${exeName}` : 'Run as administrator';
  const riskSummary = `${payload.subject_username} requested admin to run ${
    payload.target_executable_path
  }${hasSigner ? ` (signed by ${payload.target_executable_signer})` : ' (unsigned)'}.`;

  const actionArguments: Record<string, unknown> = {
    targetExecutablePath: payload.target_executable_path,
    targetExecutableSigner: payload.target_executable_signer ?? null,
    targetExecutableHash: payload.target_executable_hash ?? null,
    parentImage: payload.parent_image ?? null,
    commandLine: payload.command_line ?? null,
    reason,
    subjectUsername: payload.subject_username,
    deviceHostname: device.hostname,
  };

  // approval_requests is Shape-6 RLS (USING/WITH CHECK user_id = current_user
  // OR scope='system'). This ingest path runs in the agent's ORG-scoped DB
  // context, under which the INSERT is DENIED. withSystemDbAccessContext is a
  // no-op when a context is already open (db/index.ts), so we must FIRST escape
  // the request context with runOutsideDbContext, THEN open a system context —
  // exactly as routes/agents/commands.ts does. All DB reads/writes (resolve
  // approvers, the per-approver approval_requests insert, push-token lookup) run
  // inside this one system context; we then perform the Expo network calls
  // AFTER it closes so we never hold the DB transaction open across the network
  // round-trip (the held-context tripwire in db/index.ts).
  const pushTargets = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const approverIds = await resolveElevationApprovers(device.orgId);
      if (approverIds.length === 0) return [];

      const targets: Array<{ approvalId: string; actionLabel: string; tokens: string[] }> = [];
      for (const userId of approverIds) {
        let approvalId: string;
        try {
          const [row] = await db
            .insert(approvalRequests)
            .values({
              userId,
              elevationRequestId,
              requestingClientLabel: 'Breeze Agent',
              requestingMachineLabel: device.hostname ?? null,
              actionLabel,
              actionToolName: 'uac_intercept',
              actionArguments,
              riskTier,
              riskSummary,
              status: 'pending',
              isRecursive: false,
              expiresAt,
            })
            .returning({ id: approvalRequests.id });
          if (!row) continue;
          approvalId = row.id;
        } catch (err) {
          console.error(
            `[ElevationRequests] mobile approval insert failed for user=${userId} elevation=${elevationRequestId}:`,
            err,
          );
          continue;
        }

        const tokens = await getUserPushTokens(userId);
        targets.push({ approvalId, actionLabel, tokens });
      }
      return targets;
    }),
  );

  // Expo network calls run OUTSIDE the system DB context (no open transaction
  // held across the HTTP round-trip). Push is best-effort per approver — a dead
  // token or Expo outage must not block the remaining approvers or the 201.
  for (const { approvalId, actionLabel: label, tokens } of pushTargets) {
    if (tokens.length === 0) continue;
    try {
      await sendExpoPush(
        tokens.map((to) => ({
          to,
          ...buildApprovalPush({
            approvalId,
            actionLabel: label,
            requestingClientLabel: 'Breeze Agent',
          }),
        })),
      );
    } catch (err) {
      console.error(
        `[ElevationRequests] mobile push failed for approval=${approvalId}:`,
        err,
      );
    }
  }
}

export const elevationRequestsRoutes = new Hono();
// Elevation-request ingest is the main agent's job; reject watchdog tokens.
elevationRequestsRoutes.use('*', requireAgentRole);

elevationRequestsRoutes.post(
  '/:id/elevation-requests',
  // Body-size check happens before zod parses, so a 32 MB payload doesn't
  // first consume zod CPU. Hono exposes the raw Request; we read the
  // Content-Length header (the body has not been buffered yet at this
  // point in the middleware chain).
  async (c, next) => {
    const lenHeader = c.req.header('content-length');
    if (lenHeader) {
      const len = Number.parseInt(lenHeader, 10);
      if (Number.isFinite(len) && len > ELEVATION_REQUEST_MAX_BODY_BYTES) {
        return c.json({ error: 'Body too large' }, 413);
      }
    }
    return next();
  },
  zValidator('json', elevationRequestSchema),
  async (c) => {
    const agentId = c.req.param('id');
    const payload = c.req.valid('json');
    const agent = c.get('agent') as
      | { deviceId?: string; orgId?: string; agentId?: string; siteId?: string }
      | undefined;

    // Rate limit per device. Keying on deviceId from the auth context
    // prevents a stolen token from inflating a different device's budget.
    // Fall back to agentId if the middleware didn't populate deviceId
    // (shouldn't happen, but defensive).
    const rateKey = agent?.deviceId ?? agentId;
    const redis = getRedis();
    const rateCheck = await rateLimiter(
      redis,
      `elevation:rate:device:${rateKey}`,
      ELEVATION_REQUEST_RATE_LIMIT,
      ELEVATION_REQUEST_RATE_WINDOW_SECONDS,
    );
    if (!rateCheck.allowed) {
      return c.json(
        {
          error: 'Rate limit exceeded',
          resetAt: rateCheck.resetAt.toISOString(),
        },
        429,
      );
    }

    const [device] = await db
      .select({
        id: devices.id,
        orgId: devices.orgId,
        siteId: devices.siteId,
        hostname: devices.hostname,
      })
      .from(devices)
      .where(eq(devices.agentId, agentId))
      .limit(1);

    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const observedAt = payload.observed_at ? new Date(payload.observed_at) : new Date();
    if (Number.isNaN(observedAt.getTime())) {
      return c.json({ error: 'Invalid observed_at' }, 400);
    }

    const clientIp = getTrustedClientIpOrUndefined(c);
    const userAgent = c.req.header('user-agent') ?? null;

    // Reason: synthesized server-side. The agent only sends discovery data;
    // it doesn't get to write arbitrary reason text.
    const reason = `UAC consent UI observed for ${payload.target_executable_path}`;

    // ------------------------------------------------------------------
    // Decisioning (#1163). Both evaluators run inside the request's
    // org-scoped withDbAccessContext (opened by agentAuthMiddleware), so
    // policy/rule lookups are RLS-scoped to the device's org. Any error
    // fails SAFE to 'pending' — an evaluator outage must never become an
    // auto-approval, and degrading a blocklist deny to a pending row is
    // preferable to dropping the observation entirely.
    // ------------------------------------------------------------------
    let bridgeVerdict: PamBridgeVerdict | null = null;
    let decision: IngestDecision = { kind: 'pending' };
    try {
      bridgeVerdict = await evaluatePamBridge({
        orgId: device.orgId,
        deviceId: device.id,
        targetExecutablePath: payload.target_executable_path,
        targetExecutableHash: payload.target_executable_hash,
        targetExecutableSigner: payload.target_executable_signer,
      });

      if (bridgeVerdict.match === 'blocklist') {
        decision = { kind: 'denied', source: 'policy', policyId: bridgeVerdict.policyId };
      } else if (bridgeVerdict.match === 'allowlist') {
        decision = {
          kind: 'auto_approved',
          source: 'policy',
          policyId: bridgeVerdict.policyId,
          durationMinutes: PAM_DEFAULT_AUTO_APPROVAL_DURATION_MINUTES,
        };
      } else {
        // No software policy bound — fall through to PAM-native rules.
        const orgRules = await db
          .select()
          .from(pamRules)
          .where(
            and(
              eq(pamRules.orgId, device.orgId),
              eq(pamRules.enabled, true),
              device.siteId
                ? or(isNull(pamRules.siteId), eq(pamRules.siteId, device.siteId))
                : isNull(pamRules.siteId),
            ),
          );
        // Resolve any signer groups referenced by the candidate rules so the
        // engine can match matchSignerGroupId against the group's members.
        const signerGroupIds = [
          ...new Set(
            orgRules
              .map((r) => r.matchSignerGroupId)
              .filter((x): x is string => x != null),
          ),
        ];
        let signerGroups: Map<string, string[]> | undefined;
        if (signerGroupIds.length > 0) {
          const groups = await db
            .select({ id: pamSignerGroups.id, signers: pamSignerGroups.signers })
            .from(pamSignerGroups)
            .where(
              and(
                eq(pamSignerGroups.orgId, device.orgId),
                inArray(pamSignerGroups.id, signerGroupIds),
              ),
            );
          signerGroups = new Map(groups.map((g) => [g.id, g.signers]));
        }
        const ruleMatch = evaluatePamRules(
          orgRules,
          {
            targetExecutablePath: payload.target_executable_path,
            targetExecutableHash: payload.target_executable_hash,
            targetExecutableSigner: payload.target_executable_signer,
            subjectUsername: payload.subject_username,
            parentImage: payload.parent_image,
            commandLine: payload.command_line,
            at: observedAt,
          },
          signerGroups,
        );
        if (!ruleMatch) {
          // No software policy and no PAM rule matched — apply the org's
          // default verdict for unmatched elevations. The historical default
          // (and the default when no config row exists) is require_approval,
          // i.e. leave the request pending; an org can opt into auto_deny.
          const [cfg] = await db
            .select({ verdict: pamOrgConfig.defaultUnmatchedVerdict })
            .from(pamOrgConfig)
            .where(eq(pamOrgConfig.orgId, device.orgId))
            .limit(1);
          if (cfg?.verdict === 'auto_deny') {
            decision = { kind: 'denied', source: 'default' };
          }
        } else {
          switch (ruleMatch.verdict) {
            case 'auto_approve':
              decision = {
                kind: 'auto_approved',
                source: 'rule',
                rule: ruleMatch,
                durationMinutes:
                  ruleMatch.approvalDurationMinutes ??
                  PAM_DEFAULT_AUTO_APPROVAL_DURATION_MINUTES,
              };
              break;
            case 'auto_deny':
              decision = { kind: 'denied', source: 'rule', rule: ruleMatch };
              break;
            case 'ignore':
              decision = { kind: 'ignored', rule: ruleMatch };
              break;
            case 'require_approval':
            default:
              decision = { kind: 'pending' };
              break;
          }
        }
      }
    } catch (err) {
      console.error(
        `[ElevationRequests] decisioning failed for device=${device.id} org=${device.orgId} (failing safe to pending):`,
        err,
      );
      decision = { kind: 'pending' };
    }

    // 'ignore' rules suppress the request entirely: no elevation_requests
    // row (the approval queue stays signal-only), but the observation is
    // still recorded in the general audit log for forensics.
    if (decision.kind === 'ignored') {
      writeAuditEvent(c, {
        orgId: agent?.orgId ?? device.orgId,
        actorType: 'agent',
        actorId: agent?.agentId ?? agentId,
        action: 'agent.elevation_request.ignored',
        resourceType: 'elevation_request',
        resourceId: decision.rule.ruleId,
        details: {
          flow_type: 'uac_intercept',
          subject_username: payload.subject_username,
          target_executable_path: payload.target_executable_path,
          pam_rule_id: decision.rule.ruleId,
          pam_rule_name: decision.rule.ruleName,
        },
      });
      // The agent treats any 200/201 as success and ignores the body.
      return c.json({ id: null, status: 'ignored' }, 200);
    }

    const now = new Date();
    const status =
      decision.kind === 'auto_approved'
        ? 'auto_approved'
        : decision.kind === 'denied'
          ? 'denied'
          : 'pending';

    try {
      const inserted = await db
        .insert(elevationRequests)
        .values({
          orgId: device.orgId,
          siteId: device.siteId ?? null,
          deviceId: device.id,
          flowType: 'uac_intercept',
          subjectUserId: null,
          subjectUsername: payload.subject_username,
          reason,
          targetExecutablePath: payload.target_executable_path,
          targetExecutableHash: payload.target_executable_hash ?? null,
          targetExecutableSigner: payload.target_executable_signer ?? null,
          status,
          requestedAt: observedAt,
          approvedAt: decision.kind === 'auto_approved' ? now : null,
          expiresAt:
            decision.kind === 'auto_approved'
              ? new Date(now.getTime() + decision.durationMinutes * 60_000)
              : null,
          denialReason:
            decision.kind === 'denied'
              ? decision.source === 'policy'
                ? 'Blocked by software policy'
                : decision.source === 'default'
                  ? 'Blocked by org default (no matching policy or rule)'
                  : `Blocked by PAM rule "${decision.rule?.ruleName ?? ''}"`
              : null,
          softwarePolicyMatchId:
            decision.kind !== 'pending' && decision.source === 'policy'
              ? (decision.policyId ?? null)
              : null,
          clientIp: clientIp ?? null,
          userAgent,
          metadata: {
            pid: payload.pid,
            parent_image: payload.parent_image,
            command_line: payload.command_line,
            ...(decision.kind !== 'pending' && decision.rule
              ? { pam_rule_id: decision.rule.ruleId, pam_rule_name: decision.rule.ruleName }
              : {}),
          },
        })
        .returning({ id: elevationRequests.id, status: elevationRequests.status });

      const row = inserted[0];
      if (!row) {
        return c.json({ error: 'Insert returned no row' }, 500);
      }

      // PAM-specific audit chain: one 'requested' row always, plus the
      // auto-decision row when policy/rule decided, plus evidence rows for
      // audit-mode policy hits. Best-effort: the request row is committed;
      // an audit-chain insert failure must not 500 the agent.
      try {
        const auditRows: (typeof elevationAudit.$inferInsert)[] = [
          {
            orgId: device.orgId,
            elevationRequestId: row.id,
            eventType: 'requested',
            actor: 'end_user',
            details: {
              subject_username: payload.subject_username,
              target_executable_path: payload.target_executable_path,
            },
            occurredAt: observedAt,
          },
        ];
        if (decision.kind === 'auto_approved' || decision.kind === 'denied') {
          auditRows.push({
            orgId: device.orgId,
            elevationRequestId: row.id,
            eventType: decision.kind === 'auto_approved' ? 'auto_approved' : 'denied',
            actor: 'policy',
            details:
              decision.source === 'policy'
                ? { software_policy_id: decision.policyId }
                : decision.source === 'default'
                  ? { default_unmatched_verdict: 'auto_deny' }
                  : {
                      pam_rule_id: decision.rule?.ruleId,
                      pam_rule_name: decision.rule?.ruleName,
                    },
            occurredAt: now,
          });
        }
        for (const evidence of bridgeVerdict?.auditMatches ?? []) {
          auditRows.push({
            orgId: device.orgId,
            elevationRequestId: row.id,
            eventType: 'evidence_attached',
            actor: 'policy',
            details: {
              software_policy_id: evidence.policyId,
              rule_name: evidence.ruleName,
              matched_field: evidence.matchedField,
            },
            occurredAt: now,
          });
        }
        await db.insert(elevationAudit).values(auditRows);
      } catch (auditErr) {
        console.error(
          `[ElevationRequests] elevation_audit write failed for request=${row.id}:`,
          auditErr,
        );
      }

      writeAuditEvent(c, {
        orgId: agent?.orgId ?? device.orgId,
        actorType: 'agent',
        actorId: agent?.agentId ?? agentId,
        action: 'agent.elevation_request.submit',
        resourceType: 'elevation_request',
        resourceId: row.id,
        details: {
          flow_type: 'uac_intercept',
          subject_username: payload.subject_username,
          target_executable_path: payload.target_executable_path,
          ingest_status: row.status,
        },
      });

      const eventType: EventType =
        decision.kind === 'auto_approved'
          ? 'elevation.auto_approved'
          : decision.kind === 'denied'
            ? 'elevation.denied'
            : 'elevation.requested';
      await safePublish(eventType, device.orgId, {
        elevationRequestId: row.id,
        deviceId: device.id,
        flowType: 'uac_intercept',
        status: row.status,
        subjectUsername: payload.subject_username,
        targetExecutablePath: payload.target_executable_path,
        ...(decision.kind !== 'pending' && decision.source === 'policy'
          ? { softwarePolicyId: decision.policyId }
          : {}),
        ...(decision.kind !== 'pending' && 'rule' in decision && decision.rule
          ? { pamRuleId: decision.rule.ruleId }
          : {}),
      });

      // #1254: bridge a manually-pending uac_intercept to the mobile approval
      // surface (fan-out to eligible technicians). Best-effort — the elevation
      // row + audit are already committed and the agent must get its 201 even
      // if the entire bridge fails. auto_approved / denied rows skip this (no
      // human decision is needed).
      if (decision.kind === 'pending') {
        try {
          await fanOutMobileApprovals({
            elevationRequestId: row.id,
            device: { id: device.id, orgId: device.orgId, hostname: device.hostname },
            payload,
            reason,
            bridgeVerdict,
            expiresAt: new Date(now.getTime() + PAM_MOBILE_APPROVAL_TTL_MINUTES * 60_000),
          });
        } catch (bridgeErr) {
          console.error(
            `[ElevationRequests] mobile bridge failed for request=${row.id}:`,
            bridgeErr,
          );
        }
      }

      return c.json({ id: row.id, status: row.status }, 201);
    } catch (err) {
      console.error(
        `[ElevationRequests] Failed to insert for device=${device.id} org=${device.orgId}:`,
        err,
      );
      return c.json({ error: 'Failed to record elevation request' }, 500);
    }
  },
);
