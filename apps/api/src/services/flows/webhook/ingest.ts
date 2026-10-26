/**
 * Tool Catalog W05 (#5220), plan Task A6 — the flow webhook ingress
 * (Decisions 1, 2, 4, 5, 6).
 *
 * Order (every step before authentication answers the same 401, so the
 * endpoint is not an existence oracle for flows):
 *   1. FLOWS_ENABLED off ⇒ 404; a non-uuid flow id ⇒ 401.
 *   2. Redis limiter `flow-webhook:<flowId>` BEFORE any DB read (Redis down ⇒
 *      the limiter fails closed ⇒ 429).
 *   3. System read of the flow and its LIVE publication; enabled, a webhook
 *      trigger on the publication (not just the draft), a stored secret —
 *      any miss ⇒ 401.
 *   4. Verify (hmac / token). A failure marks the flow (≤ once a minute) and
 *      answers 401; unauthenticated failures are never delivery rows.
 *   5. Tenant status after authentication: the owning partner strictly
 *      active, an org flow's org live ⇒ else 401, no row.
 *   6. JSON object bodies only (415 for another content type, 422
 *      `invalid_body` + row for a non-object).
 *   7. Replay: an ACCEPTED row with the same signature digest or delivery id
 *      ⇒ 200 duplicate with its run (attempts + 1).
 *   8. Org resolution ⇒ 422 `org_unresolved` + an org-less row on a miss.
 *   9. The redacted trigger envelope is bounded again (the request limit alone
 *      does not bound what is stored) ⇒ 413 `payload_too_large` + row.
 *  10. createFlowRun (kind `webhook`: never honours pre-approvals), bound to
 *      the verified publication seq and secret generation; the accepted row
 *      is written by `onCreated` INSIDE the run's transaction, so a run and
 *      its accepted row commit or roll back together. A unique conflict on
 *      the accepted row (a racing replay) ⇒ 200 duplicate. An admission
 *      refusal ⇒ 429 + a refused row (coalesced per key per minute).
 */
import { createHash } from 'node:crypto';
import {
  FLOW_RUN_LIMITS,
  flowDocumentV1Schema,
  isFlowAdmissionRefusal,
  type FlowAdmissionRefusal,
  type FlowValue,
  type FlowWebhookAuthMode,
} from '@breeze/shared';
import { and, eq } from 'drizzle-orm';
import { flowsEnabled, flowWebhookRatePerMinute } from '../../../config/env';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { flows } from '../../../db/schema/flows';
import { flowVersions } from '../../../db/schema/flowRuns';
import { isPgUniqueViolation } from '../../../utils/pgErrors';
import { redactPersistedToolInput } from '../../aiToolOutput';
import { rateLimiter } from '../../rate-limit';
import { getRedis } from '../../redis';
import { getActiveOrgTenant, getActivePartner } from '../../tenantStatus';
import { nullFlowInputs } from '../inputDefaults';
import { createFlowRun } from '../runService';
import { buildTriggerScope } from '../triggerScope';
import {
  bumpAcceptedDelivery,
  findAcceptedDelivery,
  insertAcceptedDelivery,
  markWebhookAuthFailure,
  recordNonAcceptedDelivery,
  type DeliveryFacts,
} from './deliveries';
import { resolveWebhookOrg } from './orgResolver';
import { decryptFlowWebhookSecret } from './secret';
import { verifyFlowWebhook } from './verify';

export type WebhookIngestResult =
  | { http: 202; body: { status: 'accepted'; runId: string; deliveryId: string } }
  | { http: 200; body: { status: 'duplicate'; runId: string } }
  | { http: 401 | 404 | 415; body: { error: string } }
  | { http: 413; body: { error: 'payload_too_large'; deliveryId: string } }
  | { http: 409; body: { status: 'refused'; code: 'flow_changed' } }
  | { http: 422; body: { status: 'org_unresolved' | 'invalid_body'; deliveryId: string } }
  | { http: 429; body: { status: 'refused'; code: FlowAdmissionRefusal | 'rate_limited'; deliveryId?: string }; retryAfterSec: number };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNAUTHORIZED = { http: 401, body: { error: 'Unauthorized' } } as const;
