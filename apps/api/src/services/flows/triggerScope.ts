/**
 * Tool catalog W04 (#5219), plan Task A7 — the `trigger` root of a run's flow
 * scope (spec §6.2: `{{trigger.*}}`).
 *
 * Built once when a run is created (the runner stores it, redacted, as the
 * run's trigger payload). Two rules:
 *  - the event payload is redacted with the persisted-input redactor BEFORE it
 *    becomes scope, so a secret an event carried can never be templated into a
 *    step input or stored on the run;
 *  - `trigger.device` is enriched only when `payload.deviceId` is a uuid of a
 *    device in the RUN org, read in one query under an org-scoped,
 *    user-less DB context (the flow principal's shape). A foreign or missing
 *    device leaves `device` absent — the step that names it then fails
 *    ownership at run time (`revalidateRenderedStep`), never here.
 */
import { and, eq } from 'drizzle-orm';
import type { FlowTriggerKind, FlowValue } from '@breeze/shared';
import { db, runOutsideDbContext, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { redactPersistedToolInput } from '../aiToolOutput';
import type { BreezeEvent } from '../eventBus';

export interface FlowTriggerScope {
  kind: FlowTriggerKind;
  orgId: string;
  firedAt: string;
  event?: { id: string; type: string };
  payload?: Record<string, FlowValue>;
  device?: { id: string; hostname: string; siteId: string | null };
  /** W5 (#5220): a webhook's JSON body, redacted — templates read `trigger.body.*`. */
  body?: Record<string, FlowValue>;
  webhook?: { deliveryId: string | null; receivedAt: string };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** JSON-normalize to a FlowValue: drops undefined/functions, Dates become ISO strings. */
function toFlowRecord(value: unknown): Record<string, FlowValue> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const normalized: unknown = JSON.parse(JSON.stringify(value));
    return normalized !== null && typeof normalized === 'object' && !Array.isArray(normalized)
      ? (normalized as Record<string, FlowValue>)
      : undefined;
  } catch {
    // A cyclic / BigInt-bearing payload cannot be scope; the trigger keeps its kind and event id.
    return undefined;
  }
}

/** The flow principal's DB shape for one org (flowAuthContext.flowDbAccessContext without a partner axis). */
function runOrgDbContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

async function deviceInOrg(orgId: string, deviceId: string): Promise<FlowTriggerScope['device']> {
  const rows = await runOutsideDbContext(() =>
    withDbAccessContext(runOrgDbContext(orgId), () =>
      db
        .select({ id: devices.id, hostname: devices.hostname, siteId: devices.siteId })
        .from(devices)
        // App-layer org predicate on top of RLS: enrichment never crosses orgs.
        .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
        .limit(1),
    ),
  );
  const row = rows[0];
  if (!row || row.id !== deviceId) return undefined;
  return { id: row.id, hostname: row.hostname, siteId: row.siteId ?? null };
}

export async function buildTriggerScope(input: {
  kind: FlowTriggerKind;
  orgId: string;
  event?: BreezeEvent;
  /** W5: the verified webhook delivery (the body is redacted again here). */
  webhook?: { body: Record<string, unknown>; deliveryId: string | null; receivedAt: string };
}): Promise<FlowTriggerScope> {
  const { kind, orgId, event, webhook } = input;
  const scope: FlowTriggerScope = {
    kind,
    orgId,
    firedAt: event?.metadata?.timestamp ?? webhook?.receivedAt ?? new Date().toISOString(),
  };
  if (webhook) {
    // No device enrichment: the sender controls the body, so a device id in it
    // never pulls a device into scope (templates still read trigger.body.*).
    scope.body = toFlowRecord(redactPersistedToolInput(webhook.body)) ?? {};
    scope.webhook = { deliveryId: webhook.deliveryId, receivedAt: webhook.receivedAt };
    return scope;
  }
  if (!event) return scope;

  scope.event = { id: event.id, type: event.type };
  const payload = toFlowRecord(redactPersistedToolInput(event.payload));
  if (payload) scope.payload = payload;

  const deviceId = payload?.deviceId;
  if (typeof deviceId === 'string' && UUID_RE.test(deviceId)) {
    const device = await deviceInOrg(orgId, deviceId);
    if (device) scope.device = device;
  }
  return scope;
}
