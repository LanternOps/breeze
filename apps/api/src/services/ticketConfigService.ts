// Owns ticketing configuration: custom statuses, priority SLA settings, and org-level overrides — per 2026-06-12 spec.

import { eq, and, asc, desc, inArray, count } from 'drizzle-orm';
import { ticketStatuses, ticketPrioritySettings, orgTicketSettings, partners, ticketEmailInbound, organizations } from '../db/schema';
import { ticketStatusEnum } from '../db/schema/portal';
import { getConfig } from '../config/validate';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { createTicket, type TicketActor } from './ticketService';
import { isPgUniqueViolation } from '../utils/pgErrors';
import type {
  CreateTicketStatusInput, UpdateTicketStatusInput, PrioritySettingsInput,
  OrgTicketSettingsInput, TicketPriorityValue
} from '@breeze/shared';
import type { TicketSlaPriority } from './ticketSla';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CoreTicketStatus = (typeof ticketStatusEnum.enumValues)[number];

export const DEFAULT_STATUSES: Array<{
  coreStatus: CoreTicketStatus;
  name: string;
  sortOrder: number;
}> = [
  { coreStatus: 'new', name: 'New', sortOrder: 0 },
  { coreStatus: 'open', name: 'Open', sortOrder: 1 },
  { coreStatus: 'pending', name: 'Pending', sortOrder: 2 },
  { coreStatus: 'on_hold', name: 'On hold', sortOrder: 3 },
  { coreStatus: 'resolved', name: 'Resolved', sortOrder: 4 },
  { coreStatus: 'closed', name: 'Closed', sortOrder: 5 },
];

/**
 * Insert the six system ticket statuses for a newly created partner.
 * Called inside `createPartner`'s transaction — `tx` is the Drizzle
 * transaction object.
 */
export async function seedSystemTicketStatuses(
  tx: Tx,
  partnerId: string,
): Promise<void> {
  await tx
    .insert(ticketStatuses)
    .values(
      DEFAULT_STATUSES.map((s) => ({
        partnerId,
        name: s.name,
        coreStatus: s.coreStatus,
        sortOrder: s.sortOrder,
        isSystem: true,
      })),
    );
}

/**
 * Parse a single SLA minutes value defensively. Returns null for anything that
 * isn't a finite integer (rejects floats, strings, nulls, missing keys).
 */
function parseSlaMinutes(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number') return null;
  if (!Number.isFinite(v)) return null;
  if (!Number.isInteger(v)) return null;
  // Negative values are invalid; upper-bound enforcement lives in the shared write validator (Task 6).
  if (v < 0) return null;
  return v;
}

/**
 * Per-priority SLA minutes from org_ticket_settings.sla_overrides, or nulls.
 * System-context read — never throws on malformed config.
 */
export async function getOrgSlaOverride(
  orgId: string,
  priority: TicketSlaPriority,
): Promise<{ responseMinutes: number | null; resolutionMinutes: number | null }> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ slaOverrides: orgTicketSettings.slaOverrides })
        .from(orgTicketSettings)
        .where(eq(orgTicketSettings.orgId, orgId))
        .limit(1)
    )
  );
  const row = rows[0];
  if (!row) return { responseMinutes: null, resolutionMinutes: null };

  const overrides = row.slaOverrides;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return { responseMinutes: null, resolutionMinutes: null };
  }
  const tier = (overrides as Record<string, unknown>)[priority];
  if (!tier || typeof tier !== 'object' || Array.isArray(tier)) {
    return { responseMinutes: null, resolutionMinutes: null };
  }
  const t = tier as Record<string, unknown>;
  return {
    responseMinutes: parseSlaMinutes(t['responseMinutes']),
    resolutionMinutes: parseSlaMinutes(t['resolutionMinutes']),
  };
}

/**
 * Per-priority SLA minutes from ticket_priority_settings, or nulls.
 * System-context read — missing row returns nulls, never throws.
 */
