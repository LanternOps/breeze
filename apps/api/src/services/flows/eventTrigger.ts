/**
 * Tool catalog W04 (#5219), plan Task A9 — the durable event trigger.
 *
 * `flowEventTriggerSubscriber` (id `flow-event-trigger`, every event type)
 * starts one run per matching enabled event flow. Event flows only enable when
 * dispatch is `enforce` AND this id is in EVENT_DISPATCH_QUEUE_SUBSCRIBERS
 * (Decision 10), so in production this handler runs from the durable
 * deliver-event queue with at-least-once delivery and the retry policy below.
 * It is registered in eventSubscribers.ts behind a lazy import (that file's
 * worker-closure rule).
 *
 * Per event:
 *  1. flag off ⇒ return;
 *  2. ONE system read of the candidate flows: enabled, live publication
 *     triggered by this event type, owned by the event's org, or partner-wide
 *     under that org's partner (resolved in SQL from `organizations`, never
 *     from the event) when the event's org passes `partnerFanoutOrgCondition`
 *     — an org the partner-wide schedule fan-out skips (quick_support, the
 *     holding org, deleted, not active/trial) never starts a partner-wide
 *     run. Most events match nothing and stop here;
 *  3. ancestry (Decision 14): `metadata.flowRunId` / `flowChainDepth`
 *     (stamped by publishEvent inside a flow execution frame) for any event
 *     type, and the payload of `flow.run.*`. The flow that owns the causing
 *     run is skipped (no self-trigger); the new run's depth is parent + 1,
 *     and past MAX_FLOW_CHAIN_DEPTH no run starts (warn + metric). A depth
 *     without a run id is malformed ancestry and is refused rather than read
 *     as depth 0 — a loop guard must fail closed;
 *  4. per flow: the trigger filter (`eventMatchesFilter`; a malformed filter
 *     is skipped with a warn), then — for an ORG-OWNED flow — the event org's
 *     liveness (`liveOrgCondition`: active/trial, not deleted; read once per
 *     event, only when an org-owned flow would start): a suspended or deleted
 *     org's own flows stop with it, its org type does not matter (the type
 *     exclusions are partner-wide fan-out only). Then `createFlowRun` with
 *     dedupe `event:<event.id>` — a redelivered event is a duplicate, never a
 *     second run.
 * Throws on DB failure (the queue retries; dedupe makes the retry idempotent
 * per flow), never on a non-match. A full queue is logged and counted
 * (`flow_event_admission_refused_total`), not retried.
 */
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { flowsEnabled } from '../../config/env';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { flowRuns, flowVersions } from '../../db/schema/flowRuns';
import { flows } from '../../db/schema/flows';
import { organizations } from '../../db/schema/orgs';
import type { BreezeEvent } from '../eventBus';
import { liveOrgCondition, partnerFanoutOrgCondition } from '../partnerFanoutOrgs';
import type { DurableEventSubscriber } from '../eventSubscriberRegistry';
import { MAX_FLOW_CHAIN_DEPTH } from './flowExecutionContext';
import { isFlowAdmissionRefusal } from '@breeze/shared';
import { recordFlowChainDepthRefused, recordFlowEventAdmissionRefused } from './flowTriggerMetrics';
import { nullFlowInputs } from './inputDefaults';
import { createFlowRun } from './runService';
import { eventInstant, eventOccurrenceKey } from './conversion/claims';
import { buildTriggerScope, type FlowTriggerScope } from './triggerScope';
import { eventMatchesFilter, isPlainContainer } from './eventFilter';

const LOG = '[FlowEventTrigger]';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The filter match lives in a leaf module (the conversion shadow uses it too).
export { eventMatchesFilter } from './eventFilter';

// ── ancestry ────────────────────────────────────────────────────────────────

type Ancestry =
  | { kind: 'none' }
  | { kind: 'chained'; runId: string; depth: number | null; payloadFlowId: string | null }
  | { kind: 'malformed' };

