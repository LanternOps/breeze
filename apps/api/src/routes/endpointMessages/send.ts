import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { ENDPOINT_MESSAGE_LIMITS, endpointMessageSendSchema, type EndpointMessageSendInput } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { queueCommandForExecution } from '../../services/commandQueue';
import { CommandTypes } from '../../services/commandTypes';
import { deliveryTtlMs } from '../../services/commandOfflinePolicy';
import { agentSupportsMessaging } from '../../services/commandMinVersion';
import { buildHelperConfigUpdate } from '../../services/helperSettings';
import { writeAuditEventAsync } from '../../services/auditEvents';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { resolveMessageBranding, type MessageBranding } from '../../services/endpointMessaging/brandingSnapshot';
import {
  checkActorSendLimit,
  checkPartnerDeliveryLimit,
  claimCriticalSlot,
  releaseCriticalSlot,
} from '../../services/endpointMessaging/rateLimits';
import {
  claimMessageIdempotency,
  completeMessageIdempotency,
  releaseMessageIdempotency,
} from '../../services/endpointMessaging/idempotency';
import { resolveTargetsDetailed, type TargetGroup } from './resolveTargets';

export type SendErrorCode =
  | 'agent_unsupported'
  | 'no_permission'
  | 'offline_rejected'
  | 'rate_limited'
  | 'cap_exceeded'
  | 'feature_disabled'
  | 'queue_failed';

export interface DeviceSendResult {
  deviceId: string;
  orgId: string;
  status: 'queued' | 'failed';
  commandId?: string;
  errorCode?: SendErrorCode;
}

const FLAG_CONCURRENCY = 20;
const MINUTE_MS = 60_000;

export const sendRoutes = new Hono();

type Ctx = Context;

function targetMode(t: EndpointMessageSendInput['targets']): string {
  const kinds = [
    t.deviceIds?.length ? 'devices' : null,
    t.siteIds?.length ? 'sites' : null,
    t.deviceGroupIds?.length ? 'groups' : null,
  ].filter((k): k is string => k !== null);
  if (kinds.length === 0) return 'org';
  return kinds.length === 1 ? kinds[0]! : 'mixed';
}

/** Map a queueCommandForExecution refusal onto the public error codes. */
function queueErrorCode(res: { error?: string; trust?: unknown }): SendErrorCode {
  if (res.trust) return 'no_permission';
  if (res.error && /offline/i.test(res.error)) return 'offline_rejected';
  return 'queue_failed';
}