export async function getPartnerPrioritySla(
  partnerId: string,
  priority: TicketSlaPriority,
): Promise<{ responseMinutes: number | null; resolutionMinutes: number | null }> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          responseSlaMinutes: ticketPrioritySettings.responseSlaMinutes,
          resolutionSlaMinutes: ticketPrioritySettings.resolutionSlaMinutes,
        })
        .from(ticketPrioritySettings)
        .where(
          and(
            eq(ticketPrioritySettings.partnerId, partnerId),
            eq(ticketPrioritySettings.priority, priority as 'low' | 'normal' | 'high' | 'urgent'),
          )
        )
        .limit(1)
    )
  );
  const row = rows[0];
  if (!row) return { responseMinutes: null, resolutionMinutes: null };
  return {
    responseMinutes: parseSlaMinutes(row.responseSlaMinutes),
    resolutionMinutes: parseSlaMinutes(row.resolutionSlaMinutes),
  };
}

/**
 * Resolve the system ticket_statuses row id for a given partner + core status.
 * System-context read — returns null when no row exists; never throws.
 */
export async function getSystemStatusId(
  partnerId: string,
  coreStatus: CoreTicketStatus,
): Promise<string | null> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ id: ticketStatuses.id })
        .from(ticketStatuses)
        .where(
          and(
            eq(ticketStatuses.partnerId, partnerId),
            eq(ticketStatuses.coreStatus, coreStatus),
            eq(ticketStatuses.isSystem, true),
          )
        )
        .limit(1)
    )
  );
  return rows[0]?.id ?? null;
}

/**
 * Per-org billing defaults from org_ticket_settings.
 * System-context read — returns null when no row exists; never throws.
 * D6: org defaults win over category defaults in the time-entry chain.
 */
export async function getOrgBillingDefaults(orgId: string): Promise<{
  defaultHourlyRate: string | null;
  defaultBillable: boolean | null;
} | null> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          defaultHourlyRate: orgTicketSettings.defaultHourlyRate,
          defaultBillable: orgTicketSettings.defaultBillable,
        })
        .from(orgTicketSettings)
        .where(eq(orgTicketSettings.orgId, orgId))
        .limit(1)
    )
  );
  return rows[0] ?? null;
}

/**
 * Look up a ticket_statuses row by id.
 * System-context read — returns null when no row exists; never throws.
 */
export async function getTicketStatusById(id: string): Promise<{
  id: string; partnerId: string; coreStatus: CoreTicketStatus; name: string;
  isActive: boolean; isSystem: boolean;
} | null> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          id: ticketStatuses.id,
          partnerId: ticketStatuses.partnerId,
          coreStatus: ticketStatuses.coreStatus,
          name: ticketStatuses.name,
          isActive: ticketStatuses.isActive,
          isSystem: ticketStatuses.isSystem,
        })
        .from(ticketStatuses)
        .where(eq(ticketStatuses.id, id))
        .limit(1)
    )
  );
  return rows[0] ?? null;
}

/**
 * Find an active ticket_statuses row by name for the given partner (case-insensitive).
 * System-context read — returns null when no matching active row exists; never throws.
 */
export async function findStatusByName(
  partnerId: string,
  name: string,
): Promise<{ id: string; partnerId: string; coreStatus: CoreTicketStatus; name: string; isActive: boolean; isSystem: boolean } | null> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          id: ticketStatuses.id,
          partnerId: ticketStatuses.partnerId,
          coreStatus: ticketStatuses.coreStatus,
          name: ticketStatuses.name,
          isActive: ticketStatuses.isActive,
          isSystem: ticketStatuses.isSystem,
        })
        .from(ticketStatuses)
        .where(
          and(
            eq(ticketStatuses.partnerId, partnerId),
            eq(ticketStatuses.isActive, true),
          )
        )
    )
  );
  // Case-insensitive match in application code (normalise both sides to lower)
  const lowerName = name.toLowerCase();
  return rows.find((r) => r.name.toLowerCase() === lowerName) ?? null;
}

/**
 * List the display names of all active ticket_statuses rows for the given partner.
 * System-context read — used to build error messages for the AI tool.
 */
export async function listActiveStatusNames(partnerId: string): Promise<string[]> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ name: ticketStatuses.name })
        .from(ticketStatuses)
        .where(
          and(
            eq(ticketStatuses.partnerId, partnerId),
            eq(ticketStatuses.isActive, true),
          )
        )
    )
  );
  return rows.map((r) => r.name);
}

// ============================================================================
// CRUD layer (Task 6). All writes run in the REQUEST DB context (plain `db`):
// the caller's partner context is set and the partner-axis RLS policy is the
// real backstop. The system-context config reads above are unchanged.
// ============================================================================

