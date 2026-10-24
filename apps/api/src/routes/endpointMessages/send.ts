import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { ENDPOINT_MESSAGE_LIMITS, endpointMessageSendSchema, type EndpointMessageSendInput } from '@breeze/shared';
import { runOutsideDbContext } from '../../db';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { queueCommandForExecution } from '../../services/commandQueue';
import { CommandTypes } from '../../services/commandTypes';
import { deliveryTtlMs } from '../../services/commandOfflinePolicy';
import { agentSupportsMessaging } from '../../services/commandMinVersion';
import { buildHelperConfigUpdate } from '../../services/helperSettings';
import type { BrandingDecision } from '../../services/helperBranding';
import { endpointMessageIdentity } from '../../services/helperBrandingEndpointIdentity';
import { writeAuditEventAsync, type RequestLike } from '../../services/auditEvents';
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
import { computeSendFingerprint } from '../../services/endpointMessaging/requestFingerprint';
import {
  attachDeliveryCommand,
  markDeliveryQueueFailed,
  persistSend,
  type PersistDeviceInput,
} from '../../services/endpointMessaging/persistence';
import { withdrawCommand } from '../../services/endpointMessaging/retract';
import { resolveTargetsDetailed, type TargetGroup } from './resolveTargets';

export type SendErrorCode =
  | 'agent_unsupported'
  | 'no_permission'
  | 'offline_rejected'
  | 'rate_limited'
  | 'cap_exceeded'
  | 'feature_disabled'
  | 'queue_failed'
  // A retract landed while this send was still queueing its devices.
  | 'retracted';

export interface DeviceSendResult {
  deviceId: string;
  orgId: string;
  status: 'queued' | 'failed';
  commandId?: string;
  errorCode?: SendErrorCode;
}

export interface SendSuccessBody {
  batchId: string;
  deviceCount: number;
  results: DeviceSendResult[];
}

/** Everything a send needs from its caller; the HTTP route, resend and the AI tool each build one. */
export interface EndpointMessageSendContext {
  req: RequestLike;
  auth: AuthContext;
  permissions?: UserPermissions;
  ipAddress?: string;
  /** Set by the resend route: the endpoint_messages row this send replaces. */
  resendOfId?: string;
}

export type EndpointMessageSendOutcome =
  | { status: 200; body: SendSuccessBody }
  | { status: 400 | 403 | 409 | 429 | 503; body: Record<string, unknown> };

const FLAG_CONCURRENCY = 20;
const MINUTE_MS = 60_000;

export const sendRoutes = new Hono();

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

