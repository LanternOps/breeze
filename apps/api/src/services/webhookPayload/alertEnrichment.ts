import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as dbModule from '../../db';
import { alerts, devices, organizations, organizationExternalLinks, sites } from '../../db/schema';
import type { BreezeEvent } from '../eventBus';
import { captureException } from '../sentry';
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

async function readEnrichment(event: BreezeEvent) {
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
    resolutionReason: alerts.resolutionReason,
    acknowledgedBy: alerts.acknowledgedBy,
    suppressedUntil: alerts.suppressedUntil,
  }).from(organizations)
    // Publishers may still be in a transaction. The org anchors the read so a
    // not-yet-visible alert does not prevent enrichment by payload deviceId.
    .leftJoin(alerts, and(eq(alerts.id, sql`${validUuid(event.payload.alertId)}::uuid`), eq(alerts.orgId, organizations.id)))
    .leftJoin(devices, and(
      eq(devices.id, sql`COALESCE(${alerts.deviceId}, ${validUuid(event.payload.deviceId)}::uuid)`),
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
  const payload = event.payload;
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
    externalTickets: [], acknowledgedByPrincipalId: null, resolvedByPrincipalId: null,
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
  try {
    ({ row, orgExternalIds } = await runWithSystemDbAccess(() => readEnrichment(event)));
  } catch (error) {
    const context = { errorId: 'WEBHOOK_ALERT_ENRICHMENT_FAILED', eventId: event.id, orgId: event.orgId, eventType: event.type };
    captureException(error, undefined, context);
    console.error(`[WebhookAlertEnrichment] enrichment-failed ${JSON.stringify(context)}`);
    row = undefined;
    orgExternalIds = [];
  }
  const data = project(event, row, !row?.alertId);
  return { org: frozenCopy(data), partner: frozenCopy({ ...data, orgExternalIds }) };
}