export type TicketConfigServiceErrorCode =
  | 'STATUS_NAME_TAKEN'
  | 'STATUS_NOT_FOUND'
  | 'SYSTEM_STATUS_IMMUTABLE'
  | 'SYSTEM_STATUS_REQUIRED'
  | 'INBOUND_ROW_NOT_FOUND'
  | 'INBOUND_ROW_ALREADY_RESOLVED'
  | 'INBOUND_ROW_NO_SENDER'
  | 'ORG_NOT_ACCESSIBLE';

export class TicketConfigServiceError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 = 400, public code?: TicketConfigServiceErrorCode) {
    super(message);
    this.name = 'TicketConfigServiceError';
  }
}

const PRIORITIES: TicketPriorityValue[] = ['low', 'normal', 'high', 'urgent'];

function isUniqueNameViolation(err: unknown): boolean {
  // Only the name-uniqueness index counts as a name collision; other 23505s
  // (e.g. ticket_statuses_partner_core_status_system_uq) must propagate as-is.
  // isPgUniqueViolation unwraps the DrizzleQueryError `.cause` — a bare
  // `err.code` check missed every wrapped insert and leaked a 500 (BUG: dup
  // status name returned 500 instead of STATUS_NAME_TAKEN).
  return isPgUniqueViolation(err, 'ticket_statuses_partner_name_uq');
}

type PriorityConfig = {
  label: string | null;
  responseSlaMinutes: number | null;
  resolutionSlaMinutes: number | null;
};

async function readPriorities(partnerId: string): Promise<Record<TicketPriorityValue, PriorityConfig>> {
  const rows = await db
    .select({
      priority: ticketPrioritySettings.priority,
      label: ticketPrioritySettings.label,
      responseSlaMinutes: ticketPrioritySettings.responseSlaMinutes,
      resolutionSlaMinutes: ticketPrioritySettings.resolutionSlaMinutes,
    })
    .from(ticketPrioritySettings)
    .where(eq(ticketPrioritySettings.partnerId, partnerId));

  const byPriority = new Map(rows.map((r) => [r.priority as TicketPriorityValue, r]));
  const out = {} as Record<TicketPriorityValue, PriorityConfig>;
  for (const p of PRIORITIES) {
    const row = byPriority.get(p);
    out[p] = {
      label: row?.label ?? null,
      responseSlaMinutes: row?.responseSlaMinutes ?? null,
      resolutionSlaMinutes: row?.resolutionSlaMinutes ?? null,
    };
  }
  return out;
}

/**
 * Full partner ticketing configuration: every custom + system status (ordered),
 * the merged per-priority SLA settings (nulls where unset), and the inbound-email
 * block (resolved address + override, enabled/autoresponder flags, defaultTriageOrgId,
 * slug, and whether TICKETS_INBOUND_DOMAIN is configured).
 */
export async function getTicketConfig(partnerId: string) {
  const statuses = await db
    .select({
      id: ticketStatuses.id,
      name: ticketStatuses.name,
      coreStatus: ticketStatuses.coreStatus,
      color: ticketStatuses.color,
      sortOrder: ticketStatuses.sortOrder,
      isSystem: ticketStatuses.isSystem,
      isActive: ticketStatuses.isActive,
    })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.partnerId, partnerId))
    .orderBy(asc(ticketStatuses.sortOrder), asc(ticketStatuses.name));

  const priorities = await readPriorities(partnerId);

  const [partner] = await db
    .select({ slug: partners.slug, settings: partners.settings })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);

  const slug = partner?.slug ?? '';
  const settings = (partner?.settings as Record<string, unknown> | null) ?? {};
  const inboundCfg = (((settings.ticketing as Record<string, unknown> | undefined)?.inbound) as
    { enabled?: boolean; address?: string; defaultTriageOrgId?: string | null; autoresponderEnabled?: boolean } | undefined) ?? {};
  const domain = getConfig().TICKETS_INBOUND_DOMAIN ?? '';
  const domainConfigured = domain.length > 0;
  const derived = domainConfigured && slug ? `${slug}@${domain}` : '';
  const addressOverride = (inboundCfg.address && inboundCfg.address.length > 0) ? inboundCfg.address : null;

  const inbound = {
    enabled: inboundCfg.enabled ?? false,
    address: addressOverride ?? derived,
    addressOverride,
    defaultTriageOrgId: inboundCfg.defaultTriageOrgId ?? null,
    autoresponderEnabled: inboundCfg.autoresponderEnabled ?? true,
    slug,
    domainConfigured,
  };

  return { statuses, priorities, inbound };
}

