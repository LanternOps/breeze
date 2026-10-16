/**
 * Endpoint message history reads (#8742 W02): the batch list and one batch's
 * per-device status. Runs in the request's RLS context; the app-layer org
 * condition is the same filter, stated, never a widening. A site-restricted
 * caller sees only deliveries on devices in their allowed sites.
 */
import { and, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { devices, endpointMessageDeliveries, endpointMessageReceipts, endpointMessages } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import type { UserPermissions } from '../permissions';

export const HISTORY_PAGE_MAX = 100;

type Auth = Pick<AuthContext, 'orgCondition' | 'canAccessOrg'>;
type SitePerms = Pick<UserPermissions, 'allowedSiteIds'> | undefined;

function siteFilter(permissions: SitePerms): SQL | undefined {
  const allowed = permissions?.allowedSiteIds;
  if (allowed === undefined) return undefined;
  if (!Array.isArray(allowed) || allowed.length === 0) return sql`false`;
  return inArray(devices.siteId, allowed);
}

/** Same rule as siteFilter, against the raw `dv` alias used in correlated subqueries. */
function siteFilterRaw(permissions: SitePerms): SQL {
  const allowed = permissions?.allowedSiteIds;
  if (!Array.isArray(allowed) || allowed.length === 0) return sql`false`;
  return sql`dv.site_id IN (${sql.join(allowed.map((s) => sql`${s}::uuid`), sql`, `)})`;
}

export interface MessageListItem {
  id: string;
  orgId: string;
  batchId: string;
  title: string | null;
  severity: string;
  requiresAck: boolean;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  retractedAt: string | null;
  bodyPurged: boolean;
  aiInitiated: boolean;
  resendOfId: string | null;
  deviceCount: number;
  statusCounts: Record<string, number>;
}

export async function listEndpointMessages(args: {
  auth: Auth;
  permissions?: SitePerms;
  orgId?: string;
  limit: number;
  cursor?: { createdAt: Date; id: string };
}): Promise<{ items: MessageListItem[]; nextCursor: string | null }> {
  const { auth, orgId, cursor } = args;
  const limit = Math.min(Math.max(args.limit, 1), HISTORY_PAGE_MAX);
  if (orgId && !auth.canAccessOrg(orgId)) return { items: [], nextCursor: null };

  const rows = await db
    .select({
      id: endpointMessages.id,
      orgId: endpointMessages.orgId,
      batchId: endpointMessages.batchId,
      title: endpointMessages.title,
      severity: endpointMessages.severity,
      requiresAck: endpointMessages.requiresAck,
      createdBy: endpointMessages.createdBy,
      createdAt: endpointMessages.createdAt,
      expiresAt: endpointMessages.expiresAt,
      retractedAt: endpointMessages.retractedAt,
      bodyPurgedAt: endpointMessages.bodyPurgedAt,
      aiInitiatorKind: endpointMessages.aiInitiatorKind,
      resendOfId: endpointMessages.resendOfId,
    })
    .from(endpointMessages)
    .where(and(
      auth.orgCondition(endpointMessages.orgId),
      orgId ? eq(endpointMessages.orgId, orgId) : undefined,
      // A site-restricted reader lists only messages that reached one of their sites.
      args.permissions?.allowedSiteIds !== undefined
        ? sql`EXISTS (
            SELECT 1 FROM endpoint_message_deliveries d
              JOIN devices dv ON dv.id = d.device_id
             WHERE d.endpoint_message_id = ${endpointMessages.id}
               AND ${siteFilterRaw(args.permissions)}
          )`
        : undefined,
      cursor
        ? or(
            lt(endpointMessages.createdAt, cursor.createdAt),
            and(eq(endpointMessages.createdAt, cursor.createdAt), lt(endpointMessages.id, cursor.id)),
          )
        : undefined,
    ))
    .orderBy(desc(endpointMessages.createdAt), desc(endpointMessages.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const counts = new Map<string, Record<string, number>>();
  if (page.length > 0) {
    const grouped = await db
      .select({
        messageId: endpointMessageDeliveries.endpointMessageId,
        status: endpointMessageDeliveries.status,
        n: sql<number>`count(*)::int`,
      })
      .from(endpointMessageDeliveries)
      .innerJoin(devices, eq(devices.id, endpointMessageDeliveries.deviceId))
      .where(and(
        inArray(endpointMessageDeliveries.endpointMessageId, page.map((r) => r.id)),
        siteFilter(args.permissions),
      ))
      .groupBy(endpointMessageDeliveries.endpointMessageId, endpointMessageDeliveries.status);
    for (const g of grouped) {
      if (!g.messageId) continue;
      const c = counts.get(g.messageId) ?? {};
      c[g.status] = Number(g.n);
      counts.set(g.messageId, c);
    }
  }

  const items = page.map((r) => {
    const statusCounts = counts.get(r.id) ?? {};
    return {
      id: r.id,
      orgId: r.orgId,
      batchId: r.batchId,
      title: r.title,
      severity: r.severity,
      requiresAck: r.requiresAck,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      retractedAt: r.retractedAt?.toISOString() ?? null,
      bodyPurged: r.bodyPurgedAt !== null,
      aiInitiated: r.aiInitiatorKind !== null,
      resendOfId: r.resendOfId,
      deviceCount: Object.values(statusCounts).reduce((a, b) => a + b, 0),
      statusCounts,
    };
  });
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last
    ? Buffer.from(JSON.stringify({ c: last.createdAt.toISOString(), i: last.id })).toString('base64url')
    : null;
  return { items, nextCursor };
}

export function decodeHistoryCursor(raw: string | undefined): { createdAt: Date; id: string } | undefined | 'invalid' {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { c?: unknown; i?: unknown };
    if (typeof parsed.c !== 'string' || typeof parsed.i !== 'string') return 'invalid';
    const createdAt = new Date(parsed.c);
    if (Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(parsed.i)) return 'invalid';
    return { createdAt, id: parsed.i };
  } catch {
    return 'invalid';
  }
}

export interface MessageDetail extends MessageListItem {
  body: string | null;
  deliveries: Array<{
    id: string;
    deviceId: string;
    hostname: string | null;
    siteId: string;
    status: string;
    surface: string | null;
    errorCode: string | null;
    deliveredAt: string | null;
    displayedAt: string | null;
    acknowledgedAt: string | null;
    dismissedAt: string | null;
    retractedAt: string | null;
    receipts: Array<{ sessionUsername: string | null; eventType: string; occurredAt: string }>;
  }>;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

export async function getEndpointMessageDetail(args: {
  auth: Auth;
  permissions?: SitePerms;
  messageRowId: string;
}): Promise<MessageDetail | null> {
  const { auth, messageRowId } = args;
  const [m] = await db
    .select()
    .from(endpointMessages)
    .where(and(eq(endpointMessages.id, messageRowId), auth.orgCondition(endpointMessages.orgId)))
    .limit(1);
  if (!m || !auth.canAccessOrg(m.orgId)) return null;

  const rows = await db
    .select({
      id: endpointMessageDeliveries.id,
      deviceId: endpointMessageDeliveries.deviceId,
      hostname: devices.hostname,
      siteId: devices.siteId,
      status: endpointMessageDeliveries.status,
      surface: endpointMessageDeliveries.surface,
      errorCode: endpointMessageDeliveries.errorCode,
      deliveredAt: endpointMessageDeliveries.deliveredAt,
      displayedAt: endpointMessageDeliveries.displayedAt,
      acknowledgedAt: endpointMessageDeliveries.acknowledgedAt,
      dismissedAt: endpointMessageDeliveries.dismissedAt,
      retractedAt: endpointMessageDeliveries.retractedAt,
    })
    .from(endpointMessageDeliveries)
    .innerJoin(devices, eq(devices.id, endpointMessageDeliveries.deviceId))
    .where(and(eq(endpointMessageDeliveries.endpointMessageId, m.id), siteFilter(args.permissions)))
    .orderBy(devices.hostname);

  const receiptsByDelivery = new Map<string, MessageDetail['deliveries'][number]['receipts']>();
  if (rows.length > 0) {
    const receipts = await db
      .select({
        deliveryId: endpointMessageReceipts.deliveryId,
        sessionUsername: endpointMessageReceipts.sessionUsername,
        eventType: endpointMessageReceipts.eventType,
        occurredAt: endpointMessageReceipts.occurredAt,
      })
      .from(endpointMessageReceipts)
      .where(inArray(endpointMessageReceipts.deliveryId, rows.map((r) => r.id)))
      .orderBy(endpointMessageReceipts.occurredAt);
    for (const r of receipts) {
      const list = receiptsByDelivery.get(r.deliveryId) ?? [];
      list.push({ sessionUsername: r.sessionUsername, eventType: r.eventType, occurredAt: r.occurredAt.toISOString() });
      receiptsByDelivery.set(r.deliveryId, list);
    }
  }

  const statusCounts: Record<string, number> = {};
  for (const r of rows) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;

  return {
    id: m.id,
    orgId: m.orgId,
    batchId: m.batchId,
    title: m.title,
    body: m.body,
    severity: m.severity,
    requiresAck: m.requiresAck,
    createdBy: m.createdBy,
    createdAt: m.createdAt.toISOString(),
    expiresAt: m.expiresAt.toISOString(),
    retractedAt: iso(m.retractedAt),
    bodyPurged: m.bodyPurgedAt !== null,
    aiInitiated: m.aiInitiatorKind !== null,
    resendOfId: m.resendOfId,
    deviceCount: rows.length,
    statusCounts,
    deliveries: rows.map((r) => ({
      id: r.id,
      deviceId: r.deviceId,
      hostname: r.hostname,
      siteId: r.siteId,
      status: r.status,
      surface: r.surface,
      errorCode: r.errorCode,
      deliveredAt: iso(r.deliveredAt),
      displayedAt: iso(r.displayedAt),
      acknowledgedAt: iso(r.acknowledgedAt),
      dismissedAt: iso(r.dismissedAt),
      retractedAt: iso(r.retractedAt),
      receipts: receiptsByDelivery.get(r.id) ?? [],
    })),
  };
}

/**
 * Devices a resend reaches: attached deliveries that failed or expired
 * WITHOUT ever being shown, and that no earlier resend of this message
 * already covers (so repeated resends never re-pop a card).
 */
export async function resendTargets(messageRowId: string): Promise<string[]> {
  const rows = await db
    .select({ deviceId: endpointMessageDeliveries.deviceId })
    .from(endpointMessageDeliveries)
    .where(and(
      eq(endpointMessageDeliveries.endpointMessageId, messageRowId),
      inArray(endpointMessageDeliveries.status, ['failed', 'expired']),
      sql`${endpointMessageDeliveries.displayedAt} IS NULL`,
      sql`${endpointMessageDeliveries.acknowledgedAt} IS NULL`,
      sql`NOT EXISTS (
        SELECT 1 FROM endpoint_message_deliveries r
          JOIN endpoint_messages rm ON rm.id = r.endpoint_message_id
         WHERE rm.resend_of_id = ${messageRowId}::uuid
           AND r.device_id = ${endpointMessageDeliveries.deviceId}
      )`,
    ));
  return rows.map((r) => r.deviceId);
}
