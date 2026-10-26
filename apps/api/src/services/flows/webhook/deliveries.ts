/**
 * Tool Catalog W05 (#5220), plan Task A6 / Decision 2 — the webhook delivery
 * log: writes for the ingress (system context, explicit predicates) and the
 * read for `GET /api/v1/flows/:id/webhook-deliveries` (CALLER context: RLS —
 * the conditional connection_health_incidents policy — is the reach, so an
 * org token sees only its org's rows and never a partner-level one; a
 * site-limited or device-bound reader also gets the run-body read ceiling).
 *
 * Rows never carry a body: only its sha256 and size. Accepted rows are
 * unique per (flow, signature digest) and per (flow, delivery id) — the
 * partial unique indexes ARE the replay protection. Non-accepted rows of the
 * same delivery within a minute are coalesced (`attempts + 1`).
 */
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { FlowWebhookAuthFailure, FlowWebhookAuthMode, FlowWebhookDeliveryDto, FlowWebhookDeliveryStatus } from '@breeze/shared';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { flows } from '../../../db/schema/flows';
import { flowWebhookDeliveries } from '../../../db/schema/flowWebhooks';
import type { AuthContext } from '../../../middleware/auth';
import { captureException } from '../../sentry';
import { runBodiesRestricted } from '../runBodyAccess';

export interface DeliveryFacts {
  flowId: string;
  partnerId: string;
  authMode: FlowWebhookAuthMode;
  deliveryId: string | null;
  signatureDigest: string | null;
  bodySha256: string;
  bodyBytes: number;
  receivedAt: Date;
}

export const FLOW_WEBHOOK_DELIVERIES_PAGE_MAX = 100;

function inSystem<T>(fn: () => Promise<T>, label: string): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

/** The accepted delivery a replay or retry collides with, by signature digest or delivery id. */
export async function findAcceptedDelivery(key: { flowId: string; signatureDigest: string | null; deliveryId: string | null }): Promise<{ id: string; runId: string } | null> {
  const matches = [
    ...(key.signatureDigest ? [eq(flowWebhookDeliveries.signatureDigest, key.signatureDigest)] : []),
    ...(key.deliveryId ? [eq(flowWebhookDeliveries.deliveryId, key.deliveryId)] : []),
  ];
  if (matches.length === 0) return null;
  const [row] = await inSystem(() => db
    .select({ id: flowWebhookDeliveries.id, runId: flowWebhookDeliveries.runId })
    .from(flowWebhookDeliveries)
    .where(and(eq(flowWebhookDeliveries.flowId, key.flowId), eq(flowWebhookDeliveries.status, 'accepted'), or(...matches)))
    .limit(1), 'flows.webhook.findAccepted');
  return row?.runId ? { id: row.id, runId: row.runId } : null;
}

/** A duplicate of an accepted delivery: visible as attempts, nothing else changes. */
export async function bumpAcceptedDelivery(id: string): Promise<void> {
  await inSystem(() => db
    .update(flowWebhookDeliveries)
    .set({ attempts: sql`${flowWebhookDeliveries.attempts} + 1`, lastAttemptAt: new Date() })
    .where(and(eq(flowWebhookDeliveries.id, id), eq(flowWebhookDeliveries.status, 'accepted'))), 'flows.webhook.bumpAccepted');
}

/**
 * The accepted row, written by createFlowRun's `onCreated` inside the run's
 * system transaction (it joins the ambient context). A unique violation
 * (a racing replay) propagates and rolls the run back with it.
 */
export async function insertAcceptedDelivery(row: DeliveryFacts & { orgId: string; runId: string; resolverValue: string | null }): Promise<string> {
  if (getCurrentDbAccessContext()?.scope !== 'system') {
    throw new Error('insertAcceptedDelivery must run inside the run-creation system transaction');
  }
  const [inserted] = await db
    .insert(flowWebhookDeliveries)
    .values({
      partnerId: row.partnerId,
      orgId: row.orgId,
      flowId: row.flowId,
      receivedAt: row.receivedAt,
      lastAttemptAt: row.receivedAt,
      authMode: row.authMode,
      deliveryId: row.deliveryId,
      signatureDigest: row.signatureDigest,
      bodySha256: row.bodySha256,
      bodyBytes: row.bodyBytes,
      status: 'accepted',
      resolverValue: row.resolverValue,
      runId: row.runId,
    })
    .returning({ id: flowWebhookDeliveries.id });
  if (!inserted) throw new Error('insertAcceptedDelivery: insert returned no row');
  return inserted.id;
}

/**
 * A refused / org_unresolved / invalid_body delivery. The same delivery (same
 * status, key and body hash) within a minute bumps the existing row instead
 * of adding one, so a sender retrying a capped delivery does not fill the log.
 */