export async function createTicketStatus(partnerId: string, input: CreateTicketStatusInput) {
  try {
    const [row] = await db
      .insert(ticketStatuses)
      .values({
        partnerId,
        name: input.name,
        coreStatus: input.coreStatus,
        color: input.color ?? null,
        sortOrder: input.sortOrder ?? 0,
        isSystem: false,
        isActive: true,
      })
      .returning();
    return row;
  } catch (err) {
    if (isUniqueNameViolation(err)) {
      throw new TicketConfigServiceError('A status with this name already exists', 409, 'STATUS_NAME_TAKEN');
    }
    throw err;
  }
}

export async function updateTicketStatus(partnerId: string, id: string, input: UpdateTicketStatusInput) {
  const existing = await db
    .select({
      id: ticketStatuses.id,
      coreStatus: ticketStatuses.coreStatus,
      isSystem: ticketStatuses.isSystem,
    })
    .from(ticketStatuses)
    .where(and(eq(ticketStatuses.id, id), eq(ticketStatuses.partnerId, partnerId)))
    .limit(1);

  const row = existing[0];
  if (!row) {
    throw new TicketConfigServiceError('Status not found', 404, 'STATUS_NOT_FOUND');
  }

  if (row.isSystem) {
    if (input.coreStatus !== undefined && input.coreStatus !== row.coreStatus) {
      throw new TicketConfigServiceError('System statuses cannot be remapped to a different core state', 400, 'SYSTEM_STATUS_IMMUTABLE');
    }
    if (input.isActive === false) {
      throw new TicketConfigServiceError('System statuses cannot be deactivated', 400, 'SYSTEM_STATUS_REQUIRED');
    }
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.coreStatus !== undefined) patch.coreStatus = input.coreStatus;
  if (input.color !== undefined) patch.color = input.color;
  if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
  if (input.isActive !== undefined) patch.isActive = input.isActive;

  try {
    const [updated] = await db
      .update(ticketStatuses)
      .set(patch)
      .where(and(eq(ticketStatuses.id, id), eq(ticketStatuses.partnerId, partnerId)))
      .returning();
    if (!updated) throw new TicketConfigServiceError('Status not found', 404, 'STATUS_NOT_FOUND');
    return updated;
  } catch (err) {
    if (err instanceof TicketConfigServiceError) throw err;
    if (isUniqueNameViolation(err)) {
      throw new TicketConfigServiceError('A status with this name already exists', 409, 'STATUS_NAME_TAKEN');
    }
    throw err;
  }
}

/**
 * Assign sortOrder by array position. Ids that don't belong to the partner are
 * skipped silently; the WHERE clause keys on (id, partnerId). withDbAccessContext
 * wraps the request in a transaction, so the sequential updates commit atomically.
 */
export async function reorderTicketStatuses(partnerId: string, ids: string[]): Promise<{ updated: number }> {
  const owned = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(and(inArray(ticketStatuses.id, ids), eq(ticketStatuses.partnerId, partnerId)));
  const ownedIds = new Set(owned.map((r) => r.id));

  let updated = 0;
  for (const [index, id] of ids.entries()) {
    if (!ownedIds.has(id)) continue;
    await db
      .update(ticketStatuses)
      .set({ sortOrder: index, updatedAt: new Date() })
      .where(and(eq(ticketStatuses.id, id), eq(ticketStatuses.partnerId, partnerId)));
    updated += 1;
  }
  return { updated };
}

/**
 * Upsert per-priority SLA settings. Each provided priority is upserted on the
 * (partner_id, priority) unique index; only fields present in the payload are
 * written on conflict. Returns the merged priorities map.
 */