function ancestryOf(event: BreezeEvent): Ancestry {
  const meta = (event.metadata ?? {}) as { flowRunId?: unknown; flowChainDepth?: unknown };
  let runId = typeof meta.flowRunId === 'string' && UUID_RE.test(meta.flowRunId) ? meta.flowRunId : null;
  let depth = Number.isInteger(meta.flowChainDepth) ? (meta.flowChainDepth as number) : null;
  let payloadFlowId: string | null = null;
  if (String(event.type).startsWith('flow.run.') && isPlainContainer(event.payload)) {
    const p = event.payload as { runId?: unknown; chainDepth?: unknown; flowId?: unknown };
    if (!runId && typeof p.runId === 'string' && UUID_RE.test(p.runId)) runId = p.runId;
    if (depth === null && Number.isInteger(p.chainDepth)) depth = p.chainDepth as number;
    if (typeof p.flowId === 'string' && UUID_RE.test(p.flowId)) payloadFlowId = p.flowId;
  }
  if (runId) return { kind: 'chained', runId, depth, payloadFlowId };
  return depth === null ? { kind: 'none' } : { kind: 'malformed' };
}

// ── reads ───────────────────────────────────────────────────────────────────

interface CandidateFlow {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  trigger: unknown;
  inputs: unknown;
}

function system<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

/** Enabled flows whose LIVE publication listens for `event.type`, owned by the event's org or its partner (partner-wide). */
function loadCandidateFlows(event: BreezeEvent): Promise<CandidateFlow[]> {
  return system(
    async () => db
      .select({
        id: flows.id,
        orgId: flows.orgId,
        partnerId: flows.partnerId,
        trigger: sql<unknown>`${flowVersions.definition}->'trigger'`,
        inputs: sql<unknown>`${flowVersions.definition}->'inputs'`,
      })
      .from(flows)
      .innerJoin(flowVersions, and(eq(flowVersions.flowId, flows.id), eq(flowVersions.publicationSeq, flows.enabledPublicationSeq)))
      .where(and(
        eq(flows.status, 'enabled'),
        sql`${flowVersions.definition}->'trigger'->>'type' = 'event'`,
        sql`${flowVersions.definition}->'trigger'->>'event' = ${String(event.type)}`,
        or(
          eq(flows.orgId, event.orgId),
          // Partner-wide: only when the event's org is one the partner-wide
          // schedule fan-out would reach (the shared live-org predicate).
          and(
            isNull(flows.orgId),
            inArray(
              flows.partnerId,
              db
                .select({ partnerId: organizations.partnerId })
                .from(organizations)
                .where(and(eq(organizations.id, event.orgId), partnerFanoutOrgCondition())),
            ),
          ),
        ),
      )),
    'flows.eventTrigger.candidates',
  );
}

async function loadCausingRun(runId: string): Promise<{ flowId: string; chainDepth: number } | null> {
  const [row] = await system(
    async () => db.select({ flowId: flowRuns.flowId, chainDepth: flowRuns.chainDepth }).from(flowRuns).where(eq(flowRuns.id, runId)).limit(1),
    'flows.eventTrigger.causingRun',
  );
  return row ?? null;
}

/** Whether the org is live (active/trial, not deleted) — the gate for its own flows. */
async function isLiveOrg(orgId: string): Promise<boolean> {
  const rows = await system(
    async () => db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.id, orgId), liveOrgCondition()))
      .limit(1),
    'flows.eventTrigger.orgLiveness',
  );
  return rows.length > 0;
}

function eventFilterOf(trigger: unknown): Record<string, string | number | boolean | null> | null {
  if (!isPlainContainer(trigger)) return null;
  const filter = (trigger as { filter?: unknown }).filter;
  if (filter === undefined) return {};
  return isPlainContainer(filter) && !Array.isArray(filter) ? (filter as Record<string, string | number | boolean | null>) : null;
}

// ── handler ─────────────────────────────────────────────────────────────────

