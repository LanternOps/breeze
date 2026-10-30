import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as dbModule from '../../db';
import { alerts, devices, organizations, organizationExternalLinks, sites } from '../../db/schema';
import type { BreezeEvent } from '../eventBus';
import { captureException } from '../sentry';
import { listAlertExternalTickets, type AlertExternalTicket } from '../alertExternalTickets';
import { alertWebhookDataV2Schema, type AlertWebhookDataV2, type AlertWebhookDataV2Partner } from './alertV2';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

let warnedMissingBase = false;
export function __resetAlertUrlWarningForTests(): void {
  warnedMissingBase = false;
}

export function alertWebhookUrl(alertId: string): string {
  const base = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
  if (!base && !warnedMissingBase) {
    warnedMissingBase = true;
    console.warn('[WebhookAlertEnrichment] DASHBOARD_URL and PUBLIC_APP_URL are unset; alert URLs are relative');
  }
  return alertId ? `${base}/alerts/${alertId}` : `${base}/alerts`;
}

const uuidSchema = z.string().uuid();
const isoSchema = z.string().datetime({ offset: true });
const stringOrNull = (value: unknown): string | null => typeof value === 'string' ? value : null;
const validUuid = (value: unknown): string | null => uuidSchema.safeParse(value).success ? value as string : null;
const validTimestamp = (value: unknown): string | null => {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  return isoSchema.safeParse(value).success ? value as string : null;
};

function eventPayload(event: BreezeEvent): Record<string, unknown> {
  return event.payload !== null && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload
    : {};
}

function projectExternalTickets(tickets: AlertExternalTicket[]): AlertWebhookDataV2['externalTickets'] {
  return tickets.map(({ source, externalId, externalUrl, externalNumber }) => ({ source, externalId, externalUrl, externalNumber }));
}

async function readEnrichment(event: BreezeEvent) {
  const payload = eventPayload(event);
  const [row] = await db.select({
    alertId: alerts.id,
    ruleId: alerts.ruleId,
    monitorId: alerts.monitorId,
    deviceId: alerts.deviceId,
    episodeId: alerts.episodeId,
    severity: alerts.severity,
    title: alerts.title,
    message: alerts.message,
    triggeredAt: alerts.triggeredAt,
    acknowledgedAt: alerts.acknowledgedAt,
    resolvedAt: alerts.resolvedAt,
    deviceHostname: devices.hostname,
    siteId: sql<string | null>`COALESCE(${alerts.topologySiteId}, ${devices.siteId})`,
    siteName: sites.name,
    orgName: organizations.name,
    partnerId: organizations.partnerId,
    subjectKey: alerts.subjectKey,
    resolutionNote: alerts.resolutionNote,
    resolvedBy: alerts.resolvedBy,
    resolvedByPrincipalId: alerts.resolvedByPrincipalId,
    resolutionReason: alerts.resolutionReason,
    acknowledgedBy: alerts.acknowledgedBy,
    acknowledgedByPrincipalId: alerts.acknowledgedByPrincipalId,
    suppressedUntil: alerts.suppressedUntil,
  }).from(organizations)
    // Publishers may still be in a transaction. The org anchors the read so a
    // not-yet-visible alert does not prevent enrichment by payload deviceId.
    .leftJoin(alerts, and(eq(alerts.id, sql`${validUuid(payload.alertId)}::uuid`), eq(alerts.orgId, organizations.id)))
    .leftJoin(devices, and(
      eq(devices.id, sql`COALESCE(${alerts.deviceId}, ${validUuid(payload.deviceId)}::uuid)`),
      eq(devices.orgId, organizations.id),
    ))
    .leftJoin(sites, and(
      eq(sites.id, sql`COALESCE(${alerts.topologySiteId}, ${devices.siteId})`),
      eq(sites.orgId, organizations.id),
    ))
    .where(eq(organizations.id, event.orgId))
    .limit(1);

  const orgExternalIds = row?.partnerId
    ? await db.select({ system: organizationExternalLinks.system, externalId: organizationExternalLinks.externalId })
      .from(organizationExternalLinks)
      .where(and(eq(organizationExternalLinks.orgId, event.orgId), eq(organizationExternalLinks.partnerId, row.partnerId)))
      .orderBy(asc(organizationExternalLinks.system), asc(organizationExternalLinks.externalId))
    : [];
  return { row, orgExternalIds };
}

type EnrichmentRow = Awaited<ReturnType<typeof readEnrichment>>['row'];
const topLevelKeys = new Set(Object.keys(alertWebhookDataV2Schema.shape));