export async function upsertPrioritySettings(partnerId: string, input: PrioritySettingsInput) {
  for (const [priority, settings] of Object.entries(input.priorities)) {
    if (!settings) continue;
    const setPatch: Record<string, unknown> = { updatedAt: new Date() };
    if (settings.label !== undefined) setPatch.label = settings.label ?? null;
    if (settings.responseSlaMinutes !== undefined) setPatch.responseSlaMinutes = settings.responseSlaMinutes ?? null;
    if (settings.resolutionSlaMinutes !== undefined) setPatch.resolutionSlaMinutes = settings.resolutionSlaMinutes ?? null;

    await db
      .insert(ticketPrioritySettings)
      .values({
        partnerId,
        priority: priority as TicketPriorityValue,
        label: settings.label ?? null,
        responseSlaMinutes: settings.responseSlaMinutes ?? null,
        resolutionSlaMinutes: settings.resolutionSlaMinutes ?? null,
      })
      .onConflictDoUpdate({
        target: [ticketPrioritySettings.partnerId, ticketPrioritySettings.priority],
        set: setPatch,
      });
  }
  return readPriorities(partnerId);
}

function toOrgTicketSettingsResponse(orgId: string, row?: {
  slaOverrides?: unknown;
  defaultHourlyRate?: string | null;
  defaultBillable?: boolean | null;
}) {
  return {
    orgId,
    slaOverrides: (row?.slaOverrides ?? {}) as Record<string, unknown>,
    defaultHourlyRate: row?.defaultHourlyRate ?? null,
    defaultBillable: row?.defaultBillable ?? null,
  };
}

export async function getOrgTicketSettings(orgId: string) {
  const rows = await db
    .select({
      slaOverrides: orgTicketSettings.slaOverrides,
      defaultHourlyRate: orgTicketSettings.defaultHourlyRate,
      defaultBillable: orgTicketSettings.defaultBillable,
    })
    .from(orgTicketSettings)
    .where(eq(orgTicketSettings.orgId, orgId))
    .limit(1);
  return toOrgTicketSettingsResponse(orgId, rows[0]);
}

/**
 * Upsert org-level ticket settings on the org_id unique index. slaOverrides is
 * REPLACED WHOLESALE when provided (not merged) — the client sends the full
 * desired override map. defaultHourlyRate is a numeric column, so Drizzle wants
 * a string; we convert with String() (null stays null).
 */
export async function upsertOrgTicketSettings(orgId: string, input: OrgTicketSettingsInput) {
  const fields: Record<string, unknown> = {};
  if (input.slaOverrides !== undefined) fields.slaOverrides = input.slaOverrides;
  if (input.defaultHourlyRate !== undefined) {
    fields.defaultHourlyRate = input.defaultHourlyRate == null ? null : String(input.defaultHourlyRate);
  }
  if (input.defaultBillable !== undefined) fields.defaultBillable = input.defaultBillable;

  const [row] = await db
    .insert(orgTicketSettings)
    .values({ orgId, ...fields })
    .onConflictDoUpdate({
      target: orgTicketSettings.orgId,
      set: { ...fields, updatedAt: new Date() },
    })
    .returning();
  return toOrgTicketSettingsResponse(orgId, row);
}

// ============================================================================
// Inbound-email review queue (Phase 4). Admin-only surface — the routes carry
// writePerm + adminMiddleware. Reads/writes run in the REQUEST DB context, so
// the partner-axis RLS policy on ticket_email_inbound is the real backstop; the
// explicit partnerId filter is defense-in-depth.
// ============================================================================

const REVIEW_STATUSES = ['quarantined', 'failed'] as const;

/**
 * Extract a display name from a raw From header (`"Jane Doe" <jane@x.com>`
 * → `Jane Doe`). Replicates the Mailgun provider's `extractName` so a converted
 * ticket carries the submitter's name. Returns '' for a bare address.
 */
function extractFromName(fromHeader: string): string {
  const m = fromHeader.match(/^\s*"?([^"<]+?)"?\s*</);
  return m ? (m[1] ?? '').trim() : '';
}

export interface EmailInboundQueueRow {
  id: string;
  fromAddress: string | null;
  toAddress: string | null;
  subject: string | null;
  parseStatus: string;
  error: string | null;
  ticketId: string | null;
  createdAt: Date;
}