export async function handleFlowEventTrigger(event: BreezeEvent): Promise<void> {
  if (!flowsEnabled()) return;
  if (typeof event.orgId !== 'string' || !UUID_RE.test(event.orgId) || typeof event.id !== 'string' || event.id.length === 0) return;

  const candidates = await loadCandidateFlows(event);
  if (candidates.length === 0) return;

  const ancestry = ancestryOf(event);
  if (ancestry.kind === 'malformed') {
    console.warn(`${LOG} event ${event.id} (${event.type}) carries a chain depth without a run id; no flow runs start`);
    return;
  }
  let chainDepth = 0;
  let causedByRunId: string | null = null;
  let causingFlowId: string | null = null;
  if (ancestry.kind === 'chained') {
    const causing = await loadCausingRun(ancestry.runId);
    causingFlowId = causing?.flowId ?? ancestry.payloadFlowId;
    chainDepth = (ancestry.depth ?? causing?.chainDepth ?? 0) + 1;
    causedByRunId = ancestry.runId;
  }

  let scope: Omit<FlowTriggerScope, 'kind' | 'orgId'> | null = null;
  const occurrenceEventKey = eventOccurrenceKey(event.id);
  const occurrenceAt = eventInstant(event.metadata?.timestamp);
  let orgLive: boolean | null = null;
  let firstError: unknown = null;
  for (const flow of candidates) {
    // No self-trigger, whatever the event type (Decision 14).
    if (causingFlowId && flow.id === causingFlowId) continue;
    const filter = eventFilterOf(flow.trigger);
    if (!filter) {
      console.warn(`${LOG} flow ${flow.id} has a malformed trigger filter; not started for event ${event.id} (${event.type})`);
      continue;
    }
    if (!eventMatchesFilter(filter, event.payload)) continue;
    if (chainDepth > MAX_FLOW_CHAIN_DEPTH) {
      console.warn(`${LOG} chain depth ${chainDepth} > ${MAX_FLOW_CHAIN_DEPTH}: flow ${flow.id} not started for event ${event.id} (caused by run ${causedByRunId})`);
      recordFlowChainDepthRefused();
      continue;
    }
    // An org-owned flow runs only in a live org (a DB failure here throws: the
    // queue retries the event). Partner-wide candidates were already gated by
    // the stricter fan-out predicate in the candidate read.
    if (flow.orgId) {
      orgLive ??= await isLiveOrg(event.orgId);
      if (!orgLive) continue;
    }
    try {
      if (!scope) {
        const { kind: _kind, orgId: _orgId, ...rest } = await buildTriggerScope({ kind: 'event', orgId: event.orgId, event });
        scope = rest;
      }
      const result = await createFlowRun({
        triggerKind: 'event',
        flowId: flow.id,
        orgId: event.orgId,
        scope,
        inputs: nullFlowInputs(flow.inputs),
        dedupeKey: `event:${event.id}`,
        chainDepth,
        causedByRunId,
        // #5221 B2 (Decision 6): the same `event:<id>` the legacy engine claims
        // and stores in automation_runs, and the event's instant. Only a flow
        // converted from a legacy automation consults it; an id that cannot be
        // a key gives no key, so a switched flow leaves that event to legacy.
        occurrence: { keys: occurrenceEventKey ? [occurrenceEventKey] : [], at: occurrenceAt },
      });
      // Already admitted by the legacy engine (or another generation): handled, not retried.
      if (!result.created && result.reason === 'occurrence_claimed') continue;
      // Active-run cap or a monthly cap (W5): handled, never retried — a retry
      // would only refuse again (the flow is not paused).
      if (!result.created && isFlowAdmissionRefusal(result.reason)) {
        console.warn(`${LOG} admission refused (${result.reason}): flow ${flow.id} not started for event ${event.id} in org ${event.orgId}`);
        recordFlowEventAdmissionRefused(result.reason);
      }
    } catch (err) {
      console.error(`${LOG} run creation failed (flow=${flow.id}, event=${event.id})`, err);
      firstError ??= err;
    }
  }
  // Every flow was tried once; the retry re-creates only what failed (dedupe).
  if (firstError) throw firstError;
}

export const flowEventTriggerSubscriber: DurableEventSubscriber = {
  id: 'flow-event-trigger',
  eventTypes: '*',
  handler: handleFlowEventTrigger,
  retry: { attempts: 5, backoffMs: 30_000 },
};