export async function recordNonAcceptedDelivery(
  row: DeliveryFacts & {
    orgId: string | null;
    status: Exclude<FlowWebhookDeliveryStatus, 'accepted'>;
    refusalCode: string | null;
    resolverValue: string | null;
  },
): Promise<string> {
  return inSystem(async () => {
    const now = new Date();
    const [coalesced] = await db
      .update(flowWebhookDeliveries)
      .set({ attempts: sql`${flowWebhookDeliveries.attempts} + 1`, lastAttemptAt: now, refusalCode: row.refusalCode })
      .where(and(
        eq(flowWebhookDeliveries.flowId, row.flowId),
        eq(flowWebhookDeliveries.status, row.status),
        eq(flowWebhookDeliveries.authMode, row.authMode),
        eq(flowWebhookDeliveries.bodySha256, row.bodySha256),
        sql`${flowWebhookDeliveries.signatureDigest} IS NOT DISTINCT FROM ${row.signatureDigest}`,
        sql`${flowWebhookDeliveries.deliveryId} IS NOT DISTINCT FROM ${row.deliveryId}`,
        sql`${flowWebhookDeliveries.orgId} IS NOT DISTINCT FROM ${row.orgId}::uuid`,
        sql`${flowWebhookDeliveries.lastAttemptAt} > now() - interval '60 seconds'`,
      ))
      .returning({ id: flowWebhookDeliveries.id });
    if (coalesced) return coalesced.id;
    const [inserted] = await db
      .insert(flowWebhookDeliveries)
      .values({
        partnerId: row.partnerId,
        orgId: row.orgId,
        flowId: row.flowId,
        receivedAt: row.receivedAt,
        lastAttemptAt: now,
        authMode: row.authMode,
        deliveryId: row.deliveryId,
        signatureDigest: row.signatureDigest,
        bodySha256: row.bodySha256,
        bodyBytes: row.bodyBytes,
        status: row.status,
        refusalCode: row.refusalCode,
        resolverValue: row.resolverValue,
      })
      .returning({ id: flowWebhookDeliveries.id });
    if (!inserted) throw new Error('recordNonAcceptedDelivery: insert returned no row');
    return inserted.id;
  }, 'flows.webhook.recordDelivery');
}

/** The flow's last unauthenticated-delivery reason, written at most once a minute. Best effort. */
export async function markWebhookAuthFailure(flowId: string, reason: FlowWebhookAuthFailure): Promise<void> {
  try {
    await inSystem(() => db.execute(sql`
      UPDATE flows SET webhook_last_auth_failure_at = now(), webhook_last_auth_failure_reason = ${reason}
      WHERE id = ${flowId}
        AND (webhook_last_auth_failure_at IS NULL OR webhook_last_auth_failure_at < now() - interval '1 minute')`),
    'flows.webhook.markAuthFailure');
  } catch (err) {
    // Best effort, but reported: the marker is the operator's only view of a failing sender.
    console.error(`[flows] webhook auth-failure marker failed (flow=${flowId})`, err);
    captureException(err instanceof Error ? err : new Error(String(err)), undefined,
      { flow_id: flowId, flow_site: 'flows.webhook.markAuthFailure' }, { fingerprint: ['flow', 'flows.webhook.markAuthFailure'] });
  }
}

/**
 * Newest first, in the CALLER's context (RLS is the reach); `before` pages by
 * received_at. Null when the flow itself is not visible to the caller (the
 * route's 404), so another org's flow id reads like an unknown one.
 *
 * Read ceiling: the run-body rule (`runBodiesRestricted`). The delivery id and
 * the resolver value are sender-supplied identifiers from the request: the
 * delivery id is kept in the run's `triggerPayload.webhook`, and the resolver
 * value is read out of the request body, which `triggerPayload.body` holds.
 * A site-limited or device-bound caller never sees run bodies, so it gets
 * both as null here too (refused and unresolved rows, which have no run,
 * included). Status, refusal code, received-at time, org id, run id, auth
 * mode, size and attempts stay: the ledger's shape, as the run summaries keep it.
 */
export async function listWebhookDeliveries(
  auth: AuthContext,
  flowId: string,
  q: { limit?: number; before?: string } = {},
): Promise<FlowWebhookDeliveryDto[] | null> {
  const [visible] = await db.select({ id: flows.id }).from(flows).where(eq(flows.id, flowId)).limit(1);
  if (!visible) return null;
  const restricted = runBodiesRestricted(auth);
  const limit = Math.min(Math.max(q.limit ?? 50, 1), FLOW_WEBHOOK_DELIVERIES_PAGE_MAX);
  const before = q.before ? new Date(q.before) : null;
  const rows = await db
    .select()
    .from(flowWebhookDeliveries)
    .where(and(
      eq(flowWebhookDeliveries.flowId, flowId),
      ...(before && !Number.isNaN(before.getTime()) ? [lt(flowWebhookDeliveries.receivedAt, before)] : []),
    ))
    .orderBy(desc(flowWebhookDeliveries.receivedAt), desc(flowWebhookDeliveries.id))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    receivedAt: r.receivedAt.toISOString(),
    status: r.status,
    refusalCode: r.refusalCode ?? null,
    orgId: r.orgId ?? null,
    runId: r.runId ?? null,
    deliveryId: restricted ? null : r.deliveryId ?? null,
    authMode: r.authMode,
    bodyBytes: r.bodyBytes,
    attempts: r.attempts,
    resolverValue: restricted ? null : r.resolverValue ?? null,
  }));
}