async function handleSend(c: Ctx, input: EndpointMessageSendInput) {
  const auth = c.get('auth') as AuthContext;
  const permissions = c.get('permissions') as UserPermissions | undefined;
  const startedAt = Date.now();

  const { groups, denied } = await resolveTargetsDetailed(auth, input.targets, { permissions });
  const resolvedDevices = groups.flatMap((g) => g.devices.map((d) => ({ ...d, orgId: g.orgId })));
  const deviceCount = resolvedDevices.length;

  if (deviceCount === 0 && denied.length === 0) {
    return { status: 400 as const, body: { error: 'no_devices_resolved' } };
  }
  if (deviceCount > ENDPOINT_MESSAGE_LIMITS.maxDevices) {
    return { status: 400 as const, body: { error: 'cap_exceeded', deviceCount } };
  }

  // Rollout flag, resolved per device. A settings entry cached before the flag
  // existed has no `endpointMessaging` key and counts as off.
  const flagOn = new Map<string, boolean | 'error'>();
  for (let i = 0; i < resolvedDevices.length; i += FLAG_CONCURRENCY) {
    const chunk = resolvedDevices.slice(i, i + FLAG_CONCURRENCY);
    const settled = await Promise.all(chunk.map(async (d) => {
      try {
        const s = await buildHelperConfigUpdate(d.id, d.orgId);
        return s.endpointMessaging?.enabled === true;
      } catch (err) {
        console.error('[endpoint-messages] helper settings resolution failed', { deviceId: d.id, error: err instanceof Error ? err.message : String(err) });
        return 'error' as const;
      }
    }));
    chunk.forEach((d, idx) => flagOn.set(d.id, settled[idx]!));
  }
  if (deviceCount > 0 && [...flagOn.values()].every((v) => v === false)) {
    return { status: 403 as const, body: { error: 'feature_disabled' } };
  }

  if (deviceCount > ENDPOINT_MESSAGE_LIMITS.confirmAbove && input.confirmedCount !== deviceCount) {
    return { status: 409 as const, body: { error: 'confirmation_required', deviceCount } };
  }

  const actor = await checkActorSendLimit(auth.user.id);
  if (!actor.allowed) {
    return { status: 429 as const, body: { error: 'rate_limited', retryAfterSeconds: actor.retryAfterSeconds } };
  }

  // Sender identity, once per org, from the org itself (never the request).
  const brandingByOrg = new Map<string, { partnerId: string; branding: MessageBranding } | null>();
  for (const g of groups) brandingByOrg.set(g.orgId, await resolveMessageBranding(g.orgId));

  // Pre-queue classification: which devices are eligible for delivery at all.
  const failures = new Map<string, SendErrorCode>();
  const eligibleByPartner = new Map<string, number>();
  for (const d of resolvedDevices) {
    const flag = flagOn.get(d.id);
    const brand = brandingByOrg.get(d.orgId);
    if (flag === false) failures.set(d.id, 'feature_disabled');
    else if (flag === 'error') failures.set(d.id, 'queue_failed');
    else if (!agentSupportsMessaging(d.agentVersion)) failures.set(d.id, 'agent_unsupported');
    else if (!brand) failures.set(d.id, 'queue_failed');
    else eligibleByPartner.set(brand.partnerId, (eligibleByPartner.get(brand.partnerId) ?? 0) + 1);
  }
  for (const [partnerId, cost] of eligibleByPartner) {
    if (cost <= 0) continue;
    const partner = await checkPartnerDeliveryLimit(partnerId, cost);
    if (!partner.allowed) {
      return { status: 429 as const, body: { error: 'rate_limited', retryAfterSeconds: partner.retryAfterSeconds } };
    }
  }

  const batchId = randomUUID();
  const ttlMs = deliveryTtlMs('standard');
  const expiresMinutes = input.expiresInMinutes ?? ENDPOINT_MESSAGE_LIMITS.maxExpiresInMinutes;
  const expiresAtMs = startedAt + expiresMinutes * MINUTE_MS;
  const expiresAt = new Date(expiresAtMs).toISOString();

  const results: DeviceSendResult[] = [];
  const perOrg = new Map<string, DeviceSendResult[]>();

  for (const g of groups) {
    const orgResults: DeviceSendResult[] = [];
    perOrg.set(g.orgId, orgResults);
    const brand = brandingByOrg.get(g.orgId);
    for (const d of g.devices) {
      const failure = failures.get(d.id);
      let result: DeviceSendResult;
      if (failure || !brand) {
        result = { deviceId: d.id, orgId: g.orgId, status: 'failed', errorCode: failure ?? 'queue_failed' };
      } else {
        result = await queueOne(d.id, g.orgId, brand.branding);
      }
      results.push(result);
      orgResults.push(result);
    }
  }
  for (const dn of denied) {
    // A named device the caller may not reach. Same code whether or not it exists.
    results.push({ deviceId: dn.deviceId, orgId: dn.orgId ?? '', status: 'failed', errorCode: 'no_permission' });
  }

  async function queueOne(deviceId: string, orgId: string, branding: MessageBranding): Promise<DeviceSendResult> {
    let slotClaimed = false;
    try {
      if (input.severity === 'critical') {
        if (!(await claimCriticalSlot(deviceId))) {
          return { deviceId, orgId, status: 'failed', errorCode: 'rate_limited' };
        }
        slotClaimed = true;
      }
      const deliverWithinMs = input.expiresInMinutes === null
        ? ttlMs
        : Math.min(Math.max(expiresAtMs - Date.now(), 1000), ttlMs);
      const res = await queueCommandForExecution(
        deviceId,
        CommandTypes.NOTIFY_USER,
        {
          title: input.title,
          body: input.body,
          urgency: input.severity,
          severity: input.severity,
          messageId: input.messageId,
          batchId,
          persistent: true,
          requiresAck: input.requiresAck,
          expiresAt,
          branding,
          source: 'endpoint_message',
        },
        {
          userId: auth.user.id,
          expectedOrgId: orgId,
          offlinePolicy: { kind: 'queue', deliverWithinMs },
          // Set when an AI surface drove this send; undefined for a person.
          aiOrigin: auth.aiOrigin,
        },
      );
      if (res.error || !res.command) {
        if (slotClaimed) await releaseCriticalSlot(deviceId);
        console.error('[endpoint-messages] queue refused', { deviceId, error: res.error });
        return { deviceId, orgId, status: 'failed', errorCode: queueErrorCode(res) };
      }
      return { deviceId, orgId, status: 'queued', commandId: res.command.id };
    } catch (err) {
      if (slotClaimed) await releaseCriticalSlot(deviceId);
      // Never echo the error into the response: it can carry internals.
      console.error('[endpoint-messages] queue threw', { deviceId, error: err instanceof Error ? err.message : String(err) });
      return { deviceId, orgId, status: 'failed', errorCode: 'queue_failed' };
    }
  }

  // One audit row per org group: hash + length of the body, never its text.
  const bodySha256 = createHash('sha256').update(input.body).digest('hex');
  const ipAddress = getTrustedClientIpOrUndefined(c);
  for (const [orgId, orgResults] of perOrg) {
    const failedByCode: Record<string, number> = {};
    for (const r of orgResults) if (r.errorCode) failedByCode[r.errorCode] = (failedByCode[r.errorCode] ?? 0) + 1;
    await writeAuditEventAsync(c, {
      orgId,
      action: 'endpoint_message.send',
      resourceType: 'endpoint_message',
      resourceId: input.messageId,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      details: {
        batchId,
        messageId: input.messageId,
        targetMode: targetMode(input.targets),
        deviceCount: orgResults.length,
        queued: orgResults.filter((r) => r.status === 'queued').length,
        failed: orgResults.filter((r) => r.status === 'failed').length,
        failedByCode,
        severity: input.severity,
        requiresAck: input.requiresAck,
        expiresInMinutes: input.expiresInMinutes,
        bodySha256,
        bodyLength: input.body.length,
        titleLength: input.title.length,
        ...(auth.aiOrigin ? { aiOrigin: true } : {}),
      },
      ipAddress,
    });
  }

  return { status: 200 as const, body: { batchId, deviceCount: results.length, results } };
}