async function handleSend(ctx: EndpointMessageSendContext, input: EndpointMessageSendInput): Promise<EndpointMessageSendOutcome> {
  const { auth, permissions } = ctx;
  const startedAt = Date.now();

  const { groups, denied } = await resolveTargetsDetailed(auth, input.targets, { permissions });
  const resolvedDevices = groups.flatMap((g) => g.devices.map((d) => ({ ...d, orgId: g.orgId })));
  const deviceCount = resolvedDevices.length;

  if (deviceCount === 0 && denied.length === 0) {
    return { status: 400, body: { error: 'no_devices_resolved' } };
  }
  if (deviceCount > ENDPOINT_MESSAGE_LIMITS.maxDevices) {
    return { status: 400, body: { error: 'cap_exceeded', deviceCount } };
  }

  // Confirmation first: a refused send must not spend a per-device settings
  // resolution on up to 5 000 devices (#8742 carry-forward).
  if (deviceCount > ENDPOINT_MESSAGE_LIMITS.confirmAbove && input.confirmedCount !== deviceCount) {
    return { status: 409, body: { error: 'confirmation_required', deviceCount } };
  }

  // Rollout flag, resolved per device. The Redis settings cache is skipped on
  // both sides: this runs inside the request's held DB transaction (#1105),
  // and a cached entry written before the flag existed would read as "off".
  const flagOn = new Map<string, boolean | 'error'>();
  // Helper branding is partner/org-only, so one decision per org serves every device in it.
  const helperBrandingByOrg = new Map<string, BrandingDecision>();
  for (let i = 0; i < resolvedDevices.length; i += FLAG_CONCURRENCY) {
    const chunk = resolvedDevices.slice(i, i + FLAG_CONCURRENCY);
    const settled = await Promise.all(chunk.map(async (d) => {
      try {
        const s = await buildHelperConfigUpdate(d.id, d.orgId, { skipCacheRead: true, skipCacheWrite: true });
        if (s.branding && !helperBrandingByOrg.has(d.orgId)) helperBrandingByOrg.set(d.orgId, s.branding);
        return s.endpointMessaging?.enabled === true;
      } catch (err) {
        console.error('[endpoint-messages] helper settings resolution failed', { deviceId: d.id, error: err instanceof Error ? err.message : String(err) });
        return 'error' as const;
      }
    }));
    chunk.forEach((d, idx) => flagOn.set(d.id, settled[idx]!));
  }
  if (deviceCount > 0 && [...flagOn.values()].every((v) => v === false)) {
    return { status: 403, body: { error: 'feature_disabled' } };
  }

  const actor = await runOutsideDbContext(() => checkActorSendLimit(auth.user.id));
  if (!actor.allowed) {
    return { status: 429, body: { error: 'rate_limited', retryAfterSeconds: actor.retryAfterSeconds } };
  }

  // Sender identity, once per org, from the org itself (never the request).
  const brandingByOrg = new Map<string, { partnerId: string; branding: MessageBranding } | null>();
  for (const g of groups) brandingByOrg.set(g.orgId, await resolveMessageBranding(g.orgId));
  // Sender identity per org: always the partner name (#9396: org-level Helper branding never
  // reaches the sender slot). Only the accent follows the Helper branding already resolved for
  // this send (no extra query); cleared or absent branding keeps the partner colour.
  const identityByOrg = new Map<string, MessageBranding | null>();
  for (const g of groups) {
    const brand = brandingByOrg.get(g.orgId);
    identityByOrg.set(g.orgId, brand ? endpointMessageIdentity(helperBrandingByOrg.get(g.orgId), brand.branding) : null);
  }

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
    const partner = await runOutsideDbContext(() => checkPartnerDeliveryLimit(partnerId, cost));
    if (!partner.allowed) {
      return { status: 429, body: { error: 'rate_limited', retryAfterSeconds: partner.retryAfterSeconds } };
    }
  }

  const batchId = randomUUID();
  const ttlMs = deliveryTtlMs('standard');
  const expiresMinutes = input.expiresInMinutes ?? ENDPOINT_MESSAGE_LIMITS.maxExpiresInMinutes;
  const expiresAtMs = startedAt + expiresMinutes * MINUTE_MS;
  const expiresAt = new Date(expiresAtMs).toISOString();
  const bodySha256 = createHash('sha256').update(input.body).digest('hex');

  // Persist the message and every delivery (W02) BEFORE queueing, in a
  // transaction of its own that is visible before any command exists: a fast
  // agent's command result must find its row. A failure here queues nothing.
  const persistDevices: PersistDeviceInput[] = [];
  for (const g of groups) {
    const brand = brandingByOrg.get(g.orgId);
    for (const d of g.devices) {
      const failure = failures.get(d.id) ?? (brand ? undefined : 'queue_failed');
      persistDevices.push(failure
        ? { deviceId: d.id, orgId: g.orgId, status: 'failed', errorCode: failure }
        : { deviceId: d.id, orgId: g.orgId, status: 'queued' });
    }
  }
  const deliveryByDevice = await persistSend({
    batchId,
    clientMessageId: input.messageId,
    actorId: auth.user.id,
    targetMode: targetMode(input.targets),
    targetSpec: input.targets as Record<string, unknown>,
    title: input.title,
    body: input.body,
    bodySha256,
    severity: input.severity,
    requiresAck: input.requiresAck,
    expiresAt: new Date(expiresAtMs),
    aiOrigin: auth.aiOrigin,
    resendOfId: ctx.resendOfId,
    orgGroups: groups.map((g) => ({
      orgId: g.orgId,
      branding: { ...(identityByOrg.get(g.orgId) ?? {}) },
    })),
    devices: persistDevices,
  });

  const results: DeviceSendResult[] = [];
  const perOrg = new Map<string, DeviceSendResult[]>();

  async function recordQueueOutcome(
    deliveryId: string | undefined,
    result: DeviceSendResult,
    agentVersion: string | null,
  ): Promise<DeviceSendResult> {
    if (!deliveryId) return result;
    let attached: Awaited<ReturnType<typeof attachDeliveryCommand>> | undefined;
    try {
      if (result.status === 'queued' && result.commandId) attached = await attachDeliveryCommand(deliveryId, result.commandId);
      else if (result.status === 'failed') await markDeliveryQueueFailed(deliveryId, result.errorCode ?? 'queue_failed');
    } catch (err) {
      // The command is already queued (or refused). Losing this bookkeeping
      // write leaves the delivery `queued`; the command result still finds it
      // by batch, and the expiry sweep closes it otherwise.
      console.error('[endpoint-messages] delivery bookkeeping failed', {
        deliveryId,
        batchId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (attached !== 'retracted' || !result.commandId) return result;

    // The operator retracted this message while the send was still working
    // through its devices: take back the command just queued.
    const withdrawn = await withdrawCommand({
      deviceId: result.deviceId,
      orgId: result.orgId,
      commandId: result.commandId,
      clientMessageId: input.messageId,
      expiresAt: new Date(expiresAtMs),
      agentVersion,
      userId: auth.user.id,
      aiOrigin: auth.aiOrigin,
    });
    if (withdrawn.kind === 'failed') {
      console.error('[endpoint-messages] could not withdraw a message retracted mid-send', {
        deviceId: result.deviceId, batchId, errorCode: withdrawn.errorCode,
      });
    }
    return { deviceId: result.deviceId, orgId: result.orgId, status: 'failed', errorCode: 'retracted' };
  }

  async function queueOne(deviceId: string, orgId: string, branding: MessageBranding): Promise<DeviceSendResult> {
    let slotClaimed = false;
    try {
      if (input.severity === 'critical') {
        if (!(await runOutsideDbContext(() => claimCriticalSlot(deviceId)))) {
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
        if (slotClaimed) await runOutsideDbContext(() => releaseCriticalSlot(deviceId));
        console.error('[endpoint-messages] queue refused', { deviceId, error: res.error });
        return { deviceId, orgId, status: 'failed', errorCode: queueErrorCode(res) };
      }
      return { deviceId, orgId, status: 'queued', commandId: res.command.id };
    } catch (err) {
      if (slotClaimed) await runOutsideDbContext(() => releaseCriticalSlot(deviceId));
      // Never echo the error into the response: it can carry internals.
      console.error('[endpoint-messages] queue threw', { deviceId, error: err instanceof Error ? err.message : String(err) });
      return { deviceId, orgId, status: 'failed', errorCode: 'queue_failed' };
    }
  }

  for (const g of groups) {
    const orgResults: DeviceSendResult[] = [];
    perOrg.set(g.orgId, orgResults);
    const identity = identityByOrg.get(g.orgId);
    for (const d of g.devices) {
      const failure = failures.get(d.id);
      let result: DeviceSendResult;
      if (failure || !identity) {
        result = { deviceId: d.id, orgId: g.orgId, status: 'failed', errorCode: failure ?? 'queue_failed' };
      } else {
        result = await queueOne(d.id, g.orgId, identity);
        result = await recordQueueOutcome(deliveryByDevice.get(d.id), result, d.agentVersion);
      }
      results.push(result);
      orgResults.push(result);
    }
  }
  for (const dn of denied) {
    // A named device the caller may not reach. Same code whether or not it exists.
    results.push({ deviceId: dn.deviceId, orgId: dn.orgId ?? '', status: 'failed', errorCode: 'no_permission' });
  }

  // One audit row per org group: hash + length of the body, never its text.
  for (const [orgId, orgResults] of perOrg) {
    const failedByCode: Record<string, number> = {};
    for (const r of orgResults) if (r.errorCode) failedByCode[r.errorCode] = (failedByCode[r.errorCode] ?? 0) + 1;
    await writeAuditEventAsync(ctx.req, {
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
        ...(ctx.resendOfId ? { resendOf: ctx.resendOfId } : {}),
      },
      ipAddress: ctx.ipAddress,
    });
  }

  return { status: 200, body: { batchId, deviceCount: results.length, results } };
}

/**
 * The whole send, idempotency included. Shared by the HTTP route, the resend
 * route and the `send_endpoint_message` AI tool, so every path gets the same
 * caps, limits, version gate, persistence and audit.
 */
export async function executeEndpointMessageSend(
  ctx: EndpointMessageSendContext,
  input: EndpointMessageSendInput,
): Promise<EndpointMessageSendOutcome> {
  const actorId = ctx.auth.user.id;

  // Idempotency first: a replay must consume no budget and touch no device.
  // Redis round-trips run outside the request's held DB transaction.
  const fingerprint = computeSendFingerprint(input);
  const claim = await runOutsideDbContext(() => claimMessageIdempotency(actorId, input.messageId, fingerprint));
  if (claim.state === 'replay') return { status: 200, body: claim.body as SendSuccessBody };
  if (claim.state === 'in_progress') return { status: 409, body: { error: 'in_progress' } };
  if (claim.state === 'conflict') return { status: 409, body: { error: 'idempotency_conflict' } };
  if (claim.state === 'unavailable') return { status: 503, body: { error: 'unavailable' } };

  const release = () => runOutsideDbContext(() => releaseMessageIdempotency(actorId, input.messageId));

  let outcome: EndpointMessageSendOutcome;
  try {
    outcome = await handleSend(ctx, input);
  } catch (err) {
    await release();
    throw err;
  }

  if (outcome.status === 200 && outcome.body.results.some((r) => r.status === 'queued')) {
    await runOutsideDbContext(() => completeMessageIdempotency(actorId, input.messageId, fingerprint, outcome.body));
  } else {
    // A refused send, or a 200 that queued nothing, must not burn the id:
    // fix the problem, resend.
    await release();
  }
  return outcome;
}

sendRoutes.post(
  '/',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ENDPOINT_MESSAGES_SEND.resource, PERMISSIONS.ENDPOINT_MESSAGES_SEND.action),
  requireMfa(),
  zValidator('json', endpointMessageSendSchema),
  async (c) => {
    const input = c.req.valid('json') as EndpointMessageSendInput;
    const outcome = await executeEndpointMessageSend({
      req: c,
      auth: c.get('auth') as AuthContext,
      permissions: c.get('permissions') as UserPermissions | undefined,
      ipAddress: getTrustedClientIpOrUndefined(c),
    }, input);
    return c.json(outcome.body, outcome.status);
  },
);

export type { TargetGroup };