export async function listEmailInboundQueue(
  partnerId: string,
  opts: { page: number; limit: number },
): Promise<{ data: EmailInboundQueueRow[]; pagination: { page: number; limit: number; total: number } }> {
  const page = Math.max(1, Math.floor(opts.page) || 1);
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit) || 50));
  const offset = (page - 1) * limit;

  const where = and(
    eq(ticketEmailInbound.partnerId, partnerId),
    inArray(ticketEmailInbound.parseStatus, REVIEW_STATUSES as unknown as string[]),
  );

  const data = await db
    .select({
      id: ticketEmailInbound.id,
      fromAddress: ticketEmailInbound.fromAddress,
      toAddress: ticketEmailInbound.toAddress,
      subject: ticketEmailInbound.subject,
      parseStatus: ticketEmailInbound.parseStatus,
      error: ticketEmailInbound.error,
      ticketId: ticketEmailInbound.ticketId,
      createdAt: ticketEmailInbound.createdAt,
    })
    .from(ticketEmailInbound)
    .where(where)
    .orderBy(desc(ticketEmailInbound.createdAt))
    .limit(limit)
    .offset(offset);

  const countRows = await db
    .select({ total: count() })
    .from(ticketEmailInbound)
    .where(where);
  const total = countRows[0]?.total ?? 0;

  return { data, pagination: { page, limit, total: Number(total) } };
}

// The columns returned by convert/dismiss — same projection as the queue list so
// the card can drop the resolved row into its local state without a refetch.
const returnQueueCols = {
  id: ticketEmailInbound.id,
  fromAddress: ticketEmailInbound.fromAddress,
  toAddress: ticketEmailInbound.toAddress,
  subject: ticketEmailInbound.subject,
  parseStatus: ticketEmailInbound.parseStatus,
  error: ticketEmailInbound.error,
  ticketId: ticketEmailInbound.ticketId,
  createdAt: ticketEmailInbound.createdAt,
};

/**
 * Load a review-queue row scoped to (id, partnerId) and assert it is still in a
 * resolvable state. Shared by convert + dismiss so both share the same NOT_FOUND
 * / ALREADY_RESOLVED guards. The (id, partnerId) filter is the tenant boundary
 * (defense-in-depth atop the partner-axis RLS policy): a row belonging to
 * another partner reads as NOT_FOUND, never leaking its existence.
 */
async function readQueueRow(partnerId: string, id: string) {
  const [row] = await db
    .select({
      id: ticketEmailInbound.id,
      partnerId: ticketEmailInbound.partnerId,
      parseStatus: ticketEmailInbound.parseStatus,
      fromAddress: ticketEmailInbound.fromAddress,
      toAddress: ticketEmailInbound.toAddress,
      subject: ticketEmailInbound.subject,
      raw: ticketEmailInbound.raw,
    })
    .from(ticketEmailInbound)
    .where(and(eq(ticketEmailInbound.id, id), eq(ticketEmailInbound.partnerId, partnerId)))
    .limit(1);
  if (!row) throw new TicketConfigServiceError('Inbound email not found', 404, 'INBOUND_ROW_NOT_FOUND');
  if (!(REVIEW_STATUSES as readonly string[]).includes(row.parseStatus)) {
    // Idempotency: a second convert/dismiss on an already-handled row is a
    // no-op-error, not a silent re-create. The card refetches and the row drops.
    throw new TicketConfigServiceError('This inbound email has already been handled', 409, 'INBOUND_ROW_ALREADY_RESOLVED');
  }
  return row;
}

/**
 * Convert a quarantined/failed inbound email into a source:'email' ticket in the
 * chosen org, then link the row (ticket_id + parse_status='created'). Tenancy-
 * critical — it creates a ticket in an operator-chosen org:
 *   - the row must belong to the resolved partner (404 if not);
 *   - the row must be unresolved (409 idempotency guard);
 *   - the chosen org must belong to the resolved partner (ORG_NOT_ACCESSIBLE);
 *   - the row must carry a usable sender address (INBOUND_ROW_NO_SENDER) — a
 *     reply-less email-source ticket defeats the submitterEmail extension.
 * `actor` is the REAL authenticated admin threaded from the route, giving correct
 * audit attribution (no synthetic all-zero-UUID sentinel).
 */