sendRoutes.post(
  '/',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ENDPOINT_MESSAGES_SEND.resource, PERMISSIONS.ENDPOINT_MESSAGES_SEND.action),
  requireMfa(),
  zValidator('json', endpointMessageSendSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const input = c.req.valid('json') as EndpointMessageSendInput;
    const actorId = auth.user.id;

    // Idempotency first: a replay must consume no budget and touch no device.
    const claim = await claimMessageIdempotency(actorId, input.messageId);
    if (claim.state === 'replay') return c.json(claim.body as object, 200);
    if (claim.state === 'in_progress') return c.json({ error: 'in_progress' }, 409);
    if (claim.state === 'unavailable') return c.json({ error: 'unavailable' }, 503);

    let outcome: Awaited<ReturnType<typeof handleSend>>;
    try {
      outcome = await handleSend(c, input);
    } catch (err) {
      await releaseMessageIdempotency(actorId, input.messageId);
      throw err;
    }

    if (outcome.status === 200) {
      await completeMessageIdempotency(actorId, input.messageId, outcome.body);
    } else {
      // A refused send must not burn the id: fix the problem, resend.
      await releaseMessageIdempotency(actorId, input.messageId);
    }
    return c.json(outcome.body, outcome.status);
  },
);

export type { TargetGroup };
