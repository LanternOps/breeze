import { createHash } from 'node:crypto';
import type { EventType } from '../eventBus';

// Pure parts of the connection health events (spec 2026-10-15 §2.4, W5 plan
// D7–D13). No db, no event bus: the webhook fan-out imports the self-delivery
// predicate from here, and that module must never value-import the bus
// (eventSubscribers.contract.test.ts).

export const HEALTH_EVENT_TYPE = {
  opened: 'integration.health_opened',
  resolved: 'integration.health_resolved',
} as const satisfies Record<string, EventType>;

export type HealthEventKind = keyof typeof HEALTH_EVENT_TYPE;

/** The incident columns the events read. Deliberately narrow: nothing else can reach a payload. */
export type HealthEventRow = {
  id: string;
  orgId: string | null;
  sourceKind: string;
  sourceId: string;
  condition: string;
  severity: string;
  fixHref: string;
  openedAt: Date | null;
  resolvedAt: Date | null;
  resolution: string | null;
  flapCount: number;
  eventState: string | null;
};

/**
 * The documented payload (spec §2.4). It carries fixed codes and ids only: no
 * `detail` (provider text), no `displayName` (user- or provider-entered text),
 * no owner, no recipients.
 */
export type HealthEventPayload = {
  incidentId: string;
  orgId: string;
  sourceKind: string;
  /** null for oauth_grant: its source id is `<owner user id>:<client id>`. */
  sourceId: string | null;
  condition: string;
  severity: string;
  fixHref: string;
  openedAt: string;
  resolvedAt: string | null;
  resolution: string | null;
};

/** Source kinds whose source_id embeds a user id; it never leaves through an event. */
const PERSONAL_SOURCE_ID_KINDS: ReadonlySet<string> = new Set(['oauth_grant']);

/**
 * The event due for this row, if any. Consumers converge on the incident's
 * current state (level-triggered): an open org incident they were not told is
 * open is due 'opened'; a resolved one they were told is open is due
 * 'resolved'. A flap that opens and resolves between two drains is coalesced
 * and never contradicts the current state. Pending rows and partner-wide
 * incidents (org_id NULL, plan D10) never emit.
 */
export function dueHealthEvent(row: Pick<HealthEventRow, 'orgId' | 'openedAt' | 'resolvedAt' | 'eventState'>): HealthEventKind | null {
  if (!row.orgId || !row.openedAt) return null;
  if (row.resolvedAt === null) return row.eventState === 'opened' ? null : 'opened';
  return row.eventState === 'opened' ? 'resolved' : null;
}

export function buildHealthEventPayload(row: HealthEventRow): HealthEventPayload {
  if (!row.orgId || !row.openedAt) throw new Error('connection health event needs an org incident that opened');
  return {
    incidentId: row.id,
    orgId: row.orgId,
    sourceKind: row.sourceKind,
    sourceId: PERSONAL_SOURCE_ID_KINDS.has(row.sourceKind) ? null : row.sourceId,
    condition: row.condition,
    severity: row.severity,
    fixHref: row.fixHref,
    openedAt: row.openedAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolution: row.resolution,
  };
}

/**
 * Deterministic event id (plan D9), shaped as an RFC 4122 v5-style UUID so
 * the event bus accepts it. Opened ids key on (opened_at, flap_count), so a
 * same-episode reopen gets a fresh id; resolved ids key on resolved_at. A
 * re-publish after a crash between publish and mark reuses the id, and webhook
 * delivery dedupes on (webhook_id, event_id).
 */
export function healthEventId(row: Pick<HealthEventRow, 'id' | 'openedAt' | 'resolvedAt' | 'flapCount'>, kind: HealthEventKind): string {
  const key = kind === 'opened'
    ? `connection-health:${row.id}:opened:${row.openedAt?.getTime() ?? 0}:${row.flapCount}`
    : `connection-health:${row.id}:resolved:${row.resolvedAt?.getTime() ?? 0}`;
  const h = createHash('sha256').update(key).digest('hex').slice(0, 32).split('');
  h[12] = '5';
  h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

const HEALTH_EVENT_TYPES: ReadonlySet<string> = new Set(Object.values(HEALTH_EVENT_TYPE));

/**
 * Spec §9 W5: an incident about a webhook is never delivered to that same
 * webhook, which would be a feedback loop (a failing endpoint receiving
 * "you are failing" deliveries that fail in turn). Other subscribed webhooks
 * still receive it.
 */
export function isSelfDeliveryOfHealthEvent(event: { type: string; payload: unknown }, webhookId: string): boolean {
  if (!HEALTH_EVENT_TYPES.has(event.type)) return false;
  const p = event.payload;
  if (typeof p !== 'object' || p === null) return false;
  const { sourceKind, sourceId } = p as { sourceKind?: unknown; sourceId?: unknown };
  return sourceKind === 'webhook' && typeof sourceId === 'string' && sourceId === webhookId;
}