function project(event: BreezeEvent, row: EnrichmentRow, incomplete: boolean): AlertWebhookDataV2 {
  const payload = eventPayload(event);
  const text = (key: keyof AlertWebhookDataV2): string | null =>
    stringOrNull(payload[key]) ?? stringOrNull(row?.[key as keyof NonNullable<EnrichmentRow>]);
  const time = (key: 'triggeredAt' | 'acknowledgedAt' | 'resolvedAt' | 'suppressedUntil'): string | null =>
    (typeof payload[key] === 'string' ? validTimestamp(payload[key]) : null) ?? validTimestamp(row?.[key]);
  const payloadSeverity = alertWebhookDataV2Schema.shape.severity.safeParse(payload.severity);
  const rowSeverity = alertWebhookDataV2Schema.shape.severity.safeParse(row?.severity);
  const status = event.type === 'alert.acknowledged' ? 'acknowledged'
    : event.type === 'alert.resolved' ? 'resolved'
      : event.type === 'alert.suppressed' ? 'suppressed' : 'active';
  const alertId = text('alertId');
  return {
    alertId, ruleId: text('ruleId'), monitorId: text('monitorId'), deviceId: text('deviceId'), episodeId: text('episodeId'),
    status,
    severity: payloadSeverity.success && payloadSeverity.data !== null ? payloadSeverity.data : rowSeverity.success ? rowSeverity.data : null,
    title: text('title'), message: text('message'), triggeredAt: time('triggeredAt'), acknowledgedAt: time('acknowledgedAt'), resolvedAt: time('resolvedAt'),
    deviceHostname: stringOrNull(row?.deviceHostname), siteId: stringOrNull(row?.siteId), siteName: stringOrNull(row?.siteName), orgName: stringOrNull(row?.orgName),
    alertUrl: alertWebhookUrl(alertId ?? ''),
    externalTickets: [], acknowledgedByPrincipalId: text('acknowledgedByPrincipalId'), resolvedByPrincipalId: text('resolvedByPrincipalId'),
    enrichmentIncomplete: incomplete,
    subjectKey: text('subjectKey'), resolutionNote: text('resolutionNote'), resolvedBy: text('resolvedBy'), resolutionReason: text('resolutionReason'),
    acknowledgedBy: text('acknowledgedBy'), suppressedBy: stringOrNull(payload.suppressedBy), suppressedUntil: time('suppressedUntil'),
    responsesOwner: typeof payload.responsesOwner === 'boolean' ? payload.responsesOwner : null,
    kind: stringOrNull(payload.kind), source: stringOrNull(payload.source),
    details: Object.fromEntries(Object.entries(payload).filter(([key]) => !topLevelKeys.has(key))),
  };
}

/** Copy before freezing: neither projection may freeze or share the producer's objects. */
function frozenCopy<T>(value: T, seen = new Map<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value) as T;
  if (value instanceof Date) return Object.freeze(new Date(value.getTime())) as T;
  const copy: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(copy, key, { value: frozenCopy(item, seen), enumerable: true, configurable: true, writable: true });
  }
  return Object.freeze(copy) as T;
}

export async function buildAlertWebhookProjections(event: BreezeEvent): Promise<{
  org: Readonly<AlertWebhookDataV2>;
  partner: Readonly<AlertWebhookDataV2Partner>;
}> {
  let row: EnrichmentRow;
  let orgExternalIds: { system: string; externalId: string }[] = [];
  let externalTickets: AlertWebhookDataV2['externalTickets'] = [];
  let partnerExternalTickets: AlertWebhookDataV2['externalTickets'] = [];
  let readFailed = false;
  try {
    ({ row, orgExternalIds } = await runWithSystemDbAccess(() => readEnrichment(event)));
  } catch (error) {
    const context = { errorId: 'WEBHOOK_ALERT_ENRICHMENT_FAILED', eventId: event.id, orgId: event.orgId, eventType: event.type };
    readFailed = true;
    captureException(error, undefined, context, { fingerprint: ['webhook-alert-enrichment-failed'] });
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
    console.error(`[WebhookAlertEnrichment] enrichment-failed ${JSON.stringify({
      ...context,
      error: error instanceof Error ? error.message : String(error),
      ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    })}`);
    row = undefined;
    orgExternalIds = [];
  }
  // Keep optional ticket enrichment failures from discarding the main row.
  // Pin reads to the event org without locking the publisher's alert row:
  // fan-out may be awaited while another connection holds its UPDATE lock.
  if (row?.alertId) {
    const { alertId, partnerId } = row;
    try {
      ({ externalTickets, partnerExternalTickets } = await runWithSystemDbAccess(async () => ({
        // Enforce audience visibility even under system access.
        externalTickets: projectExternalTickets(await listAlertExternalTickets(alertId, null, { orgId: event.orgId })),
        partnerExternalTickets: projectExternalTickets(await listAlertExternalTickets(alertId, partnerId, { orgId: event.orgId })),
      })));
    } catch (error) {
      const context = { errorId: 'WEBHOOK_ALERT_EXTERNAL_TICKETS_FAILED', eventId: event.id, orgId: event.orgId, eventType: event.type };
      readFailed = true;
      externalTickets = [];
      partnerExternalTickets = [];
      captureException(error, undefined, context, { fingerprint: ['webhook-alert-external-tickets-failed'] });
      console.error(`[WebhookAlertEnrichment] external-tickets-failed ${JSON.stringify({
        ...context,
        error: error instanceof Error ? error.message : String(error),
      })}`);
    }
  }
  const reason = !validUuid(eventPayload(event).alertId) ? 'alert_id_invalid'
    : !row ? 'org_not_found'
      : !row.alertId ? 'alert_not_visible' : null;
  if (!readFailed && reason) {
    console.warn(`[WebhookAlertEnrichment] enrichment-incomplete ${JSON.stringify({
      errorId: 'WEBHOOK_ALERT_ENRICHMENT_INCOMPLETE', eventId: event.id, orgId: event.orgId, eventType: event.type, reason,
    })}`);
  }
  const data = { ...project(event, row, readFailed || reason !== null), externalTickets };
  return { org: frozenCopy(data), partner: frozenCopy({ ...data, externalTickets: partnerExternalTickets, orgExternalIds }) };
}