export async function convertEmailInbound(partnerId: string, id: string, orgId: string, actor: TicketActor): Promise<EmailInboundQueueRow> {
  // Read first only to validate the guards (org-in-partner, usable sender) and to
  // distinguish NOT_FOUND from ALREADY_RESOLVED for the caller. The actual race-
  // safe transition is the claim UPDATE below — no ticket is created until the
  // row is atomically claimed out of the review state.
  const row = await readQueueRow(partnerId, id);

  // Guard (spec §6): the chosen org must belong to the resolved partner. Without
  // this, an admin could convert an email into a ticket in an org outside their
  // partner. RLS on organizations already scopes the request context, but the
  // explicit partner_id equality is the security boundary, not the read.
  const [orgOk] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, orgId), eq(organizations.partnerId, partnerId)))
    .limit(1);
  if (!orgOk) throw new TicketConfigServiceError('That organization is not in your partner', 400, 'ORG_NOT_ACCESSIBLE');

  // A ticket with no sender email can never receive a reply — the whole point of
  // source:'email' is the submitterEmail recipient (spec §6). Block instead of
  // silently creating a reply-less ticket.
  const submitterEmail = (row.fromAddress ?? '').trim();
  if (!submitterEmail) {
    throw new TicketConfigServiceError('This email has no usable sender address; it cannot be converted to a ticket', 400, 'INBOUND_ROW_NO_SENDER');
  }

  // The persisted `raw` JSONB is the UNTRANSFORMED Mailgun webhook form body, so
  // it carries `stripped-text`/`body-plain` (not `text`) and `from` (the full
  // From header, not `fromName`). Read those real keys — using `raw.text` /
  // `raw.fromName` here silently lost the body and submitter name on every convert.
  const raw = (row.raw as Record<string, unknown> | null) ?? {};
  const description =
    (typeof raw['stripped-text'] === 'string' && raw['stripped-text']) ||
    (typeof raw['body-plain'] === 'string' && raw['body-plain']) ||
    '';
  const fromName = extractFromName(typeof raw.from === 'string' ? raw.from : '') || undefined;

  // CLAIM-FIRST: atomically transition the row out of the review state BEFORE any
  // ticket is created. If a concurrent dismiss/convert won the race, this affects
  // 0 rows and we throw before createTicket runs — so a lost race never orphans a
  // ticket. The WHERE keys on (id, partnerId, parse_status IN review) so it's also
  // the real TOCTOU-safe transition (the read above is advisory only).
  const [claimed] = await db
    .update(ticketEmailInbound)
    .set({ parseStatus: 'created' })
    .where(and(
      eq(ticketEmailInbound.id, id),
      eq(ticketEmailInbound.partnerId, partnerId),
      inArray(ticketEmailInbound.parseStatus, REVIEW_STATUSES as unknown as string[]),
    ))
    .returning(returnQueueCols);
  if (!claimed) throw new TicketConfigServiceError('Inbound email not found', 404, 'INBOUND_ROW_NOT_FOUND');

  // Only now create the ticket. If createTicket throws, the error propagates
  // (non-service error → handleServiceError rethrows → the request transaction
  // rolls back, undoing the claim above — the row is never left half-updated).
  const ticket = await createTicket(
    {
      orgId,
      subject: row.subject?.trim() || '(no subject)',
      description,
      source: 'email',
      submitterEmail,
      submitterName: fromName,
    },
    actor,
  );

  const [updated] = await db
    .update(ticketEmailInbound)
    .set({ ticketId: ticket.id })
    .where(and(eq(ticketEmailInbound.id, id), eq(ticketEmailInbound.partnerId, partnerId)))
    .returning(returnQueueCols);
  // The row was claimed by THIS transaction a moment ago, so it must still exist;
  // an empty result would mean the row vanished mid-transaction (shouldn't happen).
  if (!updated) throw new TicketConfigServiceError('Inbound email not found', 404, 'INBOUND_ROW_NOT_FOUND');
  return updated;
}

/**
 * Drop a quarantined/failed inbound email out of the review queue by marking it
 * parse_status='ignored' (PR 1's terminal "do not process" value — no new enum
 * value). The row stays in the table for audit; the queue lists only
 * quarantined/failed, so an ignored row disappears. No ticket is created.
 */
export async function dismissEmailInbound(partnerId: string, id: string): Promise<EmailInboundQueueRow> {
  await readQueueRow(partnerId, id);
  const [updated] = await db
    .update(ticketEmailInbound)
    .set({ parseStatus: 'ignored' })
    .where(and(eq(ticketEmailInbound.id, id), eq(ticketEmailInbound.partnerId, partnerId)))
    .returning(returnQueueCols);
  if (!updated) throw new TicketConfigServiceError('Inbound email not found', 404, 'INBOUND_ROW_NOT_FOUND');
  return updated;
}