/** What a stored trigger envelope may hold beyond the body (Decision 6). */
const ENVELOPE_SLACK_BYTES = 4096;

function inSystem<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const mediaType = value.split(';')[0]!.trim().toLowerCase();
  return mediaType === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(mediaType);
}

/** Seconds until the cap can clear: the next UTC month for a monthly cap, a minute for the active queue. */
function retryAfterFor(code: FlowAdmissionRefusal, now: Date): number {
  if (code === 'flow_queue_full') return 60;
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

async function loadLiveWebhookFlow(flowId: string) {
  return inSystem(async () => {
    const [flow] = await db
      .select({
        id: flows.id,
        orgId: flows.orgId,
        partnerId: flows.partnerId,
        status: flows.status,
        enabledPublicationSeq: flows.enabledPublicationSeq,
        webhookSecretEncrypted: flows.webhookSecretEncrypted,
        webhookSecretRotatedAt: flows.webhookSecretRotatedAt,
      })
      .from(flows)
      .where(eq(flows.id, flowId))
      .limit(1);
    if (!flow || flow.status !== 'enabled' || flow.enabledPublicationSeq === null) return null;
    const seq = flow.enabledPublicationSeq;
    const [pub] = await db
      .select({ definition: flowVersions.definition })
      .from(flowVersions)
      .where(and(eq(flowVersions.flowId, flow.id), eq(flowVersions.publicationSeq, seq)))
      .limit(1);
    const doc = pub ? flowDocumentV1Schema.safeParse(pub.definition) : null;
    if (!doc?.success || doc.data.trigger.type !== 'webhook') return null;
    return { flow: { ...flow, enabledPublicationSeq: seq }, doc: doc.data, trigger: doc.data.trigger };
  }, 'flows.webhook.loadFlow');
}

export async function ingestFlowWebhook(i: { flowId: string; rawBody: string; headers: Headers; receivedAt: Date }): Promise<WebhookIngestResult> {
  if (!flowsEnabled()) return { http: 404, body: { error: 'Not found' } };
  if (!UUID_RE.test(i.flowId)) return UNAUTHORIZED;
  const flowId = i.flowId.toLowerCase();

  const rate = await rateLimiter(getRedis(), `flow-webhook:${flowId}`, flowWebhookRatePerMinute(), 60);
  if (!rate.allowed) {
    const retryAfterSec = Math.max(1, Math.ceil((rate.resetAt.getTime() - Date.now()) / 1000));
    return { http: 429, body: { status: 'refused', code: 'rate_limited' }, retryAfterSec };
  }

  const live = await loadLiveWebhookFlow(flowId);
  if (!live) return UNAUTHORIZED;
  const { flow, doc, trigger } = live;
  let secret: string | null;
  try {
    secret = decryptFlowWebhookSecret(flow);
  } catch {
    secret = null; // a ciphertext bound to another row, or a key that is gone: refuse
  }
  if (!secret || !flow.webhookSecretRotatedAt) return UNAUTHORIZED;

  const authMode: FlowWebhookAuthMode = trigger.auth;
  const verified = verifyFlowWebhook({ rawBody: i.rawBody, headers: i.headers, secret, mode: authMode, now: Date.now() });
  if (!verified.ok) {
    await markWebhookAuthFailure(flow.id, verified.reason);
    return UNAUTHORIZED;
  }

  // Tenant status after authentication, never before (no status oracle).
  let partnerId: string;
  if (flow.orgId) {
    const tenant = await getActiveOrgTenant(flow.orgId);
    if (!tenant) return UNAUTHORIZED;
    partnerId = tenant.partnerId;
  } else {
    if (!flow.partnerId || !(await getActivePartner(flow.partnerId))) return UNAUTHORIZED;
    partnerId = flow.partnerId;
  }

  if (!isJsonContentType(i.headers.get('content-type'))) return { http: 415, body: { error: 'Unsupported media type: send application/json' } };

  const facts: DeliveryFacts = {
    flowId: flow.id,
    partnerId,
    authMode,
    deliveryId: verified.deliveryId,
    signatureDigest: verified.signatureDigest,
    bodySha256: createHash('sha256').update(i.rawBody, 'utf8').digest('hex'),
    bodyBytes: Buffer.byteLength(i.rawBody, 'utf8'),
    receivedAt: i.receivedAt,
  };

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(i.rawBody);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    const id = await recordNonAcceptedDelivery({ ...facts, orgId: flow.orgId, status: 'invalid_body', refusalCode: null, resolverValue: null });
    return { http: 422, body: { status: 'invalid_body', deliveryId: id } };
  }

  const prior = await findAcceptedDelivery({ flowId: flow.id, signatureDigest: facts.signatureDigest, deliveryId: facts.deliveryId });
  if (prior) {
    await bumpAcceptedDelivery(prior.id);
    return { http: 200, body: { status: 'duplicate', runId: prior.runId } };
  }

  const resolved = await resolveWebhookOrg({ orgId: flow.orgId, partnerId }, trigger.orgResolver, body);
  if (!resolved.ok) {
    const id = await recordNonAcceptedDelivery({ ...facts, orgId: null, status: 'org_unresolved', refusalCode: null, resolverValue: resolved.value });
    return { http: 422, body: { status: 'org_unresolved', deliveryId: id } };
  }
  const orgId = resolved.orgId;

  const redacted = redactPersistedToolInput(body) as Record<string, FlowValue>;
  const { kind: _kind, orgId: _org, ...scope } = await buildTriggerScope({
    kind: 'webhook',
    orgId,
    webhook: { body: redacted, deliveryId: facts.deliveryId, receivedAt: i.receivedAt.toISOString() },
  });
  if (Buffer.byteLength(JSON.stringify(scope), 'utf8') > FLOW_RUN_LIMITS.maxStoredOutputBytes + ENVELOPE_SLACK_BYTES) {
    const id = await recordNonAcceptedDelivery({ ...facts, orgId, status: 'refused', refusalCode: 'payload_too_large', resolverValue: resolved.value });
    return { http: 413, body: { error: 'payload_too_large', deliveryId: id } };
  }

  let acceptedId: string | null = null;
  try {
    const result = await createFlowRun({
      triggerKind: 'webhook',
      flowId: flow.id,
      orgId,
      scope,
      inputs: nullFlowInputs(doc.inputs),
      dedupeKey: `webhook:${facts.deliveryId ?? `sig:${facts.signatureDigest}`}`,
      expectedPublicationSeq: flow.enabledPublicationSeq,
      expectedSecretRotatedAt: flow.webhookSecretRotatedAt,
      onCreated: async (runId) => {
        acceptedId = await insertAcceptedDelivery({ ...facts, orgId, runId, resolverValue: resolved.value });
      },
    });
    if (result.created) return { http: 202, body: { status: 'accepted', runId: result.runId, deliveryId: acceptedId ?? '' } };
    if (result.reason === 'duplicate') return { http: 200, body: { status: 'duplicate', runId: result.runId } };
    if (result.reason === 'not_enabled') return { http: 409, body: { status: 'refused', code: 'flow_changed' } };
    if (isFlowAdmissionRefusal(result.reason)) {
      const id = await recordNonAcceptedDelivery({ ...facts, orgId, status: 'refused', refusalCode: result.reason, resolverValue: resolved.value });
      return { http: 429, body: { status: 'refused', code: result.reason, deliveryId: id }, retryAfterSec: retryAfterFor(result.reason, new Date()) };
    }
    return { http: 409, body: { status: 'refused', code: 'flow_changed' } };
  } catch (err) {
    // A replay that raced us to the accepted row: the run and our row rolled back together.
    if (!isPgUniqueViolation(err)) throw err;
    const winner = await findAcceptedDelivery({ flowId: flow.id, signatureDigest: facts.signatureDigest, deliveryId: facts.deliveryId });
    if (!winner) throw err;
    return { http: 200, body: { status: 'duplicate', runId: winner.runId } };
  }
}
